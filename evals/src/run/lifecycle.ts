/**
 * The run lifecycle: freeze a plan, write records, continue an interrupted run.
 *
 * The one property this module exists to guarantee is that a record is written once
 * and never rewritten. An interrupted run is a normal state, so the format has to
 * represent it: `records/<cellId>.json` appears when a cell finishes and stays as it
 * was, and `index.json` is the only file that changes. That is what makes continuation
 * a fact about the directory rather than a claim in a document — the set of records is
 * exactly the set of attempts that actually ran.
 *
 * Three consequences follow, and each is enforced here rather than documented:
 *
 *   - continuing only adds missing cells. A cell that already has a record is never
 *     re-dispatched, so a continuation cannot spend money re-learning a failure or
 *     double-count a repair that a previous attempt already paid for.
 *   - the spent totals are *recomputed from the records*, not carried in a mutable
 *     counter. A resumed run that added the old counter to its own would double-count
 *     everything; recomputing from the files cannot.
 *   - a plan whose hash changed is refused. A continuation that ran a different
 *     selection would produce a run directory that no longer describes one experiment.
 *
 * Nothing here calls a model. `createRun` writes an index and no records, and the
 * caller decides whether to dispatch; `evals run` is the explicit command that does.
 */

import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalJson } from '../data/hash.js';
import type { ReviewCase } from '../data/types.js';

import { planDigest, recordPathOf, RUN_FILES, writeJson } from './artifact.js';
import { dispatch } from './scheduler.js';
import type { DispatchOutcome } from './scheduler.js';
import { cellGrid, planProblems } from './plan.js';
import type { RunCheckers } from './schemas.js';
import { RUN_INDEX_VERSION } from './types.js';
import type {
  CellRecord,
  CellState,
  FixtureCell,
  RunFixture,
  RunIndex,
  RunPlan,
  RunSpend,
  RunVersions,
} from './types.js';

/** What a caller must supply to start a run. */
export interface CreateRunOptions {
  readonly directory: string;
  readonly runId: string;
  readonly plan: RunPlan;
  readonly cases: readonly ReviewCase[];
  readonly datasetDigest: string;
  readonly versions: RunVersions;
  /** Wall clock, injected so a test never depends on the real one. */
  readonly now: () => number;
}

/** A run that was created, or refused before anything was written. */
export type CreateResult =
  | { readonly ok: true; readonly index: RunIndex }
  | { readonly ok: false; readonly problems: readonly string[] };

/** The cells a plan's dataset can actually supply. */
export function planCases(
  plan: RunPlan,
  cases: readonly ReviewCase[],
): readonly ReviewCase[] {
  const byId = new Map(cases.map((entry) => [entry.caseId, entry] as const));
  return (plan.caseIds ?? []).flatMap((caseId) => {
    const entry = byId.get(caseId);
    return entry === undefined ? [] : [entry];
  });
}

/**
 * Freeze one plan into a new run directory.
 *
 * The index is written before any dispatch, so an interrupted run still has the plan
 * it was running and the full cell list it intended. A run directory that exists with
 * an index and no records is therefore a truthful description of "started, produced
 * nothing yet" rather than an unexplained empty folder.
 */
