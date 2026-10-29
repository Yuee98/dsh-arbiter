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
import { renderPlan } from '../../scripts/arbiter-reset/report.ts';
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
    writeFileSync(join(directory, 'arbiter.db.backup-v2.staging'), 'partial');
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

  test('refuses a structurally old database that also holds current-format rows', async () => {
    const home = await makeHome();
    const database = join(pluginDir(home), 'arbiter.db');
    writeOldDatabase(database, { currentFormatRows: 2 });
    const before = treeDigest(home);

    const refused = run(['--home', home]);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('current record format');
    expect(existsSync(database)).toBe(true);
    expect(treeDigest(home)).toBe(before);

    // The operator can acknowledge the mixed state explicitly; the reason then
    // records that those rows went with it.
    const allowed = run(['--home', home, '--include-current-format-records']);
    expect(allowed.code).toBe(0);
    expect(allowed.out).toContain('operator acknowledged');
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
