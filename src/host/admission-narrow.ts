/**
 * Narrowing helpers shared by teardown, disable and a refused resume.
 *
 * Every one of these writes moves a permission in the restrictive direction
 * only. That is what lets a refusal to take over clean up after an earlier
 * widening without ever expanding a session the host confined more strictly — a
 * read-only sandbox or an approval policy tighter than `ask` stays untouched.
 */

import { boundaryWrites, knobsOf, narrowWrites } from './boundary-writes.js';
import type { ExecutionBoundary } from '../types.js';
import type { SessionLike } from '../snapshot.js';
import type { KnobWrite } from './types.js';

/**
 * The writes a normal exit performs.
 *
 * This is the confirmed #4 lifecycle target for an ordinary disable — master
 * switch off, or an explicit API disable — and it deliberately differs from
 * `restrictedWrites`: a normal exit must reach the documented
 * `workspace-write + ask` end state so the session is usable afterwards. Only
 * the *refusal* path is monotonic, because there the plugin never had the right
 * to change the session at all.
 */
export function exitWrites(session: SessionLike): readonly KnobWrite[] {
  return session.header?.parentSession === undefined
    ? boundaryWrites(session, 'guarded')
    : narrowWrites(session);
}

/** Approval values tighter than, or as tight as, `ask`. */
const NOT_WIDER_THAN_ASK = new Set(['ask', 'never']);

/**
 * The writes that take back what this plugin itself granted.
 *
 * Monotonic in the restrictive direction, which is what makes it usable when
 * this plugin is *refusing* to take over: it may remove a sandbox of its own
 * making, and must never move a stricter host choice — read-only, or an approval
 * policy tighter than ask — anywhere else. A delegated child is only ever
 * narrowed, because the host pinned its approval at delegation.
 */
export function restrictedWrites(
  session: SessionLike,
  boundary: ExecutionBoundary = 'guarded',
): readonly KnobWrite[] {
  if (session.header?.parentSession !== undefined) return narrowWrites(session);
  const current = knobsOf(session);
  const writes: KnobWrite[] = [];
  const target =
    boundary === 'trusted' ? 'danger-full-access' : 'workspace-write';
  if (
    current.sandbox === 'danger-full-access' &&
    target !== 'danger-full-access'
  ) {
    writes.push({ type: 'sandbox/mode', value: target });
  }
  if (current.approval !== null && !NOT_WIDER_THAN_ASK.has(current.approval)) {
    writes.push({ type: 'approval/policy', value: 'ask' });
  }
  return writes;
}
