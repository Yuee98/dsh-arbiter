/**
 * The scoped reset of this plugin's old test data.
 *
 * Every case runs against a synthetic data directory built for that test, never
 * the operator's real `~/.dsh`: the tool deletes files by design, so a test that
 * pointed it at real data would be the exact accident it is meant to prevent.
 *
 * What the cases have to prove, in the order the acceptance conditions ask:
 *
 * 1. a dry run removes nothing and still reports the target, the counts and the
 *    reason;
 * 2. an explicit apply removes the old database and its migration backups, while
 *    files that are not this plugin's old audit data survive untouched;
 * 3. a repeated run is safe, because the second run finds nothing old and leaves
 *    the current records alone;
 * 4. the refusals are real: a foreign database, a newer build's database, a
 *    profile directory and an unauthorized profile all block the deletion rather
 *    than being "cleaned up".
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';

import { afterEach, describe, expect, test } from 'vitest';

import { applyPlan } from '../../scripts/arbiter-reset/apply.ts';
import { buildPlan } from '../../scripts/arbiter-reset/plan.ts';
import {
  renderOutcome,
  renderPlan,
} from '../../scripts/arbiter-reset/report.ts';
import { main } from '../../scripts/arbiter-reset-test-data.ts';
import { AuditStore, fingerprintOf } from '../../src/audit.js';
import type { CallRecord } from '../../src/audit.js';
import { RECORD_FORMAT } from '../../src/audit/schema.ts';
import { DEFAULT_CONFIG } from '../../src/config.js';
import type { ReviewScores } from '../../src/types.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

/** A fresh synthetic data directory, with no plugin directory yet. */
async function makeHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'arbiter-reset-'));
  roots.push(root);
  return root;
}

/** The plugin's own directory inside a data directory. */
function pluginDir(home: string): string {
  return join(home, 'arbiter');
}

