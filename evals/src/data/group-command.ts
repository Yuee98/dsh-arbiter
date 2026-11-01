import { runLegacyCommand } from '../annotation/legacy-command.js';
/** A narrow registration for grouped check; legacy commands keep their existing parser. */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { REVIEW_CONTRACT_VERSION } from '../../../src/review-contract/index.js';
import { checkSnapshot } from './rubric.js';
import { compileCheckers } from './schemas.js';
import { hasGroupedLayout, readGroupedDataset } from './group-read.js';
import type { GroupSelection } from './group-types.js';

interface CommandIo {
  readonly root: string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}
type LegacyRunner = (argv: readonly string[], io: CommandIo) => Promise<number>;

const USAGE =
  '  check <dataset> --format grouped-v1 [--split dev|calibration|holdout|all] [--group <slug>] [--content-set legacy-v1|workflows-v1]';

function selectionOf(argv: readonly string[]): GroupSelection | string {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      flag === undefined ||
      !['--format', '--split', '--group', '--content-set'].includes(flag)
    )
      return `unknown grouped check option ${flag ?? ''}`;
    if (value === undefined || value.startsWith('--'))
      return `${flag} needs a value`;
    if (values.has(flag)) return `duplicate option ${flag}`;
    values.set(flag, value);
  }
  if (values.get('--format') !== 'grouped-v1')
    return 'supported collection format is grouped-v1';
  const split = values.get('--split') ?? 'dev';
  if (
    split !== 'dev' &&
    split !== 'calibration' &&
    split !== 'holdout' &&
    split !== 'all'
  )
    return 'split must be dev, calibration, holdout or all';
  const contentSet = values.get('--content-set');
  if (
    contentSet !== undefined &&
    contentSet !== 'legacy-v1' &&
    contentSet !== 'workflows-v1'
  )
    return 'content-set must be legacy-v1 or workflows-v1';
  const group = values.get('--group');
  return {
    split,
    references: true,
    ...(group === undefined ? {} : { group }),
    ...(contentSet === undefined ? {} : { contentSet }),
  };
}

async function checkGrouped(
  io: CommandIo,
  dataset: string,
  selection: GroupSelection,
): Promise<number> {
  const checked = await readGroupedDataset(
    resolve(io.root, dataset),
    selection,
  );
  const scope = `${checked.scope.splits.join(',')}/${checked.scope.group ?? '*'} (${checked.scope.contentSet ?? 'all content sets'})`;
  io.out(
    `grouped ${dataset}: scope ${scope}; isolation checked only within selected scope`,
  );
  for (const problem of checked.problems)
    io.err(`problem ${problem.path}: ${problem.message}`);
  for (const finding of checked.findings)
    io.err(`note ${finding.path}: ${finding.message}`);
  const roots = checked.groups.reduce(
    (count, group) => count + group.workflows.length + group.cases.length,
    0,
  );
  const points = checked.groups.reduce(
    (count, group) =>
      count +
      group.cases.length +
      group.workflows.reduce(
        (sum, entry) => sum + entry.document.points.length,
        0,
      ),
    0,
  );
  io.out(
    `${String(checked.groups.length)} groups, ${String(roots)} roots, ${String(points)} points; source validation, not rendered-view/reference qualification`,
  );
  return checked.problems.length === 0 ? 0 : 1;
}

/** Never lose the unconditional schema/rubric check on a grouped-only repository. */
async function checkRubric(io: CommandIo): Promise<number> {
  const checkers = await compileCheckers();
  const checked = checkers.rubric(
    JSON.parse(
      await readFile(join(io.root, 'evals/rubrics/rubric-v1.json'), 'utf8'),
    ),
  );
  if (!checked.ok) {
    for (const problem of checked.problems)
      io.err(`problem rubric: ${problem}`);
    return 1;
  }
  if (checked.document.contractVersion !== REVIEW_CONTRACT_VERSION) {
    io.err(
      `problem rubric: contract ${checked.document.contractVersion} differs from ${REVIEW_CONTRACT_VERSION}`,
    );
    return 1;
  }
  const result = checkSnapshot(
    checked.document,
    await readFile(
      join(io.root, 'docs/milestones/review-quality-rubrics.md'),
      'utf8',
    ),
  );
  for (const problem of result.problems) io.err(`problem rubric: ${problem}`);
  for (const finding of result.findings) io.err(`note rubric: ${finding}`);
  return result.problems.length === 0 ? 0 : 1;
}

async function checkAll(io: CommandIo, legacy: LegacyRunner): Promise<number> {
  let failures = await checkRubric(io);
  const parent = join(io.root, 'evals/datasets');
  let names: readonly string[];
  try {
    names = (await readdir(parent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      names = [];
    else throw error;
  }
  if (names.length === 0) {
    io.err('problem evals/datasets: no dataset is published here');
    failures += 1;
  }
  for (const name of names) {
    const relative = `evals/datasets/${name}`;
    const grouped = await hasGroupedLayout(join(parent, name));
    // A damaged legacy dataset is still checked; absence of manifest is not a
    // license to silently skip it. Mixed format-example checks both layouts.
    const top = await readdir(join(parent, name));
    const legacyLayout = top.some((entry) =>
      ['cases', 'labels', 'reviews', 'manifest.json'].includes(entry),
    );
    if (!grouped || legacyLayout)
      failures += await legacy(['check', relative], io);
    if (grouped)
      failures += await checkGrouped(io, relative, {
        split: 'all',
        references: true,
      });
  }
  failures += await legacy(['experiments', 'check-all'], io);
  return failures === 0 ? 0 : 1;
}

/** null means this registration did not claim the command. */
export async function runGroupedCli(
  argv: readonly string[],
  io: CommandIo,
  legacy: LegacyRunner,
): Promise<number | null> {
  try {
    const legacyResult = await runLegacyCommand(argv, io);
    if (legacyResult !== null) return legacyResult;
    if (argv.length === 1 && argv[0] === 'check-all')
      return await checkAll(io, legacy);
    if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
      io.out(`grouped source checks:\n${USAGE}`);
      io.out(
        'legacy migration: migrate-legacy <destination> [--check]\nlegacy annotation: export <dataset> --split dev|calibration|holdout --out <file>\n                   import <dataset> --split dev|calibration|holdout --fill <file> [--write]',
      );
      return null;
    }
    if (argv[0] !== 'check' || !argv.includes('--format')) return null;
    const dataset = argv[1];
    if (dataset === undefined || dataset.startsWith('--')) {
      io.err(`check needs a dataset\n${USAGE}`);
      return 2;
    }
    const selection = selectionOf(argv.slice(2));
    if (typeof selection === 'string') {
      io.err(`${selection}\n${USAGE}`);
      return 2;
    }
    return await checkGrouped(io, dataset, selection);
  } catch (error) {
    io.err(
      `problem grouped check: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
