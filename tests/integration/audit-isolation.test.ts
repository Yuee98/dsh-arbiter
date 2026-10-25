import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { AuditStore, resolveAuditPath } from '../../src/audit.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { initializeHost } from '../../src/host/runtime.js';
import { ConfigurationAccess } from '../../src/host/configuration.js';
import { statePayload } from '../../src/host/state.js';
import type { ConnectionLike, HostEnvironment } from '../../src/host/types.js';
import { DecisionHistory } from '../../src/host/history.js';
import { CallSettlement } from '../../src/host/settlement.js';
import type {
  AuditExtras,
  CallContext,
  ToolExecutionLike,
} from '../../src/host/types.js';
import type { AgentLike, SessionLike } from '../../src/snapshot/types.js';
import { createStubContext, stubEditor } from '../helpers/host-stub.js';

/**
 * Audit fault isolation.
 *
 * What is pinned here:
 *   - a database this build cannot migrate keeps configuration, approvals and
 *     session records working, and reports why audit is unavailable;
 *   - a paused store writes nothing and leaves the newer database untouched;
 *   - the state payload separates the effective configuration from a missing
 *     history, so a broken database cannot read as a rolled-back config.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'arbiter-audit-isolation-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('expected an object');
  return { ...value };
}

function recordField(value: unknown, name: string): unknown {
  const source = asRecord(value);
  return Object.hasOwn(source, name) ? Reflect.get(source, name) : undefined;
}

function numberField(value: unknown, name: string): number {
  const field = recordField(value, name);
  if (typeof field !== 'number' || !Number.isFinite(field))
    throw new TypeError(`${name} must be a number`);
  return field;
}

function stringField(value: unknown, name: string): string {
  const field = recordField(value, name);
  if (typeof field !== 'string')
    throw new TypeError(`${name} must be a string`);
  return field;
}

function userVersion(path: string): number {
  const db = new DatabaseSync(path);
  try {
    return numberField(db.prepare('PRAGMA user_version').get(), 'user_version');
  } finally {
    db.close();
  }
}

interface Started {
  readonly host: HostEnvironment;
  readonly home: string;
}

async function startHost(
  options: { readonly config?: unknown; readonly breakDatabase?: boolean } = {},
): Promise<Started> {
  const home = join(root, 'home');
  const profileDir = join(home, 'profiles', 'audit-isolation');
  const documentPath = join(profileDir, 'cordis.patch.yml');
  await mkdir(profileDir, { recursive: true });
  await writeFile(
    documentPath,
    options.config === undefined
      ? '[]\n'
      : `${JSON.stringify(options.config)}\n`,
    'utf8',
  );
  if (options.breakDatabase === true) {
    // A database written by a newer plugin: this build must not modify it.
    await mkdir(join(home, 'arbiter'), { recursive: true });
    const db = new DatabaseSync(resolveAuditPath(home));
    db.exec('CREATE TABLE calls (call_id TEXT PRIMARY KEY)');
    db.exec('PRAGMA user_version = 99');
    db.close();
  }
  const connection: ConnectionLike = {
    fetch: { register: () => () => undefined },
  };
  const parts = createStubContext({
    profileContext: { home, dir: profileDir, name: 'audit-isolation' },
    sandboxPolicy: { defaultMode: 'workspace-write' },
    sessions: { get: () => undefined },
    approval: {
      config: { policy: 'ask' },
      request: () => Promise.resolve('allowed-once'),
    },
    permissionPresets: { registerAuto: () => () => undefined },
    workingDirectory: { ensure: () => Promise.resolve(home) },
    connection,
    configEditor: stubEditor({
      documentPath,
      config: () => options.config ?? {},
      onEdit: () => undefined,
    }),
  });
  return {
    host: initializeHost(parts.ctx, options.config),
    home,
  };
}

function stateOf(host: HostEnvironment): Record<string, unknown> {
  return asRecord(statePayload(host, new ConfigurationAccess(host)));
}

/**
 * Settle one approved call through the real settlement adapter.
 *
 * This is the production path that adds a `runtime.pending` entry, so the test
 * exercises the same code the host runs rather than a hand-written map insert.
 */
function settle(options: {
  readonly host: HostEnvironment;
  readonly callId: string;
  readonly ts: number;
}): void {
  const { host, callId, ts } = options;
  const settlement = new CallSettlement(host, new DecisionHistory(host));
  const extras: AuditExtras = {
    effect: null,
    signals: null,
    snapshot: null,
    strategy: 'normal',
    decisionRules: [],
    modelAttempts: [],
    ruleId: null,
  };
  const session: SessionLike = { id: 'session' };
  const agent: AgentLike = { session };
  const exec: ToolExecutionLike = {
    callId,
    name: 'bash',
    arguments: { command: 'echo hi' },
    signal: new AbortController().signal,
  };
  const call: CallContext = {
    exec,
    agent,
    session,
    sessionKind: 'main',
    mode: 'normal',
    cwd: '/w',
    trace: [],
  };
  settlement.finalize(call, 'review-allow', 'approved', extras);
  // The entry's timestamp drives the stale sweep; shift it for the stale case.
  const entry = host.runtime.pending.get(callId);
  if (entry !== undefined)
    host.runtime.pending.set(callId, { sessionId: entry.sessionId, ts });
}

