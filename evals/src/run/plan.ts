/**
 * Turning a frozen plan into the exact cells it plans to run.
 *
 * Nothing here calls a model. A plan is a document, and this module's whole job is
 * to say, before anything is sent, every cell the run intends to produce and which
 * of them this repository cannot actually support. That split matters because the
 * acceptance rule is that an unsupported model/protocol combination is *reported*
 * as unsupported rather than filled with a made-up answer: the only way to keep
 * that promise is to decide it here, from the plan, and never from a response.
 *
 * Two properties are load-bearing:
 *
 *   - the cell order is total and derived only from the plan. Case order, target
 *     order and protocol order come from the document, and the repeat index is
 *     ascending, so two runs of the same plan produce the same list and a resumed
 *     run can locate its own progress by position as well as by id.
 *   - a cell is identified by `(case, target, protocol, repeat)`. An independent
 *     repeat is therefore a different cell, which is what keeps "the same
 *     observation twice" from being written as one observation reused twice.
 */

import type { ReviewCase } from '../data/types.js';

import { cellIdOf } from './artifact.js';
import type { RunBounds, RunPlan, RunProtocol, RunTarget } from './types.js';

/** One planned cell, before anything ran. */
export interface PlannedCell {
  readonly cellId: string;
  readonly caseId: string;
  readonly targetId: string;
  readonly protocol: RunProtocol;
  readonly repeat: number;
  /** Whether the plan's target offers this protocol at all. */
  readonly supported: boolean;
  /** Why this cell cannot be sent, when it cannot. */
  readonly unsupportedReason: string | null;
}

/** A plan that could be resolved, or why it could not. */
export type PlanResolution =
  | {
      readonly ok: true;
      readonly plan: RunPlan;
      readonly cases: readonly ReviewCase[];
    }
  | { readonly ok: false; readonly problems: readonly string[] };

/** The cells a plan produces, in the plan's own order. */
export interface CellGrid {
  readonly cells: readonly PlannedCell[];
  readonly supported: number;
  readonly unsupported: number;
}

/** The bounds a plan may state, checked before anything runs. */
const MAX_CONCURRENCY = 32;

/**
 * Problems with a plan's own declarations.
 *
 * Every one of these is a plan that cannot mean what it says: a duplicate target, a
 * target that supports nothing, a bound that is not a bound. Reporting them is the
 * difference between an experiment and a hope.
 *
 * A protocol that *some* target does not offer is deliberately not a problem: that is
 * exactly the grid cell the artifact must record as unsupported, and refusing the plan
 * would remove the only way to state it.
 */
export function planProblems(plan: RunPlan): readonly string[] {
  const problems: string[] = [];
  if (plan.repeats < 1) problems.push('repeats must be at least 1');
  if (plan.protocols.length === 0) problems.push('the plan names no protocol');
  if (plan.targets.length === 0) problems.push('the plan names no target');
  if (plan.caseIds.length === 0) problems.push('the plan selects no case');
  const bounds = plan.bounds;
  if (bounds.concurrency < 1 || bounds.concurrency > MAX_CONCURRENCY) {
    problems.push(
      `concurrency must be between 1 and ${String(MAX_CONCURRENCY)}`,
    );
  }
  if (bounds.timeoutMs < 1) problems.push('timeoutMs must be positive');
  if (bounds.maxAttempts < 1) problems.push('maxAttempts must be positive');
  if (bounds.maxInputTokens < 1)
    problems.push('maxInputTokens must be positive');

  const seenTargets = new Set<string>();
  for (const target of plan.targets) {
    if (seenTargets.has(target.targetId)) {
      problems.push(`target ${target.targetId} is declared twice`);
    }
    seenTargets.add(target.targetId);
    if (target.chat === null && target.decision === null) {
      // A target that supports nothing is not an unsupported cell: it is a plan
      // that would silently run nothing for this model, which a reader would then
      // have to notice by absence.
      problems.push(
        `target ${target.targetId} supports neither protocol; omit it or name what it supports`,
      );
    }
  }
  if (plan.transport === 'offline' && plan.fixture === null) {
    problems.push('an offline plan needs a fixture to replay');
  }
  if (plan.transport === 'live' && plan.fixture !== null) {
    problems.push('a live plan must not carry a fixture');
  }
  return problems;
}

