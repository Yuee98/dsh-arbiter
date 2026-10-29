/**
 * The bounded scheduler: concurrency, budget, cancellation and timeouts.
 *
 * One run dispatches many cells, and the acceptance rule is that every bound is
 * *observable* rather than merely declared. This module keeps the whole accounting in
 * one place and turns each bound into a decision taken before a cell starts, never a
 * check applied afterwards:
 *
 *   concurrency   at most `bounds.concurrency` workers exist. Each worker takes one
 *                 cell at a time, so the number of live reviews is a property of the
 *                 loop rather than a hope about `Promise.all`.
 *   attempts      a cell starts only when the transport's worst-case attempt count
 *                 still fits what remains. The worst case is one attempt plus the
 *                 transport's own repair retries, because a repair is a real call the
 *                 run pays for. The reservation is taken synchronously, before the
 *                 first `await`, so two workers cannot both spend the last attempt.
 *                 When a cell finishes, the difference between its reservation and
 *                 what it actually used is returned to the budget.
 *   input tokens  a cell starts only when the material it would send fits
 *                 `bounds.maxInputTokens`. The estimate is the production renderer's
 *                 own, taken from the material this cell just built.
 *   timeout       each cell runs under its own `bounds.timeoutMs` signal, composed
 *                 with the caller's. A timeout and a cancellation are reported
 *                 separately: one says the cell was too slow, the other says the
 *                 operator stopped the run.
 *   cancellation  the caller's signal stops new dispatch immediately, and the
 *                 in-flight cells abort and settle as `cancelled`. Cells that never
 *                 started are recorded as `not-run`, so the run states its whole plan.
 *
 * Nothing here retries a cell. A retry would be a second observation the plan did not
 * ask for, and the production transport already owns the one retry the design allows:
 * a format repair inside a single call, which appears as a second attempt in the same
 * record.
 */

import type { ReviewCase } from '../data/types.js';

import { runCell, timedOutRecord } from './execute.js';
import type { CellDeps } from './execute.js';
import { caseMaterial } from './material.js';
import { attemptCeilingOf } from './plan.js';
import type { PlannedCell } from './plan.js';
import type {
  CellRecord,
  CellStatus,
  FixtureCell,
  RunPlan,
  RunVersions,
} from './types.js';

/** One settled cell. */
export interface DispatchResult {
  readonly cellId: string;
  readonly record: CellRecord | null;
  readonly status: CellStatus | 'not-run';
  /** Attempts the cell actually made. */
  readonly attempts: number;
  /** Why this cell did not run, or what ended it. */
  readonly stopReason: string | null;
}

/** What the scheduler needs from the caller. */
export interface DispatchOptions {
  readonly runId: string;
  readonly plan: RunPlan;
  readonly cells: readonly PlannedCell[];
  readonly cases: ReadonlyMap<string, ReviewCase>;
  readonly fixture: Readonly<Record<string, FixtureCell>>;
  readonly versions: RunVersions;
  readonly llm: CellDeps['llm'];
  readonly readCredential: CellDeps['readCredential'];
  /** The caller's lifetime. */
  readonly signal: AbortSignal;
  /** Called as each cell settles, so a caller can persist progress incrementally. */
  readonly onSettled?: (result: DispatchResult) => void | Promise<void>;
  /**
   * Attempts this run already made before this pass.
   *
   * A continuation must respect the run's original ceiling, so its remaining allowance is
   * the plan maximum minus what the records prove was already spent.
   */
  readonly alreadySpentAttempts?: number;
  readonly now?: () => number;
}

/** Why a run stopped dispatching. */
/**
 * Why dispatch stopped before the grid was walked.
 *
 * `in-flight-timeout` is its own reason rather than a timeout status: one cell's own bound
 * expired while its request was still outstanding, so the runner stopped taking work it
 * could not account for. No status is reused for it, because "a cell timed out" and "the
 * run stopped because a call was abandoned" are different facts about the artifact.
 */
export type StopReason = 'cancelled' | 'budget-exhausted' | 'in-flight-timeout';

/** The whole run's dispatch outcome. */
export interface DispatchOutcome {
  readonly results: readonly DispatchResult[];
  readonly stoppedBy: StopReason | null;
  readonly status: 'complete' | StopReason;
  /** Total attempts actually made. */
  readonly attempts: number;
  /** Estimated input reported by the cells that ran. */
  readonly estimatedInputTokens: number;
  /** Sum of output counts the attempts reported, or null when none reported any. */
  readonly reportedOutputTokens: number | null;
}

