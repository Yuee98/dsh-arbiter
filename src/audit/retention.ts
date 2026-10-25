import type { DatabaseSync } from 'node:sqlite';
import { asRow, rowNumber, rowChanges } from './rows.js';
export function clearCalls(db: DatabaseSync): number {
  const count = rowNumber(
    asRow(db.prepare('SELECT COUNT(*) AS count FROM calls').get())['count'],
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM calls');
    db.exec('DELETE FROM candidates');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return count;
}
function compact(db: DatabaseSync): void {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // Another reader can keep a checkpoint from completing; the next run retries.
  }
  try {
    db.exec('VACUUM');
    db.exec('PRAGMA optimize');
  } catch {
    // Vacuum is a space optimization, never a permission or retention precondition.
  }
}
export interface RetentionOutcome {
  readonly deleted: number;
  /**
   * True when the target cannot be met because the newest remaining call alone
   * exceeds it. Reported instead of deleting the last record: an audit that
   * keeps nothing is worse than one that states its constraint.
   */
  readonly irreducible: boolean;
  /** Total bytes the target applies to, including sidecars and backups. */
  readonly bytes: number;
}

export function runRetention(
  db: DatabaseSync,
  now: number,
  retentionDays: number,
  retentionBytes: number,
  databaseBytes: () => number,
): RetentionOutcome {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // Continue with the current page counts.
  }
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1_000;
  let deleted = rowChanges(
    db.prepare('DELETE FROM calls WHERE ts < ?').run(cutoff),
  );
  let guard = 0;
  // Eviction must see the same footprint the target is measured against,
  // including migration backups; otherwise the database alone can look small
  // while the audit directory is already over budget.
  while (databaseBytes() > retentionBytes && guard < 40) {
    guard += 1;
    const remaining = rowNumber(
      asRow(db.prepare('SELECT COUNT(*) AS count FROM calls').get())['count'],
    );
    if (remaining <= 1) break;
    const average = asRow(
      db
        .prepare(
          `SELECT AVG(
               length(arguments) + length(trace) + length(effect) +
               COALESCE(length(signals), 0) + 256
             ) AS average FROM calls`,
        )
        .get(),
    );
    const excess = databaseBytes() - retentionBytes;
    const batch = Math.max(
      1,
      Math.min(
        32,
        Math.ceil(excess / Math.max(rowNumber(average['average'], 1_024), 256)),
      ),
    );
    const changes = rowChanges(
      db
        .prepare(
          `DELETE FROM calls WHERE call_id IN (
               SELECT call_id FROM calls ORDER BY ts ASC LIMIT ?
             )`,
        )
        .run(Math.min(batch, remaining - 1)),
    );
    if (changes === 0) break;
    deleted += changes;
  }
  // Orphaned review snapshots go with their call. Configuration snapshots are
  // different: an activation row is itself a reference, so a snapshot that no
  // current call points at is still needed to explain configuration history.
  db.prepare(
    'DELETE FROM snapshots WHERE call_id NOT IN (SELECT call_id FROM calls)',
  ).run();
  // A retained call may reference a configuration without any activation row,
  // so both references keep a snapshot alive.
  db.prepare(
    `DELETE FROM config_snapshots
      WHERE snapshot_id NOT IN (SELECT snapshot_id FROM config_activations)
        AND snapshot_id NOT IN (SELECT config_snapshot_id FROM calls)
        AND created_at < ?`,
  ).run(cutoff);
  if (deleted > 0 || databaseBytes() > retentionBytes) compact(db);
  // After compaction the physical footprint may still exceed the target because
  // the single newest call (or a sidecar/backup) is larger than it. Say so
  // rather than deleting the last record to satisfy a number.
  const irreducible = databaseBytes() > retentionBytes;
  return { deleted, irreducible, bytes: databaseBytes() };
}
