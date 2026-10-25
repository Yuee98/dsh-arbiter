import { existsSync, statSync, unlinkSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Application schema version, carried by `PRAGMA user_version`.
 *
 * This is the *database structure* version, distinct from the per-row record
 * format (`record_format_version`) that says how one record was written. A v1
 * row inside a v2 database is normal; a v2 row inside a v1 database is not.
 */
const SCHEMA_VERSION = 2;

/** How many pre-migration backups to keep; older ones are removed. */
export const BACKUP_KEEP = 2;

/** Record format this build writes and can fully interpret. */
export const RECORD_FORMAT = 2;

/** Record formats this build can still read, newest first. */
export const READABLE_RECORD_FORMATS: readonly number[] = [2, 1];

const SCHEMA_SQL = `
        CREATE TABLE IF NOT EXISTS config_snapshots (
          snapshot_id TEXT PRIMARY KEY,
          content_hash TEXT NOT NULL UNIQUE,
          content TEXT NOT NULL,
          format_version INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS config_activations (
          id TEXT PRIMARY KEY,
          snapshot_id TEXT NOT NULL,
          activated_at INTEGER NOT NULL,
          entry TEXT NOT NULL,
          scope TEXT NOT NULL,
          revision TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS templates (
          template_id TEXT PRIMARY KEY,
          content_hash TEXT NOT NULL UNIQUE,
          content TEXT NOT NULL,
          format_version INTEGER NOT NULL,
          renderer_version TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS calls (
          call_id TEXT PRIMARY KEY,
          ts INTEGER NOT NULL,
          session_id TEXT NOT NULL,
          session_kind TEXT NOT NULL,
          parent_session TEXT,
          profile TEXT,
          workspace TEXT,
          tool TEXT NOT NULL,
          arguments TEXT NOT NULL,
          arguments_schema TEXT,
          cwd TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          config_revision TEXT NOT NULL,
          config_snapshot_id TEXT NOT NULL,
          approval_mode TEXT NOT NULL,
          execution_mode TEXT NOT NULL,
          result TEXT NOT NULL,
          reason TEXT NOT NULL,
          trace TEXT NOT NULL,
          effect TEXT NOT NULL,
          session_record_state TEXT NOT NULL,
          signals TEXT,
          policy_strategy TEXT,
          decision_rules TEXT NOT NULL,
          execution_status TEXT NOT NULL,
          record_format_version INTEGER NOT NULL,
          execution_started_at INTEGER,
          execution_finished_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS calls_ts ON calls(ts DESC);
        CREATE INDEX IF NOT EXISTS calls_result ON calls(result);
        CREATE INDEX IF NOT EXISTS calls_session ON calls(session_id);
        CREATE TABLE IF NOT EXISTS stages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          call_id TEXT NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          stage TEXT NOT NULL,
          result TEXT NOT NULL,
          reason TEXT,
          rule_id TEXT,
          rule_name TEXT,
          decision_rules TEXT,
          config_revision TEXT,
          config_snapshot_id TEXT,
          ts INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS stages_call ON stages(call_id, seq);
        CREATE TABLE IF NOT EXISTS snapshots (
          snapshot_id TEXT PRIMARY KEY,
          call_id TEXT NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
          content_hash TEXT NOT NULL,
          content TEXT NOT NULL,
          format_version INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS model_calls (
          id TEXT PRIMARY KEY,
          call_id TEXT NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
          attempt INTEGER NOT NULL,
          backend TEXT NOT NULL,
          protocol TEXT NOT NULL,
          request TEXT NOT NULL,
          template_id TEXT,
          response_text TEXT,
          parsed TEXT,
          error TEXT,
          started_at INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL,
          estimated_input_tokens INTEGER NOT NULL,
          usage TEXT
        );
        CREATE INDEX IF NOT EXISTS model_calls_call ON model_calls(call_id, attempt);
        CREATE TABLE IF NOT EXISTS candidates (
          candidate_id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          status TEXT NOT NULL,
          rule TEXT NOT NULL,
          stats TEXT NOT NULL,
          evidence TEXT NOT NULL,
          window_start INTEGER NOT NULL,
          window_end INTEGER NOT NULL,
          note TEXT
        );
        CREATE TABLE IF NOT EXISTS analysis_runs (
          id TEXT PRIMARY KEY,
          ran_at INTEGER NOT NULL,
          window_start INTEGER NOT NULL,
          window_end INTEGER NOT NULL,
          considered INTEGER NOT NULL,
          created INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        PRAGMA user_version = ${String(SCHEMA_VERSION)};
      `;

/**
 * Columns this build adds to a v1 database, applied in one transaction.
 *
 * `ADD COLUMN` with a constant default is safe on an existing table, and a
 * nullable column without a default leaves old rows as `NULL` — which the read
 * adapter reports as unknown rather than inventing `0`, `false` or `allow`.
 */
/** A migration that could not be completed; the database is left untouched. */
export class AuditMigrationError extends Error {
  readonly backupPath: string | null;

  constructor(message: string, backupPath: string | null, cause?: unknown) {
    super(message, { cause });
    this.name = 'AuditMigrationError';
    this.backupPath = backupPath;
  }
}

function userVersion(db: DatabaseSync): number {
  const row: unknown = db.prepare('PRAGMA user_version').get();
  if (row === null || typeof row !== 'object' || !('user_version' in row))
    return 0;
  const value = (row as { readonly user_version?: unknown }).user_version ?? 0;
  return typeof value === 'bigint' ? Number(value) : Number(value);
}

function rowCount(
  db: DatabaseSync,
  table: 'calls' | 'config_activations',
): number {
  const row: unknown = db
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .get();
  if (row === null || typeof row !== 'object' || !('count' in row)) return 0;
  const value = (row as { readonly count?: unknown }).count ?? 0;
  return typeof value === 'bigint' ? Number(value) : Number(value);
}

/**
 * Take a consistent copy before touching the structure.
 *
 * `VACUUM INTO` writes a transactionally consistent snapshot of the current
 * database, including committed WAL content, without blocking readers. That is
 * the backup the design requires before a migration; a failed migration keeps
 * it so the operator can go back.
 */
function backupDatabase(db: DatabaseSync, path: string): string {
  const backupPath = `${path}.backup-v${String(userVersion(db))}`;
  try {
    if (existsSync(backupPath)) unlinkSync(backupPath);
    db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
  } catch (error) {
    throw new AuditMigrationError(
      `audit backup failed: ${error instanceof Error ? error.message : String(error)}`,
      null,
      error,
    );
  }
  return backupPath;
}

/** Keep only the newest few backups, so they cannot accumulate without bound. */
export function pruneBackups(
  path: string,
  keep = BACKUP_KEEP,
): readonly string[] {
  const removed: string[] = [];
  const candidates = Array.from({ length: 8 }, (_, index) => index + 1)
    .map((version) => `${path}.backup-v${String(version)}`)
    .filter((candidate) => existsSync(candidate))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  for (const stale of candidates.slice(keep)) {
    try {
      unlinkSync(stale);
      removed.push(stale);
    } catch {
      // A backup that cannot be removed is not a reason to stop serving.
    }
  }
  return removed;
}

/**
 * Upgrade the database to this build's structure version.
 *
 * The sequence is: back up consistently, migrate inside one transaction, verify
 * integrity and row preservation, commit, then prune old backups. On any
 * failure the transaction rolls back, `user_version` stays where it was, the
 * backup is kept, and a typed error is thrown so the store can pause writes for
 * this database instead of corrupting it or blocking approvals.
 */
/** Whether a migrating database must be backed up before it is touched. */
function needsBackup(db: DatabaseSync): boolean {
  return userVersion(db) > 0;
}

/** Verify the structure after the DDL, before the transaction commits. */
function verifyMigration(
  db: DatabaseSync,
  before: { readonly calls: number; readonly activations: number },
): void {
  const integrity: unknown = db.prepare('PRAGMA integrity_check').get();
  const verdict =
    integrity !== null && typeof integrity === 'object'
      ? (integrity as { readonly integrity_check?: unknown }).integrity_check
      : null;
  if (verdict !== 'ok')
    throw new Error(`integrity check reported ${String(verdict)}`);
  if (rowCount(db, 'calls') !== before.calls)
    throw new Error('call row count changed during migration');
  if (rowCount(db, 'config_activations') !== before.activations)
    throw new Error('activation row count changed during migration');
}

/** Columns a v1 database may already carry from an interrupted earlier attempt. */
function columnNames(
  db: DatabaseSync,
  table: 'calls' | 'stages' | 'model_calls',
): ReadonlySet<string> {
  const rows: readonly unknown[] = db
    .prepare(`PRAGMA table_info(${table})`)
    .all();
  const names = new Set<string>();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const name = (row as { readonly name?: unknown }).name;
    if (typeof name === 'string') names.add(name);
  }
  return names;
}

