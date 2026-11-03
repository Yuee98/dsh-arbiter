import { cellIdOf } from './artifact.js';
import { sourceKeys } from './workflow-types.js';
import type { RunPlan, RunProtocol, RunTarget } from './types.js';

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

/** The cells a plan produces, in the plan's own order. */
export interface CellGrid {
  readonly cells: readonly PlannedCell[];
  readonly supported: number;
  readonly unsupported: number;
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
  for (const caseId of sourceKeys(plan)) {
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