/** Sum one cell's reported output, or null when no attempt reported it. */
function outputOf(record: CellRecord): number | null {
  let sum = 0;
  let reported = 0;
  for (const attempt of record.attempts) {
    const value = attempt.normalizedUsage?.tokens.outputTokens ?? null;
    if (value === null) continue;
    sum += value;
    reported += 1;
  }
  return reported === 0 ? null : sum;
}

/**
 * Which cells still need running.
 *
 * A cell with a record is done, whatever the record says: an unsupported cell was
 * decided and a failed cell was attempted. Only a cell without a record has not run.
 * This is the rule a continuation uses, and it is about the record's existence rather
 * than about success — re-running a failure would spend money to re-learn the same
 * fact, and a plan that wants a second observation asks for it with another repeat.
 */
export function pendingCells(
  cells: readonly PlannedCell[],
  existing: ReadonlySet<string>,
): readonly PlannedCell[] {
  return cells.filter((cell) => !existing.has(cell.cellId));
}

/**
 * The accounting shared by all workers.
 *
 * Kept as one object rather than as closure variables so the reservation and release
 * rules live together: a reservation taken before an `await` and released after one is
 * the only thing that keeps two workers from spending the same last attempt.
 *
 * `alreadySpent` is not an optimisation. A continuation dispatches a *subset* of the
 * plan's cells, so a budget that starts from the plan maximum would hand every
 * continuation a fresh allowance and let the cumulative attempts exceed the bound the
 * plan declared. The spent count therefore comes from the records on disk, which is the
 * same source the index's totals are recomputed from.
 */
class Budget {
  private remainingAttempts: number;
  private readonly maxInputTokens: number;

  constructor(plan: RunPlan, alreadySpent: number) {
    this.remainingAttempts = Math.max(
      0,
      plan.bounds.maxAttempts - alreadySpent,
    );
    this.maxInputTokens = plan.bounds.maxInputTokens;
  }

  /** Reserve a cell's worst case, or say why it cannot start. */
  reserve(parts: {
    readonly ceiling: number;
    readonly estimatedInputTokens: number;
    readonly inputCap: number;
  }): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    if (parts.ceiling > this.remainingAttempts) {
      return {
        ok: false,
        reason: `the run's attempt budget cannot cover this cell: it needs up to ${String(parts.ceiling)} attempt(s) and ${String(this.remainingAttempts)} remain`,
      };
    }
    if (parts.estimatedInputTokens > parts.inputCap) {
      return {
        ok: false,
        reason: `this case renders to ${String(parts.estimatedInputTokens)} estimated input tokens, above this protocol's ${String(parts.inputCap)} bound`,
      };
    }
    this.remainingAttempts -= parts.ceiling;
    return { ok: true };
  }

  /** Return the unused part of a reservation once a cell has settled. */
  release(parts: { readonly reserved: number; readonly used: number }): void {
    this.remainingAttempts += Math.max(0, parts.reserved - parts.used);
  }
}

/**
 * Dispatch a run's cells under every bound.
 *
 * The grid is walked in plan order by a fixed pool of workers, so the order cells
 * *start* in is deterministic while their completion order is not. Each worker takes
 * the next unclaimed cell, so no cell is dispatched twice and no cell is skipped.
 */