/**
 * Whether one target offers one protocol, and why not.
 *
 * The reason is written from the plan alone so it is identical on a first run and
 * on a continuation: a cell that was unsupported before must still read as
 * unsupported afterwards, with the same sentence.
 */
function supportOf(
  target: RunTarget,
  protocol: RunProtocol,
): { readonly supported: boolean; readonly reason: string | null } {
  if (protocol === 'chat') {
    const config = target.chat;
    if (config === null) {
      return {
        supported: false,
        reason: `target ${target.targetId} does not offer protocol chat`,
      };
    }
    if (config.model.length === 0) {
      return {
        supported: false,
        reason: `target ${target.targetId} names no chat model`,
      };
    }
    return { supported: true, reason: null };
  }
  const config = target.decision;
  if (config === null) {
    return {
      supported: false,
      reason: `target ${target.targetId} does not offer protocol decision`,
    };
  }
  if (config.url.length === 0) {
    return {
      supported: false,
      reason: `target ${target.targetId} names no decision endpoint`,
    };
  }
  return { supported: true, reason: null };
}

/**
 * Expand a plan into its cells.
 *
 * The loop order is the plan's, so the result is deterministic: cases in the
 * resolved order, then targets, then protocols, then repeats. A caller that wants
 * a different order sorts the result; nothing here depends on a hash or a clock.
 */
export function cellGrid(plan: RunPlan): CellGrid {
  const cells: PlannedCell[] = [];
  for (const caseId of plan.caseIds) {
    for (const target of plan.targets) {
      for (const protocol of plan.protocols) {
        const support = supportOf(target, protocol);
        for (let repeat = 1; repeat <= plan.repeats; repeat += 1) {
          cells.push({
            cellId: cellIdOf({
              caseId,
              targetId: target.targetId,
              protocol,
              repeat,
            }),
            caseId,
            targetId: target.targetId,
            protocol,
            repeat,
            supported: support.supported,
            unsupportedReason: support.reason,
          });
        }
      }
    }
  }
  const unsupported = cells.filter((cell) => !cell.supported).length;
  return {
    cells,
    supported: cells.length - unsupported,
    unsupported,
  };
}

/** The target one cell names, or null when the plan does not declare it. */
export function targetOf(plan: RunPlan, targetId: string): RunTarget | null {
  return plan.targets.find((target) => target.targetId === targetId) ?? null;
}

/**
 * The attempt ceiling one cell can consume.
 *
 * A run-level attempt bound has to be reserved before dispatch, and an attempt's cost is
 * not known until it returns. The reservation therefore uses the ceiling the transport
 * itself enforces — one attempt plus its repair retries — so the bound can never be
 * exceeded by a repair loop the runner did not anticipate.
 *
 * An offline cell is additionally bounded by its own script: the production offline
 * adapter derives its repair budget from the number of scripted answers it was given, so
 * a fixture with one script can answer one attempt. Reserving more than that would strand
 * budget the run could never spend.
 */
export function attemptCeilingOf(
  target: RunTarget,
  protocol: RunProtocol,
  options: { readonly scripted?: number } = {},
): number {
  const transportCeiling =
    protocol === 'chat'
      ? 1 + Math.max(0, target.chat?.maxRepairRetries ?? 0)
      : 1;
  if (options.scripted === undefined) return transportCeiling;
  return Math.max(1, Math.min(transportCeiling, options.scripted));
}

/**
 * Whether a cell would fit the run's attempt budget.
 *
 * This is asked before dispatch, not after: a run that started a cell it could not
 * afford would have to either overrun the bound or discard the attempt, and both
 * lose information the artifact is supposed to keep.
 */
export function fitsAttemptBudget(parts: {
  readonly bounds: RunBounds;
  readonly remainingAttempts: number;
  readonly ceiling: number;
}): boolean {
  return parts.ceiling <= parts.remainingAttempts;
}
