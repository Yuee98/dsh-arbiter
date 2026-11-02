/** Group-local claim and atomic role writes. Opinions survive a later label-write failure. */
import { lstat, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { readGroupedDataset } from '../data/group-read.js';
import { compileCheckers } from '../data/schemas.js';
import { checkGroups } from '../data/group-check.js';
import { canonicalJson } from '../data/hash.js';
import { destinationsInside } from '../report/write.js';
import { datasetEvidence } from '../data/source-evidence.js';
import { sameAnnotationView } from '../data/annotation-binding.js';
import { legacyMetadata } from '../data/legacy-metadata.js';
import { REVIEW_CONTRACT_VERSION } from '../../../src/review-contract/index.js';
import type {
  GroupedDataset,
  WorkflowLabel,
  WorkflowOpinion,
} from '../data/group-types.js';
import type { Split } from '../data/types.js';
import type { WorkflowBatch } from './workflow-types.js';

export function assertWorkflowOutput(
  root: string,
  dataset: string,
  path: string,
): void {
  const protectedPaths = [
    ...datasetEvidence(root, dataset),
    { path: resolve(root, dataset), kind: 'directory' as const },
    { path: resolve(root, 'evals/datasets'), kind: 'directory' as const },
    {
      path: resolve(root, '.local/evals/workflow-annotation'),
      kind: 'directory' as const,
    },
    { path: resolve(root, '.local/evals/runs'), kind: 'directory' as const },
  ];
  if (destinationsInside([path], protectedPaths).length > 0)
    throw new Error(
      `annotation output would overwrite protected evidence: ${path}`,
    );
}
export async function regularWorkflowDirectory(
  dataset: string,
  split: Split,
  group: string,
  references = true,
): Promise<string> {
  if (
    !['dev', 'calibration', 'holdout'].includes(split) ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(group) ||
    group === '.' ||
    group === '..' ||
    group === 'legacy-v1'
  )
    throw new Error('invalid workflow scope');
  let path = resolve(dataset);
  for (const part of ['', split, group]) {
    if (part !== '') path = join(path, part);
    if (!(await lstat(path)).isDirectory())
      throw new Error(
        `workflow directory must be regular, not symlinked: ${path}`,
      );
  }
  for (const role of references
    ? ['workflows', 'labels', 'opinions']
    : ['workflows']) {
    try {
      if (!(await lstat(join(path, `${role}.json`))).isFile())
        throw new Error(`${role} must be a regular file, not a symlink`);
    } catch (error) {
      if (
        role !== 'workflows' &&
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        continue;
      throw error;
    }
  }
  return path;
}
export async function workflowState(
  dataset: string,
  split: Split,
  group: string,
): Promise<GroupedDataset> {
  await regularWorkflowDirectory(dataset, split, group);
  const state = await readGroupedDataset(dataset, {
    split,
    group,
    contentSet: 'workflows-v1',
    references: true,
  });
  if (state.problems.length > 0)
    throw new Error(
      state.problems.map((p) => `${p.path}: ${p.message}`).join('; '),
    );
  return state;
}
export function workflowRecords(state: GroupedDataset) {
  return {
    labels: state.groups.flatMap((group) =>
      group.labels.flatMap((entry) =>
        'referenceId' in entry.document ? [entry.document] : [],
      ),
    ),
    opinions: state.groups.flatMap((group) =>
      group.opinions.flatMap((entry) =>
        'opinion' in entry.document ? [entry.document] : [],
      ),
    ),
  };
}
async function atomicRole(
  directory: string,
  role: string,
  records: readonly unknown[],
  beforePublish: () => Promise<void>,
): Promise<void> {
  const temporary = join(directory, `.${role}-${randomUUID()}.tmp`);
  try {
    await writeFile(
      temporary,
      JSON.stringify({ schemaVersion: 'grouped-v1', records }, null, 2) + '\n',
      { flag: 'wx' },
    );
    await beforePublish();
    await rename(temporary, join(directory, `${role}.json`));
  } finally {
    await rm(temporary, { force: true });
  }
}
interface GroupChange<T> {
  readonly labels: readonly WorkflowLabel[];
  readonly opinions: readonly WorkflowOpinion[];
  readonly result: T;
}
export async function changeWorkflowGroup<T>(
  dataset: string,
  split: Split,
  group: string,
  write: boolean,
  operation: (
    state: GroupedDataset,
  ) => GroupChange<T> | Promise<GroupChange<T>>,
): Promise<T> {
  const directory = await regularWorkflowDirectory(dataset, split, group);
  const lockPath = join(directory, '.annotation.lock');
  const lock = write ? await open(lockPath, 'wx') : null;
  try {
    const state = await workflowState(dataset, split, group);
    const original = workflowRecords(state);
    const next = await operation(state);
    const checkers = await compileCheckers();
    const labels = checkers.groupedLabels({
      schemaVersion: 'grouped-v1',
      records: next.labels,
    });
    const opinions = checkers.groupedOpinions({
      schemaVersion: 'grouped-v1',
      records: next.opinions,
    });
    if (!labels.ok || !opinions.ok)
      throw new Error(
        [
          ...(labels.ok ? [] : labels.problems),
          ...(opinions.ok ? [] : opinions.problems),
        ].join('; '),
      );
    const first = state.groups[0];
    if (first === undefined) throw new Error('selected group disappeared');
    const checked = checkGroups(
      [
        {
          ...first,
          labels: next.labels.map((document) => ({
            path: 'labels.json',
            document,
          })),
          opinions: next.opinions.map((document) => ({
            path: 'opinions.json',
            document,
          })),
        },
      ],
      checkers,
      {
        contract: REVIEW_CONTRACT_VERSION,
        rubric: (await legacyMetadata()).versions.rubric,
      },
    );
    if (checked.problems.length > 0)
      throw new Error(checked.problems.map((p) => p.message).join('; '));
    // An editor that doesn't participate in our lock must not be overwritten.
    const freshState = await workflowState(dataset, split, group);
    const fresh = workflowRecords(freshState);
    if (
      canonicalJson(freshState.groups.flatMap((group) => group.workflows)) !==
      canonicalJson(state.groups.flatMap((group) => group.workflows))
    )
      throw new Error(
        'source changed while preparing annotation; retry against the current view',
      );
    if (canonicalJson(fresh) !== canonicalJson(original))
      throw new Error(
        'annotation conflict: role files changed while preparing the update',
      );
    if (write) {
      const unchanged = async (role: 'opinions' | 'labels'): Promise<void> => {
        const latest = workflowRecords(
          await workflowState(dataset, split, group),
        );
        if (canonicalJson(latest[role]) !== canonicalJson(original[role]))
          throw new Error(
            `annotation conflict: ${role} changed before publication`,
          );
      };
      if (canonicalJson(original.opinions) !== canonicalJson(next.opinions))
        await atomicRole(directory, 'opinions', next.opinions, () =>
          unchanged('opinions'),
        );
      try {
        if (canonicalJson(original.labels) !== canonicalJson(next.labels))
          await atomicRole(directory, 'labels', next.labels, () =>
            unchanged('labels'),
          );
      } catch (error) {
        throw new Error(
          `opinions retained; labels were not updated; retry the same response IDs: ${String(error)}`,
          { cause: error },
        );
      }
    }
    return next.result;
  } finally {
    if (lock !== null) {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }
}
export function mergeOpinions(
  current: readonly WorkflowOpinion[],
  incoming: readonly WorkflowOpinion[],
): readonly WorkflowOpinion[] {
  const records = new Map(
    current.map((value) => [value.opinion.reviewId, value]),
  );
  let order = Math.max(
    0,
    ...current.map((value) => value.annotation?.recordedOrder ?? 0),
  );
  for (const value of incoming) {
    const old = records.get(value.opinion.reviewId);
    if (
      old?.annotation !== undefined &&
      value.annotation !== undefined &&
      old.annotation.responseHash === value.annotation.responseHash &&
      old.batchId === value.batchId &&
      old.rootId === value.rootId &&
      old.pointId === value.pointId &&
      old.viewId === value.viewId &&
      old.annotation.modelKey === value.annotation.modelKey &&
      sameAnnotationView(old.annotation.binding, value.annotation.binding) &&
      canonicalJson(old.opinion.model) === canonicalJson(value.opinion.model) &&
      canonicalJson(old.annotation.parameters) ===
        canonicalJson(value.annotation.parameters) &&
      canonicalJson(old.annotation.aliases) ===
        canonicalJson(value.annotation.aliases) &&
      old.annotation.registration === value.annotation.registration
    )
      continue;
    if (old !== undefined && canonicalJson(old) !== canonicalJson(value))
      throw new Error(
        `opinion conflict for ${value.opinion.reviewId}; attempts are immutable`,
      );
    order += 1;
    records.set(
      value.opinion.reviewId,
      value.annotation === undefined
        ? value
        : {
            ...value,
            annotation: { ...value.annotation, recordedOrder: order },
          },
    );
  }
  return [...records.values()];
}
export function assertHumanBaseline(
  batch: WorkflowBatch,
  current: readonly WorkflowLabel[],
  desired: readonly WorkflowLabel[],
  replacements: readonly WorkflowLabel[],
): void {
  for (const replacement of replacements) {
    const sorted = (values: readonly WorkflowLabel[]) =>
      values
        .filter((value) =>
          replacement.annotation?.humanState === 'draft'
            ? value.referenceId === replacement.referenceId
            : value.pointId === replacement.pointId &&
              value.viewId === replacement.viewId &&
              ['human', 'human-inherited'].includes(value.source) &&
              value.annotation !== undefined &&
              value.annotation.humanState !== 'draft' &&
              replacement.annotation !== undefined &&
              sameAnnotationView(
                value.annotation.binding,
                replacement.annotation.binding,
              ),
        )
        .sort((a, b) => a.referenceId.localeCompare(b.referenceId));
    const before = sorted(batch.labels);
    const actual = sorted(current);
    const after = sorted(desired);
    if (
      canonicalJson(actual) !== canonicalJson(before) &&
      canonicalJson(actual) !== canonicalJson(after)
    )
      throw new Error(
        `annotation conflict for ${replacement.pointId}; related human decision changed since export`,
      );
  }
}
export async function readJson(path: string): Promise<unknown> {
  if (!(await lstat(path)).isFile())
    throw new Error('JSON input must be a regular file');
  return JSON.parse(await readFile(path, 'utf8'));
}
