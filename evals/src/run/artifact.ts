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

import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
  /**
   * The claim file a dispatch holds.
   *
   * Not part of the artifact's readable surface: a report never reads it, and a run
   * interrupted without releasing it is a run a person has to inspect rather than one a
   * later pass may quietly take over.
   */
  lock: 'run.lock',
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

/**
 * A run directory's exclusive claim, held for the life of one dispatch.
 *
 * Two processes pointed at the same directory would each read the same pending cells and
 * each dispatch them, spending the run's budget twice and racing to write the same
 * records. The occupancy check alone cannot stop that: both can pass it before either
 * publishes. A lock file created exclusively is what makes "one run, one writer" true
 * rather than expected, and it is the same mechanism a record uses to claim its own name.
 *
 * The claim is released on success and on failure alike, and a stale claim from a crashed
 * process deliberately blocks continuation: a run whose writer died mid-dispatch cannot
 * promise its budget either, so a person has to look at it.
 */
export async function claimRun(
  directory: string,
): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true });
  const lock = join(directory, RUN_FILES.lock);
  try {
    const handle = await open(lock, 'wx');
    try {
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, claimedAt: new Date().toISOString() })}\n`,
        'utf8',
      );
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code: unknown =
      error !== null && typeof error === 'object'
        ? Reflect.get(error, 'code')
        : null;
    if (code === 'EEXIST') {
      const held = await readFile(lock, 'utf8').catch(() => '');
      throw new Error(
        `refusing to dispatch ${directory}: another process holds the run claim (${held.trim() || 'no details'}); a run has one writer, so finish or remove it before continuing`,
        { cause: error },
      );
    }
    throw error;
  }
  return async (): Promise<void> => {
    await rm(lock, { force: true });
  };
}

/**
 * Write one JSON document, creating its directory.
 *
 * Written beside the target and renamed into place, because a half-written document is
 * worse than an absent one. This matters most for `index.json`, which every pass rewrites:
 * an interrupt during a plain write would truncate the previous index and leave
 * `readExisting` with nothing to recover, so a run interrupted once could not be continued
 * at all. A rename is atomic within a directory, so a reader sees either the old document
 * or the new one and never a mixture.
 *
 * The temporary name is distinct per call so two writers cannot collide on it, and it is
 * cleaned up on failure rather than left as debris beside the real documents.
 */
export async function writeJson(
  path: string,
  document: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(document, null, 2)}\n`,
      'utf8',
    );
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * The digest of what a run actually executes.
 *
 * A run reads the manifest and the cases; it never reads a label or a model opinion. The
 * dataset's own digest covers all four because the annotation tools need to know when an
 * adjudication moved, but freezing that value into a run would mean ordinary annotation
 * work — even editing a rationale — blocks finishing an interrupted experiment whose inputs
 * and plan never changed. So the execution revision is the part a run depends on, and the
 * annotation digest stays where it belongs.
 */
export function executionDigest(parts: {
  readonly manifest: unknown;
  readonly cases: readonly unknown[];
}): string {
  return digestOf({ manifest: parts.manifest, cases: parts.cases });
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
  // The same population the stored summary covers: requests that were sent. Including a
  // pre-send refusal would make a downstream re-aggregation disagree with the record's own
  // `usage`, which is the one thing this helper exists to prevent.
  return record.attempts
    .filter((attempt) => attempt.sent !== false)
    .map((attempt) => ({
      attemptId: attempt.attemptId,
      usage: attempt.normalizedUsage,
    }));
}

/**
 * The cell statuses a dispatch produced, so a record must exist.
 *
 * A dispatched cell always writes a record, whatever it settled at: the runner keeps the
 * attempts a failure made, so `failed` belongs here beside `reviewed`, `timeout` and
 * `cancelled`. Leaving `failed` out let a persisted failure disappear from a report's
 * evidence population without the reader saying so.
 *
 * A status outside this set is a decision reached *before* dispatch — a plan-level
 * refusal, an exhausted budget, a cell the run never reached — and having no record is
 * exactly right for it. Stating the rule as "these must have a record" rather than
 * "these may lack one" is what keeps a dispatched failure from being read as a settled
 * non-event.
 */
const NEEDS_RECORD: ReadonlySet<CellState['status']> = new Set([
  'reviewed',
  'cancelled',
  'timeout',
  'failed',
]);

/**
 * The cell statuses that are a decision reached before any request.
 *
 * These have no record by construction, and `unresolvable` is the status a pre-dispatch
 * refusal takes precisely so it cannot be confused with `failed`. The pair of sets is
 * exhaustive over the settled statuses, which is what lets a reader decide whether a
 * missing record is a gap or the expected shape of that status.
 */
export const RECORDLESS_STATUSES: ReadonlySet<CellState['status']> = new Set([
  'unsupported',
  'budget-exhausted',
  'unresolvable',
  'not-run',
]);

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
      // A cell that never produced an attempt has no record by design: an unsupported
      // pairing was refused by the plan, an exhausted budget stopped dispatch, and a
      // cancelled run never started the cell. A cell that says it ran must have one.
      if (NEEDS_RECORD.has(cell.status)) missing.push(cell);
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
