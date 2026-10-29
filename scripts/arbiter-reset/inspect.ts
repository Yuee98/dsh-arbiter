/**
 * Reading a candidate audit file without modifying it.
 *
 * Two rules decide the shape of this module.
 *
 * 1. **The original is never handed to SQLite.** Opening a database — even
 *    read-only — lets SQLite recover a WAL, checkpoint it and drop the
 *    `-shm`/`-wal` sidecars. A tool that promises "dry run changes nothing"
 *    cannot open the file it is inspecting, so every structural read happens on
 *    a throwaway copy that is deleted before the function returns.
 *
 * 2. **The decision comes from the build, not from a version number.** The reset
 *    target is *exactly* the file the running build refuses as an unsupported
 *    structure, which `auditFileState` decides from the header stamp alone. A
 *    tool that hard-coded "version 3 is current" would silently start treating
 *    current data as old the next time that number moves.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { RECORD_FORMAT, auditFileState } from '../../src/audit/schema.ts';

/** The 16 bytes every SQLite 3 file starts with. */
const SQLITE_MAGIC = 'SQLite format 3\u0000';

/** Bytes read to recognise the file and its application version. */
const HEADER_BYTES = 100;

/** Bytes per read while hashing a file. */
const HASH_CHUNK = 1 << 20;

/**
 * Sidecar suffixes SQLite keeps beside a database.
 *
 * `-journal` is listed for completeness: the retired chain ran in WAL mode, but
 * a copy interrupted at the wrong moment can leave a rollback journal behind,
 * and such a file belongs to the database it was written beside.
 */
export const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

/** How one candidate file relates to the structure this build can read. */
export type DatabaseKind =
  /** No file at this path. */
  | 'absent'
  /** Present, but not a SQLite database (or not a regular file). */
  | 'not-sqlite'
  /** A SQLite file with no application table: nothing to preserve, nothing to delete. */
  | 'empty'
  /** A database this build refuses because its structure version is not current. */
  | 'unsupported'
  /** A database written by a newer build: not this build's to modify or delete. */
  | 'newer'
  /** A database in the structure this build creates and reads. */
  | 'current';

/** Rows one column value accounts for. */
export interface ValueCount {
  readonly value: string;
  readonly records: number;
}

/** What one file is, as far as the reset needs to know. */
export interface DatabaseProbe {
  readonly kind: DatabaseKind;
  readonly bytes: number;
  readonly sha256: string | null;
  /** Structure version from the header, when the stamp is not the current one. */
  readonly version: number | null;
  /** Application tables the file actually has. */
  readonly tables: readonly string[];
  /** Row count per table, for the operator's before/after tally. */
  readonly records: Readonly<Record<string, number>>;
  /** Rows per `calls.profile`, so the plan can name the profiles affected. */
  readonly profiles: readonly ValueCount[];
  /** Rows per `calls.workspace`, so the plan can name the projects affected. */
  readonly workspaces: readonly ValueCount[];
  /** Rows in `calls` written in a record format this build cannot read. */
  readonly foreignRecords: number;
  /** Rows in `calls` written in the record format this build writes. */
  readonly currentFormatRecords: number;
  /** Why the structure could not be inspected, when the copy could not be read. */
  readonly problem: string | null;
}

/** The probe for a path with no file. */
export function absentProbe(): DatabaseProbe {
  return {
    kind: 'absent',
    bytes: 0,
    sha256: null,
    version: null,
    tables: [],
    records: {},
    profiles: [],
    workspaces: [],
    foreignRecords: 0,
    currentFormatRecords: 0,
    problem: null,
  };
}

/**
 * The few file facts this tool needs.
 *
 * A narrowed record rather than a `Stats` value: `statSync` has a bigint
 * overload whose `size` is not a `number`, and picking it up would let a byte
 * count arrive here as a `bigint` the report cannot print.
 */
interface FileFacts {
  readonly size: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}

/** The facts of one path, or `null` when it cannot be read. */
function factsOf(path: string, follow: boolean): FileFacts | null {
  try {
    const stats = follow ? statSync(path) : lstatSync(path);
    return {
      size: stats.size,
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      isSymbolicLink: stats.isSymbolicLink(),
    };
  } catch {
    return null;
  }
}