export async function createRun(
  options: CreateRunOptions,
): Promise<CreateResult> {
  const problems = [...planProblems(options.plan)];
  const missing = (options.plan.caseIds ?? []).filter(
    (caseId) => !options.cases.some((entry) => entry.caseId === caseId),
  );
  if (missing.length > 0) {
    problems.push(
      `the plan names ${String(missing.length)} case(s) this dataset does not publish: ${missing.join(', ')}`,
    );
  }
  if (problems.length > 0) return { ok: false, problems };
  const grid = cellGrid(options.plan);
  const index: RunIndex = {
    documentVersion: RUN_INDEX_VERSION,
    runId: options.runId,
    createdAt: new Date(options.now()).toISOString(),
    updatedAt: new Date(options.now()).toISOString(),
    status: 'running',
    plan: options.plan,
    planHash: planDigest(options.plan),
    dataset: {
      datasetId: options.plan.datasetId,
      digest: options.datasetDigest,
      caseCount: (options.plan.caseIds ?? []).length,
      caseIds: options.plan.caseIds ?? [],
    },
    versions: options.versions,
    transport: options.plan.transport,
    bounds: options.plan.bounds,
    spent: emptySpend(grid.cells.length),
    cells: grid.cells.map((cell) => ({
      cellId: cell.cellId,
      caseId: cell.caseId,
      targetId: cell.targetId,
      protocol: cell.protocol,
      repeat: cell.repeat,
      record: recordPathOf(cell.cellId),
      status: cell.supported ? 'not-run' : 'unsupported',
      attempts: 0,
      stopReason: cell.unsupportedReason,
    })),
    resumed: [],
    notes: [],
  };
  await mkdir(join(options.directory, RUN_FILES.records), { recursive: true });
  await writeJson(join(options.directory, RUN_FILES.plan), options.plan);
  await writeJson(join(options.directory, RUN_FILES.index), index);
  return { ok: true, index };
}

/** A run whose records already exist, as a continuation reads them. */
export interface ExistingRun {
  readonly index: RunIndex;
  readonly records: readonly CellRecord[];
}

/** Reading an existing run, or why it cannot be continued. */
export type ResumeRead =
  | { readonly ok: true; readonly existing: ExistingRun }
  | { readonly ok: false; readonly problems: readonly string[] };

/** An empty spend total for a plan with this many cells. */
function emptySpend(planned: number): RunSpend {
  return {
    cellsStarted: 0,
    cellsCompleted: 0,
    cellsPlanned: planned,
    attempts: 0,
    estimatedInputTokens: 0,
    reportedOutputTokens: null,
  };
}

/**
 * Read whatever records a run directory already holds.
 *
 * Only files this runner wrote are read, and only under `records/`: a stray document
 * in the run directory must not be mistaken for one of this format's records. Each one
 * is narrowed by its published schema, so a record that a later writer changed
 * incompatibly is refused here rather than silently influencing a run's totals.
 */
async function readRecords(
  directory: string,
  checkers: RunCheckers,
): Promise<{
  readonly records: readonly CellRecord[];
  readonly problems: readonly string[];
}> {
  let names: readonly string[];
  try {
    names = await readdir(join(directory, RUN_FILES.records));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { records: [], problems: [] };
    }
    throw error;
  }
  const records: CellRecord[] = [];
  const problems: string[] = [];
  for (const name of [...names].sort((left, right) =>
    left.localeCompare(right),
  )) {
    if (!name.endsWith('.json')) continue;
    const path = `${RUN_FILES.records}/${name}`;
    const parsed: unknown = JSON.parse(
      await readFile(join(directory, RUN_FILES.records, name), 'utf8'),
    );
    const checked = checkers.record(parsed);
    if (!checked.ok) {
      problems.push(`${path}: ${checked.problems.join('; ')}`);
      continue;
    }
    records.push(checked.document);
  }
  return { records, problems };
}

/**
 * Read a run directory for continuation.
 *
 * The plan's hash is compared before anything else: a continuation that ran a
 * different selection would leave a directory that no longer describes one experiment,
 * and no amount of later bookkeeping could repair that. The check is on the canonical
 * digest, so a reordered but equivalent plan is still refused — an experiment is a
 * document, not a set of members.
 */
