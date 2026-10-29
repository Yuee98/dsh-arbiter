/**
 * The `replay` command: re-derive one run's outcomes from its saved answers.
 *
 * This is the offline capability the issue names, expressed as one command with no
 * dispatch path at all. It reads a run directory, replays one or more variants into
 * separate derived directories, and prints what moved. It imports no executor, no
 * scheduler, no transport and no credential resolver — the only production code it
 * reaches is the shared contract and the adapters' parsers, which are the code the
 * thing being measured would have used.
 *
 * Three choices are the caller's:
 *
 *   --variants   a variants document, when the caller wants several derivations in
 *                one invocation
 *   flags        one variant stated inline: `--threshold-risk`, `--threshold-auth`,
 *                `--answer`, `--mode`, `--channel`
 *   --out        the parent directory the derived runs are written under
 *
 * The two ways of stating a variant are exclusive. Accepting both would leave the
 * command deciding which of two descriptions it was actually asked for, and the
 * description is the only record of intent a derived directory carries.
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { REVIEW_CONTRACT_VERSION } from '../../../src/review-contract/index.js';
import { REVIEW_PROMPT_VERSION } from '../../../src/reviewer/contract.js';

import { defaultSettings } from '../metrics/index.js';
import type { ReportSettings } from '../metrics/types.js';

import { deriveRun } from './assemble.js';
import { compareInputs } from './inputs.js';
import type { InputComparison } from './inputs.js';
import { readSource } from './source.js';
import type { SourceRead } from './source.js';
import { parseVariants, statesAnyAxis, variantFromFlags } from './variants.js';
import type { FlagsVariant } from './variants.js';
import { variantDirectoryOf, writeDerivation } from './write.js';
import type { InputStanding, ReplayVariant } from './types.js';

/** Where the command writes its human-readable output. */
export interface ReplayIo {
  readonly root: string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** What `replay` was asked for. */
export interface ReplayCommand {
  /** The run directory to replay, as the caller named it. */
  readonly directory: string;
  /** The variants document, or null when the variant is stated on the command line. */
  readonly variants: string | null;
  /** The parent directory the derived runs are written under. */
  readonly output: string | null;
  readonly flags: FlagsVariant;
  readonly force: boolean;
}

/** The usage text for `replay`, printed beside the report command's. */
export const REPLAY_USAGE = [
  'replay commands (offline; a replay re-reads saved responses and never calls a model):',
  '  replay <run-dir> --variants FILE [--out DIR] [--force]',
  '  replay <run-dir> [--answer response-text|recorded-parse]',
  '                   [--threshold-risk strict|at-least]',
  '                   [--threshold-auth strict|at-least]',
  '                   [--mode ask|no-ask] [--channel available|unavailable]',
  '                   [--out DIR] [--force]',
  '                                         write one derived run per variant under DIR',
].join('\n');

/** The flags `replay` accepts, and no others. */
interface ReplayFlags {
  variants: string | null;
  output: string | null;
  force: boolean;
  inline: FlagsVariant;
}

/** The value-taking flags, and which member each fills. */
const VALUE_FLAGS = [
  '--variants',
  '--out',
  '--answer',
  '--threshold-risk',
  '--threshold-auth',
  '--mode',
  '--channel',
] as const;

type ValueFlag = (typeof VALUE_FLAGS)[number];

/** Whether a spelling names a value-taking flag. */
function isValueFlag(value: string): value is ValueFlag {
  return VALUE_FLAGS.some((flag) => flag === value);
}

/** An empty set of inline axes. */
function emptyInline(): Mutable<FlagsVariant> {
  return {
    answer: null,
    thresholdRisk: null,
    thresholdAuthorization: null,
    mode: null,
    channel: null,
  };
}

/** A mutable form of the caller's inline axes, while they are being read. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Read `replay`'s flags; an unknown one is refused rather than ignored. */
function readReplayFlags(rest: readonly string[]): ReplayFlags | string {
  const inline = emptyInline();
  const flags: ReplayFlags = {
    variants: null,
    output: null,
    force: false,
    inline,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === undefined) break;
    if (flag === '--force') {
      flags.force = true;
      continue;
    }
    if (!isValueFlag(flag)) {
      return `replay does not take ${flag}\n\n${REPLAY_USAGE}`;
    }
    const value = rest[index + 1];
    if (value === undefined) return `${flag} needs a value\n\n${REPLAY_USAGE}`;
    index += 1;
    if (flag === '--variants') flags.variants = value;
    else if (flag === '--out') flags.output = value;
    else if (flag === '--answer') inline.answer = value;
    else if (flag === '--threshold-risk') inline.thresholdRisk = value;
    else if (flag === '--threshold-auth') inline.thresholdAuthorization = value;
    else if (flag === '--mode') inline.mode = value;
    else inline.channel = value;
  }
  return flags;
}

