/**
 * Narrowing with a bounded retry.
 *
 * This write is the last protection before gate protection ends, so a single
 * transient append failure must not leave a session wide. The host has no
 * transaction, so the only recovery available is to write again and then to
 * verify the real value rather than trusting the attempt.
 */

import { atSafeSandbox } from './boundary-writes.js';
import type { SessionLike } from '../snapshot.js';
import type { KnobWrite } from './types.js';

/** The write path a retry needs, kept narrow so it cannot do more than narrow. */
export interface NarrowWriter {
  writeSessionKnobs(session: SessionLike, writes: readonly KnobWrite[]): void;
}

/**
 * Force a safe sandbox on one session, retrying.
 *
 * An absent override is written too: it can fall back to a full-access
 * deployment default, which is not something a teardown may leave behind.
 */
export function narrowWithRetry(
  session: SessionLike,
  writer: NarrowWriter,
  attempts = 3,
): boolean {
  if (typeof session.append !== 'function') return false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (!atSafeSandbox(session)) {
        writer.writeSessionKnobs(session, [
          { type: 'sandbox/mode', value: 'workspace-write' },
        ]);
      }
      if (atSafeSandbox(session)) return true;
    } catch {
      // Retry: the host may still be publishing another append.
    }
  }
  return false;
}
