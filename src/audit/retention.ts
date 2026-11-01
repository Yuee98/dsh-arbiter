import type { DatabaseSync } from 'node:sqlite';
import { asRow, rowNumber, rowChanges } from './rows.js';
import {
  clearToolResults,
  expireToolResults,
  retentionGroupCount,
  oldestRetentionGroups,
  deleteRetentionGroup,
} from './tool-result-retention.js';
import { toolResultFileBytes } from './tool-result-files.js';
import { recoverToolResults } from './tool-results.js';
export function clearCalls(db: DatabaseSync): number {
  const count = rowNumber(
    asRow(db.prepare('SELECT COUNT(*) AS count FROM calls').get())['count'],
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    clearToolResults(db);
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
  readonly cleanupPending?: boolean;
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
  auxiliaryBytes: () => number,
  bodyPath: string,
): RetentionOutcome {
  const cutoff = now - retentionDays * 86_400_000;
  let deleted = expireRecords(db, cutoff);
  let cleanupPending = !recoverToolResults(db, bodyPath).ok;
  let checkpointed = checkpoint(db);
  const total = (): number =>
    occupiedBytes(db) + auxiliaryBytes() + toolResultFileBytes(bodyPath);
  for (
    let guard = 0;
    guard < 40 && !cleanupPending && checkpointed && total() > retentionBytes;
    guard += 1
  ) {
    const remaining = retentionGroupCount(db);
    if (remaining <= 1) break;
    const groups = oldestRetentionGroups(db, Math.min(32, remaining - 1));
    for (const group of groups) {
      if (total() <= retentionBytes) break;
      deleted += deleteRetentionGroup(db, group.sessionId, group.callId);
      cleanupPending = !recoverToolResults(db, bodyPath).ok;
      reclaimShared(db, cutoff);
      checkpointed = checkpoint(db);
      // Reclaim failure cannot justify sacrificing another unrelated record.
      if (cleanupPending || !checkpointed) break;
    }
  }
  reclaimShared(db, cutoff);
  if (deleted > 0 || total() > retentionBytes) compact(db);
  checkpoint(db);
  const bytes = total();
  return {
    deleted,
    irreducible: !cleanupPending && checkpointed && bytes > retentionBytes,
    bytes,
    ...(cleanupPending ? { cleanupPending: true } : {}),
  };
}
function expireRecords(db: DatabaseSync, cutoff: number): number {
  db.exec('BEGIN IMMEDIATE');
  try {
    expireToolResults(db, cutoff);
    const deleted = rowChanges(
      db.prepare('DELETE FROM calls WHERE ts < ?').run(cutoff),
    );
    reclaimShared(db, cutoff);
    db.exec('COMMIT');
    return deleted;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