/**
 * Parse one `replay` command line.
 *
 * The run directory is the argument and everything else is a flag, matching
 * `report`: a replay always reads exactly one run, while where its derivations go
 * is optional. Naming both a document and inline axes is refused here rather than
 * resolved later, because the command has no basis for preferring one.
 */
export function parseReplayCommand(
  rest: readonly string[],
): ReplayCommand | string {
  const [directory, ...flags] = rest;
  if (directory === undefined) {
    return `replay needs a run directory\n\n${REPLAY_USAGE}`;
  }
  const parsed = readReplayFlags(flags);
  if (typeof parsed === 'string') return parsed;
  if (parsed.variants !== null && statesAnyAxis(parsed.inline)) {
    return `--variants and an inline axis describe two different requests; state the variant one way\n\n${REPLAY_USAGE}`;
  }
  return {
    directory,
    variants: parsed.variants,
    output: parsed.output,
    flags: parsed.inline,
    force: parsed.force,
  };
}

/** Whether an argument names the replay command. */
export function isReplayCommand(name: string): boolean {
  return name === 'replay';
}

/** The variants a parsed command asked for, or why none could be resolved. */
async function variantsOf(
  io: ReplayIo,
  command: ReplayCommand,
): Promise<
  | {
      readonly ok: true;
      readonly variants: readonly ReplayVariant[];
      readonly document: string | null;
    }
  | { readonly ok: false; readonly problems: readonly string[] }
> {
  if (command.variants === null) {
    const one = variantFromFlags(command.flags);
    return typeof one === 'string'
      ? { ok: false, problems: [one] }
      : { ok: true, variants: [one], document: null };
  }
  const path = resolve(io.root, command.variants);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { ok: false, problems: [`${command.variants} cannot be read`] };
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return {
      ok: false,
      problems: [`${command.variants} is not valid JSON`],
    };
  }
  const parsed = parseVariants(document);
  if (parsed.ok) {
    return {
      ok: true,
      variants: parsed.variants,
      document: parsed.documentVersion,
    };
  }
  return {
    ok: false,
    problems: parsed.problems.map(
      (problem) => `${command.variants ?? ''}: ${problem}`,
    ),
  };
}

/** The report settings a variant implies, with the source's own dataset. */
function settingsOf(root: string, variant: ReplayVariant): ReportSettings {
  return {
    ...defaultSettings(root),
    mode: variant.settlement.mode,
    channel: variant.settlement.channel,
  };
}

/**
 * How the saved run differs from this build, in the terms that change what the
 * derivation means.
 *
 * Three versions matter and they differ in kind. A contract drift is reinterpreted
 * honestly: the same answer is read by today's N0, which is exactly what a replay
 * measures. A prompt or input drift is not: the answers were produced by other
 * instructions or from other material, so no re-reading can say what the current ones
 * would produce, and the only honest statement is that another request is required.
 */
function standingOf(inputs: InputComparison): InputStanding {
  if (inputs.status === 'unavailable') {
    return {
      status: 'undetermined',
      reason: inputs.reason,
      reRequestRequired: true,
    };
  }
  return {
    status: 'compared',
    drifted: inputs.drifted,
    unverified: inputs.unverified,
    reRequestRequired:
      inputs.drifted.length > 0 || inputs.unverified.length > 0,
  };
}

