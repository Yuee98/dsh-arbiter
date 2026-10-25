/**
 * Pure computations of the host knob writes one boundary needs.
 *
 * These read a session log and answer "what must be appended", but never append:
 * the admission service keeps every write, its ordering and its confirmation.
 * Keeping the arithmetic here makes it unit-testable without a host and keeps
 * the lifecycle file about ordering rather than about knob comparisons.
 */

import type { SessionLike } from '../snapshot.js';
import type { ExecutionBoundary } from '../types.js';
import type { KnobWrite, Knobs } from './types.js';

/** The session's latest sandbox and approval values, `null` when unobserved. */
export function knobsOf(session: SessionLike): Knobs {
  let sandbox: string | null = null;
  let approval: string | null = null;
  if (typeof session.snapshotEvents !== 'function') {
    return { sandbox, approval };
  }
  for (const event of session.snapshotEvents()) {
    const data: unknown = event.data;
    if (data === null || typeof data !== 'object') continue;
    const record: Readonly<Record<string, unknown>> = { ...data };
    if (event.type === 'sandbox/mode' && typeof record['mode'] === 'string')
      sandbox = record['mode'];
    if (
      event.type === 'approval/policy' &&
      typeof record['policy'] === 'string'
    )
      approval = record['policy'];
  }
  return { sandbox, approval };
}

/**
 * The knob changes one boundary needs on this session.
 *
 * A subagent is never rewritten: the host pins delegated approval and captures
 * the parent's sandbox, and widening that from inside would grant a child more
 * than its delegation carried. An absent knob means the deployment default
 * applies, which is the host's choice, not this plugin's — so a managed session
 * states its boundary explicitly rather than trusting that default.
 */
export function boundaryWrites(
  session: SessionLike,
  boundary: ExecutionBoundary,
): readonly KnobWrite[] {
  if (session.header?.parentSession !== undefined) return [];
  const target =
    boundary === 'trusted'
      ? { sandbox: 'danger-full-access', approval: 'ask' }
      : { sandbox: 'workspace-write', approval: 'ask' };
  const current = knobsOf(session);
  const writes: KnobWrite[] = [];
  if (current.sandbox !== target.sandbox) {
    writes.push({ type: 'sandbox/mode', value: target.sandbox });
  }
  if (current.approval !== target.approval) {
    writes.push({ type: 'approval/policy', value: target.approval });
  }
  return writes;
}

/**
 * The narrowing a still-covered session needs to stop running wide.
 *
 * A subagent never gets its knobs widened by this plugin, but the host captures
 * the parent's sandbox at delegation, so a child of a trusted root can be running
 * `danger-full-access` without any record of its own. When the plugin stops
 * taking over (explicit disable, unload, a boundary change) that captured sandbox
 * must be narrowed too.
 *
 * Only the sandbox is touched: the host pins a delegated child's approval to
 * `never`, and replacing that would open prompts the delegation never had.
 */
export function narrowWrites(session: SessionLike): readonly KnobWrite[] {
  // Only a value that is actually wider is rewritten. Absent is left alone here
  // because this narrowing must never widen a session the host confined more
  // strictly (a child captured read-only, an explicit read-only choice);
  // the safety check still refuses to call absent "safe".
  if (knobsOf(session).sandbox !== 'danger-full-access') return [];
  return [{ type: 'sandbox/mode', value: 'workspace-write' }];
}

/** Whether the observed sandbox is a value this plugin can call safe. */
export function atSafeSandbox(session: SessionLike): boolean {
  const sandbox = knobsOf(session).sandbox;
  return sandbox === 'workspace-write' || sandbox === 'read-only';
}

/**
 * Whether this session already satisfies everything teardown must restore.
 *
 * A main session must end at `workspace-write + ask`; a delegated child only
 * needs its captured sandbox narrowed, because the host pinned its approval
 * policy at delegation and this plugin must not rewrite it.
 */
export function boundaryIsSafe(session: SessionLike): boolean {
  const current = knobsOf(session);
  if (session.header?.parentSession !== undefined) {
    return current.sandbox !== 'danger-full-access';
  }
  return (
    current.sandbox !== null &&
    current.sandbox !== 'danger-full-access' &&
    current.approval === 'ask'
  );
}