export async function readExisting(
  directory: string,
  plan: RunPlan,
  checkers: RunCheckers,
  datasetDigest?: string,
): Promise<ResumeRead> {
  let indexRaw: unknown;
  try {
    indexRaw = JSON.parse(
      await readFile(join(directory, RUN_FILES.index), 'utf8'),
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { ok: false, problems: [`${directory} holds no run to continue`] };
    }
    return {
      ok: false,
      problems: [`${RUN_FILES.index} is not readable JSON`],
    };
  }
  const checked = checkers.index(indexRaw);
  if (!checked.ok) {
    return {
      ok: false,
      problems: checked.problems.map(
        (problem) => `${RUN_FILES.index}: ${problem}`,
      ),
    };
  }
  const index = checked.document;
  const expected = planDigest(plan);
  if (index.planHash !== expected) {
    return {
      ok: false,
      problems: [
        `the plan does not match the run it would continue: recorded ${index.planHash}, supplied ${expected}`,
        `recorded plan: ${canonicalJson(index.plan)}`,
      ],
    };
  }
  if (datasetDigest !== undefined && index.dataset.digest !== datasetDigest) {
    // The run was frozen against a dataset revision. Continuing it against a different
    // one would mix cases from two selections under one plan hash, and a report could not
    // tell which revision a cell's input belonged to.
    return {
      ok: false,
      problems: [
        `the dataset revision moved since this run was frozen: recorded ${index.dataset.digest}, now ${datasetDigest}`,
      ],
    };
  }
  const records = await readRecords(directory, checkers);
  if (records.problems.length > 0) {
    return { ok: false, problems: records.problems };
  }
  return { ok: true, existing: { index, records: records.records } };
}

/**
 * Why a continuation cannot use the build that is asking.
 *
 * A run's index declares the contract, prompt and usage mapping it started under. Those
 * three decide what a recorded number *means*, so continuing under different ones would
 * put two semantics inside one run and let a report compare them as if they were one. The
 * build identity is compared too: a record written by a different runner implementation is
 * not obviously the same evidence.
 *
 * Only the semantic identifiers are compared. A new plan or artifact version is a
 * different document, which the plan hash and the schema already cover.
 */
export function versionDrift(
  index: RunIndex,
  current: RunVersions,
): readonly string[] {
  const problems: string[] = [];
  const compare = (
    name: 'contract' | 'prompt' | 'usageMapping' | 'implementation',
    label: string,
  ): void => {
    // Every one of these four is required on an index, so a mismatch is the only case that
    // matters.
    const frozen = index.versions[name];
    if (frozen !== current[name]) {
      problems.push(
        `the ${label} changed since this run was frozen: recorded ${frozen}, now ${current[name]}`,
      );
    }
  };
  compare('contract', 'review contract');
  compare('prompt', 'review prompt');
  compare('usageMapping', 'usage mapping');
  compare('implementation', 'runner implementation');
  return problems;
}

/** A continuation's outcome. */
export interface ResumeOutcome {
  readonly index: RunIndex;
  readonly dispatch: DispatchOutcome;
  /** Cells this continuation dispatched, in the order they settled. */
  readonly ran: number;
}

/**
 * Continue a run: dispatch only the cells that have no record yet.
 *
 * A record is written as each cell settles rather than at the end, so a crash mid-run
 * leaves every finished cell durable. The index is rewritten once at the end, because
 * its only job is to describe the directory: recomputing it from the records is
 * exactly what keeps a continuation from double-counting.
 */
