/** Read only selected split/group directories. Optional authoring is never opened. */
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Finding } from './inspect.js';
import type {
  DataGroup,
  GroupedDataset,
  GroupSelection,
  RecordCollection,
} from './group-types.js';
import type { Checker } from './schemas.js';
import { compileCheckers } from './schemas.js';
import type { Sourced } from './read.js';
import type { Split } from './types.js';

const SPLITS: readonly Split[] = ['dev', 'calibration', 'holdout'];
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Directory discovery does not follow symlinks into an unselected split. */
async function directories(parent: string): Promise<readonly string[]> {
  try {
    return (await readdir(parent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

/** Used by CLI discovery, without probing or parsing another scope's JSON. */
export async function hasGroupedLayout(dataset: string): Promise<boolean> {
  for (const split of SPLITS)
    if (await isDirectory(join(dataset, split))) return true;
  return false;
}

async function collection<T>(
  dataset: string,
  path: string,
  checker: Checker<RecordCollection<T>>,
  required: boolean,
  problems: Finding[],
): Promise<readonly Sourced<T>[]> {
  try {
    const stat = await lstat(join(dataset, path));
    if (!stat.isFile())
      throw new Error(
        'collection must be a regular file (symlinks are not followed)',
      );
    const value: unknown = JSON.parse(
      await readFile(join(dataset, path), 'utf8'),
    );
    const checked = checker(value);
    if (!checked.ok) {
      for (const message of checked.problems)
        problems.push({ path: `${path}#`, message });
      return [];
    }
    return checked.document.records.map((document, index) => ({
      path: `${path}#/records/${String(index)}`,
      document,
    }));
  } catch (error) {
    if (!required && missing(error)) return [];
    problems.push({
      path: `${path}#`,
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Source-only by default. This returns validated source containers, not prompts;
 * use selectPointMaterial for an allowlisted prefix. References are opt-in.
 * Cross-split isolation is guaranteed only over the explicitly selected scope.
 */
export async function readGroupFiles(
  dataset: string,
  selection: GroupSelection = {},
): Promise<GroupedDataset> {
  const problems: Finding[] = [];
  const groups: DataGroup[] = [];
  const splits =
    selection.split === 'all' ? SPLITS : [selection.split ?? 'dev'];
  const scope = {
    splits,
    group: selection.group ?? null,
    contentSet: selection.contentSet ?? null,
  };
  if (
    (selection.group !== undefined &&
      (!SLUG.test(selection.group) ||
        selection.group === '.' ||
        selection.group === '..')) ||
    splits.some((split) => !SPLITS.includes(split)) ||
    (selection.contentSet !== undefined &&
      !['legacy-v1', 'workflows-v1'].includes(selection.contentSet))
  ) {
    return {
      groups,
      problems: [
        { path: '#', message: 'invalid split/group/content-set selection' },
      ],
      findings: [],
      scope,
    };
  }
  const checkers = await compileCheckers();
  for (const split of splits) {
    const parent = join(dataset, split);
    if (!(await isDirectory(parent))) {
      let exists = false;
      try {
        await lstat(parent);
        exists = true;
      } catch (error) {
        if (!missing(error)) throw error;
      }
      if (selection.split !== 'all' || exists)
        problems.push({
          path: split,
          message:
            'selected split directory does not exist or is not a regular directory',
        });
      continue;
    }
    const names =
      selection.group === undefined
        ? await directories(parent)
        : [selection.group];
    for (const group of names) {
      const contentSet = group === 'legacy-v1' ? 'legacy-v1' : 'workflows-v1';
      if (
        selection.contentSet !== undefined &&
        selection.contentSet !== contentSet
      )
        continue;
      const relative = `${split}/${group}`;
      if (!SLUG.test(group) || !(await isDirectory(join(parent, group)))) {
        problems.push({
          path: relative,
          message: 'selected group directory does not exist or is invalid',
        });
        continue;
      }
      const legacy = contentSet === 'legacy-v1';
      const files = await readdir(join(parent, group));
      const allowed = new Set([
        legacy ? 'cases.json' : 'workflows.json',
        'labels.json',
        'opinions.json',
        'authoring.json',
      ]);
      for (const file of files) {
        if (file.endsWith('.json') && !allowed.has(file))
          problems.push({
            path: `${relative}/${file}#`,
            message:
              'unsupported collection role: workflows.json belongs to workflow groups; cases.json belongs only to legacy-v1 (sources cannot be mixed)',
          });
      }
      const workflows = legacy
        ? []
        : await collection(
            dataset,
            `${relative}/workflows.json`,
            checkers.workflows,
            true,
            problems,
          );
      const cases = legacy
        ? await collection(
            dataset,
            `${relative}/cases.json`,
            checkers.groupedCases,
            true,
            problems,
          )
        : [];
      const labels =
        selection.references === true
          ? await collection(
              dataset,
              `${relative}/labels.json`,
              checkers.groupedLabels,
              false,
              problems,
            )
          : [];
      const opinions =
        selection.references === true
          ? await collection(
              dataset,
              `${relative}/opinions.json`,
              checkers.groupedOpinions,
              false,
              problems,
            )
          : [];
      groups.push({
        split,
        group,
        contentSet,
        workflows,
        cases,
        labels,
        opinions,
      });
    }
  }
  if (groups.length === 0)
    problems.push({
      path: '#',
      message: 'no source group matches the selected scope',
    });
  return { groups, problems, findings: [], scope };
}