describe('an unmigratable audit database', () => {
  test('keeps configuration readable and reports why audit is down', async () => {
    const { host } = await startHost({ breakDatabase: true });
    expect(host.audit).not.toBeNull();
    expect(host.audit?.paused).toBe(true);
    expect(host.audit?.health()).toMatchObject({
      state: 'unavailable',
      lastError: expect.stringContaining('newer') as unknown,
    });

    const payload = stateOf(host);
    // The effective configuration is a separate fact from storage health.
    expect(recordField(payload, 'config')).toBeTruthy();
    expect(recordField(payload, 'invalidConfigError')).toBeNull();
    // No fabricated identity: the snapshot is unavailable rather than stale.
    expect(recordField(payload, 'configSnapshotId')).toBe('cfg-unavailable');
    expect(recordField(payload, 'configHistoryComplete')).toBe(false);
    const health = asRecord(
      recordField(recordField(payload, 'audit'), 'health'),
    );
    expect(stringField(health, 'state')).toBe('unavailable');
  });

  test('a paused store accepts no records and leaves the file untouched', async () => {
    const { home } = await startHost({ breakDatabase: true });
    const path = resolveAuditPath(home);
    const versionBefore = userVersion(path);
    const store = new AuditStore(path, DEFAULT_CONFIG.audit);
    expect(store.paused).toBe(true);
    // Callers keep calling this; it must be a no-op with a health note.
    store.enqueue({
      callId: 'blocked',
      ts: Date.now(),
      sessionId: 's1',
      sessionKind: 'main',
      parentSession: null,
      profile: null,
      workspace: null,
      tool: 'bash',
      arguments: { command: 'echo hi' },
      cwd: '/w',
      fingerprint: 'bash:abc',
      configRevision: 'r1',
      configSnapshotId: 'cfg-1',
      approvalMode: 'normal',
      executionMode: 'trusted',
      result: 'review-allow',
      reason: 'test',
      trace: [],
      effect: null,
      sessionRecordState: 'written',
      snapshot: null,
      modelAttempts: [],
      signals: null,
      policyStrategy: null,
      decisionRules: [],
      executionStatus: 'pending',
    });
    await store.flush();
    expect(store.health().state).toBe('unavailable');
    expect(store.health().lastError).toContain('newer');
    // Every mutating entry point is contained, not just enqueue.
    expect(store.saveConfigSnapshot(DEFAULT_CONFIG)).toBeNull();
    expect(store.recordActivation('cfg-x', 'rev-x', 'ui', 'profile')).toBe(
      false,
    );
    expect(store.runRetention().deleted).toBe(0);
    expect(store.clearCalls()).toBe(0);
    store.close();
    expect(userVersion(path)).toBe(versionBefore);
  });

  test('unresolved pending entries stay bounded and keep an unknown outcome', async () => {
    const { host } = await startHost();
    const pending = host.runtime.pending;
    // Simulate approved calls whose result event never arrives.
    for (let index = 0; index < 900; index += 1) {
      settle({
        host,
        callId: `abandoned-${String(index)}`,
        ts: Date.now(),
      });
    }
    expect(pending.size).toBeLessThanOrEqual(512);
    // The stored record must keep `pending`: the outcome is unknown, not failed.
    const audit = host.audit;
    if (audit === null) throw new Error('missing audit');
    await audit.flush();
    const stored = audit.getCall('abandoned-899');
    expect(stored).not.toBeNull();
    expect(recordField(stored, 'executionStatus')).toBe('pending');
    expect(recordField(stored, 'executionFinishedAt')).toBeNull();
    // A stale entry is reaped even when the map is under the cap.
    pending.clear();
    settle({ host, callId: 'stale', ts: Date.now() - 60 * 60 * 1000 });
    settle({ host, callId: 'fresh', ts: Date.now() });
    expect(pending.has('stale')).toBe(false);
    expect(pending.has('fresh')).toBe(true);
  });

  test('the payload keeps the effective revision while history is unavailable', async () => {
    const { host } = await startHost({
      breakDatabase: true,
      config: { modes: { main: 'strict' } },
    });
    const payload = stateOf(host);
    expect(stringField(payload, 'effectiveRevision').length).toBeGreaterThan(0);
    expect(recordField(recordField(payload, 'config'), 'modes')).toMatchObject({
      main: 'strict',
    });
    const audit = asRecord(recordField(payload, 'audit'));
    const health = asRecord(recordField(audit, 'health'));
    expect(stringField(health, 'state')).toBe('unavailable');
    // Reading history from a structure this build does not own surfaces the
    // database's own error; either way no history is invented.
    expect(recordField(health, 'lastError')).not.toBeNull();
    expect(recordField(audit, 'history') ?? []).toEqual([]);
  });
});