export async function resumeRun(options: {
  readonly directory: string;
  readonly existing: ExistingRun;
  readonly cases: readonly ReviewCase[];
  readonly fixture: RunFixture;
  readonly versions: RunVersions;
  readonly checkers: RunCheckers;
  readonly llm: Parameters<typeof dispatch>[0]['llm'];
  readonly readCredential: Parameters<typeof dispatch>[0]['readCredential'];
  readonly signal: AbortSignal;
  readonly onProgress?: (result: CellRecord) => void | Promise<void>;
  /**
   * Whether this pass continues an earlier one.
   *
   * A first pass and a continuation run the same code, but they are different events: the
   * `resumed` log exists to record when someone came back to a run, and logging the
   * original pass there would make two identical entries that hide the actual retry.
   */
  readonly continuation: boolean;
  readonly now?: () => number;
}): Promise<ResumeOutcome> {
  const now = options.now ?? (() => Date.now());
  // A continuation must not mix reviewer semantics inside one run. The index declares what
  // the run started under, so a build that disagrees is refused before dispatching
  // anything: the records already written would otherwise be read as comparable with the
  // new ones.
  if (options.continuation) {
    const drift = versionDrift(options.existing.index, options.versions);
    if (drift.length > 0) {
      throw new Error(
        `refusing to continue a run under different versions — ${drift.join('; ')}`,
      );
    }
  }
  const completed = new Set(
    options.existing.records.map((record) => record.cellId),
  );
  const grid = cellGrid(options.existing.index.plan);
  const pending = grid.cells.filter((cell) => !completed.has(cell.cellId));
  const cases = new Map(
    options.cases.map((entry) => [entry.caseId, entry] as const),
  );
  const outcome = await dispatch({
    runId: options.existing.index.runId,
    plan: options.existing.index.plan,
    cells: pending,
    cases,
    fixture: fixtureByCell(options.fixture),
    versions: options.versions,
    llm: options.llm,
    readCredential: options.readCredential,
    signal: options.signal,
    // The continuation inherits the run's remaining allowance, not a fresh one: without
    // this, each pass could spend the full maximum and the cumulative total would exceed
    // the bound the frozen plan declared.
    alreadySpentAttempts: attemptsIn(options.existing.records),
    now,
    onSettled: async (result) => {
      if (result.record !== null) {
        await writeRecord(options.directory, result.record);
        await options.onProgress?.(result.record);
      }
    },
  });
  const records = await readRecords(options.directory, options.checkers);
  if (records.problems.length > 0) {
    throw new Error(
      `a record written by this run is unreadable: ${records.problems.join('; ')}`,
    );
  }
  const index = indexFrom({
    existing: options.existing.index,
    records: records.records,
    outcome,
    now,
    planned: grid.cells.length,
    continuation: options.continuation,
  });
  await writeJson(join(options.directory, RUN_FILES.index), index);
  return { index, dispatch: outcome, ran: pending.length };
}

/**
 * The attempts a set of records already paid for.
 *
 * A cell abandoned while its request was outstanding reports zero attempts, because the
 * transport never returned one — but its request may have used its whole reservation, and
 * the run kept that reservation rather than freeing the slot. A continuation cannot see
 * the in-memory reservation, so the record carries it in `abandonment` and the full figure
 * is charged here. Charging an inferred single attempt instead would let a cell that
 * reserved three start another three-attempt cell, and the run's declared bound would be
 * exceeded rather than held.
 */
function attemptsIn(records: readonly CellRecord[]): number {
  return records.reduce((sum, record) => sum + attemptsOfCell(record), 0);
}

/**
 * What one record spent against the run's budget.
 *
 * A settled cell reports its attempts, so that is the figure. An abandoned cell reports
 * nothing — the transport never returned — and guessing one attempt would under-count a
 * call that could have sent its whole reservation. So the reservation is what gets
 * charged, for both timeout and cancellation: what the run knows is that it may have spent
 * that much, and a budget that assumes less is not a bound.
 */
function attemptsOfCell(record: CellRecord): number {
  if (record.attempts.length > 0) return record.attempts.length;
  return record.abandonment?.reservedAttempts ?? 0;
}

/** The fixture entries, keyed by cell id for the scheduler. */
export function fixtureByCell(
  fixture: RunFixture,
): Readonly<Record<string, FixtureCell>> {
  return fixture.cells;
}

/**
 * Write one cell's record, refusing to overwrite an existing one.
 *
 * Refusing rather than replacing is the whole contract: a record is evidence, and an
 * artifact whose evidence can be silently rewritten cannot be relied on by a report.
 * The check reads the file rather than trusting a set, because the set is in memory
 * and the file is what a later reader will find.
 */
export async function writeRecord(
  directory: string,
  record: CellRecord,
): Promise<void> {
  const path = join(directory, recordPathOf(record.cellId));
  const existing = await readFile(path, 'utf8').catch(() => null);
  if (existing !== null) {
    throw new Error(
      `refusing to overwrite ${record.cellId}: a record is written once and read many times`,
    );
  }
  await writeJson(path, record);
}

/**
 * Recompute one run's spend from the records on disk.
 *
 * `cellsCompleted` counts every cell that has a record, not only the ones that scored.
 * A recorded failure is a result: it entered the denominator, it cost what its attempts
 * cost, and leaving it out would let a run look more successful by failing less visibly.
 * `cellsStarted` is the narrower number — the cells that actually reached a transport —
 * so a reader can still tell a decided-before-dispatch cell from a billed one.
 */
