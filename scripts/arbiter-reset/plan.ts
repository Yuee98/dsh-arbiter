/**
 * Enumerating exactly what a reset would delete, and refusing everything else.
 *
 * The scope is one directory and a closed set of exact file names: the audit
 * database this build writes (`arbiter.db`), the sidecars SQLite keeps beside it,
 * the migration backups the retired chain produced (`arbiter.db.backup-v<N>`),
 * and the `.staging` residue a failed backup could leave. Nothing is discovered
 * recursively, by glob or by "looks like a database": a file is in scope because
 * of its exact name inside the plugin's own data directory.
 *
 * Every candidate is then *decided*, and that decision is what the operator
 * confirms:
 *
 * - `delete` — provably old Arbiter audit data this build refuses to open;
 * - `keep` — a database this build reads (current records must survive a reset)
 *   or one written by a newer build, which is not this build's to remove;
 * - `refuse` — the file cannot be shown to be this plugin's audit database, so
 *   the whole run is blocked instead of deleting a file of unknown origin.
 *
 * **A fact that could not be established is `refuse`, never `delete` and never a
 * quiet `keep`.** An unreadable directory, an unreadable copy, a `calls` table
 * with no `profile` column and a `.staging` file that is not a readable Arbiter
 * copy all describe states where this tool does not know what it would destroy;
 * each one blocks the run rather than producing a confident-looking empty plan.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

import type { DatabaseProbe, ValueCount } from './inspect.ts';
import {
  CURRENT_SCHEMA_VERSION,
  absentProbe,
  currentVersionKnown,
  inspectDatabase,
  isDirectory,
  sha256OfFile,
} from './inspect.ts';
import type { SessionLogFinding } from './session-logs.ts';

/** The audit database file name inside the plugin's data directory. */
export const DATABASE_NAME = 'arbiter.db';

/** The directory this plugin owns under a DSH data directory. */
export const DATA_DIRECTORY = 'arbiter';

/** Sidecars SQLite may hold beside the database. */
export const SIDECAR_NAMES: readonly string[] = [
  `${DATABASE_NAME}-wal`,
  `${DATABASE_NAME}-shm`,
  `${DATABASE_NAME}-journal`,
];

/** The file every DSH profile directory carries. */
const PROFILE_MARKER = 'cordis.patch.yml';

/** The retired migration backups: `arbiter.db.backup-v2`. */
const BACKUP_NAME = /^arbiter\.db\.backup-v\d+$/u;

/** A partial backup the retired chain could leave before renaming it. */
const RESIDUE_NAME = /^arbiter\.db\.backup-v\d+\.staging$/u;

/**
 * Tables every audit structure this project ever wrote has.
 *
 * This check is what makes "the file is Arbiter's" a fact rather than an
 * assumption: another plugin's SQLite file at the same name does not carry all
 * four, so it is refused instead of deleted.
 */
const OWNERSHIP_TABLES: readonly string[] = [
  'calls',
  'stages',
  'model_calls',
  'config_snapshots',
];

/** What a reset does to one file. */
export type TargetAction = 'delete' | 'keep' | 'refuse';

/** Which part of the scope a file belongs to. */
export type TargetGroup = 'database' | 'backup' | 'residue';

/** One file the plan considered. */
export interface ResetTarget {
  readonly name: string;
  readonly path: string;
  readonly group: TargetGroup;
  readonly action: TargetAction;
  /** Why this action, in terms an operator can check. */
  readonly reason: string;
  readonly bytes: number;
  readonly sha256: string | null;
  /** Structure read for a database or backup; `null` for sidecars and residue. */
  readonly probe: DatabaseProbe | null;
  /** Tables and their row counts, or `null` when they could not be read. */
  readonly records: Readonly<Record<string, number>> | null;
}

/** The complete, confirmable plan. */
export interface ResetPlan {
  /** The data directory the scope was resolved from. */
  readonly home: string;
  /**
   * The canonical, symlink-free plugin directory this plan was built from.
   *
   * `applyPlan` revalidates this exact path before the first deletion, so a
   * preview made against one directory cannot delete inside another.
   */
  readonly directory: string;
  readonly directoryExists: boolean;
  readonly targets: readonly ResetTarget[];
  /** Arbiter records found in host session logs; reported, never deleted. */
  readonly sessionLogs: readonly SessionLogFinding[];
  /** Parts of the impact scope this tool does not touch, with the reason. */
  readonly exclusions: readonly string[];
  /** Reasons the plan cannot be applied at all. */
  readonly refusals: readonly string[];
  /** Profiles whose rows live in the target databases. */
  readonly profiles: readonly ValueCount[];
  /** Projects whose rows live in the target databases. */
  readonly projects: readonly ValueCount[];
  /**
   * Digest binding the canonical directory, the authorization options and every
   * deletion target's name, size and content.
   */
  readonly planId: string;
  readonly deleteCount: number;
  readonly deleteBytes: number;
  readonly deleteRecords: number;
  readonly keepCount: number;
}

