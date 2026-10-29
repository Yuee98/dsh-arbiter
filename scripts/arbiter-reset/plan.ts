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
 * A sidecar is decided *with* its database: deleting a `-wal` while keeping the
 * database it belongs to would discard committed rows, and an orphaned sidecar
 * cannot be shown to be anything at all.
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
  absentProbe,
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
  /** Tables and their row counts, for the before/after tally. */
  readonly records: Readonly<Record<string, number>>;
}

/** The complete, confirmable plan. */
export interface ResetPlan {
  /** The data directory the scope was resolved from. */
  readonly home: string;
  /** `<home>/arbiter`. */
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
  /** Digest of the target set: the token an apply must echo back. */
  readonly planId: string;
  readonly deleteCount: number;
  readonly deleteBytes: number;
  readonly deleteRecords: number;
  readonly keepCount: number;
}

/** Sum of every table's row count. */
function totalRows(records: Readonly<Record<string, number>>): number {
  return Object.values(records).reduce((sum, value) => sum + value, 0);
}

/**
 * Refusals that make any deletion unsafe, whichever files were found.
 *
 * These are about the *scope* rather than one file: a plugin directory that is a
 * link would let a name that looks like ours point outside the data directory.
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
  // The scope is always applied to the resolved directory, so an operator who
  // passes a symlinked path (macOS `/tmp`, a linked home) still gets the exact
  // directory that was inspected rather than a name that could be repointed.
  //
  // A DSH profile directory is not a data directory. Pointing the tool at one
  // must fail loudly rather than silently find nothing: an operator who aimed at
  // the wrong level would otherwise read "nothing to delete" as "the old data is
  // already gone".
  if (existsSync(join(resolved, PROFILE_MARKER)))
    return [
      `${home} is a DSH profile directory, not a data directory; pass the data directory that contains ${DATA_DIRECTORY}/ so the scope covers exactly this plugin`,
    ];
  let pluginDirectory: string;
  try {
    pluginDirectory = realpathSync(join(resolved, DATA_DIRECTORY));
  } catch {
    // An absent plugin directory is a valid, empty scope: there is nothing here.
    return [];
  }
  if (!isDirectory(pluginDirectory))
    return [`${join(resolved, DATA_DIRECTORY)} is not a directory`];
  if (pluginDirectory !== join(resolved, DATA_DIRECTORY))
    return [
      `${join(resolved, DATA_DIRECTORY)} resolves to ${pluginDirectory}; a linked plugin directory is refused so the scope stays inside the data directory`,
    ];
  return [];
}

/** Whether the probe is an audit database this project could have written. */
function ownershipRefusal(probe: DatabaseProbe): string | null {
  if (probe.problem !== null) return probe.problem;
  const absent = OWNERSHIP_TABLES.filter(
    (table) => !probe.tables.includes(table),
  );
  if (absent.length === 0) return null;
  return `it is not an Arbiter audit database: the ${absent.join(', ')} table(s) are missing`;
}

/** A decision plus the sentence that justifies it. */
interface Decision {
  readonly action: TargetAction;
  readonly reason: string;
}

/** Scope choices the operator made before the plan was built. */
export interface PlanOptions {
  /**
   * Whether a database that also holds rows in the *current* record format may
   * be deleted.
   *
   * A structurally old database can still contain rows an interim build wrote
   * with today's record contract (the mixed state the design names). Deleting it
   * removes those rows too, so the default plan refuses and the operator has to
   * say so explicitly: mixed state is never cleared indiscriminately.
   */
  readonly includeCurrentFormatRecords?: boolean;
  /** Profiles the reset is authorized for; any other profile blocks it. */
  readonly expectProfiles?: readonly string[];
}

/** Rows in a probe that carry the record contract this build writes. */
function currentRows(probe: DatabaseProbe): number {
  return probe.currentFormatRecords;
}

/** The mixed-state refusal, when the operator has not acknowledged it. */
function mixedRefusal(
  probe: DatabaseProbe,
  options: PlanOptions,
): string | null {
  const current = currentRows(probe);
  if (current === 0 || options.includeCurrentFormatRecords === true)
    return null;
  return `it also holds ${String(current)} row(s) written in the current record format, so deleting it would discard data the current contract produced; pass --include-current-format-records once those rows are confirmed disposable`;
}

