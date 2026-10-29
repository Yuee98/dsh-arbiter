/**
 * The `report` command: read a saved run and write its three-layer report.
 *
 * This command is the whole offline path. It reads a run directory through the published
 * artifact interface, joins the dataset when one is named, and writes the JSON, Markdown
 * and HTML documents. It never dispatches, never resolves a credential and never calls a
 * model: `pnpm verify` may run it, and running it twice produces the same bytes.
 *
 * Three choices are the caller's, because they are not properties of the artifact:
 *
 *   --mode      which ask policy layer three is computed under
 *   --channel   whether a person can be reached at all
 *   --dataset   which dataset to join labels from
 *
 * The other two are about writing rather than reading: `--out` names the prefix, and
 * `--force` allows overwriting a report that already exists. Overwriting is refused by
 * default because a report is evidence.
 */

import { join, resolve } from 'node:path';

import {
  buildReport,
  datasetSourceOf,
  defaultSettings,
  parseSettlementMode,
} from '../metrics/index.js';
import { observeRun } from '../metrics/observe.js';
import type { ReportSettings } from '../metrics/types.js';
import { RUN_FILES } from '../run/artifact.js';
import { defaultPrefixOf, writeReport } from './write.js';
import type { EvidencePath } from './write.js';

/** Where the command writes its human-readable output. */
export interface ReportIo {
  readonly root: string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** What `report` was asked for. */
export interface ReportCommand {
  /** The run directory, relative to the repository root. */
  readonly directory: string;
  /** The output prefix without an extension, or null to write inside the run directory. */
  readonly output: string | null;
  /** The dataset to join, or null to read the one the run recorded. */
  readonly dataset: string | null;
  /** The ask policy to compute layer three under. */
  readonly mode: string;
  /** Whether an approval channel is reachable. */
  readonly channel: string;
  readonly force: boolean;
}

/** The usage text for `report`, printed beside the run commands'. */
export const REPORT_USAGE = [
  'report commands (offline; a report is rebuilt from a saved run, never by calling a model):',
  '  report <run-dir> [--out PREFIX] [--dataset DIR] [--mode ask|no-ask]',
  '                   [--channel available|unavailable] [--force]',
  '                                         write PREFIX.json, PREFIX.md and PREFIX.html',
].join('\n');

/** The flags `report` accepts, and no others. */
interface ReportFlags {
  output: string | null;
  dataset: string | null;
  mode: string;
  channel: string;
  force: boolean;
}

/** Read `report`'s flags; an unknown one is refused rather than ignored. */
function readReportFlags(rest: readonly string[]): ReportFlags | string {
  const flags: ReportFlags = {
    output: null,
    dataset: null,
    mode: 'ask',
    channel: 'available',
    force: false,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--force') {
      flags.force = true;
      continue;
    }
    if (
      flag !== '--out' &&
      flag !== '--dataset' &&
      flag !== '--mode' &&
      flag !== '--channel'
    ) {
      return `report does not take ${String(flag)}\n\n${REPORT_USAGE}`;
    }
    const value = rest[index + 1];
    if (value === undefined) return `${flag} needs a value\n\n${REPORT_USAGE}`;
    index += 1;
    if (flag === '--out') flags.output = value;
    else if (flag === '--dataset') flags.dataset = value;
    else if (flag === '--mode') flags.mode = value;
    else flags.channel = value;
  }
  return flags;
}

/**
 * Parse one `report` command line.
 *
 * The run directory is the argument and the prefix is a flag, which is the opposite of
 * `export`'s shape and deliberate: a report always reads exactly one run, while the place
 * its files go is optional and defaults inside that run.
 */
export function parseReportCommand(
  rest: readonly string[],
): ReportCommand | string {
  const [directory, ...flags] = rest;
  if (directory === undefined) {
    return `report needs a run directory\n\n${REPORT_USAGE}`;
  }
  const parsed = readReportFlags(flags);
  if (typeof parsed === 'string') return parsed;
  return {
    directory,
    output: parsed.output,
    dataset: parsed.dataset,
    mode: parsed.mode,
    channel: parsed.channel,
    force: parsed.force,
  };
}

/** Whether an argument names the report command. */
export function isReportCommand(name: string): boolean {
  return name === 'report';
}

/**
 * The evidence this report reads, and may therefore never overwrite.
 *
 * The run directory's own documents are protected by name and its records directory by
 * prefix, because a record is addressed by cell id and a report must not be able to land on
 * one by choosing a clever prefix. The dataset's three document directories are protected
 * the same way. What is deliberately *not* protected is the run directory itself: a report
 * written beside the run's index is the normal, documented destination.
 *
 * A dataset the report did not actually join is not protected, because writing a report into
 * an unrelated directory is ordinary use.
 */