export async function dispatch(
  options: DispatchOptions,
): Promise<DispatchOutcome> {
  const now = options.now ?? (() => Date.now());
  const budget = new Budget(options.plan, options.alreadySpentAttempts ?? 0);
  const results: DispatchResult[] = [];
  const state = { cursor: 0, stopped: null as StopReason | null };

  const settle = async (result: DispatchResult): Promise<void> => {
    results.push(result);
    await options.onSettled?.(result);
  };

  /** Take the next unclaimed cell, or null when the grid is walked. */
  const claim = (): PlannedCell | null => {
    const cell = options.cells[state.cursor];
    if (cell === undefined) return null;
    state.cursor += 1;
    return cell;
  };

  /** Record a cell that will never run, and say why. */
  const abandonRest = async (reason: string): Promise<void> => {
    let rest = claim();
    while (rest !== null) {
      await settle({
        cellId: rest.cellId,
        record: null,
        status: 'not-run',
        attempts: 0,
        stopReason: reason,
      });
      rest = claim();
    }
  };

  /** One worker: take a cell, decide whether it may run, run it, settle it. */
  const worker = async (): Promise<void> => {
    for (;;) {
      if (state.stopped !== null) return;
      if (options.signal.aborted) {
        state.stopped = 'cancelled';
        return;
      }
      const cell = claim();
      if (cell === null) return;
      if (!cell.supported) {
        // The plan itself pairs this model with no such protocol. No request is
        // built and no attempt is reserved: an unsupported cell costs nothing.
        await settle({
          cellId: cell.cellId,
          record: null,
          status: 'unsupported',
          attempts: 0,
          stopReason: cell.unsupportedReason,
        });
        continue;
      }
      const prepared = prepare(cell, options);
      if ('reason' in prepared) {
        // Nothing was sent, so there is no record and no attempt. Calling this `failed`
        // would put it in the population of dispatched failures whose evidence a reader
        // expects to find, which is not what happened.
        await settle({
          cellId: cell.cellId,
          record: null,
          status: 'unresolvable',
          attempts: 0,
          stopReason: prepared.reason,
        });
        continue;
      }
      const { caseEntry, target, material } = prepared;
      const fixtureCell = options.fixture[cell.cellId];
      const ceiling = attemptCeilingOf(target, cell.protocol, {
        // An offline cell cannot make more attempts than its own script can answer, so
        // reserving the transport's ceiling would strand budget it could never spend.
        ...(options.plan.transport !== 'offline'
          ? {}
          : {
              scripted:
                (cell.protocol === 'chat'
                  ? (fixtureCell?.chat?.length ?? 0)
                  : (fixtureCell?.decision?.length ?? 0)) || 1,
            }),
      });
      const reserved = budget.reserve({
        ceiling,
        estimatedInputTokens: material.material.estimatedInputTokens,
        inputCap: options.plan.bounds.maxInputTokens,
      });
      if (!reserved.ok) {
        // The budget, not this cell, is what ran out: stopping dispatch is the
        // honest outcome, and every remaining cell is recorded as not-run.
        state.stopped = 'budget-exhausted';
        await settle({
          cellId: cell.cellId,
          record: null,
          status: 'budget-exhausted',
          attempts: 0,
          stopReason: reserved.reason,
        });
        await abandonRest('the run stopped after its budget was exhausted');
        return;
      }
      const { result: settledCell, abandoned } = await runUnderTimeout({
        cell,
        caseEntry,
        target,
        material,
        options,
        now,
      });
      if (abandoned) {
        // The reservation stays consumed and the worker does not take another cell: the
        // request it gave up on may still be in flight, so starting another would exceed
        // the concurrency the plan declared. Dispatch stops, and the remaining cells are
        // recorded as never started rather than as budget-exhausted.
        await settle(settledCell);
        state.stopped = 'in-flight-timeout';
        return;
      }
      budget.release({ reserved: ceiling, used: settledCell.attempts });
      await settle(settledCell);
    }
  };

  const workers = Array.from(
    { length: Math.min(options.plan.bounds.concurrency, options.cells.length) },
    () => worker(),
  );
  await Promise.all(workers);

  // A run that was cancelled before its workers drained leaves cells unclaimed. They
  // never ran, and the artifact says so instead of reporting a short grid as whole.
  if (state.cursor < options.cells.length) {
    await abandonRest(stopExplanation(state.stopped));
  }

  const estimatedInputTokens = results.reduce(
    (sum, result) => sum + (result.record?.material?.estimatedInputTokens ?? 0),
    0,
  );
  let reportedOutputTokens: number | null = null;
  for (const result of results) {
    if (result.record === null) continue;
    const output = outputOf(result.record);
    if (output !== null)
      reportedOutputTokens = (reportedOutputTokens ?? 0) + output;
  }
  return {
    results,
    stoppedBy: state.stopped,
    status: state.stopped ?? 'complete',
    attempts: results.reduce((sum, result) => sum + result.attempts, 0),
    estimatedInputTokens,
    reportedOutputTokens,
  };
}

/** What one cell needs before it can be dispatched. */
interface Prepared {
  readonly caseEntry: ReviewCase;
  readonly target: RunPlan['targets'][number];
  readonly material: ReturnType<typeof caseMaterial>;
}

/**
 * Resolve a cell's case and target, and build the material it would send.
 *
 * Building the material before the budget check is what makes the input bound a real
 * comparison rather than an estimate about an estimate: the check reads the same
 * number the request would carry.
 */