/** The decision for the audit database itself. */
function databaseDecision(
  probe: DatabaseProbe,
  options: PlanOptions,
): Decision {
  switch (probe.kind) {
    case 'absent':
      return { action: 'keep', reason: 'the database does not exist' };
    case 'empty':
      return {
        action: 'delete',
        reason:
          'a SQLite file with no application table: it holds no audit history and this build refuses it',
      };
    case 'unsupported': {
      const refusal = ownershipRefusal(probe) ?? mixedRefusal(probe, options);
      if (refusal !== null) return { action: 'refuse', reason: refusal };
      const stamp =
        probe.version === null
          ? 'no schema stamp'
          : `schema ${String(probe.version)}`;
      const mixed =
        currentRows(probe) === 0
          ? ''
          : `, including ${String(currentRows(probe))} current-format row(s) the operator acknowledged`;
      return {
        action: 'delete',
        reason: `old Arbiter audit data (${stamp}; this build reads only the current structure) holding ${String(
          probe.tables.length,
        )} table(s) and ${String(totalRows(probe.records))} row(s)${mixed}`,
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
function backupDecision(probe: DatabaseProbe, options: PlanOptions): Decision {
  switch (probe.kind) {
    case 'absent':
      return { action: 'keep', reason: 'the file does not exist' };
    case 'empty':
      return {
        action: 'delete',
        reason: 'an empty migration backup: it holds no audit history',
      };
    case 'unsupported': {
      const refusal = ownershipRefusal(probe) ?? mixedRefusal(probe, options);
      if (refusal !== null) return { action: 'refuse', reason: refusal };
      return {
        action: 'delete',
        reason: `migration backup of a retired structure (schema ${String(
          probe.version,
        )}) holding ${String(totalRows(probe.records))} row(s)`,
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

/** The entries of the plugin's data directory, or none when it is absent. */
function entriesOf(directory: string): readonly Entry[] {
  let names: readonly string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const entries: Entry[] = [];
  for (const name of names) {
    const path = join(directory, name);
    try {
      // `lstat` rather than `stat`: a symlink must be recognised as one, and
      // following it would report the link as a file it is not.
      const stats = lstatSync(path, { throwIfNoEntry: false });
      if (stats === undefined) continue;
      entries.push({
        name,
        path,
        isFile: stats.isFile(),
        isSymbolicLink: stats.isSymbolicLink(),
      });
    } catch {
      // An entry that vanished between listing and reading is simply not there.
    }
  }
  return entries;
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
    records: {},
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
  let bytes: number;
  try {
    bytes = statSync(entry.path).size;
  } catch {
    bytes = 0;
  }
  return plainTarget(
    entry,
    group,
    action,
    reason,
    bytes,
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

/** The digest an apply has to echo, over names, sizes and contents. */
function digestOf(targets: readonly ResetTarget[]): string {
  const lines = targets
    .filter((target) => target.action === 'delete')
    .map(
      (target) =>
        `${target.name}\u0000${String(target.bytes)}\u0000${target.sha256 ?? 'none'}`,
    )
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** Sum of one value column across the databases a run deletes. */
function sumValues(
  targets: readonly ResetTarget[],
  pick: (probe: DatabaseProbe) => readonly ValueCount[],
): readonly ValueCount[] {
  const tally = new Map<string, number>();
  for (const target of targets) {
    if (target.action !== 'delete' || target.probe === null) continue;
    for (const item of pick(target.probe))
      tally.set(item.value, (tally.get(item.value) ?? 0) + item.records);
  }
  return [...tally]
    .map(([value, records]) => ({ value, records }))
    .sort((left, right) => right.records - left.records);
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
 * Refusals for profiles outside the ones the operator authorized.
 *
 * Audit rows are shared per data directory, so one old database can hold this
 * plugin's records for several DSH profiles. Deleting it removes all of them,
 * which is why the operator has to name the profiles the deletion may cover: an
 * unnamed profile is not silently included.
 */
function unauthorizedProfiles(
  targets: readonly ResetTarget[],
  options: PlanOptions,
): readonly string[] {
  if (options.expectProfiles === undefined) return [];
  const allowed = new Set(options.expectProfiles);
  const found = sumValues(
    targets.filter((target) => target.action === 'delete'),
    (probe) => probe.profiles,
  );
  return found
    .filter((item) => !allowed.has(item.value))
    .map(
      (item) =>
        `profile ${item.value} holds ${String(item.records)} old record(s) but is not among the profiles the reset was authorized for (${[...allowed].join(', ')}); name it with --profile or exclude this data directory`,
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
  const exists = isDirectory(directory);
  const entries = exists ? entriesOf(directory) : [];
  const targets: ResetTarget[] = [];

  const databaseEntry = entries.find((entry) => entry.name === DATABASE_NAME);
  const database: ResetTarget =
    databaseEntry === undefined
      ? {
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
        }
      : databaseEntry.isSymbolicLink || !databaseEntry.isFile
        ? (() => {
            const refusal = entryRefusal(databaseEntry);
            return plainTarget(
              databaseEntry,
              'database',
              'refuse',
              refusal ?? 'it is not a regular file',
              0,
              null,
            );
          })()
        : (() => {
            const probe = inspectDatabase(databaseEntry.path);
            return probedTarget(
              databaseEntry,
              'database',
              probe,
              databaseDecision(probe, options),
            );
          })();
  // The database target is reported even when the file is absent: "there is
  // nothing here" is a finding the operator needs, not an omission.
  targets.push(database);
  targets.push(...sidecarTargets(entries, database));

  for (const entry of entries) {
    if (BACKUP_NAME.test(entry.name)) {
      if (entryRefusal(entry) !== null || !entry.isFile) {
        const refusal = entryRefusal(entry);
        targets.push(
          plainTarget(
            entry,
            'backup',
            'refuse',
            refusal ?? 'it is not a regular file',
            0,
            null,
          ),
        );
        continue;
      }
      const probe = inspectDatabase(entry.path);
      targets.push(
        probedTarget(entry, 'backup', probe, backupDecision(probe, options)),
      );
      continue;
    }
    if (RESIDUE_NAME.test(entry.name)) {
      targets.push(
        entryTarget(
          entry,
          'residue',
          'delete',
          'partial migration backup left by the retired chain: an incomplete copy by construction, never a readable database',
        ),
      );
    }
  }

  // A profile outside the authorized set blocks the whole run, because deleting
  // the shared database would remove that profile's records as well. The targets
  // themselves are marked so the printed plan does not claim a deletion it will
  // not perform.
  const unauthorized = unauthorizedProfiles(targets, options);
  const blockedReason =
    'the database also holds old records for a profile outside the authorized set';
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
    directoryExists: exists,
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
    planId: digestOf(targets),
    deleteCount: deleted.length,
    deleteBytes: deleted.reduce((sum, target) => sum + target.bytes, 0),
    deleteRecords: deleted.reduce(
      (sum, target) => sum + totalRows(target.records),
      0,
    ),
    keepCount: targets.filter((target) => target.action === 'keep').length,
  };
}