export function spendOf(
  records: readonly CellRecord[],
  planned: number,
): RunSpend {
  let attempts = 0;
  let estimatedInputTokens = 0;
  let output: number | null = null;
  let started = 0;
  for (const record of records) {
    // The same figure the budget charges, so the index's total and a continuation's
    // allowance cannot disagree: an abandoned cell contributes what it reserved rather than
    // the zero its attempt list shows.
    attempts += attemptsOfCell(record);
    estimatedInputTokens += record.material?.estimatedInputTokens ?? 0;
    if (record.attempts.length > 0 || record.abandonment !== null) started += 1;
    for (const attempt of record.attempts) {
      const value = attempt.normalizedUsage?.tokens.outputTokens ?? null;
      if (value === null) continue;
      output = (output ?? 0) + value;
    }
  }
  return {
    cellsStarted: started,
    cellsCompleted: records.length,
    cellsPlanned: planned,
    attempts,
    estimatedInputTokens,
    reportedOutputTokens: output,
  };
}

/**
 * The index a directory's records describe.
 *
 * Every field that could be accumulated is recomputed here, which is what makes a
 * continuation idempotent: running it twice over the same records produces the same
 * index. The `resumed` log is the one field carried forward, because when a
 * continuation happened is not derivable from the records themselves.
 *
 * A cell that finished without a record — unsupported, budget-exhausted, or skipped as
 * not-run — takes its settlement from `settled`. Those cells have no evidence to
 * preserve and no record to read, so the dispatch result is the only place their
 * outcome exists; without this the index would report a settled cell as `not-run` and
 * lose the reason it did not run.
 */
export function indexFrom(parts: {
  readonly existing: RunIndex;
  readonly records: readonly CellRecord[];
  readonly outcome: DispatchOutcome | null;
  readonly now: () => number;
  readonly planned: number;
  /** Whether this pass continued an earlier one, which is what the log records. */
  readonly continuation: boolean;
}): RunIndex {
  const byCell = new Map(
    parts.records.map((record) => [record.cellId, record] as const),
  );
  const settled = new Map(
    (parts.outcome?.results ?? []).map(
      (result) => [result.cellId, result] as const,
    ),
  );
  const cells: CellState[] = parts.existing.cells.map((cell) => {
    const record = byCell.get(cell.cellId);
    if (record === undefined) {
      const result = settled.get(cell.cellId);
      if (result !== undefined && result.status !== 'not-run') {
        return {
          ...cell,
          status: result.status,
          attempts: result.attempts,
          stopReason: result.stopReason,
        };
      }
      // A cell that already carried a settled status from an earlier pass keeps it: a
      // continuation must not turn an unsupported pairing back into "not yet tried".
      return cell.status === 'unsupported' || cell.status === 'budget-exhausted'
        ? cell
        : { ...cell, status: 'not-run', stopReason: null };
    }
    return {
      ...cell,
      status: record.status,
      attempts: record.attempts.length,
      stopReason: record.stopReason,
    };
  });
  const spent = spendOf(parts.records, parts.planned);
  const resumed =
    parts.outcome === null || !parts.continuation
      ? parts.existing.resumed
      : [
          ...parts.existing.resumed,
          {
            at: new Date(parts.now()).toISOString(),
            // What was already done when this continuation started: the count now, minus
            // every record this pass created. Subtracting only the reviewed ones would
            // leave a newly failed cell in `completedBefore` and report more history than
            // the run had — a failure is a decided cell too.
            completedBefore:
              spent.cellsCompleted -
              parts.outcome.results.filter((result) => result.record !== null)
                .length,
            plannedAfter: parts.planned,
          },
        ];
  return {
    ...parts.existing,
    updatedAt: new Date(parts.now()).toISOString(),
    status:
      parts.outcome === null
        ? parts.existing.status
        : parts.outcome.status === 'complete'
          ? 'complete'
          : parts.outcome.status,
    spent,
    cells,
    resumed,
  };
}