const OWNED_DDL = `
  CREATE TABLE config_snapshots (
    snapshot_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL, format_version INTEGER NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE config_activations (
    id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, activated_at INTEGER NOT NULL,
    entry TEXT NOT NULL, scope TEXT NOT NULL, revision TEXT NOT NULL);
  CREATE TABLE calls (
    call_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, session_id TEXT NOT NULL,
    session_kind TEXT NOT NULL, parent_session TEXT, profile TEXT, workspace TEXT,
    tool TEXT NOT NULL, arguments TEXT NOT NULL, cwd TEXT NOT NULL,
    fingerprint TEXT NOT NULL, config_revision TEXT NOT NULL,
    config_snapshot_id TEXT NOT NULL, approval_mode TEXT NOT NULL,
    execution_mode TEXT NOT NULL, result TEXT NOT NULL, reason TEXT NOT NULL,
    trace TEXT NOT NULL, effect TEXT NOT NULL, session_record_state TEXT NOT NULL,
    decision_rules TEXT NOT NULL, execution_status TEXT NOT NULL,
    record_format_version INTEGER NOT NULL);
  CREATE TABLE stages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id TEXT NOT NULL, seq INTEGER NOT NULL, stage TEXT NOT NULL,
    result TEXT NOT NULL, ts INTEGER NOT NULL);
  CREATE TABLE snapshots (
    snapshot_id TEXT PRIMARY KEY, call_id TEXT NOT NULL, content_hash TEXT NOT NULL,
    content TEXT NOT NULL, format_version INTEGER NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE model_calls (
    id TEXT PRIMARY KEY, call_id TEXT NOT NULL, attempt INTEGER NOT NULL,
    backend TEXT NOT NULL, protocol TEXT NOT NULL, request TEXT NOT NULL,
    started_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
    estimated_input_tokens INTEGER NOT NULL);
  CREATE TABLE candidates (
    candidate_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, status TEXT NOT NULL,
    rule TEXT NOT NULL, stats TEXT NOT NULL, evidence TEXT NOT NULL,
    window_start INTEGER NOT NULL, window_end INTEGER NOT NULL, note TEXT);
  CREATE TABLE analysis_runs (
    id TEXT PRIMARY KEY, ran_at INTEGER NOT NULL, window_start INTEGER NOT NULL,
    window_end INTEGER NOT NULL, considered INTEGER NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** Insert one call row into an old-structure database. */
function insertCall(
  db: DatabaseSync,
  callId: string,
  fields: { profile?: string | null; workspace?: string; format?: number } = {},
): void {
  db.prepare(
    `INSERT INTO calls (call_id, ts, session_id, session_kind, profile, workspace,
       tool, arguments, cwd, fingerprint, config_revision, config_snapshot_id,
       approval_mode, execution_mode, result, reason, trace, effect,
       session_record_state, decision_rules, execution_status, record_format_version)
     VALUES (?, ?, 'session-old', 'main', ?, ?, 'bash', '{"command":"ls"}', '/tmp',
       'fp', 'rev-1', 'cfg-1', 'ask', 'trusted', 'review-allow', 'test', '[]', '',
       'written', '[]', 'pending', ?)`,
  ).run(
    callId,
    Date.now() - 86_400_000,
    fields.profile ?? null,
    fields.workspace ?? '/tmp/project-a',
    fields.format ?? 1,
  );
}

/** A database in the retired structure, as the superseded build left it. */
function writeOldDatabase(
  path: string,
  options: {
    readonly version?: number;
    readonly profiles?: readonly (string | null)[];
    readonly currentFormatRows?: number;
  } = {},
): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(OWNED_DDL);
  const profiles = options.profiles ?? ['gate'];
  profiles.forEach((profile, index) => {
    insertCall(db, `old-${String(index)}`, {
      profile,
      workspace: `/tmp/project-${String(index)}`,
    });
  });
  for (let index = 0; index < (options.currentFormatRows ?? 0); index += 1) {
    insertCall(db, `mixed-${String(index)}`, {
      profile: 'gate',
      format: RECORD_FORMAT,
    });
  }
  db.exec(`PRAGMA user_version = ${String(options.version ?? 2)}`);
  db.close();
}

/** A SQLite file that is not this plugin's audit database. */
function writeForeignDatabase(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
  db.prepare('INSERT INTO notes (body) VALUES (?)').run('someone else data');
  db.exec('PRAGMA user_version = 2');
  db.close();
}

/** A current-structure audit database holding live records. */
function writeCurrentDatabase(path: string): void {
  const store = new AuditStore(path, {
    ...DEFAULT_CONFIG.audit,
    enabled: true,
  });
  store.enqueue(currentRecord('kept-call'));
  store.close();
}

/** One record in the shape the current build writes. */
function currentRecord(callId: string): CallRecord {
  const scores: ReviewScores = {
    contractVersion: 'review-contract-v1',
    source: 'chat',
    risk: 1,
    authorization: 2,
    requiredAuthorization: 2,
    verdict: 'review-allow',
    audit: {
      risk: { native: null, published: null, point: 1, score: 1 },
      authorization: { native: null, published: null, point: 2, score: 2 },
    },
  };
  return {
    callId,
    ts: Date.now(),
    sessionId: 'session-live',
    sessionKind: 'main',
    parentSession: null,
    profile: 'web',
    workspace: '/tmp/current-project',
    tool: 'bash',
    arguments: { command: 'echo hi' },
    cwd: '/tmp/current-project',
    fingerprint: fingerprintOf('bash', { command: 'echo hi' }),
    configRevision: 'rev-live',
    configSnapshotId: 'cfg-live',
    approvalMode: 'ask',
    executionMode: 'trusted',
    reason: 'live',
    trace: [{ stage: 'review', result: 'review-allow', at: 1 }],
    effect: null,
    sessionRecordState: 'written',
    result: 'review-allow',
    snapshot: null,
    modelAttempts: [],
    scores,
    reviewStage: 'review-allow',
    usage: null,
    decisionRules: [],
    executionStatus: 'pending',
  };
}

/** Every file under a directory tree, relative, for an exact comparison. */
function treeOf(root: string, prefix = ''): readonly string[] {
  let names: readonly string[];
  try {
    names = readdirSync(join(root, prefix));
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of names) {
    const relative = prefix === '' ? name : `${prefix}/${name}`;
    const path = join(root, relative);
    if (isDirectory(path)) files.push(...treeOf(root, relative));
    else files.push(relative);
  }
  return files.sort();
}

/** Whether a path is a directory rather than a file. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A digest of a whole tree, so "untouched" is one comparable value. */
function treeDigest(root: string): string {
  const hash = createHash('sha256');
  for (const relative of treeOf(root)) {
    hash.update(relative);
    hash.update(readFileSync(join(root, relative)));
  }
  return hash.digest('hex');
}

/** Capture the text one CLI invocation printed. */
function run(args: readonly string[]): {
  readonly code: number;
  readonly out: string;
} {
  const chunks: string[] = [];
  const code = main(args, (text) => chunks.push(text));
  return { code, out: chunks.join('\n') };
}

/** The plan id from a preview's text. */
function planIdOf(out: string): string {
  const match = /^plan id: (\S+)$/mu.exec(out);
  return match?.[1] ?? '';
}

describe('dry run', () => {
  test('reports the old database with its counts and removes nothing', async () => {
    const home = await makeHome();
    const database = join(pluginDir(home), 'arbiter.db');
    writeOldDatabase(database, { profiles: ['gate', 'history-test'] });
    const before = treeDigest(home);
    const filesBefore = treeOf(home);

    const { code, out } = run(['--home', home]);

    expect(code).toBe(0);
    expect(out).toContain('preview');
    expect(out).toContain('DELETE arbiter.db');
    expect(out).toContain('old Arbiter audit data (schema 2');
    expect(out).toContain('2 row(s)');
    // The plan names who the rows belong to, before anything is removed.
    expect(out).toContain('gate: 1 record(s)');
    expect(out).toContain('history-test: 1 record(s)');
    expect(out).toContain('/tmp/project-0: 1 record(s)');
    expect(out).toContain('records: 2');
    // Nothing was written, created, re-checkpointed or hashed into place.
    expect(treeOf(home)).toEqual(filesBefore);
    expect(treeDigest(home)).toBe(before);
  });

  test('reports a missing plugin directory as nothing to delete, not as an error', async () => {
    const home = await makeHome();
    const { code, out } = run(['--home', home]);
    expect(code).toBe(0);
    expect(out).toContain('files: 0');
    expect(out).toContain('the database does not exist');
  });

  test('lists the sidecars of the old database as part of the same deletion', async () => {
    const home = await makeHome();
    const database = join(pluginDir(home), 'arbiter.db');
    writeOldDatabase(database);
    writeFileSync(`${database}-wal`, '');
    writeFileSync(`${database}-shm`, '');

    const plan = buildPlan(home);
    const names = plan.targets.map((target) => target.name).sort();
    expect(names).toEqual(['arbiter.db', 'arbiter.db-shm', 'arbiter.db-wal']);
    expect(plan.targets.every((target) => target.action === 'delete')).toBe(
      true,
    );
    // Every target is counted in the tally the operator confirms.
    expect(plan.deleteCount).toBe(3);
    expect(plan.deleteRecords).toBe(1);
  });

  test('reports host session logs without listing them as targets', async () => {
    const home = await makeHome();
    writeOldDatabase(join(pluginDir(home), 'arbiter.db'));
    const logDirectory = join(
      home,
      'sessions',
      '--tmp-project--',
      'session-one',
    );
    mkdirSync(logDirectory, { recursive: true });
    const body = [
      { type: 'session', origin: 'user' },
      { type: 'plugin:arbiter/decision', seq: 1 },
      { type: 'plugin:other/thing', seq: 2 },
      { type: 'plugin:arbiter/admission', seq: 3 },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n');
    writeFileSync(
      join(logDirectory, 'session.v4.jsonl.zstd'),
      zstdCompressSync(Buffer.from(body, 'utf8')),
    );

    const { code, out } = run(['--home', home, '--scan-logs']);
    expect(code).toBe(0);
    expect(out).toContain('plugin:arbiter/decision');
    expect(out).toContain('plugin:arbiter/admission');
    expect(out).toContain('2 arbiter record(s)');
    expect(out).not.toContain('plugin:other/thing');
    // The log is host-owned: it is reported, never a deletion target.
    expect(buildPlan(home).targets.map((target) => target.name)).toEqual([
      'arbiter.db',
    ]);
    expect(existsSync(join(logDirectory, 'session.v4.jsonl.zstd'))).toBe(true);
  });
});

describe('apply', () => {
  test('removes the old database and its backups and keeps everything else', async () => {
    const home = await makeHome();
    const directory = pluginDir(home);
    writeOldDatabase(join(directory, 'arbiter.db'));
    writeOldDatabase(join(directory, 'arbiter.db.backup-v1'), { version: 1 });
    writeOldDatabase(join(directory, 'arbiter.db.backup-v2'), { version: 2 });
    // A residue is deleted only when it is a readable copy of a retired
    // structure; a truncated one is refused (covered separately), so this fixture
    // is a complete old database under the residue name.
    copyFileSync(
      join(directory, 'arbiter.db.backup-v2'),
      join(directory, 'arbiter.db.backup-v2.staging'),
    );
    // Files this reset must not touch: a live database under another name, an
    // unrelated note, the recovery copies and another plugin's directory.
    writeCurrentDatabase(join(directory, 'other.db'));
    writeFileSync(join(directory, 'notes.txt'), 'operator note');
    mkdirSync(join(directory, 'last-good'), { recursive: true });
    writeFileSync(join(directory, 'last-good', 'web-1234.json'), '{}');
    mkdirSync(join(home, 'other-plugin'), { recursive: true });
    writeFileSync(join(home, 'other-plugin', 'arbiter.db'), 'not this plugin');

    const preview = run(['--home', home]);
    const outcome = run(['--home', home, '--apply', planIdOf(preview.out)]);

    expect(outcome.code).toBe(0);
    expect(outcome.out).toContain('result: removed');
    expect(outcome.out).toContain('files removed: 4');
    // The four removed files are named with their byte and row counts.
    expect(outcome.out).toContain('- arbiter.db [database]');
    expect(outcome.out).toContain('- arbiter.db.backup-v1 [backup]');
    expect(outcome.out).toContain('- arbiter.db.backup-v2 [backup]');
    expect(outcome.out).toContain('- arbiter.db.backup-v2.staging [residue]');
    // Everything else survived, byte for byte.
    expect(treeOf(home)).toEqual([
      'arbiter/last-good/web-1234.json',
      'arbiter/notes.txt',
      'arbiter/other.db',
      'other-plugin/arbiter.db',
    ]);
    expect(readFileSync(join(directory, 'notes.txt'), 'utf8')).toBe(
      'operator note',
    );
    expect(readFileSync(join(home, 'other-plugin', 'arbiter.db'), 'utf8')).toBe(
      'not this plugin',
    );
  });

  test('a repeated run finds nothing old and leaves the new records alone', async () => {
    const home = await makeHome();
    const directory = pluginDir(home);
    const database = join(directory, 'arbiter.db');
    writeOldDatabase(database);
    const preview = run(['--home', home]);
    expect(run(['--home', home, '--apply', planIdOf(preview.out)]).code).toBe(
      0,
    );
    expect(existsSync(database)).toBe(false);

    // The plugin starts again and writes current records into a fresh database.
    writeCurrentDatabase(database);
    const digestAfterNewRecords = treeDigest(home);

    const second = run(['--home', home]);
    expect(second.code).toBe(0);
    expect(second.out).toContain('files: 0');
    expect(second.out).toContain(
      'it is the current audit database, so records written under the current contract are kept',
    );
    // A second apply is a no-op rather than a deletion: it cannot even be
    // confirmed, because there is no target set to confirm.
    const secondApply = run(['--home', home, '--apply', planIdOf(second.out)]);
    expect(secondApply.code).toBe(1);
    expect(secondApply.out).toContain('the plan has nothing to delete');
    expect(treeDigest(home)).toBe(digestAfterNewRecords);
  });

  test('refuses an apply whose confirmation token is not this plan', async () => {
    const home = await makeHome();
    const database = join(pluginDir(home), 'arbiter.db');
    writeOldDatabase(database);
    const before = treeDigest(home);

    const outcome = run(['--home', home, '--apply', 'deadbeef']);
    expect(outcome.code).toBe(1);
    expect(outcome.out).toContain('the confirmation token does not match');
    expect(existsSync(database)).toBe(true);
    expect(treeDigest(home)).toBe(before);
  });

  test('refuses a file that changed between the preview and the apply', async () => {
    const home = await makeHome();
    const database = join(pluginDir(home), 'arbiter.db');
    writeOldDatabase(database);
    const confirmation = planIdOf(run(['--home', home]).out);
    // The operator keeps working, and the old database is rewritten before the
    // apply — the stale preview a live data directory produces. The digest has to
    // catch it: same path, same name, different content.
    const original = readFileSync(database);
    const changed = Buffer.from(original);
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 0xff;
    writeFileSync(database, changed);

    const outcome = applyPlan(buildPlan(home), confirmation);
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toContain('the confirmation token does not match');
    expect(readFileSync(database)).toEqual(changed);
  });

  test('refuses a staging file that cannot be proven to be this plugin copy', async () => {
    const home = await makeHome();
    const directory = pluginDir(home);
    writeOldDatabase(join(directory, 'arbiter.db'));
    // The name alone is not evidence: an unrelated file that happens to be
    // called this is not a backup residue of this project.
    const staged = join(directory, 'arbiter.db.backup-v3.staging');
    writeFileSync(staged, 'notes');

    const plan = buildPlan(home);
    const residue = plan.targets.find(
      (target) => target.name === 'arbiter.db.backup-v3.staging',
    );
    expect(residue?.action).toBe('refuse');
    expect(residue?.reason).toContain(
      'a residue is deleted only when it is a readable Arbiter copy',
    );
    expect(
      plan.refusals.some((line) => line.includes('backup-v3.staging')),
    ).toBe(true);
    expect(existsSync(staged)).toBe(true);
  });

  test('refuses a truncated staging file rather than guessing from its name', async () => {
    const home = await makeHome();
    const directory = pluginDir(home);
    writeOldDatabase(join(directory, 'arbiter.db'));
    // The ordinary shape of an interrupted `VACUUM INTO`: a SQLite header with a
    // truncated body. It cannot be read, so nothing proves it is this plugin's.
    const staged = join(directory, 'arbiter.db.backup-v3.staging');
    writeFileSync(
      staged,
      readFileSync(join(directory, 'arbiter.db')).subarray(0, 4096),
    );

    const plan = buildPlan(home);
    const residue = plan.targets.find(
      (target) => target.name === 'arbiter.db.backup-v3.staging',
    );
    expect(residue?.action).toBe('refuse');

    // The refused residue blocks the whole run, including the old database.
    const applied = run(['--home', home, '--apply', plan.planId]);
    expect(applied.code).toBe(1);
    expect(existsSync(join(directory, 'arbiter.db'))).toBe(true);
    expect(existsSync(staged)).toBe(true);
  });

  test('keeps a current-structure database parked under a residue name', async () => {
    const home = await makeHome();
    const directory = pluginDir(home);
    writeOldDatabase(join(directory, 'arbiter.db'));
    // A current database under the residue name is not an abandoned partial
    // copy, so the name must not make it deletable.
    const parked = join(directory, 'arbiter.db.backup-v4.staging');
    writeCurrentDatabase(parked);

    const plan = buildPlan(home);
    const residue = plan.targets.find(
      (target) => target.name === 'arbiter.db.backup-v4.staging',
    );
    expect(residue?.action).toBe('keep');
    expect(residue?.reason).toContain('current or a newer structure');
    expect(existsSync(parked)).toBe(true);
  });

  test('deletes a backup sidecar with its backup and binds it into the plan', async () => {
    const home = await makeHome();
    const directory = pluginDir(home);
    mkdirSync(directory, { recursive: true });
    // A backup written in WAL mode: committed rows live in the `-wal`, which is
    // why the inspection reads it. The sidecars therefore have to be part of the
    // deletion and of the plan identity, or a WAL-only change would slip past the
    // token and leave committed rows plus an orphaned sidecar behind.
    const staging = await makeHome();
    const live = join(staging, 'arbiter.db');
    const writer = new DatabaseSync(live);
    writer.exec(OWNED_DDL);
    writer.exec('PRAGMA user_version = 2');
    // WAL mode is set *before* the rows are written: switching an existing
    // database into WAL checkpoints it, so rows written earlier would sit in the
    // main file and the fixture would not prove anything about a WAL-only change.
    writer.exec('PRAGMA journal_mode = WAL');
    writer.exec('PRAGMA wal_autocheckpoint = 0');
    insertCall(writer, 'one', { profile: 'gate' });
    insertCall(writer, 'two', { profile: 'gate' });
    const backup = join(directory, 'arbiter.db.backup-v2');
    const copyState = () => {
      for (const suffix of ['', '-wal', '-shm'])
        if (existsSync(`${live}${suffix}`))
          copyFileSync(`${live}${suffix}`, `${backup}${suffix}`);
    };
    copyState();

    const first = buildPlan(home);
    const names = first.targets.map((target) => target.name);
    expect(names).toContain('arbiter.db.backup-v2');
    // Which sidecars SQLite keeps is its business; this asserts the rule, not a
    // particular file set: every sidecar that exists is planned with its parent.
    const sidecars = ['-wal', '-shm', '-journal'];
    const present = sidecars.filter((suffix) =>
      existsSync(`${backup}${suffix}`),
    );
    const planned = names.filter(
      (name) =>
        name.startsWith('arbiter.db.backup-v2') &&
        name !== 'arbiter.db.backup-v2',
    );
    expect(planned.sort()).toEqual(
      present.map((suffix) => `arbiter.db.backup-v2${suffix}`).sort(),
    );
    // The WAL is the point of this case, so at least it has to be there.
    expect(present).toContain('-wal');
    expect(first.deleteRecords).toBe(2);

    // A third call for another profile lands only in the backup's WAL.
    insertCall(writer, 'three', { profile: 'intruder' });
    copyState();
    const second = buildPlan(home);
    writer.close();

    expect(second.deleteRecords).toBe(3);
    expect(second.profiles.map((entry) => entry.value)).toContain('intruder');
    // The token must change, so the earlier preview cannot authorize this state.
    expect(second.planId).not.toBe(first.planId);
    const stale = applyPlan(second, first.planId);
    expect(stale.applied).toBe(false);
    expect(stale.reason).toContain('confirmation token does not match');
    expect(existsSync(backup)).toBe(true);

    // The confirmed plan removes the backup and every sidecar with it, so no
    // committed data and no orphaned log is left behind.
    const applied = run(['--home', home, '--apply', second.planId]);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain('records removed: 3');
    expect(existsSync(backup)).toBe(false);
    for (const suffix of ['-wal', '-shm', '-journal'])
      expect(existsSync(`${backup}${suffix}`)).toBe(false);
  });

  test('reports the record count of a readable staging residue', async () => {
    const home = await makeHome();
    const directory = pluginDir(home);
    writeOldDatabase(join(directory, 'arbiter.db.backup-v2.staging'));
    // No main database: the residue is the only target, and its count must appear
    // in the preview and in the execution record rather than "unreadable".
    const plan = buildPlan(home);
    const residue = plan.targets.find(
      (target) => target.name === 'arbiter.db.backup-v2.staging',
    );
    expect(residue?.action).toBe('delete');
    expect(residue?.records?.['calls']).toBe(1);
    expect(plan.deleteRecords).toBe(1);

    const preview = run(['--home', home]);
    expect(preview.out).toContain('DELETE arbiter.db.backup-v2.staging');
    expect(preview.out).toContain('1 row(s)');

    const applied = run(['--home', home, '--apply', plan.planId]);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain('records removed: 1');
  });

  test('stops at a file that vanished mid-run and reports the partial result', async () => {
    const home = await makeHome();
    const directory = pluginDir(home);
    writeOldDatabase(join(directory, 'arbiter.db'));
    writeOldDatabase(join(directory, 'arbiter.db.backup-v2'));
    const plan = buildPlan(home);
    // The backup disappears after the operator confirmed the plan. The database
    // is already removed by then, so the run has to report that partial state
    // instead of claiming a clean no-op.
    rmSync(join(directory, 'arbiter.db.backup-v2'));

    const outcome = applyPlan(plan, plan.planId);
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toContain('arbiter.db.backup-v2: the file is gone');
    expect(outcome.removed.map((file) => file.name)).toEqual(['arbiter.db']);
    expect(outcome.removedBytes).toBeGreaterThan(0);
    expect(existsSync(join(directory, 'arbiter.db'))).toBe(false);
    expect(existsSync(join(directory, 'arbiter.db.backup-v2'))).toBe(false);

    // The rendered report has to say the run was partial. "nothing removed"
    // printed directly above "files removed: 1" is contradictory evidence for the
    // later operations task that reconciles against it.
    const rendered = renderOutcome(plan, outcome);
    expect(rendered).toContain('result: PARTIAL');
    expect(rendered).not.toContain('result: nothing removed');
    expect(rendered).toContain('files removed: 1');
  });

  test('a run that removes nothing renders as nothing removed', async () => {
    const home = await makeHome();
    const plan = buildPlan(home);
    const outcome = applyPlan(plan, plan.planId);
    const rendered = renderOutcome(plan, outcome);
    expect(rendered).toContain('result: nothing removed');
    expect(rendered).not.toContain('PARTIAL');
  });
});

describe('fail-closed inspection', () => {
  test('refuses a database whose effective version is only in the WAL', async () => {
    const home = await makeHome();
    const directory = pluginDir(home);
    mkdirSync(directory, { recursive: true });
    // The main header says schema 2 while the version was raised to 99 inside an
    // uncheckpointed WAL. Reading only the header would classify a newer build's
    // database as old data and delete it.
    //
    // The state has to be *copied* into place: closing the writer checkpoints the
    // WAL, which would quietly move the version back into the header and make
    // the fixture prove nothing.
    const writer = await makeHome();
    const live = join(writer, 'arbiter.db');
    const db = new DatabaseSync(live);
    db.exec(OWNED_DDL);
    insertCall(db, 'wal-version');
    db.exec('PRAGMA user_version = 2');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA wal_autocheckpoint = 0');
    db.exec('PRAGMA user_version = 99');
    for (const suffix of ['', '-wal', '-shm'])
      if (existsSync(`${live}${suffix}`))
        copyFileSync(
          `${live}${suffix}`,
          join(directory, `arbiter.db${suffix}`),
        );
    db.close();

    const plan = buildPlan(home);
    const target = plan.targets[0];
    expect(target?.probe?.version).toBe(2);
    expect(target?.probe?.effectiveVersion).toBe(99);
    // The disagreement is refused instead of resolved in favour of either read.
    expect(target?.action).toBe('refuse');
    expect(target?.reason).toContain('does not decide which reading is right');
    expect(plan.deleteCount).toBe(0);
  });

  test('binds the confirmation token to the data directory', async () => {
    const first = await makeHome();
    const second = await makeHome();
    // Byte-identical copies in two data directories: the same files, sizes and
    // digests. Only the directory differs, and the token has to differ with it.
    const source = join(pluginDir(first), 'arbiter.db');
    writeOldDatabase(source);
    mkdirSync(pluginDir(second), { recursive: true });
    copyFileSync(source, join(pluginDir(second), 'arbiter.db'));
    const before = treeDigest(second);

    const firstPlan = buildPlan(first);
    const secondPlan = buildPlan(second);
    expect(firstPlan.planId).not.toBe(secondPlan.planId);

    // A token from the first directory cannot authorize a deletion in the second.
    const outcome = applyPlan(secondPlan, firstPlan.planId);
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toContain('confirmation token does not match');
    expect(existsSync(join(pluginDir(second), 'arbiter.db'))).toBe(true);
    expect(treeDigest(second)).toBe(before);
  });

  test('refuses a database whose calls cannot be attributed to a profile', async () => {
    const home = await makeHome();
    const database = join(pluginDir(home), 'arbiter.db');
    mkdirSync(pluginDir(home), { recursive: true });
    // The ownership tables are all present, but this `calls` table has no
    // `profile` column. "No profile names found" must not read as "no other
    // profile is affected".
    const db = new DatabaseSync(database);
    db.exec(`CREATE TABLE calls (
        call_id TEXT PRIMARY KEY, ts INTEGER, workspace TEXT,
        record_format_version INTEGER NOT NULL, result TEXT);
      CREATE TABLE stages (id INTEGER PRIMARY KEY);
      CREATE TABLE model_calls (id TEXT PRIMARY KEY);
      CREATE TABLE config_snapshots (snapshot_id TEXT PRIMARY KEY);
      PRAGMA user_version = 2;`);
    db.prepare('INSERT INTO calls VALUES (?,?,?,?,?)').run(
      'no-profile',
      Date.now(),
      '/tmp',
      1,
      'review-allow',
    );
    db.close();
    const before = treeDigest(home);

    const refused = run(['--home', home, '--profiles', 'gate']);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('profile');
    expect(refused.out).toContain('cannot be established');
    expect(existsSync(database)).toBe(true);
    expect(treeDigest(home)).toBe(before);
  });

  test('refuses when the plugin directory is swapped for a symlink after the preview', async () => {
    const home = await makeHome();
    const outside = await makeHome();
    const directory = pluginDir(home);
    writeOldDatabase(join(directory, 'arbiter.db'));
    const plan = buildPlan(home);

    // The whole directory is replaced by a link to a directory holding
    // byte-identical targets. Every file's path, size and digest still match the
    // plan, so only re-proving the directory's identity can catch it.
    const decoy = join(outside, 'arbiter');
    writeOldDatabase(join(decoy, 'arbiter.db'));
    rmSync(directory, { recursive: true, force: true });
    symlinkSync(decoy, directory);
    const outsideBefore = treeDigest(decoy);

    const outcome = applyPlan(plan, plan.planId);
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toContain('now resolves to');
    expect(existsSync(join(decoy, 'arbiter.db'))).toBe(true);
    expect(treeDigest(decoy)).toBe(outsideBefore);
  });

  test('refuses a target replaced by a symlink after the preview', async () => {
    const home = await makeHome();
    const outside = await makeHome();
    const directory = pluginDir(home);
    writeOldDatabase(join(directory, 'arbiter.db'));
    const plan = buildPlan(home);

    // The file itself is swapped for a link to an identical copy elsewhere.
    // Unlinking it would remove the link, not the data the operator was shown.
    const decoyFile = join(outside, 'decoy.db');
    copyFileSync(join(directory, 'arbiter.db'), decoyFile);
    rmSync(join(directory, 'arbiter.db'));
    symlinkSync(decoyFile, join(directory, 'arbiter.db'));

    const outcome = applyPlan(plan, plan.planId);
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toContain('now a symlink');
    expect(existsSync(decoyFile)).toBe(true);
  });

  test('refuses when the plugin directory cannot be listed', async () => {
    const home = await makeHome();
    const directory = pluginDir(home);
    writeOldDatabase(join(directory, 'arbiter.db'));
    // A directory that can be stat'ed but not read is not an empty scope: the
    // old data may be right there and this run never saw it.
    chmodSync(directory, 0o000);
    const plan = buildPlan(home);
    chmodSync(directory, 0o755);

    expect(plan.directoryExists).toBe(false);
    expect(plan.refusals[0]).toContain('could not be listed');
    expect(plan.deleteCount).toBe(0);
    expect(existsSync(join(directory, 'arbiter.db'))).toBe(true);
  });

  test('refuses an empty SQLite file rather than assuming it is this plugin', async () => {
    const home = await makeHome();
    const database = join(pluginDir(home), 'arbiter.db');
    mkdirSync(pluginDir(home), { recursive: true });
    // A stamped SQLite file with no application table proves nothing about who
    // wrote it, so the name is not accepted as evidence.
    const db = new DatabaseSync(database);
    db.exec('PRAGMA user_version = 2');
    db.close();
    const before = treeDigest(home);

    const plan = buildPlan(home);
    expect(plan.targets[0]?.action).toBe('refuse');
    expect(plan.targets[0]?.reason).toContain('nothing proves it belongs');
    const applied = run(['--home', home, '--apply', plan.planId]);
    expect(applied.code).toBe(1);
    expect(existsSync(database)).toBe(true);
    expect(treeDigest(home)).toBe(before);
  });
});

describe('historical structures', () => {
  test('resets the authentic v1 structure that has no record_format_version column', async () => {
    const home = await makeHome();
    const directory = pluginDir(home);
    mkdirSync(directory, { recursive: true });
    // The structure this project actually shipped first: `signals` and
    // `policy_strategy` instead of the format column. A missing column is a fact
    // about those rows (they declare no format), not an unreadable count — the
    // distinction decides whether the databases this tool exists for can be reset.
    const db = new DatabaseSync(join(directory, 'arbiter.db'));
    db.exec(`CREATE TABLE calls (
        call_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, session_id TEXT NOT NULL,
        session_kind TEXT NOT NULL, parent_session TEXT, profile TEXT, workspace TEXT,
        tool TEXT NOT NULL, arguments TEXT NOT NULL, cwd TEXT NOT NULL,
        fingerprint TEXT NOT NULL, config_revision TEXT NOT NULL,
        config_snapshot_id TEXT NOT NULL, approval_mode TEXT NOT NULL,
        execution_mode TEXT NOT NULL, result TEXT NOT NULL, reason TEXT NOT NULL,
        trace TEXT NOT NULL, effect TEXT NOT NULL, session_record_state TEXT NOT NULL,
        signals TEXT, policy_strategy TEXT, decision_rules TEXT NOT NULL,
        execution_status TEXT NOT NULL);
      CREATE TABLE stages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL, seq INTEGER NOT NULL,
        stage TEXT NOT NULL, result TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE TABLE model_calls (
        id TEXT PRIMARY KEY, call_id TEXT NOT NULL, attempt INTEGER NOT NULL,
        backend TEXT NOT NULL, protocol TEXT NOT NULL, request TEXT NOT NULL,
        started_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
        estimated_input_tokens INTEGER NOT NULL);
      CREATE TABLE config_snapshots (
        snapshot_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL, format_version INTEGER NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO calls VALUES ('v1-a', 1600000000000, 's', 'main', NULL, 'gate',
        '/tmp', 'bash', '{"command":"ls"}', '/tmp', 'fp', 'rev', 'cfg', 'ask',
        'trusted', 'review-allow', 'old', '[]', '', 'written', '{"riskClass":"low"}',
        NULL, '[]', 'pending');
      PRAGMA user_version = 1;`);
    db.close();

    const plan = buildPlan(home);
    expect(plan.targets[0]?.action).toBe('delete');
    expect(plan.targets[0]?.reason).toContain(
      'old Arbiter audit data (schema 1',
    );
    // The rows are counted and reported, not guessed at.
    expect(plan.deleteRecords).toBe(1);
    expect(plan.targets[0]?.probe?.currentFormatRecords).toBe(0);
    expect(plan.targets[0]?.probe?.foreignRecords).toBe(1);

    const applied = run(['--home', home, '--apply', plan.planId]);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain('records removed: 1');
    expect(existsSync(join(directory, 'arbiter.db'))).toBe(false);
  });

  test('counts a table whose name needs quoting instead of deleting it unread', async () => {
    const home = await makeHome();
    const directory = pluginDir(home);
    writeOldDatabase(join(directory, 'arbiter.db'));
    // A table with a space in its name. Skipping it would leave real rows
    // uncounted inside a file the plan then deletes, so the inventory would be
    // wrong in exactly the way the dry-run exists to prevent.
    const db = new DatabaseSync(join(directory, 'arbiter.db'));
    db.exec(
      'CREATE TABLE "operator notes" (id INTEGER PRIMARY KEY, body TEXT)',
    );
    db.prepare('INSERT INTO "operator notes" (body) VALUES (?)').run('kept?');
    db.close();

    const plan = buildPlan(home);
    expect(plan.targets[0]?.action).toBe('delete');
    expect(plan.targets[0]?.records?.['operator notes']).toBe(1);
    expect(plan.deleteRecords).toBe(2);

    const applied = run(['--home', home, '--apply', plan.planId]);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain('records removed: 2');
  });

  test('refuses a dangling plugin-directory symlink instead of reporting an empty scope', async () => {
    const home = await makeHome();
    // `existsSync` follows links and reports false for a dangling one, which used
    // to read as "the directory is absent" and exit 0 on a scope nothing verified.
    symlinkSync(join(home, 'does-not-exist'), pluginDir(home));

    const { code, out } = run(['--home', home]);
    expect(code).toBe(1);
    expect(out).toContain('dangling symlink');
    expect(out).toContain('plan id: (blocked)');
  });
});

describe('refusals', () => {
  test('refuses a database that is not this plugin audit history', async () => {
    const home = await makeHome();
    const database = join(pluginDir(home), 'arbiter.db');
    writeForeignDatabase(database);
    const before = treeDigest(home);

    const { code, out } = run(['--home', home]);
    expect(code).toBe(1);
    expect(out).toContain('REFUSE');
    expect(out).toContain('it is not an Arbiter audit database');
    expect(out).toContain('Refused (the plan cannot be applied)');
    // Even the token from that preview cannot delete a file the plan refused.
    const applied = run(['--home', home, '--apply', planIdOf(out)]);
    expect(applied.code).toBe(1);
    expect(applied.out).toContain('the plan is blocked by 1 refused target(s)');
    // A blocked run must not report an emptied directory: the refused file is
    // still there, and saying otherwise would tell the operator their old data
    // is gone when nothing was removed.
    expect(applied.out).toContain('left in the directory: arbiter.db');
    expect(existsSync(database)).toBe(true);
    expect(treeDigest(home)).toBe(before);
  });

  test('refuses a database written by a newer build instead of deleting it', async () => {
    const home = await makeHome();
    const database = join(pluginDir(home), 'arbiter.db');
    writeOldDatabase(database, { version: 99 });
    const before = treeDigest(home);

    const plan = buildPlan(home);
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]?.action).toBe('keep');
    expect(plan.targets[0]?.reason).toContain('newer build');
    expect(plan.deleteCount).toBe(0);
    const { code } = run(['--home', home, '--apply', plan.planId]);
    expect(code).toBe(1);
    expect(treeDigest(home)).toBe(before);
  });

  test('refuses a file whose header claims SQLite but is not one', async () => {
    const home = await makeHome();
    const database = join(pluginDir(home), 'arbiter.db');
    mkdirSync(pluginDir(home), { recursive: true });
    writeFileSync(database, 'this is not a database, whatever its name says');

    const plan = buildPlan(home);
    expect(plan.targets[0]?.action).toBe('refuse');
    expect(plan.refusals[0]).toContain('ownership cannot be proven');
    expect(plan.deleteCount).toBe(0);
  });

  test('refuses to delete through a symlink', async () => {
    const home = await makeHome();
    const outside = await makeHome();
    writeOldDatabase(join(outside, 'arbiter.db'));
    mkdirSync(pluginDir(home), { recursive: true });
    symlinkSync(
      join(outside, 'arbiter.db'),
      join(pluginDir(home), 'arbiter.db'),
    );

    const plan = buildPlan(home);
    expect(plan.targets[0]?.action).toBe('refuse');
    expect(plan.targets[0]?.reason).toContain('symlink');
    expect(plan.deleteCount).toBe(0);
    expect(existsSync(join(outside, 'arbiter.db'))).toBe(true);
  });

  test('refuses a data directory that is really a DSH profile directory', async () => {
    const home = await makeHome();
    mkdirSync(pluginDir(home), { recursive: true });
    writeFileSync(join(home, 'cordis.patch.yml'), '[]\n');
    writeOldDatabase(join(pluginDir(home), 'arbiter.db'));
    const before = treeDigest(home);

    const { code, out } = run(['--home', home]);
    expect(code).toBe(1);
    expect(out).toContain('is a DSH profile directory');
    expect(treeDigest(home)).toBe(before);
  });

  test('refuses when an unauthorized profile also holds old records', async () => {
    const home = await makeHome();
    const database = join(pluginDir(home), 'arbiter.db');
    writeOldDatabase(database, { profiles: ['gate', 'somebody-else'] });
    const before = treeDigest(home);

    // `--profiles-note` is not a flag: the tool refuses it instead of ignoring it.
    const unknownFlag = run([
      '--home',
      home,
      '--profiles',
      'gate',
      '--profiles-note',
    ]);
    expect(unknownFlag.code).toBe(2);

    const refused = run(['--home', home, '--profiles', 'gate']);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain(
      'not among the profiles the reset was authorized for',
    );
    expect(existsSync(database)).toBe(true);
    expect(treeDigest(home)).toBe(before);

    // Naming both profiles authorizes the deletion and nothing is blocked.
    const allowed = run(['--home', home, '--profiles', 'gate,somebody-else']);
    expect(allowed.code).toBe(0);
    expect(allowed.out).toContain('DELETE arbiter.db');
  });

  test('always refuses a structurally old database that also holds current-format rows', async () => {
    const home = await makeHome();
    const database = join(pluginDir(home), 'arbiter.db');
    writeOldDatabase(database, { currentFormatRows: 2 });
    const before = treeDigest(home);

    const refused = run(['--home', home]);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('current record format');
    expect(refused.out).toContain('REFUSE arbiter.db');
    expect(existsSync(database)).toBe(true);
    expect(treeDigest(home)).toBe(before);

    // There is no flag that widens this. The reset's authority covers old test
    // data, not rows the current contract produced, so a CLI switch cannot turn
    // mixed state into an authorized deletion — the invocation is rejected
    // outright rather than quietly honoured.
    const overridden = run([
      '--home',
      home,
      '--include-current-format-records',
    ]);
    expect(overridden.code).toBe(2);
    expect(existsSync(database)).toBe(true);
    expect(treeDigest(home)).toBe(before);
  });
});

describe('usage', () => {
  test('requires an explicit data directory', () => {
    const { code, out } = run([]);
    expect(code).toBe(2);
    expect(out).toBe('');
  });

  test('refuses unknown flags rather than ignoring them', async () => {
    const home = await makeHome();
    const { code } = run(['--home', home, '--yes']);
    expect(code).toBe(2);
  });

  test('prints the plan and not an execution section when only previewing', async () => {
    const home = await makeHome();
    writeOldDatabase(join(pluginDir(home), 'arbiter.db'));
    const text = renderPlan(buildPlan(home));
    expect(text).toContain('preview');
    expect(text).toContain('plan id: ');
    expect(text).not.toContain('Execution:');
  });
});
