/**
 * Releasing a session the gate is stepping away from.
 *
 * A session can become live after the teardown reconcile ran — a trusted
 * session reopened later is the ordinary case. This is the last moment the
 * plugin sees it, so it narrows here and reports honestly: `unsafe` means the
 * caller must not let that call through, because the sandbox is still wide.
 */

import { resolveScope } from './admission.js';
import type { ScopeLookup } from './admission.js';
import type { SessionLike } from '../snapshot.js';

/** What the release path needs from the admission service. */
export interface ReleaseSource {
  observe(session: SessionLike): void;
  lookup(): ScopeLookup;
  atSafeBoundary(session: SessionLike): boolean;
  narrowSession(session: SessionLike): boolean;
  readonly covered: ReadonlyMap<string, SessionLike>;
}

/**
 * Narrow one late-restored session, without writing an admission record.
 *
 * @returns `safe` when nothing was needed, `narrowed` when the host confirmed
 * the write, `unsafe` when it is still wide.
 */
export function releaseLateSession(
  session: SessionLike,
  source: ReleaseSource,
): 'safe' | 'narrowed' | 'unsafe' {
  source.observe(session);
  const id = session.id;
  if (id === undefined) return 'safe';
  const scope = resolveScope(id, source.lookup());
  // Only a session that would be managed needs narrowing; ordinary unadmitted
  // sessions are never subject to this plugin's permission.
  if (!scope.managed && !source.covered.has(id)) return 'safe';
  if (source.atSafeBoundary(session)) return 'safe';
  const narrowed = source.narrowSession(session);
  if (!source.atSafeBoundary(session)) return 'unsafe';
  return narrowed ? 'narrowed' : 'safe';
}