/**
 * Apply the structural change for one version step inside the transaction.
 *
 * The DDL is written with `IF NOT EXISTS` so it is safe after an interrupted
 * attempt whose transaction rolled back. The added columns are checked
 * individually for the same reason: a partially applied earlier run may already
 * have one of them, and `ADD COLUMN` is not idempotent.
 */
function applyStep(db: DatabaseSync, from: number): void {
  db.exec(SCHEMA_SQL);
  if (from >= 2) return;
  const existingCalls = columnNames(db, 'calls');
  const existingStages = columnNames(db, 'stages');
  const existingModels = columnNames(db, 'model_calls');
  const additions: readonly (readonly [string, string, string])[] = [
    ['calls', 'record_format_version', 'INTEGER NOT NULL DEFAULT 1'],
    ['calls', 'arguments_schema', 'TEXT'],
    ['calls', 'execution_started_at', 'INTEGER'],
    ['calls', 'execution_finished_at', 'INTEGER'],
    ['stages', 'rule_name', 'TEXT'],
    ['stages', 'config_snapshot_id', 'TEXT'],
    ['model_calls', 'template_id', 'TEXT'],
  ];
  const present =
    from === 0
      ? undefined
      : {
          calls: existingCalls,
          stages: existingStages,
          model_calls: existingModels,
        };
  // A brand-new database got every column from SCHEMA_SQL above, so there is
  // nothing to add; a v1 database is missing them.
  if (present === undefined) return;
  for (const [table, column, type] of additions) {
    const columns =
      table === 'calls'
        ? present.calls
        : table === 'stages'
          ? present.stages
          : present.model_calls;
    if (!columns.has(column))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/**
 * Upgrade the database to this build's structure version.
 *
 * The sequence is: back up consistently, migrate inside one transaction, verify
 * integrity and row preservation, commit, then prune old backups. On any
 * failure the transaction rolls back, `user_version` stays where it was, the
 * backup is kept, and a typed error is thrown so the store can pause writes for
 * this database instead of corrupting it or blocking approvals.
 */
export function migrateAudit(db: DatabaseSync, path?: string): void {
  const currentVersion = userVersion(db);
  if (currentVersion > SCHEMA_VERSION) {
    throw new AuditMigrationError(
      `audit database schema ${String(currentVersion)} is newer than this plugin (${String(SCHEMA_VERSION)}); refusing to modify it`,
      null,
    );
  }
  if (currentVersion === SCHEMA_VERSION) return;

  // A fresh database has nothing to preserve, so it is created directly: a
  // backup of an empty file would only add noise.
  const fresh = currentVersion === 0;
  const backupPath =
    needsBackup(db) && path !== undefined ? backupDatabase(db, path) : null;
  const before = {
    calls: fresh ? 0 : rowCount(db, 'calls'),
    activations: fresh ? 0 : rowCount(db, 'config_activations'),
  };

  db.exec('BEGIN IMMEDIATE');
  try {
    applyStep(db, currentVersion);
    db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`);
    if (!fresh) verifyMigration(db, before);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Keep the original error; a rollback failure adds no useful signal.
    }
    throw new AuditMigrationError(
      `audit migration failed: ${error instanceof Error ? error.message : String(error)}`,
      backupPath,
      error,
    );
  }
  if (backupPath !== null && path !== undefined) pruneBackups(path);
}
