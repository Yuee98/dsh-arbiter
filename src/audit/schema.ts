/**
 * The one audit database structure this build creates and reads.
 *
 * There is no migration chain and no compatibility read path: a database is
 * either in the structure below or it is refused with a reason. The design fixes
 * one audit shape per release and leaves older test data to an explicit reset
 * operation, so an old file is never rewritten in place and old rows are never
 * reinterpreted as current scores.
 *
 * Two refusals survive because they protect data rather than an old format:
 *
 * - a file written by a **newer** build is not modified at all, so a downgrade
 *   cannot corrupt a database this build does not understand;
 * - a file whose **tables are gone** is not recreated, because an empty table
 *   would report a lost history as a complete one.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * Application schema version, carried by `PRAGMA user_version`.
 *
 * This is the *database structure* version, distinct from the per-row record
 * format (`record_format_version`) that says how one record was written. Only
 * this version is supported; a file carrying another one must be reset rather
 * than upgraded.
 *
 * The number is a **discriminator, not a migration step**. It is incremented
 * whenever the structure changes, so the previous release's file can never be
 * mistaken for this one: the retired `signals` and `policy_strategy` columns are
 * gone, and a build that only compared table names would have opened the old
 * file and called its rows current. There is no upgrade from one number to the
 * next — a mismatch means the audit history has to be reset.
 */
const SCHEMA_VERSION = 3;

/**
 * Record format this build writes and can fully interpret.
 *
 * There is exactly one: `formatOf` and the list reader treat any other value as
 * unreadable rather than downgrading it to today's semantics.
 */
export const RECORD_FORMAT = 2;

/**
 * Supported formats per structured-content kind.
 *
 * These are independent registries: a call record being readable says nothing
 * about whether a configuration snapshot, review snapshot or template can be
 * interpreted, so each kind is validated against its own set. Only the format
 * this build writes is listed; anything else is reported as unreadable instead
 * of being read under today's semantics.
 */
export const READABLE_CONFIG_SNAPSHOT_FORMATS: readonly number[] = [1];
export const READABLE_REVIEW_SNAPSHOT_FORMATS: readonly number[] = [1];
export const READABLE_TEMPLATE_FORMATS: readonly number[] = [1];

/**
 * The structure this build writes.
 *
 * `CREATE TABLE IF NOT EXISTS` is kept so an interrupted first creation cannot
 * leave a half-built file that later looks complete; the version stamp is the
 * last statement, so it is only written once every table exists.
 */
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
          -- The current review shape: the scored pair, the stage the review
          -- reached, and the attempts' usage summary. A record this build writes
          -- fills these and only these.
          scores TEXT,
          review_stage TEXT,
          usage TEXT,
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
          usage TEXT,
          normalized_usage TEXT,
          -- Why this attempt produced no answer, as the transport classified it
          -- (provider-refusal / unreadable-answer / transport). NULL means the
          -- attempt succeeded, which is different from "unknown".
          failure_kind TEXT
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

/** Every table the structure above defines; a missing one means a lost history. */
const REQUIRED_TABLES: readonly string[] = [
  'config_snapshots',
  'config_activations',
  'templates',
  'calls',
  'stages',
  'snapshots',
  'model_calls',
  'candidates',
  'analysis_runs',
  'meta',
];

/**
 * Every column this build reads or writes, per table.
 *
 * Derived from the structure above rather than hand-listed. A hand-written list
 * is what let a file missing `model_calls.response_text` pass start-up and then
 * fail on every write, one record at a time: the check only covered columns an
 * earlier migration happened to add. Building the reference structure in memory
 * makes the comparison follow the writer by construction, so it cannot fall
 * behind a column again.
 */
function canonicalColumns(): ReadonlyMap<string, ReadonlySet<string>> {
  const reference = new DatabaseSync(':memory:');
  try {
    reference.exec(SCHEMA_SQL);
    const columns = new Map<string, ReadonlySet<string>>();
    for (const table of REQUIRED_TABLES)
      columns.set(table, columnNames(reference, table));
    return columns;
  } finally {
    reference.close();
  }
}

let canonicalCache: ReadonlyMap<string, ReadonlySet<string>> | null = null;

/** The reference structure, built once per process. */
function requiredColumns(): ReadonlyMap<string, ReadonlySet<string>> {
  canonicalCache ??= canonicalColumns();
  return canonicalCache;
}

/**
 * A database this build will not open.
 *
 * The store catches this, pauses writes for that database and reports the
 * message through `health()`; approvals never depend on audit storage, so the
 * rest of the plugin keeps working.
 */
export class AuditSchemaError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'AuditSchemaError';
  }
}

/** The refusal message for a file this build does not open. */
function refusalFor(state: AuditFileState): string | null {
  switch (state.kind) {
    case 'new':
    case 'current':
      return null;
    case 'newer':
      return `audit database schema ${String(state.version)} is newer than this plugin (${String(SCHEMA_VERSION)}); refusing to modify it`;
    case 'unsupported':
      return `audit database schema ${String(state.version)} is not supported by this build (only ${String(SCHEMA_VERSION)} is read); reset the audit database instead of migrating it`;
  }
}

/**
 * The refusal reason for one audit path, read without opening the database.
 *
 * The store asks this before it creates a connection, so a file it refuses is
 * never touched by SQLite: no WAL recovery, no checkpoint, no rewritten header.
 * `null` means the file may be opened — it is either absent or already current,
 * and the remaining structural checks run on the live connection.
 */
