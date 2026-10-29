/**
 * Execution observations: when a call started, and how it ended.
 *
 * These are deliberately not the permission verdict. `execution_status` is the
 * host's observed result of running the tool, so an allowed call that never ran
 * stays `pending`, and a denial that never started is `not-started`. The start
 * time and the finish time are separate facts because only a real start signal
 * can set `execution_started_at`: copying a finish timestamp into it would claim
 * an observation nobody made.
 *
 * A `tools/result` event can also arrive while the record is still in the
 * in-memory queue, so an update would match no row. The bounded `earlyResults`
 * map holds those observations here and the writer applies them once the row
 * exists; both orderings then converge on the same final status.
 */
import type { DatabaseSync } from 'node:sqlite';
import { rowChanges } from './rows.js';

/** One observation that arrived before its record was inserted. */
export interface EarlyResult {
  readonly status: string;
  readonly at: number;
}

/** Bound on observations awaiting their record's insertion. */
export const MAX_EARLY_RESULTS = 512;

/**
 * Apply one execution observation to an existing row; returns rows changed.
 *
 * The stage row is updated in the same call so a reader that only looks at the
 * chain still sees the outcome. `execution_started_at` is untouched here: a
 * finish observation says when the tool ended, not when it began.
 */
export function markExecuted(
  db: DatabaseSync,
  callId: string,
  status: string,
  at: number,
): number {
  const changed = rowChanges(
    db
      .prepare(
        `UPDATE calls
            SET execution_status = ?,
                execution_finished_at = ?
          WHERE call_id = ?`,
      )
      .run(status, at, callId),
  );
  db.prepare(
    "UPDATE stages SET result = ? WHERE call_id = ? AND stage = 'execution'",
  ).run(status, callId);
  return changed;
}

/** The only writer of `execution_started_at`; a second start never overwrites. */
export function markStarted(
  db: DatabaseSync,
  callId: string,
  at: number,
): void {
  db.prepare(
    'UPDATE calls SET execution_started_at = ? WHERE call_id = ? AND execution_started_at IS NULL',
  ).run(at, callId);
}

/**
 * Whether a new observation must replace the oldest held one.
 *
 * Returns the key that has to be evicted before `callId` can be stored, or
 * `null` when there is still room. Keeping the bound here rather than in the
 * store means the map and its limit cannot drift apart.
 */
export function evictedFor(
  early: Map<string, EarlyResult>,
  callId: string,
): string | null {
  if (early.has(callId) || early.size < MAX_EARLY_RESULTS) return null;
  return early.keys().next().value ?? null;
}