function prepare(
  cell: PlannedCell,
  options: DispatchOptions,
): Prepared | { readonly reason: string } {
  const caseEntry = options.cases.get(cell.caseId);
  if (caseEntry === undefined) {
    return {
      reason: `case ${cell.caseId} is not in the run's dataset revision`,
    };
  }
  const target = options.plan.targets.find(
    (entry) => entry.targetId === cell.targetId,
  );
  if (target === undefined) {
    return { reason: `target ${cell.targetId} is not in the plan` };
  }
  const material = caseMaterial(caseEntry, cell.protocol, {
    maxInputTokens: options.plan.context.maxInputTokens,
  });
  return { caseEntry, target, material };
}

/**
 * Run one cell under its own timeout, composed with the caller's signal.
 *
 * The bound is enforced from *outside* the call as well as signalled into it. Signalling
 * alone would make the runner's ceiling depend on the transport honouring the abort, and
 * a socket that ignores it would keep the whole run waiting — a run that never finishes
 * is not a bounded run. So the race is against a timer, and losing it produces a timeout
 * record instead of a hang.
 *
 * The two signals are composed rather than substituted: whichever fires first also
 * reaches the request, so a cooperating transport stops on its own.
 */
async function runUnderTimeout(parts: {
  readonly cell: PlannedCell;
  readonly caseEntry: ReviewCase;
  readonly target: RunPlan['targets'][number];
  readonly material: Prepared['material'];
  readonly options: DispatchOptions;
  readonly now: () => number;
}): Promise<{ readonly result: DispatchResult; readonly abandoned: boolean }> {
  const timeout = AbortSignal.timeout(parts.options.plan.bounds.timeoutMs);
  const composed = AbortSignal.any([parts.options.signal, timeout]);
  const deps = {
    runId: parts.options.runId,
    caseEntry: parts.caseEntry,
    target: parts.target,
    protocol: parts.cell.protocol,
    repeat: parts.cell.repeat,
    transport: parts.options.plan.transport,
    fixture: parts.options.fixture[parts.cell.cellId] ?? null,
    versions: parts.options.versions,
    llm: parts.options.llm,
    readCredential: parts.options.readCredential,
    signal: composed,
    timedOut: () => timeout.aborted && !parts.options.signal.aborted,
    now: parts.now,
  } as const;
  const startedAt = parts.now();
  const call = runCell({
    cellId: parts.cell.cellId,
    material: parts.material,
    deps,
  });
  const bounded = await Promise.race([
    call.then((settled) => ({ kind: 'settled' as const, settled })),
    new Promise<{ readonly kind: 'expired' }>((resolve) => {
      const timer = setTimeout(() => {
        resolve({ kind: 'expired' });
      }, parts.options.plan.bounds.timeoutMs);
      // A settled cell must not keep the process alive for the rest of the bound.
      call
        .finally(() => {
          clearTimeout(timer);
        })
        .catch(() => undefined);
    }),
  ]);
  if (bounded.kind === 'expired') {
    // The call is abandoned rather than awaited: waiting on a transport that ignores its
    // signal is exactly the failure this bound exists to prevent.
    call.catch(() => undefined);
    const record = timedOutRecord({
      cellId: parts.cell.cellId,
      deps,
      material: parts.material,
      startedAt,
      reason: parts.options.signal.aborted
        ? 'the run was cancelled while this cell was in flight'
        : 'the cell exceeded its own timeout',
    });
    const status = parts.options.signal.aborted ? 'cancelled' : 'timeout';
    return {
      result: {
        cellId: parts.cell.cellId,
        record: { ...record, status },
        status,
        attempts: 0,
        stopReason: record.stopReason,
      },
      // The abandoned call may still be running — and may still be billed — so it counts
      // as in flight. Treating it as finished would free its slot and could put more live
      // requests on the wire than the plan's concurrency allows.
      abandoned: true,
    };
  }
  return {
    result: {
      cellId: parts.cell.cellId,
      record: bounded.settled.record,
      status: bounded.settled.record.status,
      attempts: bounded.settled.record.attempts.length,
      stopReason: bounded.settled.record.stopReason,
    },
    abandoned: false,
  };
}

/** Why the cells after a stop never started, in the artifact's own words. */
function stopExplanation(reason: StopReason | null): string {
  switch (reason) {
    case 'budget-exhausted':
      return 'the run stopped after its budget was exhausted';
    case 'in-flight-timeout':
      return 'the run stopped because a cell was abandoned while its request was outstanding, so no further request was started';
    case 'cancelled':
    case null:
      return 'the run was cancelled before this cell started';
  }
}