export function auditRefusal(path: string): string | null {
  return refusalFor(auditFileState(path));
}

/** The 16 bytes every SQLite 3 file starts with. */
const SQLITE_MAGIC = 'SQLite format 3\u0000';

/**
 * What one audit file is, decided without opening it as a database.
 *
 * `unsupported` is the important outcome: reading the version from the header
 * means a file this build refuses is never handed to SQLite at all. Opening it
 * — even read-only — lets SQLite recover a WAL and rewrite the main file and its
 * sidecars, so a refusal that claims to leave the file untouched would be a
 * false claim about a file we must not touch in the first place.
 */
type AuditFileState =
  | { readonly kind: 'new' }
  | { readonly kind: 'current' }
  | { readonly kind: 'unsupported'; readonly version: number }
  | { readonly kind: 'newer'; readonly version: number };

/**
 * Read `PRAGMA user_version` straight out of the file header.
 *
 * Bytes 60–63 of the header hold the application version as a big-endian
 * 32-bit integer. A file that is absent, empty, or not SQLite at all reports
 * `new`: there is nothing to preserve, and `openAuditSchema` still refuses to
 * recreate a populated structure it cannot read.
 */
export function auditFileState(path: string): AuditFileState {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { kind: 'new' };
  }
  // A shorter file cannot hold a header, so it holds no history either.
  if (size < 100) return { kind: 'new' };
  const header = Buffer.alloc(100);
  const handle = openSync(path, 'r');
  try {
    readSync(handle, header, 0, 100, 0);
  } finally {
    closeSync(handle);
  }
  if (header.subarray(0, 16).toString('latin1') !== SQLITE_MAGIC)
    return { kind: 'new' };
  const version = header.readUInt32BE(60);
  if (version > SCHEMA_VERSION) return { kind: 'newer', version };
  if (version !== SCHEMA_VERSION) return { kind: 'unsupported', version };
  return { kind: 'current' };
}

function userVersion(db: DatabaseSync): number {
  const row: unknown = db.prepare('PRAGMA user_version').get();
  if (row === null || typeof row !== 'object' || !('user_version' in row))
    return 0;
  const value = (row as { readonly user_version?: unknown }).user_version ?? 0;
  return typeof value === 'bigint' ? Number(value) : Number(value);
}

/** The columns one table actually has, whatever its declaration claims. */
function columnNames(db: DatabaseSync, table: string): ReadonlySet<string> {
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

/** The tables this file actually has, whatever `user_version` claims. */
function tableNames(db: DatabaseSync): ReadonlySet<string> {
  const rows: readonly unknown[] = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all();
  const names = new Set<string>();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const name = (row as { readonly name?: unknown }).name;
    if (typeof name === 'string') names.add(name);
  }
  return names;
}

/** Create the structure in one transaction, then stamp the version. */
function createSchema(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(SCHEMA_SQL);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Keep the original error; a rollback failure adds no useful signal.
    }
    throw new AuditSchemaError(
      `audit database could not be created: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

/**
 * Open one audit database for this build.
 *
 * A genuinely new file is created and stamped. An existing file is accepted only
 * when it carries this structure version, every required table and every column a
 * current record writes; anything else is refused with a message naming the
 * reason, and the file is left exactly as it was. Nothing is backed up, upgraded,
 * recreated or reinterpreted.
 *
 * `user_version = 0` is not proof that a file is new: SQLite reports 0 for any
 * file that never had the pragma written, including one that already holds this
 * plugin's tables. Fresh therefore means "no application table exists", and a
 * populated unstamped file is refused like any other unsupported structure.
 */
export function openAuditSchema(db: DatabaseSync): void {
  const version = userVersion(db);
  // A newer file is not this build's to modify: a downgrade must not rewrite a
  // structure it cannot interpret.
  if (version > SCHEMA_VERSION) {
    throw new AuditSchemaError(
      `audit database schema ${String(version)} is newer than this plugin (${String(SCHEMA_VERSION)}); refusing to modify it`,
    );
  }
  const tables = tableNames(db);
  // A genuinely new file has no application table yet and no stamp; SQLite
  // reports 0 for any file that never had the pragma written, so "no tables" is
  // the only honest test for "nothing here to preserve". The header probe in
  // `auditRefusal` already refused every stamped mismatch before this ran, so
  // this branch only sees a file that is empty or carries no stamp.
  if (version === 0 && tables.size === 0) {
    createSchema(db);
    return;
  }
  // The stamp decides first, because an older release's file is unsupported as a
  // whole: naming its own missing tables would describe a reset as a repair.
  if (version !== SCHEMA_VERSION) {
    throw new AuditSchemaError(
      `audit database schema ${String(version)} is not supported by this build (only ${String(SCHEMA_VERSION)} is read); reset the audit database instead of migrating it`,
    );
  }
  const absent = REQUIRED_TABLES.filter((table) => !tables.has(table));
  if (absent.length > 0) {
    throw new AuditSchemaError(
      `audit database is missing the ${absent.join(', ')} table(s); this build does not recreate them, so the audit history must be reset`,
    );
  }
  const drift = [...requiredColumns()].flatMap(([table, columns]) => {
    const present = columnNames(db, table);
    return [...columns]
      .filter((column) => !present.has(column))
      .map((column) => `${table}.${column}`);
  });
  if (drift.length > 0) {
    throw new AuditSchemaError(
      `audit database is missing the ${drift.join(', ')} column(s); this build does not alter an existing structure, so the audit history must be reset`,
    );
  }
}
