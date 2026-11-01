/** Adapt legacy collections for existing case consumers without changing historical reads. */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { readGroupFiles } from './group-files.js';
import { legacyMetadata } from './legacy-metadata.js';
import type { RawDataset } from './read.js';
import type { Split } from './types.js';
export interface DatasetSelection {
  readonly split?: Split | 'all';
  readonly caseIds?: readonly string[];
}
export async function isLegacyCollection(dataset: string): Promise<boolean> {
  for (const split of ['dev', 'calibration', 'holdout']) {
    try {
      if ((await lstat(join(dataset, split, 'legacy-v1'))).isDirectory())
        return true;
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    }
  }
  return false;
}
export async function readLegacyDataset(
  dataset: string,
  selection: DatasetSelection = {},
): Promise<RawDataset> {
  const meta = await legacyMetadata();
  const familySplit = new Map(meta.families.map((f) => [f.familyId, f.split]));
  const idSplit = new Map(
    meta.cases.map((c) => [c.caseId, familySplit.get(c.familyId)]),
  );
  const explicit =
    selection.caseIds !== undefined && selection.caseIds.length > 0
      ? selection.caseIds
      : null;
  const problems: { path: string; message: string }[] = [];
  const splits: Split[] =
    explicit === null
      ? selection.split === undefined || selection.split === 'all'
        ? ['dev', 'calibration', 'holdout']
        : [selection.split]
      : [];
  if (explicit !== null)
    for (const id of explicit) {
      const split = idSplit.get(id);
      if (split === undefined)
        problems.push({ path: '#', message: `unknown legacy caseId ${id}` });
      else if (!splits.includes(split)) splits.push(split);
    }
  const groups = [];
  for (const split of splits) {
    const raw = await readGroupFiles(dataset, {
      split,
      contentSet: 'legacy-v1',
      references: true,
    });
    groups.push(...raw.groups);
    problems.push(...raw.problems);
  }
  const selectedIds =
    explicit === null
      ? new Set(
          meta.cases
            .filter((c) =>
              splits.includes(familySplit.get(c.familyId) ?? 'dev'),
            )
            .map((c) => c.caseId),
        )
      : new Set(explicit);
  const cases = groups
    .flatMap((g) => g.cases)
    .filter((e) => explicit === null || selectedIds.has(e.document.caseId));
  for (const group of groups)
    for (const entry of [...group.labels, ...group.opinions])
      if (!('caseId' in entry.document))
        problems.push({
          path: entry.path,
          message: 'legacy references require caseId records',
        });
  const labels = groups
    .flatMap((g) => g.labels)
    .filter(
      (e) =>
        'caseId' in e.document &&
        (explicit === null || selectedIds.has(e.document.caseId)),
    );
  const reviews = groups
    .flatMap((g) => g.opinions)
    .filter(
      (e) =>
        'caseId' in e.document &&
        (explicit === null || selectedIds.has(e.document.caseId)),
    );
  return {
    layout: 'collection',
    manifest: {
      path: '#',
      document: {
        ...meta,
        datasetId: 'legacy-v1',
        description:
          'Historical legacy regression; holdout retains its historical split and is not new independent holdout.',
        families: meta.families.filter((f) =>
          meta.cases.some(
            (c) => c.familyId === f.familyId && selectedIds.has(c.caseId),
          ),
        ),
        cases: meta.cases.filter((c) => selectedIds.has(c.caseId)),
      },
    },
    cases,
    labels,
    reviews,
    problems,
  };
}
