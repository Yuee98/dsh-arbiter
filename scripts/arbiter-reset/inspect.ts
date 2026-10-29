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
 * 2. **A fact that cannot be established is never guessed.** Every field below
 *    is either read from the file or explicitly marked unknown, and an unknown
 *    fact makes the caller refuse the file. The failure this prevents is not a
 *    missing feature: a copy that could not be opened used to look exactly like a
 *    database with no history, and a `calls` table without a `profile` column
 *    used to look exactly like "no other profile is affected". Both answers
 *    permitted a deletion that nothing had established was safe.
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

import { RECORD_FORMAT, openAuditSchema } from '../../src/audit/schema.ts';

/** The 16 bytes every SQLite 3 file starts with. */
const SQLITE_MAGIC = 'SQLite format 3\u0000';

/** Bytes read to recognise the file and its application version. */
const HEADER_BYTES = 100;

/** Byte offset of the application version in the SQLite header. */
const HEADER_VERSION_OFFSET = 60;

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
  /** A SQLite file with no application table: nothing to preserve, nothing to prove. */
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
  /**
   * Structure version from the main file header, when it is not the current one.
   *
   * This is the version the *header* claims. It is not necessarily the version
   * SQLite would report once a WAL is applied — see `effectiveVersion`.
   */
  readonly version: number | null;
  /**
   * Structure version actually in force, read from the copy with its sidecars.
   *
   * `null` when the copy could not be read. A version committed only to the WAL
   * is invisible in the main header, so a header-only reading would classify a
   * newer database as old and delete it.
   */
  readonly effectiveVersion: number | null;
  /** Application tables the file actually has, or `null` when unread. */
  readonly tables: readonly string[] | null;
  /** Row count per table, or `null` when unread. */
  readonly records: Readonly<Record<string, number>> | null;
  /**
   * Rows per `calls.profile`, or `null` when the column does not exist.
   *
   * `null` means attribution is unknown, which is a different fact from an empty
   * list: an empty list would claim nothing belongs to another profile.
   */
  readonly profiles: readonly ValueCount[] | null;
  /** Rows per `calls.workspace`, or `null` when the column does not exist. */
  readonly workspaces: readonly ValueCount[] | null;
  /** Rows in `calls` written in a record format this build cannot read. */
  readonly foreignRecords: number | null;
  /** Rows in `calls` written in the record format this build writes. */
  readonly currentFormatRecords: number | null;
  /** Whether the `calls` table has a `profile` column at all. */
  readonly hasProfileColumn: boolean;
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
    effectiveVersion: null,
    tables: null,
    records: null,
    profiles: null,
    workspaces: null,
    foreignRecords: null,
    currentFormatRecords: null,
    hasProfileColumn: false,
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

/** The header bytes of a file, or `null` when they cannot be read. */
function headerOf(path: string): Buffer | null {
  const header = Buffer.alloc(HEADER_BYTES);
  let handle: number | null = null;
  try {
    handle = openSync(path, 'r');
    const read = readSync(handle, header, 0, HEADER_BYTES, 0);
    return read >= HEADER_VERSION_OFFSET + 4 ? header : null;
  } catch {
    return null;
  } finally {
    if (handle !== null) closeSync(handle);
  }
}

/** Whether the header bytes name a SQLite 3 database. */
function isSqliteHeader(header: Buffer | null): boolean {
  return (
    header !== null &&
    header.subarray(0, 16).toString('latin1') === SQLITE_MAGIC
  );
}

/** The structure version the main file header claims. */
export function headerVersion(path: string): number | null {
  const header = headerOf(path);
  if (!isSqliteHeader(header)) return null;
  // Non-null: `isSqliteHeader` already required the header to be present.
  return header === null ? null : header.readUInt32BE(HEADER_VERSION_OFFSET);
}

/** One column of a SQLite row, by name, without trusting the row's shape. */
function fieldOf(row: unknown, name: string): unknown {
  if (row === null || typeof row !== 'object') return undefined;
  return Object.hasOwn(row, name) ? Reflect.get(row, name) : undefined;
}