/** Whether the path is a directory (following a symlink). */
export function isDirectory(path: string): boolean {
  return factsOf(path, true)?.isDirectory === true;
}

/**
 * SHA-256 of a whole file, streamed in fixed-size chunks.
 *
 * A reset target can be a large database, so the digest that pins the plan is
 * computed without reading the file into memory.
 */
export function sha256OfFile(path: string): string | null {
  const chunk = Buffer.alloc(HASH_CHUNK);
  const hash = createHash('sha256');
  let handle: number | null = null;
  try {
    handle = openSync(path, 'r');
    for (;;) {
      const read = readSync(handle, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
    }
    return hash.digest('hex');
  } catch {
    return null;
  } finally {
    if (handle !== null) closeSync(handle);
  }
}

/** Whether the file starts with the SQLite magic, read without a connection. */
function hasSqliteHeader(path: string): boolean {
  const header = Buffer.alloc(HEADER_BYTES);
  let handle: number | null = null;
  try {
    handle = openSync(path, 'r');
    const read = readSync(handle, header, 0, HEADER_BYTES, 0);
    return (
      read > 0 && header.subarray(0, 16).toString('latin1') === SQLITE_MAGIC
    );
  } catch {
    return false;
  } finally {
    if (handle !== null) closeSync(handle);
  }
}

/** One column of a SQLite row, by name, without trusting the row's shape. */
function fieldOf(row: unknown, name: string): unknown {
  if (row === null || typeof row !== 'object') return undefined;
  return Object.hasOwn(row, name) ? Reflect.get(row, name) : undefined;
}

/** The table names one SQLite file holds, ignoring SQLite's own tables. */
function tableNames(db: DatabaseSync): readonly string[] {
  const rows: readonly unknown[] = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all();
  const names: string[] = [];
  for (const row of rows) {
    const name = fieldOf(row, 'name');
    if (typeof name === 'string' && !name.startsWith('sqlite_'))
      names.push(name);
  }
  return names;
}

/** Whether one table has a column, asked of the file itself. */
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows: readonly unknown[] = db
    .prepare(`PRAGMA table_info("${table}")`)
    .all();
  return rows.some((row) => fieldOf(row, 'name') === column);
}

/** A table name safe to interpolate as a quoted identifier. */
function isPlainTableName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name);
}

/** A count as a number, refusing to report a non-numeric result as zero. */
function countOf(row: unknown): number {
  const count = fieldOf(row, 'count');
  if (typeof count === 'number') return count;
  if (typeof count === 'bigint') return Number(count);
  return Number.NaN;
}

/** Rows per table, plus the rows written in an unreadable record format. */
function readRows(
  db: DatabaseSync,
  tables: readonly string[],
): Pick<DatabaseProbe, 'records' | 'foreignRecords' | 'currentFormatRecords'> {
  const records: Record<string, number> = {};
  for (const table of tables) {
    if (!isPlainTableName(table)) continue;
    records[table] = countOf(
      db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get(),
    );
  }
  let foreignRecords = 0;
  let currentFormatRecords = 0;
  if (
    tables.includes('calls') &&
    hasColumn(db, 'calls', 'record_format_version')
  ) {
    foreignRecords = countOf(
      db
        .prepare(
          'SELECT COUNT(*) AS count FROM calls WHERE record_format_version IS NULL OR record_format_version <> ?',
        )
        .get(RECORD_FORMAT),
    );
    currentFormatRecords = countOf(
      db
        .prepare(
          'SELECT COUNT(*) AS count FROM calls WHERE record_format_version = ?',
        )
        .get(RECORD_FORMAT),
    );
  }
  return { records, foreignRecords, currentFormatRecords };
}

