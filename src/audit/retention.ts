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
function effectiveBytes(db: DatabaseSync): number {
  const page = asRow(db.prepare('PRAGMA page_count').get());
  const free = asRow(db.prepare('PRAGMA freelist_count').get());
  const size = asRow(db.prepare('PRAGMA page_size').get());
  const used =
    rowNumber(page['page_count']) - rowNumber(free['freelist_count']);
  return Math.max(0, used) * rowNumber(size['page_size']);
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
export function runRetention(
  db: DatabaseSync,
  now: number,
  retentionDays: number,
  retentionBytes: number,
  databaseBytes: () => number,
): number {
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
  while (effectiveBytes(db) > retentionBytes && guard < 40) {
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
    const excess = effectiveBytes(db) - retentionBytes;
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
  // Shared snapshots without a referencing call are no longer useful.
  db.prepare(
    'DELETE FROM snapshots WHERE call_id NOT IN (SELECT call_id FROM calls)',
  ).run();
  if (deleted > 0 || databaseBytes() > retentionBytes) compact(db);
  return deleted;
}
