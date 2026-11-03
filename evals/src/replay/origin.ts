/** Verify an offline derivation against the original saved execution, once per report. */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { REVIEW_CONTRACT_VERSION } from '../../../src/review-contract/index.js';
import { REVIEW_PROMPT_VERSION } from '../../../src/reviewer/contract.js';
import { USAGE_MAPPING_VERSION } from '../../../src/reviewer/usage.js';
import { canonicalJson } from '../data/hash.js';
import type { RunArtifact } from '../run/artifact.js';
import {
  RUNNER_IMPLEMENTATION_VERSION,
  RUN_ARTIFACT_VERSION,
} from '../run/types.js';
import { deriveRun } from './assemble.js';
import { referencesMatch } from './references.js';
import { readSource } from './source.js';
import { parseVariants } from './variants.js';
import {
  REPLAY_IMPLEMENTATION_VERSION,
  REPLAY_LINEAGE_VERSION,
  REPLAY_VARIANTS_VERSION,
} from './types.js';

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
function withoutNotes(value: { readonly notes: readonly string[] }): object {
  const { notes: _notes, ...evidence } = value;
  return evidence;
}
function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
async function fixtureBytes(directory: string): Promise<Buffer | null> {
  try {
    return await readFile(join(directory, 'fixture.json'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
}

export async function verifiedReplayOrigin(parts: {
  readonly directory: string;
  readonly root: string;
  readonly artifact: RunArtifact;
}): Promise<boolean> {
  try {
    return await verify(parts);
  } catch {
    return false;
  }
}

async function verify(
  parts: Parameters<typeof verifiedReplayOrigin>[0],
): Promise<boolean> {
  const raw: unknown = JSON.parse(
    await readFile(join(parts.directory, 'lineage.json'), 'utf8'),
  );
  const lineage = object(raw);
  if (lineage === null || lineage['documentVersion'] !== REPLAY_LINEAGE_VERSION)
    return false;
  const replay = object(lineage['replay']),
    source = object(lineage['source']),
    derived = object(lineage['derived']);
  if (
    replay !== null &&
    !(await referencesMatch(parts.directory, replay['references']))
  )
    return false;
  if (
    replay === null ||
    source === null ||
    derived === null ||
    replay['implementation'] !== REPLAY_IMPLEMENTATION_VERSION ||
    replay['contract'] !== REVIEW_CONTRACT_VERSION ||
    derived['runId'] !== parts.artifact.index.runId ||
    typeof source['directory'] !== 'string' ||
    typeof derived['directory'] !== 'string'
  )
    return false;
  const parsed = parseVariants({
    variantsVersion: REPLAY_VARIANTS_VERSION,
    variants: [
      {
        description: replay['description'],
        answer: replay['answer'],
        thresholds: replay['thresholds'],
        settlement: replay['settlement'],
        ...(replay['matrix'] === 'shared' ? {} : { matrix: replay['matrix'] }),
      },
    ],
  });
  if (!parsed.ok) return false;
  const variant = parsed.variants[0];
  if (
    variant === undefined ||
    variant.digest !== replay['digest'] ||
    variant.variantId !== replay['variantId']
  )
    return false;
  const original = await readSource({
    directory: resolve(parts.root, source['directory']),
    root: parts.root,
  });
  if (
    !original.ok ||
    !same(original.source, source) ||
    original.plan.workflow === undefined
  )
    return false;
  const fixture = await fixtureBytes(parts.directory);
  if (
    original.fixture === null
      ? fixture !== null
      : fixture === null || !original.fixture.equals(fixture)
  )
    return false;
  const versions = [
    original.index.versions,
    ...[...original.records.values()].map((entry) => entry.record.versions),
  ];
  if (
    versions.some(
      (version) =>
        version.implementation !== RUNNER_IMPLEMENTATION_VERSION ||
        version.contract !== REVIEW_CONTRACT_VERSION ||
        version.prompt !== REVIEW_PROMPT_VERSION ||
        version.usageMapping !== USAGE_MAPPING_VERSION ||
        version.artifact !== RUN_ARTIFACT_VERSION ||
        version.plan !== original.plan.planVersion,
    )
  )
    return false;
  const rebuilt = deriveRun({
    source: original,
    variant,
    runningContract: REVIEW_CONTRACT_VERSION,
    runningPrompt: REVIEW_PROMPT_VERSION,
    derivedDirectory: derived['directory'],
    // Input standing only annotates lineage notes; it never changes a saved answer.
    inputs: {
      status: 'undetermined',
      reason: 'origin verification',
      reRequestRequired: true,
    },
    variantsDocument:
      typeof replay['variantsDocument'] === 'string'
        ? replay['variantsDocument']
        : null,
  });
  if (
    !same(rebuilt.run.plan, parts.artifact.plan) ||
    !same(
      withoutNotes(rebuilt.run.index),
      withoutNotes(parts.artifact.index),
    ) ||
    !same(rebuilt.lineage.cells, lineage['cells']) ||
    !same(rebuilt.lineage.totals, lineage['totals']) ||
    rebuilt.run.records.length !== parts.artifact.records.length
  )
    return false;
  const expected = new Map(
    rebuilt.run.records.map((record) => [record.cellId, record]),
  );
  return parts.artifact.records.every((record) => {
    const originalRecord = expected.get(record.cellId);
    return originalRecord !== undefined && same(record, originalRecord);
  });
}