function protectedEvidenceOf(parts: {
  readonly directory: string;
  readonly root: string;
  readonly settings: ReportSettings;
  readonly observation: {
    readonly dataset: { readonly status: string };
  };
}): readonly EvidencePath[] {
  const evidence: EvidencePath[] = [
    { path: join(parts.directory, RUN_FILES.plan), kind: 'file' },
    { path: join(parts.directory, RUN_FILES.index), kind: 'file' },
    { path: join(parts.directory, RUN_FILES.fixture), kind: 'file' },
    { path: join(parts.directory, RUN_FILES.records), kind: 'directory' },
  ];
  const dataset = parts.settings.dataset;
  if (
    parts.observation.dataset.status === 'joined' &&
    dataset.kind === 'path'
  ) {
    const base = dataset.path.startsWith('/')
      ? dataset.path
      : resolve(parts.root, dataset.path);
    for (const name of ['cases', 'labels', 'reviews']) {
      evidence.push({ path: join(base, name), kind: 'directory' });
    }
  }
  return evidence;
}

/** The settings a parsed command implies. */
function settingsOf(
  io: ReportIo,
  command: ReportCommand,
): ReportSettings | string {
  const mode = parseSettlementMode(command.mode);
  if (mode === null) {
    return `--mode takes ask or no-ask, not ${command.mode}`;
  }
  const channel =
    command.channel === 'available' || command.channel === 'unavailable'
      ? command.channel
      : null;
  if (channel === null) {
    return `--channel takes available or unavailable, not ${command.channel}`;
  }
  const base = defaultSettings(io.root);
  return {
    ...base,
    mode,
    channel,
    // A named dataset wins; otherwise the run's own recorded path is read, which is what
    // makes a rebuild reproducible without the caller having to know the path.
    dataset: datasetSourceOf(command.dataset),
  };
}

/**
 * `report`: read one run and write its documents.
 *
 * Every problem is reported before anything is written, so a refused report leaves no
 * partial output behind. The exit code is the command's own: a read failure or a refusal
 * to overwrite exits non-zero, while a report with no gold labels exits zero — the run's
 * evidence is complete without labels, and an empty `labels/` is the state this
 * repository is actually in.
 */
export async function reportRun(
  io: ReportIo,
  command: ReportCommand,
): Promise<number> {
  const settings = settingsOf(io, command);
  if (typeof settings === 'string') {
    io.err(`problem ${settings}`);
    return 2;
  }
  const directory = resolve(io.root, command.directory);
  // The destinations are computed before the read so a prefix that would land inside the
  // evidence is refused without opening anything: `--force` may replace a report, never the
  // run or dataset the report is built from.
  const prefix =
    command.output === null
      ? defaultPrefixOf(directory)
      : resolve(io.root, command.output);
  const read = await observeRun({
    directory,
    root: io.root,
    dataset: settings.dataset,
  });
  if (!read.ok) {
    for (const problem of read.problems) io.err(`problem ${problem}`);
    return 1;
  }
  const report = buildReport({ observation: read.observation, settings });
  const written = await writeReport({
    prefix,
    report,
    force: command.force,
    protectedEvidence: protectedEvidenceOf({
      directory,
      root: io.root,
      settings,
      observation: read.observation,
    }),
  });
  if (!written.ok) {
    for (const problem of written.problems) io.err(`problem ${problem}`);
    return 1;
  }
  io.out(`run ${report.run.runId} (${report.run.status})`);
  io.out(
    `cells ${String(report.coverage.cellsPlanned)} planned, ${String(report.coverage.records)} recorded, ${String(report.coverage.missing.length)} missing`,
  );
  io.out(
    `behaviour ${String(report.behaviour.overall.compared)} compared of ${String(report.behaviour.overall.cells)}; matched ${String(report.behaviour.overall.matched)}`,
  );
  io.out(
    `labels gold ${String(report.diagnostics.labels.gold)}, excluded ${String(report.diagnostics.labels.excluded)}, missing ${String(report.diagnostics.labels.missing)}`,
  );
  const settlement = report.settlement.overall;
  io.out(
    `settlement (${report.settlement.projection ? 'projected' : 'observed'}, ${report.settlement.mode}/${report.settlement.channel}): allow ${String(settlement.allow)}, deny ${String(settlement.deny)}, ask ${String(settlement.askHuman)}, fallback-deny ${String(settlement.fallbackDeny)}`,
  );
  io.out(
    `usage ${report.usage.mappingVersion}: ${String(report.usage.attempts.length)} attempts, ${String(report.usage.run?.withUsage ?? 0)} with usage`,
  );
  for (const check of report.checks) {
    if (!check.ok) io.err(`check ${check.name}: ${check.detail}`);
  }
  io.out(`wrote ${prefix}.json`);
  io.out(`wrote ${prefix}.md`);
  io.out(`wrote ${prefix}.html`);
  return report.checks.every((check) => check.ok) ? 0 : 1;
}
