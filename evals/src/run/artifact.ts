/**
 * The run artifact's stable consumption interface.
 *
 * A report (#75) and an experiment configuration (#81) are developed separately
 * from this runner, so they must not import its executor, its bounds logic or its
 * fixture reader. They import this module: the document shapes, the version
 * constants, the cell identity rule, and the readers that turn a directory into
 * records. Everything here is pure or reads committed files; nothing calls a
 * model, opens a socket, or looks at the clock.
 *
 * The identity rule is the part a consumer most needs to agree on. A cell id is
 * derived from `(caseId, targetId, protocol, repeat)` with a fixed transform, so a
 * reader can locate a record from the plan alone and a runner cannot make one
 * repeat look like a different observation. Two cells with the same id are the
 * same cell; a second observation of the same case and target needs a different
 * repeat number, which is why `repeats` is part of the plan rather than a runtime
 * option.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ReviewOutcome } from '../../../src/review-contract/types.js';
import type { UsageAggregate } from '../../../src/reviewer/usage.js';

import { digestOf } from '../data/hash.js';
import type { RunCheckers } from './schemas.js';
import type {
  CellRecord,
  CellState,
  RunFixture,
  RunIndex,
  RunPlan,
  RunProtocol,
  RunVersions,
} from './types.js';
import { RUN_ARTIFACT_VERSION, RUN_PLAN_VERSION } from './types.js';

export type {
  CellRecord,
  CellState,
  RunFixture,
  RunIndex,
  RunPlan,
  RunProtocol,
  RunVersions,
};

/**
 * The one naming rule for a run directory's documents.
 *
 * A consumer reads these names rather than searching the directory, so a run that
 * wrote a partial set of files is detectable rather than merely incomplete.
 */
export const RUN_FILES = {
  plan: 'plan.json',
  index: 'index.json',
  fixture: 'fixture.json',
  records: 'records',
} as const;

/** Where one cell's record lives, relative to the run directory. */
export function recordPathOf(cellId: string): string {
  return `${RUN_FILES.records}/${cellId}.json`;
}

/**
 * The identity of one cell.
 *
 * The three parts are joined with `~` because a case id, a target id and a
 * protocol never contain it, so the id is unambiguous without escaping and stays
 * readable in a filename. `r` prefixes the repeat index: `ladder-full~chat-a~chat~r1`.
 */
export function cellIdOf(parts: {
  readonly caseId: string;
  readonly targetId: string;
  readonly protocol: RunProtocol;
  readonly repeat: number;
}): string {
  return [
    parts.caseId,
    parts.targetId,
    parts.protocol,
    `r${String(parts.repeat)}`,
  ].join('~');
}

/** Read one JSON file, or null when it is not there. */
async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  return JSON.parse(text) as unknown;
}

/** Write one JSON document, creating its directory. */
export async function writeJson(
  path: string,
  document: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
}

/** The plan's canonical digest. A continuation compares it before adding anything. */
export function planDigest(plan: RunPlan): string {
  return digestOf(plan);
}

/** The versions one run records, for a caller that supplies its own plan version. */
export function versionsOf(parts: {
  readonly contract: string;
  readonly prompt: string;
  readonly usageMapping: string;
  readonly plan?: string;
  readonly implementation: string;
  readonly node?: string;
}): RunVersions {
  return {
    contract: parts.contract,
    prompt: parts.prompt,
    usageMapping: parts.usageMapping,
    plan: parts.plan ?? RUN_PLAN_VERSION,
    artifact: RUN_ARTIFACT_VERSION,
    implementation: parts.implementation,
    ...(parts.node === undefined ? {} : { node: parts.node }),
  };
}

/**
 * A record as a consumer reads it.
 *
 * The status and the outcome are both exposed because they answer different
 * questions: the status says whether the cell ran, and the outcome says what the
 * reviewer produced when it did. A cell that ran and failed has `reviewed` plus a
 * `review-failure` outcome, which is not the same as a cell that never ran.
 */
export function cellSucceeded(record: CellRecord): boolean {
  return record.status === 'reviewed' && record.outcome !== null;
}

/** Whether this record's outcome carries a score the matrix decided. */
export function scoredOutcome(
  record: CellRecord,
): Extract<ReviewOutcome, { status: 'scored' }> | null {
  const outcome = record.outcome;
  return outcome !== null && outcome.status === 'scored' ? outcome : null;
}

