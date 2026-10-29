/**
 * The evals command line's commands.
 *
 * Five commands, all offline:
 *
 *   check-all  validate every dataset in the repository, plus the rubric snapshot
 *   check    validate one dataset and report problems, without writing anything
 *   summary  print what the committed labels and opinions add up to
 *   export   write a blank annotation document for a person to fill in
 *   import   turn a filled document back into committed label files
 *
 * `check` is the one CI runs. The other three serve the annotation window: a person
 * exports a pack, decides the cases, and imports the result. Exporting never carries
 * a decision and importing never invents one, so neither command can move an answer
 * between the two sides.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  auditPack,
  buildAnnotationPack,
  entryHashes,
} from '../annotation/export.js';
import { importFill } from '../annotation/import.js';
import { datasetDigest, summarizeDataset } from '../annotation/summary.js';
import type { DatasetSummary } from '../annotation/summary.js';
import { inspectDataset } from '../data/inspect.js';
import type { DatasetInspection, Finding } from '../data/inspect.js';
import { readDataset } from '../data/read.js';
import { checkSnapshot } from '../data/rubric.js';
import type { RubricCheck } from '../data/rubric.js';
import { compileCheckers } from '../data/schemas.js';
import type { AnnotationDocument, RubricSnapshot } from '../data/types.js';

/** Where a command writes. Supplied so tests never capture real streams. */
export interface CliIo {
  readonly root: string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** A parsed command line: one command, and its dataset and flags when it has them. */
export interface Command {
  readonly name: 'check-all' | 'check' | 'summary' | 'export' | 'import';
  readonly dataset: string | null;
  readonly out: string | null;
  readonly fill: string | null;
  readonly date: string | null;
  readonly write: boolean;
}

const USAGE = [
  'usage: evals <command> [dataset] [options]',
  '',
  'commands:',
  '  check-all                              validate every dataset in the repository',
  '  check <dataset>                        validate cases, labels, reviews, manifest',
  '  summary <dataset>                      gold counts, exclusions, disagreements',
  '  export <dataset> --out <file> [--date YYYY-MM-DD]',
  '                                         write a blank annotation document',
  '  import <dataset> --fill <file> [--write]',
  '                                         check a filled document; --write stores labels',
].join('\n');

interface Flags {
  readonly out: string | null;
  readonly fill: string | null;
  readonly date: string | null;
  readonly write: boolean;
}

/** Read the flags one command accepts; an unknown flag is refused, never ignored. */
function readFlags(rest: readonly string[]): Flags | string {
  const flags = { out: null, fill: null, date: null, write: false } as {
    out: string | null;
    fill: string | null;
    date: string | null;
    write: boolean;
  };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--write') {
      flags.write = true;
    } else if (flag === '--out' || flag === '--fill' || flag === '--date') {
      const value = rest[index + 1];
      if (value === undefined) return `${flag} needs a value`;
      index += 1;
      if (flag === '--out') flags.out = value;
      else if (flag === '--fill') flags.fill = value;
      else flags.date = value;
    } else {
      return `unknown option ${String(flag)}\n\n${USAGE}`;
    }
  }
  return flags;
}

/** Split one argument list into a command, a dataset and its flags. */
export function parseCommand(argv: readonly string[]): Command | string {
  const [name, dataset, ...rest] = argv;
  if (name === undefined) return USAGE;
  if (name === '--help' || name === 'help' || name === '-h') return USAGE;
  if (name === 'check-all') {
    if (dataset !== undefined) return `check-all takes no dataset\n\n${USAGE}`;
    return {
      name,
      dataset: null,
      out: null,
      fill: null,
      date: null,
      write: false,
    };
  }
  if (
    name !== 'check' &&
    name !== 'summary' &&
    name !== 'export' &&
    name !== 'import'
  ) {
    return `unknown command ${name}\n\n${USAGE}`;
  }
  if (dataset === undefined) {
    return `command ${name} needs a dataset directory\n\n${USAGE}`;
  }
  const flags = readFlags(rest);
  if (typeof flags === 'string') return flags;
  if (name === 'export' && flags.out === null)
    return 'export needs --out <file>';
  if (name === 'import' && flags.fill === null)
    return 'import needs --fill <file>';
  return { name, dataset, ...flags };
}

/** Format one problem as a line a terminal can follow. */
function line(problem: Finding): string {
  return `${problem.path}: ${problem.message}`;
}

/** One loaded dataset and the snapshot it is labelled against. */
interface Loaded {
  readonly inspection: DatasetInspection;
  readonly rubric: RubricCheck;
  readonly snapshot: RubricSnapshot;
}

