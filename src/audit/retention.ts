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
    // Clearing the audit records must not leave their template content behind:
    // once no model attempt references a template, the shared row has no user.
    db.exec(
      `DELETE FROM templates
        WHERE template_id NOT IN (
          SELECT template_id FROM model_calls WHERE template_id IS NOT NULL
        )`,
    );
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
/**
 * Reclaim WAL content into the main database and truncate the WAL file.
 *
 * Returns false when a reader prevented completion. That distinction matters:
 * an untruncated WAL contains bytes a later checkpoint can still reclaim, so it
 * must not be treated as permanently unavailable capacity.
 */
function checkpoint(db: DatabaseSync): boolean {
  try {
    // `wal_checkpoint` reports blocking by returning `busy = 1` rather than
    // raising, so the row has to be inspected: assuming success would treat
    // un-checkpointed WAL bytes as permanently unavailable capacity.
    const row = asRow(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get());
    return rowNumber(row['busy'], 0) === 0;
  } catch {
    return false;
  }
}

/**
 * Logical occupied bytes: pages actually in use, excluding free pages.
 *
 * A DELETE does not shrink the file, so evicting on the physical size would keep
 * deleting records while waiting for a VACUUM that never runs inside the loop.
 * The eviction decision therefore uses occupied pages; the physical target is
 * still reported and compacted towards after the loop.
 */
function occupiedBytes(db: DatabaseSync): number {
  const page = asRow(db.prepare('PRAGMA page_count').get());
  const free = asRow(db.prepare('PRAGMA freelist_count').get());
  const size = asRow(db.prepare('PRAGMA page_size').get());
  const used =
    rowNumber(page['page_count']) - rowNumber(free['freelist_count']);
  return Math.max(0, used) * rowNumber(size['page_size']);
}

export interface RetentionOutcome {
  readonly deleted: number;
  /**
   * True when the target cannot be met because the newest remaining call alone
   * exceeds it. Reported instead of deleting the last record: an audit that
   * keeps nothing is worse than one that states its constraint.
   */
  readonly irreducible: boolean;
  /** Total bytes the target applies to, including the WAL and SHM sidecars. */
  readonly bytes: number;
}

/**
 * Delete shared content with no remaining reference.
 *
 * Review snapshots go with their call. Configuration snapshots stay while an
 * activation, a call or a retained stage references them. Templates stay while a
 * model attempt references them. This runs before eviction so unreferenced
 * content cannot inflate the page count and drive deletion of retainable calls,
 * and again afterwards so a just-evicted call releases its shared rows.
 */
function reclaimShared(db: DatabaseSync, olderThan: number): void {
  db.prepare(
    'DELETE FROM snapshots WHERE call_id NOT IN (SELECT call_id FROM calls)',
  ).run();
  db.prepare(
    `DELETE FROM config_snapshots
      WHERE snapshot_id NOT IN (SELECT snapshot_id FROM config_activations)
        AND snapshot_id NOT IN (SELECT config_snapshot_id FROM calls)
        AND snapshot_id NOT IN (
          SELECT config_snapshot_id FROM stages WHERE config_snapshot_id IS NOT NULL
        )
        AND created_at < ?`,
  ).run(olderThan);
  db.prepare(
    `DELETE FROM templates
      WHERE template_id NOT IN (
        SELECT template_id FROM model_calls WHERE template_id IS NOT NULL
      )`,
  ).run();
}

export function runRetention(
  db: DatabaseSync,
  now: number,
  retentionDays: number,
  retentionBytes: number,
  /**
   * Total bytes of auxiliary audit files (the WAL and SHM sidecars).
   *
   * These are reported separately from the database because deleting rows can
   * never reclaim them, and they must not be confused with SQLite's free pages:
   * a freelist page is reclaimable database space, not an auxiliary file.
   */
  auxiliaryBytes: () => number,
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
  // Reclaim after the age-based deletion, not before it: expired calls are what
  // make their templates orphaned, and reclaiming them now keeps that content
  // out of the capacity decision below.
  reclaimShared(db, cutoff);
  // The deletion above grew the WAL, and WAL content is reclaimable. Checkpoint
  // it before measuring, or its bytes would be counted as capacity that the
  // database can never get back and would trigger needless eviction.
  const checkpointed = checkpoint(db);
  let guard = 0;
  // Auxiliary files cannot be reclaimed by deleting rows, so the database budget
  // is what remains of the target after them. The budget is derived from the
  // real auxiliary size, never from `total - occupied`: that difference includes
  // SQLite's free pages, which compaction can reclaim and which must therefore
  // stay inside the database's own budget.
  const databaseBudget = Math.max(0, retentionBytes - auxiliaryBytes());
  // When a reader blocked the checkpoint, the WAL still holds reclaimable bytes.
  // They are not evidence that the database needs to shrink, so this pass defers
  // the capacity decision instead of deleting calls for space it cannot measure
  // honestly.
  if (!checkpointed) {
    return {
      deleted,
      irreducible: false,
      bytes: occupiedBytes(db) + auxiliaryBytes(),
    };
  }
  while (occupiedBytes(db) > databaseBudget && guard < 40) {
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
               COALESCE(length(scores), 0) + COALESCE(length(usage), 0) + 256
             ) AS average FROM calls`,
        )
        .get(),
    );
    const excess = occupiedBytes(db) - databaseBudget;
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
    // A deleted call may have been the last reference to shared content.
    reclaimShared(db, cutoff);
  }
  // Final pass: the loop may have removed the last reference to shared rows.
  reclaimShared(db, cutoff);
  if (deleted > 0 || occupiedBytes(db) + auxiliaryBytes() > retentionBytes)
    compact(db);
  // VACUUM writes a fresh WAL. Checkpoint it before reporting, or the final
  // footprint would include bytes the checkpoint is about to reclaim.
  checkpoint(db);
  // After compaction the physical footprint may still exceed the target because
  // the single newest call (or a sidecar) is larger than it. Say so rather than
  // deleting the last record to satisfy a number.
  const irreducible = occupiedBytes(db) > databaseBudget;
  return { deleted, irreducible, bytes: occupiedBytes(db) + auxiliaryBytes() };
}
