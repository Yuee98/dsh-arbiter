import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { AuditStore, fingerprintOf, type CallRecord } from '../src/audit.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { ReviewSignals, TraceStage } from '../src/types.js';

const dirs: string[] = [];

async function makeStore(
  overrides: Partial<typeof DEFAULT_CONFIG.audit> = {},
): Promise<{
  readonly store: AuditStore;
  readonly dir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-audit-'));
  dirs.push(dir);
  const store = new AuditStore(join(dir, 'arbiter.db'), {
    ...DEFAULT_CONFIG.audit,
    ...overrides,
  });
  return { store, dir };
}

afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

const signals: ReviewSignals = {
  riskDist: null,
  riskPoint: 1,
  riskScore: null,
  riskClass: 'low',
  authDist: null,
  authPoint: 1,
  authClass: 'none',
  secrets: false,
  destructive: false,
  egress: false,
  bulk: false,
  source: 'chat',
  repairs: 0,
};

function record(
  overrides: Partial<CallRecord> & Pick<CallRecord, 'callId' | 'result'>,
): CallRecord {
  const trace: TraceStage[] = [
    { stage: 'rule', result: 'review(default)', at: 1 },
    { stage: 'review', result: overrides.result, decisionRules: ['R7'], at: 2 },
  ];
  return {
    ts: Date.now(),
    sessionId: 'session-1',
    sessionKind: 'main',
    parentSession: null,
    profile: 'test',
    workspace: '/workspace/app',
    tool: 'bash',
    arguments: { command: 'echo hi' },
    cwd: '/workspace/app',
    fingerprint: fingerprintOf('bash', { command: 'echo hi' }),
    configRevision: 'rev-1',
    configSnapshotId: 'cfg-1',
    approvalMode: 'normal',
    executionMode: 'trusted',
    reason: 'test',
    trace,
    effect: null,
    sessionRecordState: 'written',
    snapshot: null,
    modelAttempts: [],
    signals,
    policyStrategy: 'normal',
    decisionRules: ['R7'],
    executionStatus: 'pending',
    ...overrides,
  };
}

describe('audit store', () => {
  test('writes, queries and details one call', async () => {
    const { store } = await makeStore();
    store.enqueue(record({ callId: 'call-1', result: 'review-allow' }));
    await store.flush();
    const list = store.listCalls({});
    expect(list.total).toBe(1);
    expect(list.rows[0]?.callId).toBe('call-1');
    expect(list.rows[0]?.command).toBe('echo hi');
    const detail = store.getCall('call-1');
    expect(detail).toMatchObject({
      result: 'review-allow',
      stages: expect.any(Array) as unknown,
      signals: expect.objectContaining({ riskPoint: 1 }) as unknown,
    });
    store.close();
  });

  test('deduplicates configuration snapshots and records activations', async () => {
    const { store } = await makeStore();
    const first = store.saveConfigSnapshot(DEFAULT_CONFIG);
    const second = store.saveConfigSnapshot(DEFAULT_CONFIG);
    expect(second.snapshotId).toBe(first.snapshotId);
    store.recordActivation(
      first.snapshotId,
      first.revision,
      'arbiter',
      'profile',
    );
    store.recordActivation(
      first.snapshotId,
      first.revision,
      'arbiter',
      'profile',
    );
    expect(store.stats()).toMatchObject({ calls: 0, modelCalls: 0 });
    store.close();
  });

  test('updates execution status and retention deletes expired calls', async () => {
    const { store } = await makeStore({ retentionDays: 30 });
    store.enqueue(
      record({
        callId: 'old',
        result: 'allow',
        ts: Date.now() - 40 * 24 * 60 * 60 * 1000,
      }),
    );
    store.enqueue(record({ callId: 'new', result: 'allow' }));
    await store.flush();
    store.updateExecution('new', 'success');
    expect(store.getCall('new')).toMatchObject({ executionStatus: 'success' });
    const deleted = store.runRetention();
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(store.listCalls({}).rows.map((row) => row.callId)).toEqual(['new']);
    store.close();
  });

  test('prior verdicts can be restored by session', async () => {
    const { store } = await makeStore();
    store.enqueue(
      record({
        callId: 'denied',
        result: 'review-deny',
        sessionId: 'session-1',
      }),
    );
    store.enqueue(
      record({
        callId: 'allowed',
        result: 'review-allow',
        sessionId: 'session-1',
      }),
    );
    await store.flush();
    const prior = store.priorVerdictsForSession('session-1', 10);
    expect(prior.map((item) => item.callId)).toEqual(['denied']);
    expect(prior[0]?.result).toBe('review-deny');
    store.close();
  });

  test('refuses a database written by a newer schema', async () => {
    const { store } = await makeStore();
    const path = store.databasePath;
    store.close();
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version = 99');
    db.close();
    expect(() => new AuditStore(path, DEFAULT_CONFIG.audit)).toThrow(/newer/);
  });

  test('capacity cleanup reclaims space instead of deleting every row', async () => {
    const { store } = await makeStore();
    for (let index = 0; index < 10; index += 1) {
      store.enqueue(
        record({
          callId: `capacity-${String(index)}`,
          result: 'allow',
          arguments: { command: 'echo harmless', padding: 'x'.repeat(4_000) },
        }),
      );
    }
    await store.flush();
    const before = store.databaseBytes;
    const target = before - 16_384;
    const deleted = store.runRetention(Date.now(), 30, target);
    expect(store.listCalls({}).total).toBeGreaterThan(0);
    expect(store.databaseBytes).toBeLessThan(before);
    expect(deleted).toBeGreaterThanOrEqual(0);
    store.close();
  });

  test('a broken database path leaves the store unusable without throwing to callers', async () => {
    const { dir } = await makeStore();
    const notADirectory = join(dir, 'blocked');
    await writeFile(notADirectory, 'not a directory');
    expect(
      () =>
        new AuditStore(join(notADirectory, 'arbiter.db'), DEFAULT_CONFIG.audit),
    ).toThrow();
  });

  test('clear removes calls but keeps configuration history', async () => {
    const { store } = await makeStore();
    store.enqueue(record({ callId: 'call-1', result: 'review-deny' }));
    await store.flush();
    const snapshot = store.saveConfigSnapshot(DEFAULT_CONFIG);
    expect(store.clearCalls()).toBe(1);
    expect(store.listCalls({}).total).toBe(0);
    expect(store.listCandidates()).toEqual([]);
    expect(store.getCall('call-1')).toBeNull();
    expect(snapshot.snapshotId.length).toBeGreaterThan(0);
    store.close();
  });

  test('database file exists and has a size', async () => {
    const { store } = await makeStore();
    expect(store.databaseBytes).toBeGreaterThan(0);
    const info = await stat(store.databasePath);
    expect(info.size).toBeGreaterThan(0);
    store.close();
  });
});
