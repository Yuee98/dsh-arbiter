/**
 * One activation decision, reused by every write an activation performs.
 *
 * A takeover may be *widening* a session (moving its sandbox to full access) or
 * only confirming one already running. Detection is allowed to influence the
 * first only, and only in one direction: while another approval provider runs,
 * the widening is withheld. Everything else — the gate, the mode, the in-flight
 * work — stays as it was.
 *
 * The decision is a value so the record, the knob writes and the later lazy
 * boundary sync cannot disagree about what was actually applied.
 */

import { boundaryWrites } from './boundary-writes.js';
import type { ExecutionBoundary } from '../types.js';
import type { SessionLike } from '../snapshot.js';
import type { KnobWrite } from './types.js';

export interface Activation {
  /** The boundary the session will actually hold after this activation. */
  readonly boundary: ExecutionBoundary;
  /** The write to append, with any withheld widening removed. */
  readonly writes: readonly KnobWrite[];
  /** Whether a widening was withheld because a conflict is running. */
  readonly withheld: boolean;
}

/** Whether this write would move the sandbox to full access. */
function widens(write: KnobWrite): boolean {
  return write.type === 'sandbox/mode' && write.value === 'danger-full-access';
}

/**
 * Decide what one activation writes.
 *
 * `applied` is the boundary the session is already recorded under; it is used
 * only when a widening is withheld, so the record keeps describing the host.
 */
export function activationOf(
  session: SessionLike,
  requested: ExecutionBoundary,
  applied: ExecutionBoundary,
  conflict: boolean,
  wasManaged: boolean,
): Activation {
  const writes = boundaryWrites(session, requested);
  if (!wasManaged || !conflict) {
    return { boundary: requested, writes, withheld: false };
  }
  return {
    boundary: applied,
    writes: writes.filter((write) => !widens(write)),
    withheld: true,
  };
}