/** A count as a number, or `null` when SQLite did not answer with one. */
function countOf(row: unknown): number | null {
  const count = fieldOf(row, 'count');
  if (typeof count === 'number') return count;
  if (typeof count === 'bigint') return Number(count);
  return null;
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

/** Rows per table, or `null` when any table could not be counted. */
function readRows(
  db: DatabaseSync,
  tables: readonly string[],
): Readonly<Record<string, number>> | null {
  const records: Record<string, number> = {};
  for (const table of tables) {
    if (!isPlainTableName(table)) return null;
    const count = countOf(
      db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get(),
    );
    if (count === null) return null;
    records[table] = count;
  }
  return records;
}

/** One count over `calls`, or `null` when it could not be read. */
function countCalls(
  db: DatabaseSync,
  tables: readonly string[],
  where: string,
  parameters: readonly (string | number)[] = [],
): number | null {
  if (!tables.includes('calls')) return 0;
  try {
    return countOf(
      db
        .prepare(`SELECT COUNT(*) AS count FROM calls WHERE ${where}`)
        .get(...parameters),
    );
  } catch {
    return null;
  }
}

/** Rows per value of one `calls` column, or `null` when it cannot be attributed. */
function groupBy(
  db: DatabaseSync,
  tables: readonly string[],
  column: string,
): readonly ValueCount[] | null {
  if (!tables.includes('calls')) return [];
  if (!hasColumn(db, 'calls', column)) return null;
  try {
    const rows: readonly unknown[] = db
      .prepare(
        `SELECT "${column}" AS value, COUNT(*) AS count FROM calls GROUP BY "${column}" ORDER BY count DESC`,
      )
      .all();
    const counts: ValueCount[] = [];
    for (const row of rows) {
      const value = fieldOf(row, 'value');
      const records = countOf(row);
      if (records === null) return null;
      counts.push({
        value: typeof value === 'string' ? value : '(none)',
        records,
      });
    }
    return counts;
  } catch {
    return null;
  }
}

/** What a copy of the file says about its structure. */
interface StructureRead {
  readonly effectiveVersion: number | null;
  readonly tables: readonly string[] | null;
  readonly records: Readonly<Record<string, number>> | null;
  readonly profiles: readonly ValueCount[] | null;
  readonly workspaces: readonly ValueCount[] | null;
  readonly foreignRecords: number | null;
  readonly currentFormatRecords: number | null;
  readonly hasProfileColumn: boolean;
  readonly problem: string | null;
}

const UNREADABLE: StructureRead = {
  effectiveVersion: null,
  tables: null,
  records: null,
  profiles: null,
  workspaces: null,
  foreignRecords: null,
  currentFormatRecords: null,
  hasProfileColumn: false,
  problem: null,
};

/** The effective `PRAGMA user_version` of one open database. */
function userVersionOf(db: DatabaseSync): number | null {
  try {
    const row: unknown = db.prepare('PRAGMA user_version').get();
    const value = fieldOf(row, 'user_version');
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    return null;
  } catch {
    return null;
  }
}

/**
 * Read one database's structure from a disposable copy.
 *
 * The sidecars are copied alongside it because a database whose DDL or rows
 * landed only in the WAL would otherwise look empty on a copy made from the main
 * file alone. The copy also decides the **effective** structure version: a
 * `PRAGMA user_version` committed inside an uncheckpointed WAL never reaches the
 * main header, so the header alone cannot say whether this file is current, old
 * or newer.
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
      const effectiveVersion = userVersionOf(db);
      const tables = tableNames(db);
      const hasProfileColumn =
        tables.includes('calls') && hasColumn(db, 'calls', 'profile');
      return {
        effectiveVersion,
        tables,
        records: readRows(db, tables),
        profiles: groupBy(db, tables, 'profile'),
        workspaces: groupBy(db, tables, 'workspace'),
        foreignRecords: countCalls(
          db,
          tables,
          'record_format_version IS NULL OR record_format_version <> ?',
          [RECORD_FORMAT],
        ),
        currentFormatRecords: countCalls(
          db,
          tables,
          'record_format_version = ?',
          [RECORD_FORMAT],
        ),
        hasProfileColumn,
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
 * Decide the kind of file from the version that is actually in force.
 *
 * Both readings matter. The header decides what an unreadable copy must be
 * treated as; the effective version decides what a readable copy is. A
 * disagreement between them is not resolved in favour of either: the file is
 * reported as unreadable, because one of the two readings is wrong and this tool
 * must not pick which.
 */
function kindOf(
  headerVersionValue: number,
  read: StructureRead,
  currentVersion: number,
): { readonly kind: DatabaseKind; readonly problem: string | null } {
  if (read.problem !== null)
    return { kind: 'unsupported', problem: read.problem };
  const effective = read.effectiveVersion;
  if (effective === null)
    return {
      kind: 'unsupported',
      problem: 'the effective schema version could not be read from the copy',
    };
  if (effective !== headerVersionValue)
    return {
      kind: 'unsupported',
      problem: `the main file header declares schema ${String(
        headerVersionValue,
      )} but the effective version with its log is ${String(
        effective,
      )}; this tool does not decide which reading is right`,
    };
  if (effective > currentVersion) return { kind: 'newer', problem: null };
  if (effective !== currentVersion)
    return { kind: 'unsupported', problem: null };
  return { kind: 'current', problem: null };
}

/**
 * Inspect one candidate file.
 *
 * Reading the header decides whether the name may be treated as a database at
 * all; the structure then comes only from a copy, and a file whose effective
 * version disagrees with its header is left for a human.
 */
export function inspectDatabase(
  path: string,
  currentVersion: number,
): DatabaseProbe {
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
  if (!isSqliteHeader(headerOf(path))) {
    return {
      ...absentProbe(),
      kind: 'not-sqlite',
      bytes,
      sha256,
      problem: 'the file does not start with the SQLite header',
    };
  }
  const header = headerVersion(path);
  if (header === null) {
    return {
      ...absentProbe(),
      kind: 'not-sqlite',
      bytes,
      sha256,
      problem: 'the schema stamp could not be read from the header',
    };
  }
  const read = readStructureCopy(path);
  const { kind, problem } = kindOf(header, read, currentVersion);
  // A file with a current-or-older stamp that holds no application table is a
  // leftover rather than a history — but only the copy proves that, and an
  // unreadable copy keeps the file in the refused class.
  if (
    problem === null &&
    (kind === 'unsupported' || kind === 'current') &&
    read.tables !== null &&
    read.tables.length === 0
  )
    return {
      kind: 'empty',
      bytes,
      sha256,
      version: header,
      ...read,
    };
  return {
    kind,
    bytes,
    sha256,
    version: header,
    ...read,
    problem,
  };
}

/**
 * The structure version this build creates and reads.
 *
 * Discovered by letting the build create one database in a temporary directory
 * and reading the stamp it wrote, rather than restating the number here. A reset
 * tool with its own copy of `3` would keep calling today's structure "old" the
 * next time that number moves, and the mistake would only surface as deleted
 * current data.
 *
 * `0` means discovery failed. No real stamped file carries `0`, so every
 * database is then classified as a mismatch and refused: an unknown current
 * version must never authorize a deletion.
 */
export const CURRENT_SCHEMA_VERSION: number = discoverCurrentVersion();

/** Discover the current structure version from one database this build creates. */
function discoverCurrentVersion(): number {
  const staging = mkdtempSync(join(tmpdir(), 'arbiter-reset-version-'));
  try {
    const probe = join(staging, 'arbiter.db');
    const db = new DatabaseSync(probe);
    try {
      openAuditSchema(db);
    } finally {
      db.close();
    }
    return headerVersion(probe) ?? 0;
  } catch {
    return 0;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Whether the current structure version is known at all. */
export function currentVersionKnown(): boolean {
  return CURRENT_SCHEMA_VERSION > 0;
}
