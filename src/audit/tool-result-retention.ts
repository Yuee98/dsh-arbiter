import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { asRow, rowChanges, rowNumber, rowText } from './rows.js';

/** Queue before deleting metadata; unlink always happens AFTER this transaction commits. */
export function clearToolResults(db: DatabaseSync): void {
  db.exec(`INSERT OR IGNORE INTO tool_result_garbage(file_ref)
    SELECT file_ref FROM tool_results WHERE file_ref IS NOT NULL`);
  db.exec('DELETE FROM tool_results');
  db.prepare(
    `INSERT INTO meta(key, value) VALUES ('tool-result-generation', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(randomUUID());
}
export function expireToolResults(db: DatabaseSync, cutoff: number): void {
  const predicate = `ts < ? OR EXISTS (
    SELECT 1 FROM calls WHERE calls.session_id = tool_results.session_id
      AND calls.call_id = tool_results.call_id AND calls.ts < ?)`;
  db.prepare(
    `INSERT OR IGNORE INTO tool_result_garbage(file_ref)
    SELECT file_ref FROM tool_results WHERE file_ref IS NOT NULL AND (${predicate})`,
  ).run(cutoff, cutoff);
  db.prepare(`DELETE FROM tool_results WHERE ${predicate}`).run(cutoff, cutoff);
}
const GROUPS = `SELECT session_id, call_id, MIN(ts) AS ts FROM (
  SELECT session_id, call_id, ts FROM calls UNION ALL
  SELECT session_id, call_id, ts FROM tool_results
) GROUP BY session_id, call_id`;
export function retentionGroupCount(db: DatabaseSync): number {
  return rowNumber(
    asRow(db.prepare(`SELECT COUNT(*) AS count FROM (${GROUPS})`).get())[
      'count'
    ],
  );
}
function oldestRetentionGroups(
  db: DatabaseSync,
  limit: number,
): readonly { readonly sessionId: string; readonly callId: string }[] {
  return db
    .prepare(
      `SELECT * FROM (${GROUPS}) ORDER BY ts, session_id, call_id LIMIT ?`,
    )
    .all(limit)
    .map((value) => {
      const row = asRow(value);
      return {
        sessionId: rowText(row['session_id']),
        callId: rowText(row['call_id']),
      };
    });
}
function deleteGroupRows(
  db: DatabaseSync,
  sessionId: string,
  callId: string,
): number {
  db.prepare(
    `INSERT OR IGNORE INTO tool_result_garbage(file_ref)
    SELECT file_ref FROM tool_results WHERE session_id = ? AND call_id = ? AND file_ref IS NOT NULL`,
  ).run(sessionId, callId);
  db.prepare(
    'DELETE FROM tool_results WHERE session_id = ? AND call_id = ?',
  ).run(sessionId, callId);
  return rowChanges(
    db
      .prepare('DELETE FROM calls WHERE session_id = ? AND call_id = ?')
      .run(sessionId, callId),
  );
}
/** Recheck the whole eviction decision under the same lock as its SQL deletion. */
export function evictOldestRetentionGroup(
  db: DatabaseSync,
  overBudget: () => boolean,
): { readonly evicted: boolean; readonly deleted: number } {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (retentionGroupCount(db) <= 1 || !overBudget()) {
      db.exec('COMMIT');
      return { evicted: false, deleted: 0 };
    }
    const group = oldestRetentionGroups(db, 1)[0];
    if (group === undefined) throw new Error('retention-candidate-unavailable');
    const deleted = deleteGroupRows(db, group.sessionId, group.callId);
    db.exec('COMMIT');
    return { evicted: true, deleted };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