/** Sum of every table's row count, or `null` when a count is unknown. */
function totalRows(
  records: Readonly<Record<string, number>> | null,
): number | null {
  if (records === null) return null;
  const values = Object.values(records);
  if (values.some((value) => !Number.isFinite(value))) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

/** A row tally as text, refusing to print an unknown count as a number. */
export function rowsText(
  records: Readonly<Record<string, number>> | null,
): string {
  const total = totalRows(records);
  return total === null
    ? 'an unreadable number of row(s)'
    : `${String(total)} row(s)`;
}

/** The shared ownership + readability refusal for a deletion candidate. */
function deletionRefusal(probe: DatabaseProbe): string | null {
  if (probe.problem !== null) return probe.problem;
  const tables = probe.tables;
  if (tables === null) return 'its structure could not be read';
  const absent = OWNERSHIP_TABLES.filter((table) => !tables.includes(table));
  if (absent.length > 0)
    return `it is not an Arbiter audit database: the ${absent.join(', ')} table(s) are missing`;
  // A `calls` table without `profile` is not "no other profile affected": it is
  // an attribution this tool cannot make, which blocks the allowlist check.
  if (probe.profiles === null)
    return 'the calls table has no profile column, so which profile these records belong to cannot be established';
  return null;
}

/** A decision plus the sentence that justifies it. */
interface Decision {
  readonly action: TargetAction;
  readonly reason: string;
}

/** Scope choices the operator made before the plan was built. */
export interface PlanOptions {
  /** Profiles the reset is authorized for; any other profile blocks it. */
  readonly expectProfiles?: readonly string[];
}

/** The mixed-state refusal shared by the database and its backups. */
function mixedRefusal(probe: DatabaseProbe): string | null {
  const current = probe.currentFormatRecords;
  if (current === null)
    return 'how many rows were written in the current record format could not be read';
  if (current === 0) return null;
  return `it also holds ${String(
    current,
  )} row(s) written in the current record format, and this reset only removes old test data — deleting it would discard data the current contract produced`;
}

/** The decision for the audit database itself. */
function databaseDecision(probe: DatabaseProbe): Decision {
  switch (probe.kind) {
    case 'absent':
      return { action: 'keep', reason: 'the database does not exist' };
    case 'empty':
      // An empty SQLite file proves nothing about who wrote it: "no tables" is as
      // consistent with another tool's scratch file as with this plugin. The name
      // is not evidence, so the file is refused rather than deleted.
      return {
        action: 'refuse',
        reason:
          'a SQLite file with no application table: it holds no audit history, but nothing proves it belongs to this plugin either',
      };
    case 'unsupported': {
      const refusal = deletionRefusal(probe) ?? mixedRefusal(probe);
      if (refusal !== null) return { action: 'refuse', reason: refusal };
      const stamp =
        probe.version === null
          ? 'no schema stamp'
          : `schema ${String(probe.version)}`;
      const tables = probe.tables?.length ?? 0;
      return {
        action: 'delete',
        reason: `old Arbiter audit data (${stamp}; this build reads only the current structure: ${String(
          CURRENT_SCHEMA_VERSION,
        )}) holding ${String(tables)} table(s) and ${rowsText(probe.records)}`,
      };
    }
    case 'current':
      return {
        action: 'keep',
        reason:
          'it is the current audit database, so records written under the current contract are kept',
      };
    case 'newer':
      return {
        action: 'keep',
        reason: `it was written by a newer build (schema ${String(
          probe.version,
        )}); this build does not modify it`,
      };
    case 'not-sqlite':
      return {
        action: 'refuse',
        reason: `ownership cannot be proven: ${
          probe.problem ?? 'it is not a SQLite database'
        }`,
      };
  }
}

/** The decision for one migration backup. */
function backupDecision(probe: DatabaseProbe): Decision {
  switch (probe.kind) {
    case 'absent':
      return { action: 'keep', reason: 'the file does not exist' };
    case 'empty':
      return {
        action: 'refuse',
        reason:
          'a SQLite file with no application table: nothing proves it is a migration backup of this plugin',
      };
    case 'unsupported': {
      const refusal = deletionRefusal(probe) ?? mixedRefusal(probe);
      if (refusal !== null) return { action: 'refuse', reason: refusal };
      return {
        action: 'delete',
        reason: `migration backup of a retired structure (schema ${String(
          probe.version,
        )}) holding ${rowsText(probe.records)}`,
      };
    }
    case 'current':
      return {
        action: 'keep',
        reason:
          'it holds a current-structure database, and a backup is never deleted on a guess',
      };
    case 'newer':
      return {
        action: 'keep',
        reason: `it was written by a newer build (schema ${String(
          probe.version,
        )})`,
      };
    case 'not-sqlite':
      return {
        action: 'refuse',
        reason: `ownership cannot be proven: ${
          probe.problem ?? 'it is not a SQLite database'
        }`,
      };
  }
}

/** One directory entry, as the plan needs to see it. */
interface Entry {
  readonly name: string;
  readonly path: string;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
}

/** The result of listing the plugin directory. */
type Listing =
  | { readonly ok: true; readonly entries: readonly Entry[] }
  | { readonly ok: false; readonly problem: string };

/** `lstat` one path, or `null` when it cannot be inspected. */
function factsOfEntry(
  path: string,
): { readonly isFile: boolean; readonly isSymbolicLink: boolean } | null {
  try {
    // `lstat` rather than `stat`: a symlink must be recognised as one, and
    // following it would report the link as a file it is not.
    const stats = lstatSync(path);
    return { isFile: stats.isFile(), isSymbolicLink: stats.isSymbolicLink() };
  } catch {
    return null;
  }
}

/**
 * List the plugin directory, reporting a failure as a failure.
 *
 * An unreadable directory used to return an empty list, which the plan then
 * printed as "nothing to delete" — the operator was told their old data was gone
 * by a run that never saw the directory. Only a genuinely absent directory is an
 * empty scope; every other failure is a refusal.
 */
function listDirectory(directory: string): Listing {
  if (!existsSync(directory)) return { ok: true, entries: [] };
  let names: readonly string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    return {
      ok: false,
      problem: `the plugin directory ${directory} could not be listed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const entries: Entry[] = [];
  for (const name of names) {
    const path = join(directory, name);
    const stats = factsOfEntry(path);
    // A failed `lstat` for a listed name is not "absent": the entry exists and
    // this tool cannot describe it, so the whole listing becomes a refusal.
    if (stats === null)
      return {
        ok: false,
        problem: `the directory entry ${path} could not be inspected, so the scope is incomplete`,
      };
    entries.push({
      name,
      path,
      isFile: stats.isFile,
      isSymbolicLink: stats.isSymbolicLink,
    });
  }
  return { ok: true, entries };
}

/**
 * Why an entry may not be deleted whatever its name says.
 *
 * `statSync` follows symlinks, so `isFile` is true for a link to a real file. A
 * link is refused because deleting the name deletes the link, not the data the
 * operator was told about, and the target may be outside this scope entirely.
 */
function entryRefusal(entry: Entry): string | null {
  if (entry.isSymbolicLink)
    return 'it is a symlink, so removing this name would not remove data inside this directory';
  if (!entry.isFile) return 'it is not a regular file';
  return null;
}

/** A target read from the file system as a plain file. */
function plainTarget(
  entry: Entry,
  group: TargetGroup,
  action: TargetAction,
  reason: string,
  bytes: number,
  sha256: string | null,
): ResetTarget {
  return {
    name: entry.name,
    path: entry.path,
    group,
    action,
    reason,
    bytes,
    sha256,
    probe: null,
    records: null,
  };
}

/** A target decided from a probe. */
function probedTarget(
  entry: Entry,
  group: TargetGroup,
  probe: DatabaseProbe,
  decision: Decision,
): ResetTarget {
  return {
    name: entry.name,
    path: entry.path,
    group,
    action: decision.action,
    reason: decision.reason,
    bytes: probe.bytes,
    sha256: probe.sha256,
    probe,
    records: probe.records,
  };
}

/** The size of a plain file, or `0` when it cannot be read. */
function sizeOfPath(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** A plain target for one entry, hashing it when the operator may inspect it. */
function entryTarget(
  entry: Entry,
  group: TargetGroup,
  action: TargetAction,
  reason: string,
): ResetTarget {
  const refusal = entryRefusal(entry);
  if (refusal !== null)
    return plainTarget(entry, group, 'refuse', refusal, 0, null);
  return plainTarget(
    entry,
    group,
    action,
    reason,
    sizeOfPath(entry.path),
    sha256OfFile(entry.path),
  );
}

/** The sidecar targets of the audit database, decided by that database. */
function sidecarTargets(
  entries: readonly Entry[],
  database: ResetTarget,
): readonly ResetTarget[] {
  const targets: ResetTarget[] = [];
  for (const entry of entries) {
    if (!SIDECAR_NAMES.includes(entry.name)) continue;
    if (database.action === 'delete' && database.probe?.kind !== 'absent') {
      targets.push(
        entryTarget(
          entry,
          'database',
          'delete',
          `sidecar of ${DATABASE_NAME}, which this run deletes`,
        ),
      );
      continue;
    }
    const reason =
      database.action === 'refuse'
        ? 'its database is refused, so the sidecar is left untouched'
        : database.probe?.kind === 'absent'
          ? 'orphaned: its database is absent, and an orphaned sidecar is not provably this plugin data'
          : 'it belongs to a database this reset keeps';
    targets.push(entryTarget(entry, 'database', 'keep', reason));
  }
  return targets;
}

/**
 * The digest an apply has to echo.
 *
 * The canonical directory and the authorization options are part of it. Hashing
 * only file identities would make two data directories holding byte-identical
 * copies produce the same token, so a preview of one directory would authorize a
 * deletion in the other.
 */
function digestOf(
  directory: string,
  options: PlanOptions,
  targets: readonly ResetTarget[],
): string {
  const lines = targets
    .filter((target) => target.action === 'delete')
    .map(
      (target) =>
        `${target.name}\u0000${String(target.bytes)}\u0000${target.sha256 ?? 'none'}`,
    )
    .sort();
  const profiles = [...(options.expectProfiles ?? [])].sort().join(',');
  return createHash('sha256')
    .update(`directory\u0000${directory}\nprofiles\u0000${profiles}\n`)
    .update(lines.join('\n'))
    .digest('hex');
}

/** Sum of one value column across the databases a run deletes. */
function sumValues(
  targets: readonly ResetTarget[],
  pick: (probe: DatabaseProbe) => readonly ValueCount[] | null,
): readonly ValueCount[] {
  const tally = new Map<string, number>();
  for (const target of targets) {
    if (target.action !== 'delete' || target.probe === null) continue;
    const values = pick(target.probe);
    // A null reading is already a refusal reason on that target; it contributes
    // no tally rather than being reported as "no profile affected".
    if (values === null) continue;
    for (const item of values)
      tally.set(item.value, (tally.get(item.value) ?? 0) + item.records);
  }
  return [...tally]
    .map(([value, records]) => ({ value, records }))
    .sort((left, right) => right.records - left.records);
}

/**
 * Refusals for profiles outside the ones the operator authorized.
 *
 * Audit rows are shared per data directory, so one old database can hold this
 * plugin's records for several DSH profiles. Deleting it removes all of them,
 * which is why the operator has to name the profiles the deletion may cover: an
 * unnamed profile is not silently included, and an unnameable one blocks the run.
 */
function unauthorizedProfiles(
  targets: readonly ResetTarget[],
  options: PlanOptions,
): readonly string[] {
  if (options.expectProfiles === undefined) return [];
  const allowed = new Set(options.expectProfiles);
  const refusals: string[] = [];
  for (const target of targets) {
    if (target.action !== 'delete' || target.probe === null) continue;
    const values = target.probe.profiles;
    if (values === null) {
      refusals.push(
        `${target.name}: which profile its records belong to cannot be established, so the authorized set cannot be checked`,
      );
      continue;
    }
    for (const item of values) {
      if (allowed.has(item.value)) continue;
      refusals.push(
        `${target.name}: profile ${item.value} holds ${String(
          item.records,
        )} old record(s) but is not among the profiles the reset was authorized for (${[
          ...allowed,
        ].join(', ')}); name it with --profiles or exclude this data directory`,
      );
    }
  }
  return refusals;
}

/**
 * The parts of the impact scope this tool reports but never deletes.
 *
 * They are listed in the plan so the operator sees the boundary rather than
 * inferring it from what happens to be missing from the target list.
 */
const EXCLUSIONS: readonly string[] = [
  'host session logs: one log holds the whole conversation and every plugin, so deleting this plugin records from it would mean rewriting a file this project does not own',
  'per-profile recovery copies under arbiter/last-good: they carry the effective configuration, not review history',
  'other profiles and other plugins: nothing outside one data directory’s arbiter directory is read or removed',
];

/** An empty plan, used when the scope itself cannot be verified. */
function blockedPlan(
  home: string,
  sessionLogs: readonly SessionLogFinding[],
  refusals: readonly string[],
): ResetPlan {
  return {
    home,
    directory: join(home, DATA_DIRECTORY),
    directoryExists: false,
    targets: [],
    sessionLogs,
    exclusions: EXCLUSIONS,
    refusals,
    profiles: [],
    projects: [],
    planId: '',
    deleteCount: 0,
    deleteBytes: 0,
    deleteRecords: 0,
    keepCount: 0,
  };
}

/**
 * Refusals that make any deletion unsafe, whichever files were found.
 *
 * These are about the *scope* rather than one file: a plugin directory that is a
 * link would let a name that looks like ours point outside the data directory,
 * and a data directory that is really a profile directory means the operator
 * aimed at the wrong level.
 */
export function scopeRefusals(home: string): readonly string[] {
  if (!isDirectory(home))
    return [
      `the data directory ${home} does not exist or is not a directory; the reset scope cannot be verified`,
    ];
  let resolved: string;
  try {
    resolved = realpathSync(home);
  } catch (error) {
    return [
      `the data directory ${home} could not be resolved to a real path: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
  if (existsSync(join(resolved, PROFILE_MARKER)))
    return [
      `${home} is a DSH profile directory, not a data directory; pass the data directory that contains ${DATA_DIRECTORY}/ so the scope covers exactly this plugin`,
    ];
  if (!currentVersionKnown())
    return [
      'the current audit structure version could not be determined from this build; refusing to classify any database as old',
    ];
  const pluginDirectory = join(resolved, DATA_DIRECTORY);
  if (!existsSync(pluginDirectory)) return [];
  if (!isDirectory(pluginDirectory))
    return [`${pluginDirectory} is not a directory`];
  let canonical: string;
  try {
    canonical = realpathSync(pluginDirectory);
  } catch (error) {
    return [
      `${pluginDirectory} could not be resolved to a real path: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
  if (canonical !== pluginDirectory)
    return [
      `${pluginDirectory} resolves to ${canonical}; a linked plugin directory is refused so the scope stays inside the data directory`,
    ];
  return [];
}

/** The target for the audit database entry itself. */
function databaseTarget(
  entry: Entry | undefined,
  directory: string,
): ResetTarget {
  if (entry === undefined)
    return {
      ...plainTarget(
        {
          name: DATABASE_NAME,
          path: join(directory, DATABASE_NAME),
          isFile: false,
          isSymbolicLink: false,
        },
        'database',
        'keep',
        'the database does not exist',
        0,
        null,
      ),
      probe: absentProbe(),
    };
  const refusal = entryRefusal(entry);
  if (refusal !== null)
    return plainTarget(entry, 'database', 'refuse', refusal, 0, null);
  const probe = inspectDatabase(entry.path, CURRENT_SCHEMA_VERSION);
  return probedTarget(entry, 'database', probe, databaseDecision(probe));
}

/** The target for one migration backup entry. */
function backupTarget(entry: Entry): ResetTarget {
  const refusal = entryRefusal(entry);
  if (refusal !== null)
    return plainTarget(entry, 'backup', 'refuse', refusal, 0, null);
  const probe = inspectDatabase(entry.path, CURRENT_SCHEMA_VERSION);
  return probedTarget(entry, 'backup', probe, backupDecision(probe));
}

/**
 * The target for one `.staging` residue.
 *
 * A staging file is the interrupted output of `VACUUM INTO`, which in practice
 * means it is usually **truncated and unreadable**: the name is not evidence of
 * anything by itself, and neither is a SQLite header, because any plugin's
 * database can carry one.
 *
 * The rule is therefore the strictest one available: a residue is deleted only
 * when the file is *readable* and *provably this plugin's* — the four ownership
 * tables are present and the structure is retired. A residue that cannot be read
 * (the ordinary truncated case) is refused rather than deleted. That leaves one
 * manual cleanup step for a genuinely damaged leftover, which is the correct
 * trade for a class whose only distinguishing feature is a file name.
 */
function residueTarget(entry: Entry): ResetTarget {
  const refusal = entryRefusal(entry);
  if (refusal !== null)
    return plainTarget(entry, 'residue', 'refuse', refusal, 0, null);
  const probe = inspectDatabase(entry.path, CURRENT_SCHEMA_VERSION);
  const ownership = deletionRefusal(probe);
  if (ownership !== null)
    return entryTarget(
      entry,
      'residue',
      'refuse',
      `a residue is deleted only when it is a readable Arbiter copy of a retired structure, and here ${
        ownership.startsWith('it') ? ownership : `this fails: ${ownership}`
      }`,
    );
  if (probe.kind === 'current' || probe.kind === 'newer')
    return entryTarget(
      entry,
      'residue',
      'keep',
      'it holds a database in the current or a newer structure, so it is not an abandoned partial copy',
    );
  if (probe.kind !== 'unsupported')
    return entryTarget(
      entry,
      'residue',
      'refuse',
      `a residue is deleted only when it holds a retired structure, and this file is classified ${probe.kind}`,
    );
  if ((probe.currentFormatRecords ?? 0) > 0)
    return entryTarget(
      entry,
      'residue',
      'refuse',
      `it also holds ${String(
        probe.currentFormatRecords,
      )} row(s) written in the current record format`,
    );
  return entryTarget(
    entry,
    'residue',
    'delete',
    'partial migration backup left by the retired chain: a readable copy of a retired structure, holding no record this build can read',
  );
}

/** Build the plan for one data directory. */
export function buildPlan(
  home: string,
  sessionLogs: readonly SessionLogFinding[] = [],
  options: PlanOptions = {},
): ResetPlan {
  const refusals = scopeRefusals(home);
  if (refusals.length > 0) return blockedPlan(home, sessionLogs, refusals);
  const directory = join(realpathSync(home), DATA_DIRECTORY);
  const listing = listDirectory(directory);
  if (!listing.ok) return blockedPlan(home, sessionLogs, [listing.problem]);
  const entries = listing.entries;
  const targets: ResetTarget[] = [];

  const database = databaseTarget(
    entries.find((entry) => entry.name === DATABASE_NAME),
    directory,
  );
  targets.push(database);
  targets.push(...sidecarTargets(entries, database));
  for (const entry of entries) {
    if (BACKUP_NAME.test(entry.name)) {
      targets.push(backupTarget(entry));
      continue;
    }
    if (RESIDUE_NAME.test(entry.name)) targets.push(residueTarget(entry));
  }

  // A profile outside the authorized set blocks the run, because deleting the
  // shared database would remove that profile's records too. The targets
  // themselves are relabelled so the printed plan does not claim a deletion it
  // will not perform.
  const unauthorized = unauthorizedProfiles(targets, options);
  const blockedReason =
    'it also holds old records for a profile outside the authorized set';
  const decided: readonly ResetTarget[] =
    unauthorized.length === 0
      ? targets
      : targets.map((target): ResetTarget =>
          target.action === 'delete'
            ? { ...target, action: 'refuse', reason: blockedReason }
            : target,
        );
  const deleted = decided.filter((target) => target.action === 'delete');
  return {
    home,
    directory,
    directoryExists: true,
    targets: decided,
    sessionLogs,
    exclusions: EXCLUSIONS,
    refusals: [
      ...unauthorized,
      ...decided
        .filter((target) => target.action === 'refuse')
        .map((target) => `${target.name}: ${target.reason}`),
    ],
    profiles: sumValues(deleted, (probe) => probe.profiles),
    projects: sumValues(deleted, (probe) => probe.workspaces),
    planId: digestOf(directory, options, decided),
    deleteCount: deleted.length,
    deleteBytes: deleted.reduce((sum, target) => sum + target.bytes, 0),
    // An unreadable row count is already a refusal on that target, so a plan that
    // reaches a deletion always has every count.
    deleteRecords: deleted.reduce(
      (sum, target) => sum + (totalRows(target.records) ?? 0),
      0,
    ),
    keepCount: decided.filter((target) => target.action === 'keep').length,
  };
}