function driftOf(
  read: Extract<SourceRead, { readonly ok: true }>,
  comparison: InputComparison,
): readonly string[] {
  const drift: string[] = [];
  if (read.index.versions.prompt !== REVIEW_PROMPT_VERSION) {
    drift.push(
      `the run was produced by prompt ${read.index.versions.prompt}, this build ships ${REVIEW_PROMPT_VERSION}; a new prompt needs a new request and cannot be measured by replaying these answers`,
    );
  }
  if (read.index.versions.contract !== REVIEW_CONTRACT_VERSION) {
    drift.push(
      `the run was produced under contract ${read.index.versions.contract}, this build runs ${REVIEW_CONTRACT_VERSION}; the derived bands are today's reading of the saved answers`,
    );
  }
  const inputs = comparison;
  if (inputs.status === 'unavailable') {
    // Not a drift, and not a clean comparison either. Saying which it is keeps a reader
    // from reading silence as "the inputs are unchanged".
    drift.push(
      `whether the dataset's inputs changed could not be determined: ${inputs.reason}`,
    );
  } else {
    if (inputs.drifted.length > 0) {
      drift.push(
        `${String(inputs.drifted.length)} case input(s) changed since the run: ${inputs.drifted
          .map((drift) => drift.caseId)
          .join(
            ', ',
          )}; the saved answers were produced from the earlier material, so measuring the current input requires a new request and cannot be done by replaying these answers`,
      );
    }
    if (inputs.unverified.length > 0) {
      // Kept apart from drift: "not established" is not "changed", and a reader who
      // conflated them would either chase a change that did not happen or miss one.
      drift.push(
        `${String(inputs.unverified.length)} case input(s) could not be verified: ${inputs.unverified
          .map((entry) => entry.caseId)
          .join(
            ', ',
          )}; their current material is unknown, so the saved answers were not shown to match it`,
      );
    }
  }
  return drift;
}

/**
 * `replay`: re-derive one run under each variant and write the derived runs.
 *
 * Every variant is derived before any is written, so a variant that fails to parse
 * does not leave earlier derivations behind under a command that exits non-zero.
 * The exit code is the command's own: a read failure or a refusal exits non-zero,
 * while a derivation that simply reproduces the original reports success — that is
 * the strongest evidence the replay is faithful.
 */
export async function replayRun(
  io: ReplayIo,
  command: ReplayCommand,
): Promise<number> {
  const variants = await variantsOf(io, command);
  if (!variants.ok) {
    for (const problem of variants.problems) io.err(`problem ${problem}`);
    return 2;
  }
  const directory = resolve(io.root, command.directory);
  const read: SourceRead = await readSource({ directory, root: io.root });
  if (!read.ok) {
    for (const problem of read.problems) io.err(`problem ${problem}`);
    return 1;
  }
  io.out(
    `source ${read.index.runId} (${read.index.status}), ${String(read.records.size)} record(s), ${String(read.index.cells.length)} cell(s)`,
  );
  // Version drift is reported on stderr as well as in the lineage, because the person
  // reading the terminal is the one who has to decide whether a new request is needed.
  const inputs = await compareInputs({
    root: io.root,
    dataset: read.plan.datasetPath,
    records: [...read.records.values()].map((sourced) => sourced.record),
  });
  const notes = driftOf(read, inputs);
  for (const drift of notes) io.err(`warning ${drift}`);
  const parent =
    command.output === null
      ? `${directory}-replay`
      : resolve(io.root, command.output);
  let failed = 0;
  for (const variant of variants.variants) {
    const target = variantDirectoryOf(parent, variant.variantId);
    const derivation = deriveRun({
      source: read,
      variant,
      runningContract: REVIEW_CONTRACT_VERSION,
      runningPrompt: REVIEW_PROMPT_VERSION,
      inputs: standingOf(inputs),
      derivedDirectory: target,
      variantsDocument: variants.document,
    });
    const written = await writeDerivation({
      derivation,
      directory: target,
      settings: settingsOf(io.root, variant),
      force: command.force,
      sourceDirectory: directory,
    });
    if ('problems' in written) {
      failed += 1;
      for (const problem of written.problems) io.err(`problem ${problem}`);
      continue;
    }
    const totals = derivation.lineage.totals;
    io.out(`variant ${variant.variantId}`);
    io.out(
      `  cells ${String(totals.cells)}: re-derived ${String(totals.reDerived)}, kept ${String(totals.kept)}, not-replayable ${String(totals.notReplayable)}, no-record ${String(totals.noRecord)}`,
    );
    io.out(`  changed ${String(totals.changed)}`);
    io.out(
      `  derived run ${written.written.runId} in ${written.written.directory}`,
    );
    for (const file of written.written.report) {
      io.out(`  wrote ${join(written.written.directory, file)}`);
    }
  }
  return failed === 0 ? 0 : 1;
}