/** Read the committed rubric snapshot and check it against the live contract. */
async function loadRubric(
  root: string,
): Promise<{ rubric: RubricCheck; snapshot: RubricSnapshot }> {
  const checkers = await compileCheckers();
  const parsed: unknown = JSON.parse(
    await readFile(join(root, 'evals/rubrics/rubric-v1.json'), 'utf8'),
  );
  const checked = checkers.rubric(parsed);
  if (!checked.ok) {
    throw new TypeError(
      `evals/rubrics/rubric-v1.json does not match its schema: ${checked.problems.join('; ')}`,
    );
  }
  const document = await readFile(
    join(root, 'docs/milestones/review-quality-rubrics.md'),
    'utf8',
  );
  return {
    rubric: checkSnapshot(checked.document, document),
    snapshot: checked.document,
  };
}

/**
 * The dataset directories the repository publishes.
 *
 * `evals/datasets/<name>` is the only layout this tool reads, so a stray directory
 * under `evals/` cannot be mistaken for a dataset and an empty `evals/datasets/`
 * is reported as having nothing to check rather than as passing.
 */
const DATASETS_DIRECTORY = 'evals/datasets';

/** List the dataset directories one repository root publishes, sorted. */
async function datasetDirectories(root: string): Promise<readonly string[]> {
  const parent = join(root, DATASETS_DIRECTORY);
  let entries: readonly { readonly name: string; isDirectory(): boolean }[];
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(DATASETS_DIRECTORY, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

/** `check-all`: validate every published dataset and the rubric snapshot. */
async function checkAll(io: CliIo): Promise<number> {
  const { rubric } = await loadRubric(io.root);
  for (const finding of rubric.findings) io.err(`note ${finding}`);
  for (const problem of rubric.problems) io.err(`problem ${problem}`);
  const directories = await datasetDirectories(io.root);
  if (directories.length === 0) {
    // Nothing to check is not the same as everything agreeing, so this fails: a
    // green run has to mean some case, label and review were actually compared.
    io.err(`problem ${DATASETS_DIRECTORY}: no dataset is published here`);
    return 1;
  }
  let failedRuns = 0;
  for (const directory of directories) {
    const loaded = await load(io.root, directory);
    if (failed(loaded)) {
      failedRuns += 1;
      report(loaded, io);
      continue;
    }
    const { inspection } = loaded;
    io.out(
      `${directory}: ${String(inspection.cases.length)} cases, ${String(inspection.labels.gold.length)} gold labels, ${String(inspection.labels.excluded.length)} excluded`,
    );
  }
  return failedRuns === 0 && rubric.problems.length === 0 ? 0 : 1;
}

/** Load one dataset under one repository root. */
async function load(root: string, dataset: string): Promise<Loaded> {
  const { rubric, snapshot } = await loadRubric(root);
  const checkers = await compileCheckers();
  const raw = await readDataset(resolve(root, dataset));
  return { inspection: inspectDataset(raw, checkers), rubric, snapshot };
}

/** Whether a load found anything that must stop it. */
function failed(loaded: Loaded): boolean {
  return (
    loaded.inspection.problems.length > 0 || loaded.rubric.problems.length > 0
  );
}

/** Report every problem and finding, and say which is which. */
function report(loaded: Loaded, io: CliIo): void {
  for (const finding of loaded.inspection.findings)
    io.err(`note ${line(finding)}`);
  for (const finding of loaded.rubric.findings) io.err(`note ${finding}`);
  for (const finding of loaded.inspection.problems) {
    io.err(`problem ${line(finding)}`);
  }
  for (const problem of loaded.rubric.problems) io.err(`problem ${problem}`);
}

/** `check`: report, and stop when the dataset is not usable as published data. */
async function check(io: CliIo, command: Command): Promise<number> {
  const loaded = await load(io.root, command.dataset ?? '');
  report(loaded, io);
  if (failed(loaded)) return 1;
  const { inspection } = loaded;
  io.out(
    `dataset ${inspection.manifest?.datasetId ?? ''}: ${String(inspection.cases.length)} cases, ${String(inspection.labels.gold.length)} gold labels, ${String(inspection.labels.excluded.length)} excluded`,
  );
  return 0;
}

/** Print one summary, one line per fact. */
function printSummary(summary: DatasetSummary, io: CliIo): void {
  io.out(`dataset ${summary.datasetId ?? '(no manifest)'}`);
  io.out(
    `cases ${String(summary.totals.cases)} in ${String(summary.totals.families)} families, ${String(summary.totals.labels)} labels, ${String(summary.totals.reviews)} reviews`,
  );
  io.out(`gold ${String(summary.gold)}, excluded ${String(summary.excluded)}`);
  for (const [reason, count] of Object.entries(summary.exclusions)) {
    if (count > 0) io.out(`  excluded ${reason}: ${String(count)}`);
  }
  io.out(
    `pending ${String(summary.pending)}, disputed ${String(summary.disputed)}`,
  );
  for (const entry of summary.agreement) {
    io.out(
      `agreement ${entry.provider}/${entry.id}: ${String(entry.agreed)}/${String(entry.compared)}`,
    );
  }
  for (const entry of summary.disagreements) {
    io.out(
      `disagreement ${entry.caseId} ${entry.reviewId}: ${entry.observed} at ${String(entry.risk)}/${String(entry.authorization)}, reference ${entry.reference}`,
    );
  }
}

/** `summary`: print counts; a stale label is reported, not fatal. */
async function summary(io: CliIo, command: Command): Promise<number> {
  const loaded = await load(io.root, command.dataset ?? '');
  if (failed(loaded)) {
    report(loaded, io);
    return 1;
  }
  printSummary(summarizeDataset(loaded.inspection), io);
  io.out(`digest ${datasetDigest(loaded.inspection)}`);
  return 0;
}

/** `export`: write a blank pack, refusing if it would carry anything but blanks. */
async function exportPack(io: CliIo, command: Command): Promise<number> {
  const loaded = await load(io.root, command.dataset ?? '');
  const manifest = loaded.inspection.manifest;
  if (failed(loaded) || manifest === null) {
    report(loaded, io);
    return 1;
  }
  const document = buildAnnotationPack({
    manifest,
    cases: loaded.inspection.cases,
    rubric: loaded.snapshot,
    exportedAt: command.date ?? new Date().toISOString().slice(0, 10),
  });
  const problems = auditPack(document);
  if (problems.length > 0) {
    for (const problem of problems)
      io.err(`problem ${problem.caseId}: ${problem.message}`);
    return 1;
  }
  const path = resolve(io.root, command.out ?? '');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  io.out(`wrote ${String(document.entries.length)} blank entries to ${path}`);
  for (const entry of entryHashes(document)) {
    io.out(`  ${entry.caseId} ${entry.inputHash}`);
  }
  return 0;
}

/** Read one filled document, checking its schema first. */
async function readFill(
  path: string,
): Promise<
  | { readonly ok: true; readonly document: AnnotationDocument }
  | { readonly ok: false; readonly problems: readonly string[] }
> {
  const checkers = await compileCheckers();
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  return checkers.annotation(parsed);
}

/** `import`: check a filled document and optionally write its labels. */
async function importPack(io: CliIo, command: Command): Promise<number> {
  const loaded = await load(io.root, command.dataset ?? '');
  const manifest = loaded.inspection.manifest;
  if (manifest === null) {
    report(loaded, io);
    return 1;
  }
  const path = resolve(io.root, command.fill ?? '');
  const fill = await readFill(path);
  if (!fill.ok) {
    for (const problem of fill.problems) io.err(`problem ${path}: ${problem}`);
    return 1;
  }
  const result = importFill({
    pack: fill.document,
    manifest,
    rubric: loaded.snapshot,
    cases: loaded.inspection.cases,
  });
  for (const problem of result.problems) {
    io.err(`problem ${problem.caseId ?? '-'}: ${problem.message}`);
  }
  if (result.problems.length > 0) return 1;
  for (const caseId of result.pending) io.out(`pending ${caseId}`);
  if (command.write) {
    await writeLabels(io.root, command.dataset ?? '', result.labels);
    io.out(`wrote ${String(result.labels.length)} labels`);
  } else {
    io.out(
      `${String(result.labels.length)} labels are ready; re-run with --write to store them`,
    );
  }
  return 0;
}

/** Write one label file per decision, named after the case it judges. */
async function writeLabels(
  root: string,
  dataset: string,
  labels: readonly { readonly caseId: string }[],
): Promise<void> {
  const directory = resolve(root, dataset, 'labels');
  await mkdir(directory, { recursive: true });
  for (const label of labels) {
    await writeFile(
      join(directory, `${label.caseId}.json`),
      `${JSON.stringify(label, null, 2)}\n`,
      'utf8',
    );
  }
}

/** Run one command line and return the process exit code. */
export async function runCli(
  argv: readonly string[],
  io: CliIo,
): Promise<number> {
  const command = parseCommand(argv);
  if (typeof command === 'string') {
    io.err(command);
    return 2;
  }
  switch (command.name) {
    case 'check-all':
      return checkAll(io);
    case 'check':
      return check(io, command);
    case 'summary':
      return summary(io, command);
    case 'export':
      return exportPack(io, command);
    case 'import':
      return importPack(io, command);
  }
}