/** Rows per value of one `calls` column, or none when the column is absent. */
function groupBy(
  db: DatabaseSync,
  tables: readonly string[],
  column: string,
): readonly ValueCount[] {
  if (!tables.includes('calls') || !hasColumn(db, 'calls', column)) return [];
  const rows: readonly unknown[] = db
    .prepare(
      `SELECT "${column}" AS value, COUNT(*) AS count FROM calls GROUP BY "${column}" ORDER BY count DESC`,
    )
    .all();
  const counts: ValueCount[] = [];
  for (const row of rows) {
    const value = fieldOf(row, 'value');
    counts.push({
      value: typeof value === 'string' ? value : '(none)',
      records: countOf(row),
    });
  }
  return counts;
}

/** What a copy of the file says about its structure. */
interface StructureRead {
  readonly tables: readonly string[];
  readonly records: Readonly<Record<string, number>>;
  readonly profiles: readonly ValueCount[];
  readonly workspaces: readonly ValueCount[];
  readonly foreignRecords: number;
  readonly currentFormatRecords: number;
  readonly problem: string | null;
}

const UNREADABLE: StructureRead = {
  tables: [],
  records: {},
  profiles: [],
  workspaces: [],
  foreignRecords: 0,
  currentFormatRecords: 0,
  problem: null,
};

/**
 * Read one database's structure from a disposable copy.
 *
 * The sidecars are copied alongside it because a database whose DDL or rows
 * landed only in the WAL would otherwise look empty on a copy made from the main
 * file alone — the same reason the build's own refusal probe copies them.
 */
function readStructureCopy(path: string): StructureRead {
  const staging = mkdtempSync(join(tmpdir(), 'arbiter-reset-inspect-'));
  try {
    const copy = join(staging, 'arbiter.db');
    copyFileSync(path, copy);
    for (const suffix of SIDECAR_SUFFIXES) {
      if (existsSync(`${path}${suffix}`))
        copyFileSync(`${path}${suffix}`, `${copy}${suffix}`);
    }
    const db = new DatabaseSync(copy);
    try {
      const tables = tableNames(db);
      return {
        tables,
        ...readRows(db, tables),
        profiles: groupBy(db, tables, 'profile'),
        workspaces: groupBy(db, tables, 'workspace'),
        problem: null,
      };
    } finally {
      db.close();
    }
  } catch (error) {
    // A copy that cannot be read proves nothing about the original, so the
    // structure is reported as unknown rather than as empty.
    return {
      ...UNREADABLE,
      problem: `structure could not be read from a copy: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Inspect one candidate file.
 *
 * Reading the header decides what the file is; a database is opened only as a
 * copy, and a newer build's file is not read out at all — this build does not
 * know what its structure means, so even counting its rows would be a guess.
 */
export function inspectDatabase(path: string): DatabaseProbe {
  const stats = factsOf(path, true);
  if (stats === null) return absentProbe();
  const bytes = stats.size;
  const sha256 = sha256OfFile(path);
  if (!stats.isFile) {
    return {
      ...absentProbe(),
      kind: 'not-sqlite',
      bytes,
      sha256,
      problem: 'the path is not a regular file',
    };
  }
  if (!hasSqliteHeader(path)) {
    return {
      ...absentProbe(),
      kind: 'not-sqlite',
      bytes,
      sha256,
      problem: 'the file does not start with the SQLite header',
    };
  }
  const state = auditFileState(path);
  switch (state.kind) {
    case 'newer':
      return {
        ...absentProbe(),
        kind: 'newer',
        bytes,
        sha256,
        version: state.version,
      };
    case 'current':
      return {
        kind: 'current',
        bytes,
        sha256,
        version: null,
        ...readStructureCopy(path),
      };
    case 'unsupported': {
      const read = readStructureCopy(path);
      // `unsupported` is decided by the stamp; a SQLite file with no application
      // table is a leftover, not a history to delete.
      if (read.problem === null && read.tables.length === 0)
        return {
          kind: 'empty',
          bytes,
          sha256,
          version: state.version,
          ...read,
        };
      return {
        kind: 'unsupported',
        bytes,
        sha256,
        version: state.version,
        ...read,
      };
    }
    case 'new':
      // The header probe only reports `new` for a missing or short file, and the
      // magic check above already excluded both.
      return {
        ...absentProbe(),
        kind: 'not-sqlite',
        bytes,
        sha256,
        problem: 'the file is too short to hold a SQLite header',
      };
  }
}