/**
 * A record's attempts, keyed by the identity the shared aggregate dedupes on.
 *
 * This is the shape the production `aggregateUsage` takes, so a consumer that must
 * re-sum a record's usage — after the mapping version changes, or over a subset of
 * cells — calls the shared function with this and gets the same number the
 * artifact reported.
 */
export function usageAttemptsOf(record: CellRecord): readonly {
  readonly attemptId: string;
  readonly usage: CellRecord['attempts'][number]['normalizedUsage'];
}[] {
  return record.attempts.map((attempt) => ({
    attemptId: attempt.attemptId,
    usage: attempt.normalizedUsage,
  }));
}

/** One run directory, as a consumer sees it. */
export interface RunArtifact {
  readonly index: RunIndex;
  readonly plan: RunPlan;
  readonly records: readonly CellRecord[];
  /** Cells the index planned but for which no record file exists. */
  readonly missing: readonly CellState[];
}

/** A problem reading a run directory, named by the file that caused it. */
export interface ArtifactProblem {
  readonly path: string;
  readonly message: string;
}

/** Either a run's documents or why they could not be read. */
export type ArtifactRead =
  | { readonly ok: true; readonly artifact: RunArtifact }
  | { readonly ok: false; readonly problems: readonly ArtifactProblem[] };

/**
 * Read one run directory.
 *
 * Every document is narrowed by its published schema, not asserted into its type:
 * these files are read by a report that does not share this writer's build, so "the
 * writer meant this shape" is not evidence that the file has it. The checkers are
 * supplied rather than compiled here, so a caller reading a whole batch of runs
 * compiles the schemas once.
 *
 * A record that is missing is reported as a missing cell rather than as a failure:
 * an interrupted run is a normal state this format exists to represent. A record
 * that exists but does not match its schema is a failure, because then the index and
 * the directory disagree about a file that is supposed to be immutable.
 */
export async function readRun(
  directory: string,
  checkers: RunCheckers,
): Promise<ArtifactRead> {
  const problems: ArtifactProblem[] = [];
  const planRaw = await readJson(join(directory, RUN_FILES.plan));
  const indexRaw = await readJson(join(directory, RUN_FILES.index));
  const planChecked = planRaw === null ? null : checkers.plan(planRaw);
  const indexChecked = indexRaw === null ? null : checkers.index(indexRaw);
  if (planChecked === null) {
    problems.push({ path: RUN_FILES.plan, message: 'the run has no plan' });
  } else if (!planChecked.ok) {
    problems.push({
      path: RUN_FILES.plan,
      message: planChecked.problems.join('; '),
    });
  }
  if (indexChecked === null) {
    problems.push({ path: RUN_FILES.index, message: 'the run has no index' });
  } else if (!indexChecked.ok) {
    problems.push({
      path: RUN_FILES.index,
      message: indexChecked.problems.join('; '),
    });
  }
  if (
    planChecked === null ||
    indexChecked === null ||
    !planChecked.ok ||
    !indexChecked.ok
  ) {
    return { ok: false, problems };
  }
  const records: CellRecord[] = [];
  const missing: CellState[] = [];
  for (const cell of indexChecked.document.cells) {
    const raw = await readJson(join(directory, cell.record));
    if (raw === null) {
      missing.push(cell);
      continue;
    }
    const checked = checkers.record(raw);
    if (!checked.ok) {
      problems.push({
        path: cell.record,
        message: checked.problems.join('; '),
      });
      continue;
    }
    records.push(checked.document);
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    artifact: {
      index: indexChecked.document,
      plan: planChecked.document,
      records,
      missing,
    },
  };
}

/** Read one fixture document, or report why it cannot be replayed. */
export async function readFixture(
  path: string,
  checkers: RunCheckers,
): Promise<
  | { readonly ok: true; readonly fixture: RunFixture }
  | { readonly ok: false; readonly message: string }
> {
  const raw = await readJson(path);
  if (raw === null) return { ok: false, message: `${path} does not exist` };
  const checked = checkers.fixture(raw);
  if (!checked.ok) {
    return { ok: false, message: `${path}: ${checked.problems.join('; ')}` };
  }
  return { ok: true, fixture: checked.document };
}

/** The usage one cell reported, or null when it reported none. */
export function usageOf(record: CellRecord): UsageAggregate | null {
  return record.usage;
}
