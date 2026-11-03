import { mkdir, realpath, readdir, access } from 'node:fs/promises';
import { isAbsolute, resolve, join } from 'node:path';
import {
  claimRun,
  RUN_FILES,
  planDigest,
  readRun,
  attemptsOfCell,
} from './artifact.js';
import type { RunCheckers } from './schemas.js';
import type { RunPlan } from './types.js';

/** Process-local evidence that the existing run claim is held, not a user authorization. */
export interface ResourceLease {
  readonly directory: string;
  readonly planHash: string;
  started: boolean;
  accounted: boolean;
}
const active = new WeakSet<ResourceLease>();
const accounting = new WeakMap<
  ResourceLease,
  { spent: number; dispatched: boolean }
>();

export async function canonicalResourceDirectory(
  plan: RunPlan,
  directory: string,
): Promise<string> {
  const declared = plan.resource?.runDirectory;
  if (
    plan.workflow === undefined ||
    declared === undefined ||
    !isAbsolute(declared)
  )
    throw new Error(
      'workflow dispatch requires an absolute resource runDirectory',
    );
  await mkdir(declared, { recursive: true });
  const expected = await realpath(declared);
  const actual =
    resolve(directory) === resolve(declared)
      ? expected
      : await realpath(directory).catch(() => null);
  if (actual !== expected)
    throw new Error(
      'resource scope forbids a different run directory; a new directory cannot reset this allowance',
    );
  return expected;
}

export async function withResourceClaim<T>(
  plan: RunPlan,
  directory: string,
  operation: (lease: ResourceLease) => Promise<T>,
): Promise<T> {
  const canonical = await canonicalResourceDirectory(plan, directory);
  const release = await claimRun(canonical);
  const lease: ResourceLease = {
    directory: canonical,
    planHash: planDigest(plan),
    started: false,
    accounted: false,
  };
  active.add(lease);
  try {
    return await operation(lease);
  } finally {
    active.delete(lease);
    // A possibly sent request without durable settlement cannot regain its allowance.
    if (!lease.started || lease.accounted) await release();
  }
}

function requireResourceLease(
  plan: RunPlan,
  lease: ResourceLease | undefined,
): void {
  if (
    plan.workflow !== undefined &&
    (lease === undefined ||
      !active.has(lease) ||
      lease.planHash !== planDigest(plan))
  )
    throw new Error(
      'workflow dispatch requires the held resource claim and fresh persisted accounting',
    );
}

/** Read the existing artifacts under the held claim; never accept a supplied total. */
export async function certifyResourceAccounting(
  plan: RunPlan,
  lease: ResourceLease,
  checkers: RunCheckers,
): Promise<void> {
  requireResourceLease(plan, lease);
  if (accounting.has(lease))
    throw new Error(
      'resource claim already has a dispatch accounting observation',
    );
  const read = await readRun(lease.directory, checkers, {
    allowWorkflow: true,
  });
  if (!read.ok || read.artifact.missing.length > 0)
    throw new Error(
      'resource records are missing or unreadable; consumption is unknown',
    );
  if (planDigest(read.artifact.plan) !== lease.planHash)
    throw new Error('resource accounting does not match the frozen plan');
  if (read.artifact.records.some((record) => record.abandonment !== null))
    throw new Error('resource requests may still be outstanding');
  accounting.set(lease, {
    spent: read.artifact.records.reduce(
      (sum, record) => sum + attemptsOfCell(record),
      0,
    ),
    dispatched: false,
  });
}

/** Consume this observation once, so reusing a lease cannot renew its allowance. */
export function beginResourceDispatch(
  plan: RunPlan,
  lease: ResourceLease | undefined,
): number {
  requireResourceLease(plan, lease);
  const observed = lease === undefined ? undefined : accounting.get(lease);
  if (observed === undefined || observed.dispatched)
    throw new Error('workflow dispatch requires fresh persisted accounting');
  observed.dispatched = true;
  return observed.spent;
}

export function hasResourceClaim(lease: ResourceLease | undefined): boolean {
  return (
    lease !== undefined &&
    active.has(lease) &&
    accounting.get(lease)?.dispatched === true
  );
}

export async function requireUnoccupiedResource(
  directory: string,
): Promise<void> {
  for (const name of [RUN_FILES.plan, RUN_FILES.index]) {
    const exists = await access(join(directory, name)).then(
      () => true,
      () => false,
    );
    if (exists)
      throw new Error(
        'resource directory already contains a run; resume it instead of resetting its allowance',
      );
  }
  const records = await readdir(join(directory, RUN_FILES.records)).catch(
    (error: unknown) => {
      if (
        error !== null &&
        typeof error === 'object' &&
        Reflect.get(error, 'code') === 'ENOENT'
      )
        return [];
      throw error;
    },
  );
  if (records.length > 0)
    throw new Error(
      'resource directory contains orphan records; refusing to treat unknown consumption as zero',
    );
}

export function resourceAttemptLimit(plan: RunPlan): number {
  if (plan.workflow === undefined) return plan.bounds.maxAttempts;
  if (plan.resource === undefined)
    throw new Error('workflow resource allowance is missing');
  return Math.min(
    plan.bounds.maxAttempts,
    plan.resource.maxAttempts,
    Math.floor(
      plan.resource.maxEstimatedInputTokens / plan.bounds.maxInputTokens,
    ),
  );
}
