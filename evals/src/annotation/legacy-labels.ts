/** A group's raw label baseline and atomic optimistic merge; no human decision is invented. */
import { lstat, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../data/hash.js';
import { compileCheckers } from '../data/schemas.js';
import type { ReviewLabel, Split } from '../data/types.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export interface LabelBaseline {
  readonly caseId: string;
  readonly label: unknown;
}
export async function labelRecords(
  path: string,
): Promise<readonly LabelBaseline[]> {
  try {
    if (!(await lstat(path)).isFile())
      throw new Error('labels must be a regular file, not a symlink');
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (
      !record(value) ||
      value['schemaVersion'] !== 'grouped-v1' ||
      !Array.isArray(value['records']) ||
      Object.keys(value).some(
        (key) => !['schemaVersion', 'records'].includes(key),
      )
    )
      throw new Error('labels need a grouped-v1 collection');
    const seen = new Set<string>();
    const rows: LabelBaseline[] = [];
    for (const item of value['records'] as readonly unknown[]) {
      if (
        !record(item) ||
        typeof item['caseId'] !== 'string' ||
        seen.has(item['caseId'])
      )
        throw new Error('labels need unique caseIds');
      seen.add(item['caseId']);
      rows.push({ caseId: item['caseId'], label: item });
    }
    return rows;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return [];
    throw error;
  }
}
export async function assertLegacyDirectories(
  dataset: string,
  split: Split,
): Promise<string> {
  let path = dataset;
  for (const segment of ['', split, 'legacy-v1']) {
    if (segment !== '') path = join(path, segment);
    if (!(await lstat(path)).isDirectory())
      throw new Error(
        `legacy source directory is missing or symlinked: ${path}`,
      );
  }
  return path;
}
export async function mergeLegacyLabels(
  dataset: string,
  split: Split,
  baseline: readonly LabelBaseline[],
  labels: readonly ReviewLabel[],
  validateInputs: () => Promise<void>,
): Promise<void> {
  const directory = await assertLegacyDirectories(dataset, split);
  const path = join(directory, 'labels.json');
  const lockPath = join(directory, '.labels.lock');
  const lock = await open(lockPath, 'wx');
  const temporary = join(directory, `.labels-${randomUUID()}.tmp`);
  try {
    await validateInputs();
    const current = await labelRecords(path);
    const now = new Map(current.map((e) => [e.caseId, e.label]));
    const before = new Map(baseline.map((e) => [e.caseId, e.label]));
    for (const label of labels) {
      if (!before.has(label.caseId))
        throw new Error(
          `case ${label.caseId} is outside this annotation batch`,
        );
      const actual = now.get(label.caseId) ?? null;
      if (
        canonicalJson(actual) !== canonicalJson(before.get(label.caseId)) &&
        canonicalJson(actual) !== canonicalJson(label)
      )
        throw new Error(
          `annotation conflict for ${label.caseId}; current label changed since export`,
        );
      now.set(label.caseId, label);
    }
    const collection = {
      schemaVersion: 'grouped-v1',
      records: [...now.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, value]) => value),
    };
    const checked = (await compileCheckers()).groupedLabels(collection);
    if (!checked.ok) throw new Error(checked.problems.join('; '));
    if (labels.length === 0) return;
    await writeFile(temporary, JSON.stringify(collection, null, 2) + '\n', {
      flag: 'wx',
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
