import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AuditStore } from '../../src/audit.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { callRedactor } from '../../src/host/call-snapshot.js';
import { initializeHost, releaseRuntime } from '../../src/host/runtime.js';
import type { ContextLike, HostEnvironment } from '../../src/host/types.js';
import { credentialRegistry } from '../../src/reviewer/credential-registry.js';
import { resultCall, resultObservation } from './tool-result-helpers.js';

let root: string;
let physical: string;
let alias: string;
const stores: AuditStore[] = [];
const connections: DatabaseSync[] = [];
const hosts: HostEnvironment[] = [];
const effects: (() => unknown)[] = [];
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'arbiter-db-identity-')));
  mkdirSync(join(root, 'physical', 'arbiter'), { recursive: true });
  symlinkSync(join(root, 'physical'), join(root, 'alias'), 'junction');
  physical = join(root, 'physical', 'arbiter', 'arbiter.db');
  alias = join(root, 'alias', 'arbiter', 'arbiter.db');
});
afterEach(() => {
  for (const cleanup of effects.splice(0)) cleanup();
  for (const host of hosts.splice(0)) {
    host.runtime.instances -= 1;
    releaseRuntime(host.runtime);
  }
  for (const store of stores.splice(0)) store.close();
  for (const db of connections.splice(0)) db.close();
  rmSync(root, { recursive: true, force: true });
});
function open(path: string, days = 30, bytes = 1_073_741_824) {
  const store = new AuditStore(path, {
    ...DEFAULT_CONFIG.audit,
    retentionDays: days,
    retentionBytes: bytes,
  });
  stores.push(store);
  return store;
}
function connection(path = physical) {
  const db = new DatabaseSync(path);
  connections.push(db);
  return db;
}
function fileAlias() {
  open(physical).close();
  const path = join(root, 'file-alias.db');
  symlinkSync(physical, path, 'file');
  return path;
}
function createHost(throughAlias = true) {
  const previous = process.env['DSH_HOME'];
  process.env['DSH_HOME'] = join(root, throughAlias ? 'alias' : 'physical');
  const ctx: ContextLike = {
    get: () => undefined,
    on: () => () => undefined,
    effect: (callback) => {
      const cleanup = callback();
      if (typeof cleanup === 'function')
        effects.push(() => Reflect.apply(cleanup, undefined, []));
      return undefined;
    },
    inject: () => undefined,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
  try {
    const host = initializeHost(ctx, DEFAULT_CONFIG);
    hosts.push(host);
    return host;
  } finally {
    if (previous === undefined) delete process.env['DSH_HOME'];
    else process.env['DSH_HOME'] = previous;
  }
}
function bytesAt(paths: readonly string[]) {
  return paths.map((path) => (existsSync(path) ? readFileSync(path) : null));
}

describe('one physical audit database identity', () => {
  test.each([
    [false, false, true],
    [false, true, true],
    [true, false, true],
    [true, true, true],
    [false, false, false],
  ] as const)(
    'S01: host known credentials reach CallRecord/result bytes, physical-first=%s, large=%s, alias=%s',
    async (physicalFirst, large, throughAlias) => {
      const first = physicalFirst ? open(physical) : undefined;
      const host = createHost(throughAlias);
      const writer = first ?? open(physical);
      const session = { id: 'session', header: { id: 'session' } };
      const redactor = callRedactor(host, session);
      const known = 'synthetic-known-value-without-label';
      redactor.discover({ password: known });
      const marker = redactor.text(known);
      expect(marker).not.toBe(known);
      const body = `${known}\n${'safe-output\n'.repeat(large ? 7000 : 1)}`;
      expect(
        writer.saveToolResult(
          resultObservation({
            parts: [{ kind: 'text', channel: 'stdout', text: body }],
          }),
        ).state,
      ).toBe('saved');
      writer.enqueue(
        resultCall({ reason: known, arguments: { value: known } }),
      );
      await writer.flush();
      const result = writer.getToolResult('session', 'query');
      expect(result.state).toBe('found');
      expect(result.fragments[0]?.text).toBe(body.replace(known, marker));
      expect(writer.getCall('query')?.['reason']).toBe(marker);
      const db = connection(alias);
      expect(credentialRegistry(db, db.location()).context('session')).toBe(
        redactor,
      );
      const raw = JSON.stringify([
        db.prepare('SELECT * FROM calls').all(),
        db.prepare('SELECT * FROM tool_results').all(),
      ]);
      expect(raw).not.toContain(known);
      expect(raw).toContain(marker);
      expect(host.currentAudit()?.databasePath).toBe(physical);
      expect(result.storage).toBe(large ? 'file' : 'inline');
      const retained = large
        ? readFileSync(join(`${physical}.results`, result.fileRef ?? ''))
        : Buffer.from(
            result.fragments.map((fragment) => fragment.text).join(''),
          );
      expect(retained.toString()).toContain(marker);
      for (const bytes of bytesAt([physical, `${physical}-wal`]))
        expect(bytes?.includes(Buffer.from(known))).not.toBe(true);
      expect(retained.includes(Buffer.from(known))).toBe(false);
    },
  );

  test.each([
    ['directory', false],
    ['directory', true],
    ['file', false],
    ['file', true],
  ] as const)(
    '%s alias stores share body files and cleanup, physical-first=%s',
    (kind, physicalFirst) => {
      const alternate = kind === 'file' ? fileAlias() : alias;
      const writer = open(physicalFirst ? physical : alternate);
      const text = 'safe-body\n'.repeat(8000);
      expect(
        writer.saveToolResult(
          resultObservation({
            parts: [{ kind: 'text', channel: 'stdout', text }],
          }),
        ).state,
      ).toBe('saved');
      const reader = open(physicalFirst ? alternate : physical);
      const saved = reader.getToolResult('session', 'query');
      expect(saved.state).toBe('found');
      expect(saved.fragments[0]?.text).toBe(text);
      expect(writer.databasePath).toBe(physical);
      const body = join(`${physical}.results`, saved.fileRef ?? '');
      expect(statSync(body).size).toBe(Buffer.byteLength(text));
      const unrelated = `${alternate}.results`;
      mkdirSync(unrelated, { recursive: true });
      writeFileSync(
        join(unrelated, 'user-notes.txt'),
        'preserved alias directory',
      );
      expect(reader.recoverToolResults().ok).toBe(true);
      expect(existsSync(body)).toBe(true);
      expect(writer.databaseBytes).toBeGreaterThanOrEqual(statSync(body).size);
      expect(reader.clearCalls().ok).toBe(true);
      expect(existsSync(body)).toBe(false);
      expect(readFileSync(join(unrelated, 'user-notes.txt'), 'utf8')).toBe(
        'preserved alias directory',
      );
    },
  );

  test.each([
    ['directory', false],
    ['directory', true],
    ['file', false],
    ['file', true],
  ] as const)(
    'S01: %s clear fences alias queues, physical-first=%s',
    async (kind, physicalFirst) => {
      const alternate = kind === 'file' ? fileAlias() : alias;
      const first = open(physicalFirst ? physical : alternate);
      const second = open(physicalFirst ? alternate : physical);
      first.enqueue(resultCall({ callId: 'before-clear' }));
      expect(second.clearCalls().ok).toBe(true);
      await first.flush();
      expect(first.getCall('before-clear')).toBeNull();
      first.enqueue(resultCall({ callId: 'after-clear' }));
      await first.flush();
      expect(second.getCall('after-clear')?.['callId']).toBe('after-clear');
    },
  );

  test.each([
    ['directory', false],
    ['directory', true],
    ['file', false],
    ['file', true],
  ] as const)(
    'S01: %s policy survives owner transfer, physical-first=%s',
    (kind, physicalFirst) => {
      const alternate = kind === 'file' ? fileAlias() : alias;
      const first = open(physicalFirst ? physical : alternate, 30, 900_000);
      const second = open(physicalFirst ? alternate : physical, 1, 200_000);
      expect(second.retention).toEqual(first.retention);
      expect(second.health().state).toBe('degraded');
      first.updateConfig({
        ...DEFAULT_CONFIG.audit,
        retentionDays: 20,
        retentionBytes: 800_000,
      });
      expect(second.retention).toEqual({ days: 20, bytes: 800_000 });
      first.close();
      second.updateConfig({
        ...DEFAULT_CONFIG.audit,
        retentionDays: 1,
        retentionBytes: 200_000,
      });
      expect(second.retention).toEqual({ days: 20, bytes: 800_000 });
      second.updateConfig({
        ...DEFAULT_CONFIG.audit,
        retentionDays: 3,
        retentionBytes: 300_000,
      });
      expect(open(physical).retention).toEqual({ days: 3, bytes: 300_000 });
    },
  );

  test.each([
    [3, 'file'],
    [3, 'directory'],
    [5, 'file'],
    [5, 'directory'],
  ] as const)(
    'refuses version %i through %s alias without touching DB/WAL/body',
    (version, kind) => {
      open(physical).close();
      const db = connection();
      db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
      db.exec(`PRAGMA user_version = ${String(version)}`);
      const file = kind === 'file' ? join(root, 'refused-alias.db') : alias;
      if (kind === 'file') symlinkSync(physical, file, 'file');
      mkdirSync(`${physical}.results`);
      const body = join(`${physical}.results`, 'user-body.txt');
      writeFileSync(body, 'preserve refused body');
      const paths = [physical, `${physical}-wal`, `${physical}-shm`, body];
      const before = bytesAt(paths);
      expect(open(file).paused).toBe(true);
      expect(bytesAt(paths)).toEqual(before);
      expect(readdirSync(`${physical}.results`)).toEqual(['user-body.txt']);
    },
  );
});

describe('credential file domains', () => {
  test('unresolved dangling database symlink fails without creating a new database', () => {
    const missing = join(root, 'missing.db');
    symlinkSync(missing, physical, 'file');
    expect(() => open(alias)).toThrow();
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(`${physical}.results`)).toBe(false);
  });

  test.each([false, true])(
    'missing file shares actual parent before SQLite creation, alias-first=%s',
    (aliasFirst) => {
      const owner = {};
      const domain = aliasFirst ? alias : physical;
      const registry = credentialRegistry(owner, domain);
      registry
        .context('session')
        .discover({ password: 'synthetic-precreation-known' });
      open(aliasFirst ? physical : alias);
      const db = connection(aliasFirst ? alias : physical);
      const shared = credentialRegistry(db, db.location());
      expect(shared).toBe(registry);
      expect(
        shared.context('session').text('synthetic-precreation-known'),
      ).not.toBe('synthetic-precreation-known');
    },
  );

  test.each([false, true])(
    'file aliases share two real SQLite connections, alias-first=%s',
    (aliasFirst) => {
      const file = fileAlias();
      const first = connection(aliasFirst ? file : physical);
      const second = connection(aliasFirst ? physical : file);
      const owner = {};
      const registry = credentialRegistry(owner, aliasFirst ? file : physical);
      registry
        .context('session')
        .discover({ password: 'synthetic-file-known' });
      expect(credentialRegistry(first, first.location())).toBe(registry);
      expect(credentialRegistry(second, second.location())).toBe(registry);
      expect(credentialRegistry({}, aliasFirst ? physical : file)).toBe(
        registry,
      );
    },
  );

  test('conflicting established owner cannot overwrite file-domain knowledge', () => {
    const owner = {};
    const previous = credentialRegistry(owner);
    previous.context('session').discover({ password: 'synthetic-owner-known' });
    const established = credentialRegistry({}, physical);
    established
      .context('session')
      .discover({ password: 'synthetic-domain-known' });
    expect(() => credentialRegistry(owner, alias)).toThrow(
      'conflicts with established file domain',
    );
    expect(credentialRegistry(owner)).toBe(previous);
    expect(credentialRegistry({}, physical)).toBe(established);
    expect(
      established.context('session').text('synthetic-domain-known'),
    ).not.toBe('synthetic-domain-known');
    expect(previous.context('session').text('synthetic-owner-known')).not.toBe(
      'synthetic-owner-known',
    );
  });

  test('logical domains keep their identity independently of filesystem paths', () => {
    const logical = `workflow:${root}`;
    const registry = credentialRegistry({}, logical);
    expect(credentialRegistry({}, logical)).toBe(registry);
    expect(credentialRegistry({}, `${logical}:other`)).not.toBe(registry);
    expect(credentialRegistry({}, physical)).not.toBe(registry);
  });
});
