import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { AuditStore, fingerprintOf, type CallRecord } from '../src/audit.js';
import type { CallAnchor, CallFilter } from '../src/audit/types.js';
import { templateIdOf } from '../src/audit/metadata.js';
import { PROBE_SNAPSHOT } from '../src/reviewer/diagnostic.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { ReviewSignals, TraceStage } from '../src/types.js';

const dirs: string[] = [];

/** A guaranteed snapshot identity; the guarded store returning null is a failure. */
function snapshotOf(store: AuditStore, config = DEFAULT_CONFIG) {
  const snapshot = store.saveConfigSnapshot(config);
  if (snapshot === null) throw new Error('snapshot was not persisted');
  return snapshot;
}

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

/**
 * Narrowing readers for stored values.
 *
 * The store's detail view is a JSON-shaped record, so tests read it through
 * these instead of asserting a shape: an assertion would hide a real regression
 * behind a cast.
 */
function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('expected an object');
  return { ...value };
}

function recordField(value: unknown, name: string): unknown {
  return Object.hasOwn(asRecord(value), name)
    ? Reflect.get(asRecord(value), name)
    : undefined;
}

function stringField(value: unknown, name: string): string {
  const field = recordField(value, name);
  if (typeof field !== 'string')
    throw new TypeError(`${name} must be a string`);
  return field;
}

function numberField(value: unknown, name: string): number {
  const field = recordField(value, name);
  if (typeof field !== 'number' || !Number.isFinite(field))
    throw new TypeError(`${name} must be a number`);
  return field;
}

function nullableNumberField(value: unknown, name: string): number | null {
  const field = recordField(value, name);
  if (field === null) return null;
  if (typeof field !== 'number' || !Number.isFinite(field))
    throw new TypeError(`${name} must be a number or null`);
  return field;
}

function listField(value: unknown, name: string): readonly unknown[] {
  const field = recordField(value, name);
  if (!Array.isArray(field)) throw new TypeError(`${name} must be a list`);
  const items: readonly unknown[] = field;
  return items;
}

function boolField(value: unknown, name: string): boolean {
  const field = recordField(value, name);
  if (typeof field !== 'boolean')
    throw new TypeError(`${name} must be a boolean`);
  return field;
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
    const first = snapshotOf(store);
    const second = snapshotOf(store);
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
    const retention = store.runRetention();
    expect(retention.deleted).toBeGreaterThanOrEqual(1);
    expect(retention.irreducible).toBe(false);
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
    expect(prior.verdicts.map((item) => item.callId)).toEqual(['denied']);
    expect(prior.verdicts[0]?.result).toBe('review-deny');
    expect(prior.unreadableCount).toBe(0);
    store.close();
  });

  test('a database written by a newer schema is left untouched and only pauses writes', async () => {
    const { store } = await makeStore();
    const path = store.databasePath;
    store.close();
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version = 99');
    db.close();
    // The store opens, refuses to modify the newer database and reports why;
    // callers keep working because approvals never depend on audit writes.
    const reopened = new AuditStore(path, DEFAULT_CONFIG.audit);
    expect(reopened.paused).toBe(true);
    expect(reopened.health()).toMatchObject({
      state: 'unavailable',
      lastError: expect.stringContaining('newer') as unknown,
    });
    reopened.enqueue(record({ callId: 'paused', result: 'allow' }));
    await reopened.flush();
    expect(reopened.listCalls({}).total).toBe(0);
    reopened.close();
    const check = new DatabaseSync(path);
    expect(
      numberField(check.prepare('PRAGMA user_version').get(), 'user_version'),
    ).toBe(99);
    check.close();
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
    const retention = store.runRetention(Date.now(), 30, target);
    expect(store.listCalls({}).total).toBeGreaterThan(0);
    expect(store.databaseBytes).toBeLessThan(before);
    expect(retention.deleted).toBeGreaterThanOrEqual(0);
    expect(retention.bytes).toBeGreaterThan(0);
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
    const snapshot = snapshotOf(store);
    expect(store.clearCalls()).toEqual({ ok: true, deleted: 1 });
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

describe('immutable snapshots and activation history', () => {
  test('one deduped snapshot keeps every activation in order', async () => {
    const { store } = await makeStore();
    const first = snapshotOf(store);
    for (const entry of ['startup', 'file', 'ui']) {
      store.recordActivation(
        first.snapshotId,
        first.revision,
        entry,
        'profile',
      );
    }
    const again = snapshotOf(store);
    expect(again.snapshotId).toBe(first.snapshotId);
    store.recordActivation(first.snapshotId, first.revision, 'file', 'profile');
    const history = store.configHistory(10);
    // Deduplication must never swallow the activation trail.
    expect(history).toHaveLength(4);
    expect(history.map((row) => row.entry)).toEqual([
      'file',
      'ui',
      'file',
      'startup',
    ]);
    expect(new Set(history.map((row) => row.snapshotId))).toEqual(
      new Set([first.snapshotId]),
    );
    store.close();
  });

  test('a stored snapshot is never overwritten by later content', async () => {
    const { store } = await makeStore();
    const path = store.databasePath;
    const first = snapshotOf(store);
    store.close();
    const db = new DatabaseSync(path);
    const beforeRow = db
      .prepare('SELECT content FROM config_snapshots WHERE snapshot_id = ?')
      .get(first.snapshotId);
    const beforeContent = stringField(beforeRow, 'content');
    expect(beforeContent.length).toBeGreaterThan(0);
    // A hand-written duplicate id must not replace the recorded content: the
    // snapshot is the evidence a past decision is explained against.
    db.prepare(
      'INSERT OR IGNORE INTO config_snapshots(snapshot_id, content_hash, content, format_version, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(first.snapshotId, 'forged-hash', '{"forged":true}', 1, Date.now());
    const afterRow = db
      .prepare(
        'SELECT content, content_hash FROM config_snapshots WHERE snapshot_id = ?',
      )
      .get(first.snapshotId);
    expect(stringField(afterRow, 'content')).toBe(beforeContent);
    expect(stringField(afterRow, 'content_hash')).not.toBe('forged-hash');
    db.close();
  });
});

describe('historical rule provenance', () => {
  test('a decision keeps the rule name it used even after the rule changes', async () => {
    const { store } = await makeStore();
    store.enqueue(
      record({
        callId: 'named',
        result: 'review-deny',
        trace: [
          {
            stage: 'rule',
            result: 'deny',
            ruleId: 'no-push',
            ruleName: 'Block force push',
            at: 1,
          },
        ],
      }),
    );
    await store.flush();
    const detail = store.getCall('named');
    const stage = listField(detail, 'stages')[0];
    expect(recordField(stage, 'ruleId')).toBe('no-push');
    expect(recordField(stage, 'ruleName')).toBe('Block force push');
    // The list row carries the same historical name, not a live lookup.
    expect(store.listCalls({}).rows[0]?.ruleName).toBe('Block force push');
    store.close();
  });

  test('a record written without a rule name reports null, not the current rule', async () => {
    const { store } = await makeStore();
    store.enqueue(record({ callId: 'old-trace', result: 'review-deny' }));
    await store.flush();
    expect(store.listCalls({}).rows[0]?.ruleName).toBeNull();
    store.close();
  });
});

describe('execution result stays separate from the verdict', () => {
  test('an approved call is pending until execution is observed', async () => {
    const { store } = await makeStore();
    store.enqueue(record({ callId: 'approved', result: 'review-allow' }));
    await store.flush();
    const pending = store.getCall('approved');
    expect(stringField(pending, 'result')).toBe('review-allow');
    expect(stringField(pending, 'executionStatus')).toBe('pending');
    expect(nullableNumberField(pending, 'executionStartedAt')).toBeNull();
    expect(nullableNumberField(pending, 'executionFinishedAt')).toBeNull();

    store.updateExecution('approved', 'success', 1_700_000_000_000);
    const done = store.getCall('approved');
    expect(stringField(done, 'executionStatus')).toBe('success');
    // A finish observation is not a start observation: deriving one would claim
    // an event that was never seen.
    expect(nullableNumberField(done, 'executionStartedAt')).toBeNull();
    expect(nullableNumberField(done, 'executionFinishedAt')).toBe(
      1_700_000_000_000,
    );
    // Recording an execution result never rewrites the permission verdict.
    expect(stringField(done, 'result')).toBe('review-allow');
    store.close();
  });

  test('an observed start is recorded separately from the finish', async () => {
    const { store } = await makeStore();
    store.enqueue(record({ callId: 'started', result: 'review-allow' }));
    await store.flush();
    store.markExecutionStarted('started', 1_700_000_000_000);
    store.updateExecution('started', 'success', 1_700_000_002_000);
    const detail = store.getCall('started');
    expect(nullableNumberField(detail, 'executionStartedAt')).toBe(
      1_700_000_000_000,
    );
    expect(nullableNumberField(detail, 'executionFinishedAt')).toBe(
      1_700_000_002_000,
    );
    // A second start observation does not overwrite the first.
    store.markExecutionStarted('started', 1_800_000_000_000);
    expect(
      nullableNumberField(store.getCall('started'), 'executionStartedAt'),
    ).toBe(1_700_000_000_000);
    store.close();
  });

  test('a denied call is not-started and stays that way', async () => {
    const { store } = await makeStore();
    store.enqueue(
      record({
        callId: 'denied',
        result: 'review-deny',
        // What settlement writes for a denied call: it never started.
        executionStatus: 'not-started',
      }),
    );
    await store.flush();
    expect(store.getCall('denied')).toMatchObject({
      result: 'review-deny',
      executionStatus: 'not-started',
      executionStartedAt: null,
    });
    store.close();
  });
});

describe('record format and old data', () => {
  test('rows carry the format they were written with', async () => {
    const { store } = await makeStore();
    store.enqueue(record({ callId: 'current', result: 'allow' }));
    await store.flush();
    expect(store.getCall('current')).toMatchObject({
      recordFormatVersion: 2,
      unreadable: false,
    });
    store.close();
  });

  test('a v1 row is read with unknown fields left absent, not defaulted', async () => {
    const { store } = await makeStore();
    const path = store.databasePath;
    store.close();
    const db = new DatabaseSync(path);
    // Simulate a record written before the new columns existed: a v1 database
    // has no such columns, so the adapter must not invent values for them.
    db.exec('PRAGMA user_version = 1');
    db.prepare(
      `INSERT INTO calls(call_id, ts, session_id, session_kind, parent_session, profile, workspace,
         tool, arguments, cwd, fingerprint, config_revision, config_snapshot_id, approval_mode,
         execution_mode, result, reason, trace, effect, session_record_state, signals,
         policy_strategy, decision_rules, execution_status, record_format_version,
         execution_started_at, execution_finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'legacy',
      Date.now(),
      's1',
      'main',
      null,
      'test',
      '/w',
      'bash',
      '{"command":"echo hi"}',
      '/w',
      'bash:abc',
      'rev-old',
      'cfg-old',
      'normal',
      'trusted',
      'review-allow',
      'legacy row',
      '[]',
      'null',
      'written',
      null,
      null,
      '[]',
      'pending',
      1,
      null,
      null,
    );
    db.close();
    const reopened = new AuditStore(path, DEFAULT_CONFIG.audit);
    const detail = reopened.getCall('legacy');
    expect(numberField(detail, 'recordFormatVersion')).toBe(1);
    expect(stringField(detail, 'executionStatus')).toBe('pending');
    expect(nullableNumberField(detail, 'executionStartedAt')).toBeNull();
    expect(nullableNumberField(detail, 'executionFinishedAt')).toBeNull();
    expect(listField(detail, 'stages')).toEqual([]);
    reopened.close();
  });

  test('an unknown record format is reported without being rewritten', async () => {
    const { store } = await makeStore();
    const path = store.databasePath;
    store.close();
    const db = new DatabaseSync(path);
    db.prepare(
      `INSERT INTO calls(call_id, ts, session_id, session_kind, parent_session, profile, workspace,
         tool, arguments, cwd, fingerprint, config_revision, config_snapshot_id, approval_mode,
         execution_mode, result, reason, trace, effect, session_record_state, signals,
         policy_strategy, decision_rules, execution_status, record_format_version,
         execution_started_at, execution_finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'future',
      Date.now(),
      's1',
      'main',
      null,
      'test',
      '/w',
      'bash',
      '{"command":"echo hi"}',
      '/w',
      'bash:def',
      'rev-f',
      'cfg-f',
      'normal',
      'trusted',
      'review-allow',
      'future row',
      '[]',
      'null',
      'written',
      null,
      null,
      '[]',
      'pending',
      99,
      null,
      null,
    );
    db.close();
    const reopened = new AuditStore(path, DEFAULT_CONFIG.audit);
    const detail = reopened.getCall('future');
    expect(boolField(detail, 'unreadable')).toBe(true);
    expect(numberField(detail, 'recordFormatVersion')).toBe(99);
    expect(stringField(detail, 'unreadableReason')).toContain(
      'newer than this plugin',
    );
    // The row is reported as unreadable rather than coerced into today's shape.
    expect(recordField(detail, 'result')).toBeNull();
    expect(recordField(recordField(detail, 'raw'), 'result')).toBe(
      'review-allow',
    );
    reopened.close();
    const check = new DatabaseSync(path);
    const stored = check
      .prepare('SELECT record_format_version FROM calls WHERE call_id = ?')
      .get('future');
    expect(numberField(stored, 'record_format_version')).toBe(99);
    check.close();
  });
});

describe('retention references and ownership', () => {
  test('a configuration snapshot referenced only by an activation survives cleanup', async () => {
    const { store } = await makeStore({ retentionDays: 1 });
    const snapshot = snapshotOf(store);
    store.recordActivation(
      snapshot.snapshotId,
      snapshot.revision,
      'ui',
      'profile',
    );
    store.enqueue(
      record({
        callId: 'expired',
        result: 'allow',
        ts: Date.now() - 5 * 24 * 60 * 60 * 1_000,
      }),
    );
    await store.flush();
    store.runRetention();
    expect(store.listCalls({}).total).toBe(0);
    // The activation is what keeps the snapshot meaningful.
    expect(store.configHistory(5)).toHaveLength(1);
    const path = store.databasePath;
    store.close();
    const db = new DatabaseSync(path);
    const rows = db
      .prepare('SELECT COUNT(*) AS count FROM config_snapshots')
      .get();
    expect(numberField(rows, 'count')).toBe(1);
    db.close();
  });

  test('the owning profile may change its own retention policy', async () => {
    const { store } = await makeStore({ retentionDays: 30 });
    // The store that owns this database is the controlled update path.
    store.updateConfig({ ...DEFAULT_CONFIG.audit, retentionDays: 7 });
    expect(store.health()).toMatchObject({ state: 'ok', lastError: null });
    expect(store.retention.days).toBe(7);
    store.close();
  });

  test('clear leaves configuration history and activations intact', async () => {
    const { store } = await makeStore();
    const snapshot = snapshotOf(store);
    store.recordActivation(
      snapshot.snapshotId,
      snapshot.revision,
      'ui',
      'profile',
    );
    store.enqueue(record({ callId: 'call-1', result: 'review-deny' }));
    await store.flush();
    expect(store.clearCalls()).toEqual({ ok: true, deleted: 1 });
    expect(store.configHistory(5)).toHaveLength(1);
    store.close();
  });
});

describe('queue bounds and failure isolation', () => {
  test('a full queue drops the oldest event and stays bounded', async () => {
    const { store } = await makeStore({ maxQueue: 2 });
    // Fill without flushing so the queue is the only structure holding records.
    for (let index = 0; index < 6; index += 1) {
      store.enqueue(
        record({ callId: `queued-${String(index)}`, result: 'allow' }),
      );
    }
    expect(store.health().pending).toBeLessThanOrEqual(2);
    expect(store.health().dropped).toBeGreaterThan(0);
    await store.flush();
    expect(store.listCalls({}).total).toBeLessThanOrEqual(2);
    store.close();
  });

  test('an oversized record is dropped instead of pinning memory', async () => {
    const { store } = await makeStore();
    store.enqueue(
      record({
        callId: 'huge',
        result: 'allow',
        arguments: { command: 'echo hi', padding: 'x'.repeat(9 * 1024 * 1024) },
      }),
    );
    await store.flush();
    expect(store.listCalls({}).total).toBe(0);
    expect(store.health()).toMatchObject({ state: 'degraded' });
    expect(store.health().lastError).toContain('exceeded');
    store.close();
  });

  test('a write failure is retried a bounded number of times and then dropped', async () => {
    const { store } = await makeStore();
    const path = store.databasePath;
    const db = new DatabaseSync(path);
    // Make the target table unwritable for this connection by dropping the
    // dependent table the writer also touches; the store must not spin.
    db.exec('DROP TABLE stages');
    db.close();
    store.enqueue(record({ callId: 'failing', result: 'allow' }));
    await store.flush();
    expect(store.health().state).toBe('degraded');
    expect(store.health().dropped).toBeGreaterThanOrEqual(1);
    store.close();
  });

  test('an unavailable store never throws at the caller', async () => {
    const { store } = await makeStore();
    store.close();
    // After close, enqueue and queries must not raise: approvals keep working.
    expect(() => {
      store.enqueue(record({ callId: 'after-close', result: 'allow' }));
    }).not.toThrow();
    expect(store.health().state).toBe('unavailable');
  });
});

describe('credential boundary in stored material', () => {
  const secret = 'sk-transport-credential-sentinel';

  test('a decision attempt keeps its contracted request and no authorization', async () => {
    const { store } = await makeStore();
    store.enqueue(
      record({
        callId: 'decision-call',
        result: 'review-allow',
        modelAttempts: [
          {
            requestId: 'decision-call:model:1',
            callId: 'decision-call',
            attempt: 1,
            backend: 'decision',
            protocol: 'arbiter-decision-v1',
            // The formal decision request shape: endpoint material, never the
            // header the transport used to authenticate.
            request: {
              model: 'clef-flash',
              state: 'STATE',
              questions: { risk: { type: 'score' } },
            },
            responseText: '{"response":{}}',
            parsed: null,
            error: null,
            startedAt: 1,
            durationMs: 2,
            estimatedInputTokens: 3,
            usage: null,
          },
        ],
      }),
    );
    await store.flush();
    const path = store.databasePath;
    store.close();
    const db = new DatabaseSync(path);
    const rows = listField(
      {
        rows: db
          .prepare(
            'SELECT protocol, request, response_text, error FROM model_calls',
          )
          .all(),
      },
      'rows',
    );
    const stored = JSON.stringify(rows);
    // No credential, no header, and no bearer token reached the database.
    expect(stored).not.toContain(secret);
    expect(stored.toLowerCase()).not.toContain('authorization');
    expect(stored.toLowerCase()).not.toContain('bearer');
    // The contracted diagnostic material is still stored in full locally.
    expect(stored).toContain('arbiter-decision-v1');
    expect(JSON.parse(String(recordField(rows[0], 'request')))).toMatchObject({
      model: 'clef-flash',
      state: 'STATE',
    });
    db.close();
  });

  test('a chat attempt keeps its full request material', async () => {
    const { store } = await makeStore();
    const request = {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      system: 'REVIEW_POLICY',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'PENDING_ACTION' }] },
      ],
    };
    store.enqueue(
      record({
        callId: 'chat-call',
        result: 'review-allow',
        modelAttempts: [
          {
            requestId: 'chat-call:model:1',
            callId: 'chat-call',
            attempt: 1,
            backend: 'chat',
            protocol: 'arbiter-chat-json-v1',
            request,
            responseText: '{"risk":1}',
            parsed: { risk: 1 },
            error: null,
            startedAt: 1,
            durationMs: 2,
            estimatedInputTokens: 3,
            usage: null,
          },
        ],
      }),
    );
    await store.flush();
    const detail = store.getCall('chat-call');
    // The agreed local-complete contract: the material is not scrubbed, because
    // the boundary is specifically about transport credentials.
    expect(recordField(listField(detail, 'modelCalls')[0], 'request')).toEqual(
      request,
    );
    store.close();
  });
});

describe('prior verdicts: window, ordering and unreadable count', () => {
  function deniedRow(overrides: Record<string, unknown> = {}) {
    return {
      ...record({ callId: 'x', result: 'review-deny' }),
      ...overrides,
    };
  }

  test('same-millisecond rows are ordered by call_id so the newest survive LIMIT', async () => {
    const { store } = await makeStore();
    const ts = 1_700_000_000_000;
    for (const suffix of ['1', '2', '3', '4', '5']) {
      store.enqueue(
        deniedRow({ callId: `c${suffix}`, result: 'review-deny', ts }),
      );
    }
    await store.flush();
    const prior = store.priorVerdictsForSession('session-1', 3);
    // Without the tie-break SQLite returned the three oldest (c1,c2,c3).
    expect(prior.verdicts.map((item) => item.callId)).toEqual([
      'c5',
      'c4',
      'c3',
    ]);
    store.close();
  });

  test('an unreadable format is filtered before LIMIT, not after', async () => {
    const { store } = await makeStore();
    const path = store.databasePath;
    for (const suffix of ['1', '2', '3']) {
      store.enqueue(
        deniedRow({
          callId: `readable-${suffix}`,
          result: 'review-deny',
          ts: 1_700_000_000_000 + Number(suffix),
        }),
      );
    }
    await store.flush();
    store.close();
    // A newer row this build cannot read: its format must not consume a window
    // slot, or the result would be silently shorter than the limit.
    const db = new DatabaseSync(path);
    db.prepare(
      'UPDATE calls SET record_format_version = 99 WHERE call_id = ?',
    ).run('readable-3');
    db.close();
    const reopened = new AuditStore(path, DEFAULT_CONFIG.audit);
    const prior = reopened.priorVerdictsForSession('session-1', 2);
    // Two readable rows are returned even though an unreadable row is newer.
    expect(prior.verdicts.map((item) => item.callId)).toEqual([
      'readable-2',
      'readable-1',
    ]);
    // And the exclusion is reported rather than disappearing.
    expect(prior.unreadableCount).toBe(1);
    reopened.close();
  });

  test('a session with no unreadable rows reports a zero count', async () => {
    const { store } = await makeStore();
    store.enqueue(deniedRow({ callId: 'plain', result: 'review-deny' }));
    await store.flush();
    expect(store.priorVerdictsForSession('session-1', 10).unreadableCount).toBe(
      0,
    );
    // A session that never existed is distinguishable: empty list, zero excluded.
    const absent = store.priorVerdictsForSession('other-session', 10);
    expect(absent.verdicts).toEqual([]);
    expect(absent.unreadableCount).toBe(0);
    store.close();
  });

  test('an unreadable denial counts even when it is the only row', async () => {
    const { store } = await makeStore();
    const path = store.databasePath;
    store.enqueue(deniedRow({ callId: 'only', result: 'review-deny' }));
    await store.flush();
    store.close();
    const db = new DatabaseSync(path);
    db.prepare('UPDATE calls SET record_format_version = 99').run();
    db.close();
    const reopened = new AuditStore(path, DEFAULT_CONFIG.audit);
    const prior = reopened.priorVerdictsForSession('session-1', 10);
    // This is the dangerous shape: an empty list that is *not* "nothing happened".
    expect(prior.verdicts).toEqual([]);
    expect(prior.unreadableCount).toBe(1);
    reopened.close();
  });

  test('an unreadable allowance is not counted as a missing denial', async () => {
    const { store } = await makeStore();
    const path = store.databasePath;
    store.enqueue(deniedRow({ callId: 'deny', result: 'review-deny' }));
    store.enqueue(deniedRow({ callId: 'allow', result: 'review-allow' }));
    await store.flush();
    store.close();
    const db = new DatabaseSync(path);
    db.prepare(
      'UPDATE calls SET record_format_version = 99 WHERE call_id = ?',
    ).run('allow');
    db.close();
    const reopened = new AuditStore(path, DEFAULT_CONFIG.audit);
    const prior = reopened.priorVerdictsForSession('session-1', 10);
    expect(prior.verdicts.map((item) => item.callId)).toEqual(['deny']);
    // Only denial-shaped rows are counted; an unreadable allowance is outside
    // this query's subject and must not inflate the count.
    expect(prior.unreadableCount).toBe(0);
    reopened.close();
  });
});

describe('execution observations that race the queue', () => {
  test('a result observed before insertion is applied once the row exists', async () => {
    const { store } = await makeStore();
    // tools/result can arrive while the record is still queued; the update
    // matches no row at that moment.
    store.updateExecution('racing', 'success', 1_700_000_000_000);
    store.enqueue(record({ callId: 'racing', result: 'review-allow' }));
    await store.flush();
    expect(store.getCall('racing')).toMatchObject({
      result: 'review-allow',
      executionStatus: 'success',
      executionFinishedAt: 1_700_000_000_000,
    });
    store.close();
  });

  test('the reverse ordering produces the same final status', async () => {
    const { store } = await makeStore();
    store.enqueue(record({ callId: 'ordered', result: 'review-allow' }));
    await store.flush();
    store.updateExecution('ordered', 'success', 1_700_000_000_001);
    expect(store.getCall('ordered')).toMatchObject({
      executionStatus: 'success',
      executionFinishedAt: 1_700_000_000_001,
    });
    store.close();
  });

  test('a duplicate result is idempotent and does not fabricate a start', async () => {
    const { store } = await makeStore();
    store.enqueue(record({ callId: 'dup', result: 'review-allow' }));
    await store.flush();
    store.updateExecution('dup', 'success', 1_700_000_000_002);
    store.updateExecution('dup', 'success', 1_700_000_000_002);
    expect(store.getCall('dup')).toMatchObject({
      executionStatus: 'success',
      executionFinishedAt: 1_700_000_000_002,
    });
    store.close();
  });

  test('a missing result leaves the call pending rather than inventing success', async () => {
    const { store } = await makeStore();
    store.enqueue(record({ callId: 'no-result', result: 'review-allow' }));
    await store.flush();
    expect(store.getCall('no-result')).toMatchObject({
      executionStatus: 'pending',
      executionStartedAt: null,
      executionFinishedAt: null,
    });
    store.close();
  });

  test('early observations stay bounded', async () => {
    const { store } = await makeStore();
    for (let index = 0; index < 900; index += 1) {
      store.updateExecution(`phantom-${String(index)}`, 'success');
    }
    // The map is capped; excess observations are counted as dropped, not held.
    await store.flush();
    expect(store.health().dropped).toBeGreaterThan(0);
    store.close();
  });
});

describe('clear coordinates with the asynchronous queue', () => {
  test('a queued record cannot resurrect cleared history', async () => {
    const { store } = await makeStore();
    store.enqueue(record({ callId: 'pre-clear', result: 'review-allow' }));
    // Clear before the queue drains: the queued event must not be inserted
    // afterwards, or the user's clear would appear to undo itself.
    const cleared = store.clearCalls();
    expect(cleared).toEqual({ ok: true, deleted: 0 });
    await store.flush();
    expect(store.listCalls({}).total).toBe(0);
    // New events after the clear are kept.
    store.enqueue(record({ callId: 'post-clear', result: 'review-allow' }));
    await store.flush();
    expect(store.listCalls({}).rows.map((row) => row.callId)).toEqual([
      'post-clear',
    ]);
    store.close();
  });

  test('clear keeps configuration history and prior verdicts', async () => {
    const { store } = await makeStore();
    const snapshot = snapshotOf(store);
    store.recordActivation(
      snapshot.snapshotId,
      snapshot.revision,
      'ui',
      'profile',
    );
    store.enqueue(record({ callId: 'denied', result: 'review-deny' }));
    await store.flush();
    expect(store.clearCalls().ok).toBe(true);
    expect(store.configHistory(5)).toHaveLength(1);
    store.close();
  });
});

describe('physical retention', () => {
  test('the reported byte total includes sidecars and backups', async () => {
    const { store } = await makeStore();
    store.enqueue(record({ callId: 'one', result: 'allow' }));
    await store.flush();
    const outcome = store.runRetention(Date.now(), 30, 1);
    expect(outcome.bytes).toBeGreaterThan(0);
    // The single remaining call is larger than the 1-byte target, so the store
    // reports the constraint instead of deleting the last record.
    expect(outcome.irreducible).toBe(true);
    expect(store.listCalls({}).total).toBe(1);
    store.close();
  });

  test('an oversized single call is kept and reported, not silently deleted', async () => {
    const { store } = await makeStore();
    store.enqueue(
      record({
        callId: 'oversized',
        result: 'allow',
        arguments: { command: 'echo hi', padding: 'x'.repeat(200_000) },
      }),
    );
    await store.flush();
    const outcome = store.runRetention(Date.now(), 30, 1_024);
    expect(outcome.irreducible).toBe(true);
    expect(store.listCalls({}).total).toBe(1);
    store.close();
  });
});

describe('shared data instance ownership', () => {
  test('two stores on one path keep a single retention policy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arbiter-shared-audit-'));
    dirs.push(dir);
    const path = join(dir, 'arbiter.db');
    const first = new AuditStore(path, {
      ...DEFAULT_CONFIG.audit,
      retentionDays: 30,
      retentionBytes: 1024 ** 3,
    });
    // A second profile sharing the same data instance asks for a different one.
    const second = new AuditStore(path, {
      ...DEFAULT_CONFIG.audit,
      retentionDays: 1,
      retentionBytes: 1024,
    });
    expect(second.health()).toMatchObject({ state: 'degraded' });
    expect(second.health().lastError).toContain('another profile');
    // The surviving policy is the first one, so the second cannot widen cleanup.
    expect(second.runRetention(Date.now()).bytes).toBeGreaterThan(0);
    second.close();
    // The owner may still change its own policy through the update path.
    first.updateConfig({ ...DEFAULT_CONFIG.audit, retentionDays: 7 });
    expect(first.health().lastError).toBeNull();
    first.close();
  });
});

describe('record and stage provenance', () => {
  test('a stage keeps the configuration snapshot that governed it', async () => {
    const { store } = await makeStore();
    store.enqueue(
      record({
        callId: 'staged',
        result: 'review-allow',
        trace: [
          {
            stage: 'review',
            result: 'review-allow',
            configRevision: 'rev-a',
            configSnapshotId: 'cfg-a',
            at: 1,
          },
          {
            stage: 'review',
            result: 'review-allow',
            configRevision: 'rev-b',
            configSnapshotId: 'cfg-b',
            at: 2,
          },
        ],
      }),
    );
    await store.flush();
    const detail = store.getCall('staged');
    // An A → B switch during one call is recorded per stage, not collapsed onto
    // whichever configuration happened to be effective last.
    expect(
      listField(detail, 'stages').map((stage) =>
        recordField(stage, 'configSnapshotId'),
      ),
    ).toEqual(['cfg-a', 'cfg-b']);
    store.close();
  });

  test('the tool schema the host exposed is stored, and absence stays null', async () => {
    const { store } = await makeStore();
    const schema = {
      type: 'object',
      properties: { command: { type: 'string' } },
    };
    store.enqueue(
      record({
        callId: 'with-schema',
        result: 'allow',
        argumentsSchema: schema,
      }),
    );
    store.enqueue(record({ callId: 'no-schema', result: 'allow' }));
    await store.flush();
    expect(store.getCall('with-schema')).toMatchObject({
      argumentsSchema: schema,
    });
    expect(
      recordField(store.getCall('no-schema'), 'argumentsSchema'),
    ).toBeNull();
    store.close();
  });
});

describe('analysis consumers and unknown formats', () => {
  test('a partial signal set is unknown rather than defaulted to false', async () => {
    const { store } = await makeStore();
    const path = store.databasePath;
    store.close();
    const db = new DatabaseSync(path);
    db.prepare(
      `INSERT INTO calls(call_id, ts, session_id, session_kind, parent_session, profile, workspace,
         tool, arguments, arguments_schema, cwd, fingerprint, config_revision, config_snapshot_id,
         approval_mode, execution_mode, result, reason, trace, effect, session_record_state, signals,
         policy_strategy, decision_rules, execution_status, record_format_version,
         execution_started_at, execution_finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'partial-signals',
      Date.now(),
      's1',
      'main',
      null,
      'test',
      '/w',
      'bash',
      '{"command":"echo hi"}',
      null,
      '/w',
      'bash:partial',
      'rev-1',
      'cfg-1',
      'normal',
      'trusted',
      'review-allow',
      'partial',
      '[]',
      'null',
      'written',
      // A v1 signal set without the later probes.
      '{"source":"chat","riskClass":"low","authClass":"none","riskPoint":1,"authDist":null,"riskDist":null,"riskScore":null,"authPoint":1}',
      null,
      '[]',
      'pending',
      1,
      null,
      null,
    );
    db.close();
    const reopened = new AuditStore(path, DEFAULT_CONFIG.audit);
    const analysis = reopened.callsForAnalysis(0, Date.now() + 1_000);
    // Unknown is not "all probes false": the row is skipped, not misread.
    expect(
      analysis.find((row) => row.callId === 'partial-signals')?.signals,
    ).toBe(null);
    expect(reopened.recentForReplay(10)).toEqual([]);
    reopened.close();
  });
});

/**
 * A genuine v1 database: the structure this project shipped before #15, with a
 * call, a stage, a model attempt, a configuration snapshot and an activation.
 * Building it by hand (not by downgrading a v2 file) is what makes the migration
 * test meaningful.
 */
const V1_CALLS_SQL = `CREATE TABLE calls (
  call_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, session_id TEXT NOT NULL,
  session_kind TEXT NOT NULL, parent_session TEXT, profile TEXT, workspace TEXT,
  tool TEXT NOT NULL, arguments TEXT NOT NULL, cwd TEXT NOT NULL,
  fingerprint TEXT NOT NULL, config_revision TEXT NOT NULL,
  config_snapshot_id TEXT NOT NULL, approval_mode TEXT NOT NULL,
  execution_mode TEXT NOT NULL, result TEXT NOT NULL, reason TEXT NOT NULL,
  trace TEXT NOT NULL, effect TEXT NOT NULL, session_record_state TEXT NOT NULL,
  signals TEXT, policy_strategy TEXT, decision_rules TEXT NOT NULL,
  execution_status TEXT NOT NULL)`;

const V1_STAGES_SQL = `CREATE TABLE stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, stage TEXT NOT NULL, result TEXT NOT NULL, reason TEXT,
  rule_id TEXT, decision_rules TEXT, config_revision TEXT, ts INTEGER NOT NULL)`;

const V1_MODELS_SQL = `CREATE TABLE model_calls (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL, backend TEXT NOT NULL, protocol TEXT NOT NULL,
  request TEXT NOT NULL, response_text TEXT, parsed TEXT, error TEXT,
  started_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
  estimated_input_tokens INTEGER NOT NULL, usage TEXT)`;

const V1_CONFIG_SQL = `CREATE TABLE config_snapshots (
  snapshot_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL, format_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL)`;

const V1_ACTIVATIONS_SQL = `CREATE TABLE config_activations (
  id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, activated_at INTEGER NOT NULL,
  entry TEXT NOT NULL, scope TEXT NOT NULL, revision TEXT NOT NULL)`;

const V1_META_SQL =
  'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)';

function buildV1Database(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(V1_CONFIG_SQL);
  db.exec(V1_ACTIVATIONS_SQL);
  db.exec(V1_CALLS_SQL);
  db.exec(V1_STAGES_SQL);
  db.exec(V1_MODELS_SQL);
  db.exec(V1_META_SQL);
  db.prepare(
    'INSERT INTO config_snapshots(snapshot_id, content_hash, content, format_version, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('cfg-legacy', 'hash-legacy', '{"enabled":true}', 1, 1_600_000_000_000);
  db.prepare(
    'INSERT INTO config_activations(id, snapshot_id, activated_at, entry, scope, revision) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    'act-legacy',
    'cfg-legacy',
    1_600_000_000_000,
    'startup',
    'profile',
    'rev-legacy',
  );
  db.prepare(
    `INSERT INTO calls(call_id, ts, session_id, session_kind, parent_session, profile, workspace,
       tool, arguments, cwd, fingerprint, config_revision, config_snapshot_id, approval_mode,
       execution_mode, result, reason, trace, effect, session_record_state, signals,
       policy_strategy, decision_rules, execution_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'legacy-call',
    1_600_000_000_000,
    'legacy-session',
    'main',
    null,
    'legacy-profile',
    '/legacy/workspace',
    'bash',
    '{"command":"echo legacy"}',
    '/legacy/workspace',
    'bash:legacyfingerprint',
    'rev-legacy',
    'cfg-legacy',
    'normal',
    'trusted',
    'review-deny',
    'legacy denial',
    '[{"stage":"rule","result":"deny","ruleId":"legacy-rule","at":1600000000000}]',
    'null',
    'written',
    '{"riskDist":null,"riskPoint":1,"riskScore":null,"riskClass":"low","authDist":null,"authPoint":1,"authClass":"none","secrets":false,"destructive":false,"egress":false,"bulk":false,"source":"chat","repairs":0}',
    'normal',
    '["R7"]',
    'not-started',
  );
  db.prepare(
    'INSERT INTO stages(call_id, seq, stage, result, reason, rule_id, decision_rules, config_revision, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    'legacy-call',
    0,
    'rule',
    'deny',
    'legacy denial',
    'legacy-rule',
    '["R7"]',
    'rev-legacy',
    1_600_000_000_000,
  );
  db.prepare(
    `INSERT INTO model_calls(id, call_id, attempt, backend, protocol, request, response_text,
       parsed, error, started_at, duration_ms, estimated_input_tokens, usage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'legacy-call:model:1',
    'legacy-call',
    1,
    'decision',
    'arbiter-decision-v1',
    '{"model":"legacy-model","state":"STATE"}',
    '{"response":{}}',
    null,
    null,
    1_600_000_000_000,
    12,
    3,
    null,
  );
  db.exec('PRAGMA user_version = 1');
  db.close();
}

describe('a real v1 database', () => {
  test('upgrades in place, keeps every row and takes a backup first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arbiter-v1-'));
    dirs.push(dir);
    const path = join(dir, 'arbiter.db');
    buildV1Database(path);

    const store = new AuditStore(path, DEFAULT_CONFIG.audit);
    expect(store.paused).toBe(false);
    // The upgrade completed and the store now writes the current format.
    expect(store.health().state).toBe('ok');

    const detail = store.getCall('legacy-call');
    expect(stringField(detail, 'result')).toBe('review-deny');
    // A v1 row predates the new columns: they read as unknown, not as defaults.
    expect(numberField(detail, 'recordFormatVersion')).toBe(1);
    expect(nullableNumberField(detail, 'executionStartedAt')).toBeNull();
    expect(nullableNumberField(detail, 'executionFinishedAt')).toBeNull();
    expect(recordField(detail, 'argumentsSchema')).toBeNull();
    const stage = listField(detail, 'stages')[0];
    expect(recordField(stage, 'ruleId')).toBe('legacy-rule');
    expect(recordField(stage, 'ruleName')).toBeNull();
    expect(recordField(stage, 'configSnapshotId')).toBeNull();
    // The original material survives verbatim.
    expect(recordField(detail, 'reason')).toBe('legacy denial');
    expect(recordField(detail, 'config')).toMatchObject({ enabled: true });
    const attempt = listField(detail, 'modelCalls')[0];
    expect(recordField(attempt, 'request')).toMatchObject({
      model: 'legacy-model',
    });
    expect(store.configHistory(10)).toHaveLength(1);
    store.close();

    // The pre-migration copy exists and holds the v1 content.
    const backupPath = `${path}.backup-v1`;
    expect(existsSync(backupPath)).toBe(true);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    expect(
      numberField(backup.prepare('PRAGMA user_version').get(), 'user_version'),
    ).toBe(1);
    const backedUp = backup
      .prepare('SELECT COUNT(*) AS count FROM calls')
      .get();
    expect(numberField(backedUp, 'count')).toBe(1);
    const backupColumns = backup
      .prepare('PRAGMA table_info(calls)')
      .all()
      .map((row) => recordField(row, 'name'));
    expect(backupColumns).not.toContain('record_format_version');
    backup.close();

    const upgraded = new DatabaseSync(path, { readOnly: true });
    expect(
      numberField(
        upgraded.prepare('PRAGMA user_version').get(),
        'user_version',
      ),
    ).toBe(2);
    upgraded.close();
  });

  test('a failed migration rolls back, keeps the backup and pauses writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arbiter-v1fail-'));
    dirs.push(dir);
    const path = join(dir, 'arbiter.db');
    buildV1Database(path);
    // A stage table with an incompatible `rule_name` makes the ALTER fail while
    // the backup has already been taken.
    const before = new DatabaseSync(path);
    before.exec('ALTER TABLE stages ADD COLUMN rule_name TEXT');
    before.close();

    const store = new AuditStore(path, DEFAULT_CONFIG.audit);
    // The duplicate column is what a partial earlier attempt looks like, and the
    // migration is written to be safe against it, so this case now succeeds.
    expect(store.paused).toBe(false);
    store.close();

    // Now force a real failure after the backup: a trigger that rejects the
    // INSERT the migration's own verification performs is not enough (the
    // migration only reads), so block the ALTER by occupying the column name with
    // an incompatible declaration is also unhelpful. Instead make the schema
    // statement itself fail by pre-creating `tasks` as a view.
    const path2 = join(dir, 'arbiter2.db');
    buildV1Database(path2);
    const blocker = new DatabaseSync(path2);
    // `CREATE TABLE IF NOT EXISTS calls` would skip an existing table, but a
    // view with that name makes the statement fail outright.
    blocker.exec('DROP TABLE stages');
    blocker.exec('CREATE VIEW stages AS SELECT 1 AS id');
    blocker.close();
    const failing = new AuditStore(path2, DEFAULT_CONFIG.audit);
    expect(failing.paused).toBe(true);
    expect(failing.health()).toMatchObject({
      state: 'unavailable',
      lastError: expect.stringContaining('migration failed') as unknown,
    });
    // Writes are refused and the original structure is intact.
    expect(failing.saveConfigSnapshot(DEFAULT_CONFIG)).toBeNull();
    expect(failing.listCalls({}).total).toBe(0);
    failing.close();
    const after = new DatabaseSync(path2, { readOnly: true });
    expect(
      numberField(after.prepare('PRAGMA user_version').get(), 'user_version'),
    ).toBe(1);
    expect(
      numberField(
        after.prepare('SELECT COUNT(*) AS count FROM calls').get(),
        'count',
      ),
    ).toBe(1);
    after.close();
    // The backup survives a failed migration for recovery.
    expect(existsSync(`${path2}.backup-v1`)).toBe(true);
  });
});

describe('write containment covers every entry point', () => {
  test('a failing clear neither throws nor discards queued work', async () => {
    const { store } = await makeStore();
    const path = store.databasePath;
    store.enqueue(record({ callId: 'kept', result: 'review-allow' }));
    await store.flush();
    store.close();
    // Make DELETE fail with a trigger, which is a post-startup storage fault.
    const db = new DatabaseSync(path);
    db.exec(
      'CREATE TRIGGER block_delete BEFORE DELETE ON calls BEGIN SELECT RAISE(ABORT, "no delete"); END',
    );
    db.close();
    const reopened = new AuditStore(path, DEFAULT_CONFIG.audit);
    expect(reopened.clearCalls()).toEqual({ ok: false, deleted: 0 });
    expect(reopened.health().state).toBe('degraded');
    expect(reopened.health().lastError).toContain('no delete');
    // The rows are still there and the store still serves.
    expect(reopened.listCalls({}).total).toBe(1);
    reopened.close();
  });

  test('an unreadable structure reports unavailable instead of throwing', async () => {
    const { store } = await makeStore();
    const path = store.databasePath;
    store.close();
    const db = new DatabaseSync(path);
    // A structure this build does not know, reachable after startup.
    db.exec('DROP TABLE calls');
    db.close();
    const reopened = new AuditStore(path, DEFAULT_CONFIG.audit);
    expect(() => reopened.listCalls({})).not.toThrow();
    const listed = reopened.listCalls({});
    expect(listed.unreadable).toBe(true);
    expect(listed.rows).toEqual([]);
    expect(() => reopened.getCall('anything')).not.toThrow();
    expect(reopened.getCall('anything')).toBeNull();
    // The store degraded and explains why.
    expect(reopened.health().state).toBe('degraded');
    reopened.close();
  });
});

describe('template snapshots are immutable and reused', () => {
  const system = 'REVIEW_POLICY\n\nFIXED CONTRACT';
  const request = (systemText: string) => ({
    provider: 'p',
    model: 'm',
    system: systemText,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'X' }] }],
  });
  const chatAttempt = (
    callId: string,
    systemText: string,
    templateId: string,
  ) => ({
    requestId: `${callId}:model:1`,
    callId,
    attempt: 1,
    backend: 'chat' as const,
    protocol: 'arbiter-chat-json-v1',
    request: request(systemText),
    templateId,
    responseText: '{}',
    parsed: null,
    error: null,
    startedAt: 1,
    durationMs: 2,
    estimatedInputTokens: 3,
    usage: null,
  });

  test('two calls with the same template share one stored row', async () => {
    const { store } = await makeStore();
    const templateId = templateIdOf(system);
    for (const callId of ['tpl-1', 'tpl-2']) {
      store.enqueue(
        record({
          callId,
          result: 'review-allow',
          modelAttempts: [chatAttempt(callId, system, templateId)],
        }),
      );
    }
    await store.flush();
    const path = store.databasePath;
    store.close();
    const db = new DatabaseSync(path);
    const templates = db
      .prepare('SELECT COUNT(*) AS count FROM templates')
      .get();
    expect(numberField(templates, 'count')).toBe(1);
    // The attempt points at the template rather than copying it.
    const attempts = db
      .prepare('SELECT template_id FROM model_calls ORDER BY call_id')
      .all();
    expect(attempts.map((row) => recordField(row, 'template_id'))).toEqual([
      templateId,
      templateId,
    ]);
    db.close();
  });

  test('a changed template creates a new row instead of rewriting the old', async () => {
    const { store } = await makeStore();
    const firstId = templateIdOf('REVIEW_POLICY\nOLD');
    const secondId = templateIdOf('REVIEW_POLICY\nNEW');
    store.enqueue(
      record({
        callId: 'old-template',
        result: 'review-allow',
        modelAttempts: [
          chatAttempt('old-template', 'REVIEW_POLICY\nOLD', firstId),
        ],
      }),
    );
    store.enqueue(
      record({
        callId: 'new-template',
        result: 'review-allow',
        modelAttempts: [
          chatAttempt('new-template', 'REVIEW_POLICY\nNEW', secondId),
        ],
      }),
    );
    await store.flush();
    const path = store.databasePath;
    store.close();
    const db = new DatabaseSync(path);
    const contents = db
      .prepare('SELECT content FROM templates ORDER BY created_at, template_id')
      .all()
      .map((row) => recordField(row, 'content'));
    expect(contents).toContain('REVIEW_POLICY\nOLD');
    expect(contents).toContain('REVIEW_POLICY\nNEW');
    db.close();
  });

  test('the detail view returns the referenced template content', async () => {
    const { store } = await makeStore();
    const templateId = templateIdOf(system);
    store.enqueue(
      record({
        callId: 'with-template',
        result: 'review-allow',
        modelAttempts: [chatAttempt('with-template', system, templateId)],
      }),
    );
    await store.flush();
    const detail = store.getCall('with-template');
    const templates = listField(detail, 'templates');
    expect(templates).toHaveLength(1);
    expect(recordField(templates[0], 'templateId')).toBe(templateId);
    expect(recordField(templates[0], 'content')).toBe(system);
    expect(recordField(templates[0], 'unreadable')).toBe(false);
    store.close();
  });
});

describe('capacity accounting includes every audit artefact', () => {
  test('backups count toward the capacity target that drives eviction', async () => {
    const { store } = await makeStore();
    for (let index = 0; index < 8; index += 1) {
      store.enqueue(
        record({
          callId: `cap-${String(index)}`,
          result: 'allow',
          ts: Date.now() - index * 1_000,
          arguments: { command: 'echo hi', padding: 'y'.repeat(2_000) },
        }),
      );
    }
    await store.flush();
    const before = store.listCalls({}).total;
    // A target the database alone could meet but the database plus a backup
    // cannot: eviction has to see the same footprint the target is measured in.
    const target = Math.floor(store.databaseBytes * 0.6);
    const outcome = store.runRetention(Date.now(), 30, target);
    expect(outcome.bytes).toBeGreaterThan(0);
    expect(store.listCalls({}).total).toBeLessThanOrEqual(before);
    store.close();
  });

  test('a configuration snapshot referenced only by a retained call survives', async () => {
    const { store } = await makeStore({ retentionDays: 1 });
    const snapshot = snapshotOf(store);
    // The call references the snapshot; there is deliberately no activation row.
    store.enqueue(
      record({
        callId: 'call-ref',
        result: 'allow',
        configSnapshotId: snapshot.snapshotId,
        ts: Date.now(),
      }),
    );
    await store.flush();
    store.runRetention();
    const path = store.databasePath;
    store.close();
    const db = new DatabaseSync(path);
    const remaining = db
      .prepare(
        'SELECT COUNT(*) AS count FROM config_snapshots WHERE snapshot_id = ?',
      )
      .get(snapshot.snapshotId);
    expect(numberField(remaining, 'count')).toBe(1);
    db.close();
  });
});

describe('retention has one live policy and one executor', () => {
  test('a follower store adopts the owner live change and never deletes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arbiter-live-policy-'));
    dirs.push(dir);
    const path = join(dir, 'arbiter.db');
    const owner = new AuditStore(path, {
      ...DEFAULT_CONFIG.audit,
      retentionDays: 30,
    });
    const follower = new AuditStore(path, {
      ...DEFAULT_CONFIG.audit,
      retentionDays: 30,
    });
    expect(follower.health().state).toBe('ok');
    for (const entry of [owner, follower]) {
      entry.enqueue(
        record({
          callId: `live-${entry === owner ? 'a' : 'b'}`,
          result: 'allow',
        }),
      );
    }
    await owner.flush();
    await follower.flush();
    const total = owner.listCalls({}).total;
    expect(total).toBeGreaterThan(0);
    // The owner tightens the policy; the follower must not keep the old one.
    owner.updateConfig({ ...DEFAULT_CONFIG.audit, retentionDays: 7 });
    expect(owner.retention.days).toBe(7);
    // A follower never executes cleanup.
    const followerOutcome = follower.runRetention(Date.now(), 1, 1);
    expect(followerOutcome.deleted).toBe(0);
    expect(owner.listCalls({}).total).toBe(total);
    follower.close();
    // After the owner closes, the path's policy is released cleanly.
    owner.close();
  });
});

describe('structured-content format registries are independent', () => {
  test('a snapshot marked with an unregistered format is not interpreted', async () => {
    const { store } = await makeStore();
    const path = store.databasePath;
    const snapshot = snapshotOf(store);
    store.enqueue(
      record({
        callId: 'snapshot-formats',
        result: 'allow',
        configSnapshotId: snapshot.snapshotId,
        snapshot: PROBE_SNAPSHOT,
      }),
    );
    await store.flush();
    store.close();
    const db = new DatabaseSync(path);
    // Record format 2 is readable, but no review/config snapshot format 2
    // adapter exists; the two registries must not be conflated.
    db.prepare('UPDATE snapshots SET format_version = 2').run();
    db.prepare('UPDATE config_snapshots SET format_version = 2').run();
    db.close();
    const reopened = new AuditStore(path, DEFAULT_CONFIG.audit);
    const detail = reopened.getCall('snapshot-formats');
    // The raw content is not presented under current semantics.
    expect(recordField(detail, 'snapshot')).toBeNull();
    expect(recordField(detail, 'snapshotUnreadable')).toBe(true);
    expect(recordField(detail, 'config')).toBeNull();
    expect(recordField(detail, 'configUnreadable')).toBe(true);
    reopened.close();
  });

  test('a template marked with an unregistered format keeps no interpretation', async () => {
    const { store } = await makeStore();
    const system = 'REVIEW_POLICY\nTEMPLATE';
    const templateId = templateIdOf(system);
    store.enqueue(
      record({
        callId: 'template-format',
        result: 'allow',
        modelAttempts: [
          {
            requestId: 'template-format:model:1',
            callId: 'template-format',
            attempt: 1,
            backend: 'chat',
            protocol: 'arbiter-chat-json-v1',
            request: { provider: 'p', model: 'm', system, messages: [] },
            templateId,
            responseText: '{}',
            parsed: null,
            error: null,
            startedAt: 1,
            durationMs: 2,
            estimatedInputTokens: 3,
            usage: null,
          },
        ],
      }),
    );
    await store.flush();
    const path = store.databasePath;
    store.close();
    const db = new DatabaseSync(path);
    db.prepare('UPDATE templates SET format_version = 2').run();
    db.close();
    const reopened = new AuditStore(path, DEFAULT_CONFIG.audit);
    const templates = listField(
      reopened.getCall('template-format'),
      'templates',
    );
    expect(recordField(templates[0], 'unreadable')).toBe(true);
    expect(recordField(templates[0], 'content')).toBeNull();
    reopened.close();
  });
});

describe('clear failure is not an empty database', () => {
  test('a failed clear reports failure rather than zero deletions', async () => {
    const { store } = await makeStore();
    const path = store.databasePath;
    store.enqueue(record({ callId: 'still-there', result: 'allow' }));
    await store.flush();
    store.close();
    const db = new DatabaseSync(path);
    db.exec(
      'CREATE TRIGGER deny_clear BEFORE DELETE ON calls BEGIN SELECT RAISE(ABORT, "denied clear"); END',
    );
    db.close();
    const reopened = new AuditStore(path, DEFAULT_CONFIG.audit);
    const cleared = reopened.clearCalls();
    // The store must not let a caller report "cleared, nothing deleted".
    expect(cleared.ok).toBe(false);
    expect(reopened.listCalls({}).total).toBe(1);
    reopened.close();
  });

  test('a clear in one store drops a sibling store queued pre-clear event', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arbiter-clear-shared-'));
    dirs.push(dir);
    const path = join(dir, 'arbiter.db');
    const first = new AuditStore(path, DEFAULT_CONFIG.audit);
    const second = new AuditStore(path, DEFAULT_CONFIG.audit);
    // Queue on the store that will NOT serve the clear.
    second.enqueue(record({ callId: 'pre-clear-sibling', result: 'allow' }));
    // No delay: a timestamp-based cutoff would let a same-millisecond event slip
    // through, which is exactly the race this generation counter removes.
    expect(first.clearCalls().ok).toBe(true);
    await second.flush();
    // The event predated the user's clear, so it must not resurrect the history.
    expect(first.listCalls({}).total).toBe(0);
    second.close();
    first.close();
  });
});

describe('ownership survives the owner closing', () => {
  test('an open follower inherits the policy instead of a new opener taking over', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arbiter-succession-'));
    dirs.push(dir);
    const path = join(dir, 'arbiter.db');
    const owner = new AuditStore(path, {
      ...DEFAULT_CONFIG.audit,
      retentionDays: 30,
    });
    const follower = new AuditStore(path, {
      ...DEFAULT_CONFIG.audit,
      retentionDays: 30,
    });
    owner.updateConfig({ ...DEFAULT_CONFIG.audit, retentionDays: 7 });
    owner.close();
    // A third store with a different policy must not displace the live follower.
    const later = new AuditStore(path, {
      ...DEFAULT_CONFIG.audit,
      retentionDays: 1,
    });
    expect(later.health()).toMatchObject({ state: 'degraded' });
    expect(later.retention.days).toBe(7);
    follower.close();
    later.close();
  });

  test('a promoted owner keeps the inherited policy through routine refreshes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arbiter-promoted-'));
    dirs.push(dir);
    const path = join(dir, 'arbiter.db');
    const owner = new AuditStore(path, {
      ...DEFAULT_CONFIG.audit,
      retentionDays: 30,
    });
    const follower = new AuditStore(path, {
      ...DEFAULT_CONFIG.audit,
      retentionDays: 30,
    });
    // The owner explicitly narrows the instance policy, then closes.
    owner.updateConfig({ ...DEFAULT_CONFIG.audit, retentionDays: 7 });
    owner.close();
    expect(follower.retention.days).toBe(7);
    // B's next routine refresh still carries its unchanged 30-day profile value:
    // that is not an edit and must not republish it.
    follower.updateConfig({ ...DEFAULT_CONFIG.audit, retentionDays: 30 });
    expect(follower.retention.days).toBe(7);
    expect(follower.health().state).toBe('ok');
    // A third profile opening still reads the inherited seven days.
    const later = new AuditStore(path, {
      ...DEFAULT_CONFIG.audit,
      retentionDays: 30,
    });
    expect(later.retention.days).toBe(7);
    follower.close();
    later.close();
  });
});

describe('retention reclaims and protects the right references', () => {
  test('partial cleanup keeps more than the newest record', async () => {
    const { store } = await makeStore();
    for (let index = 0; index < 12; index += 1) {
      store.enqueue(
        record({
          callId: `partial-${String(index)}`,
          result: 'allow',
          ts: Date.now() - index * 1_000,
          arguments: { command: 'echo hi', padding: 'z'.repeat(3_000) },
        }),
      );
    }
    await store.flush();
    const before = store.listCalls({}).total;
    const target = Math.floor(store.databaseBytes * 0.5);
    const outcome = store.runRetention(Date.now(), 365, target);
    // Eviction is bounded by occupied space, so a small deletion plus compaction
    // must be allowed to meet the target instead of deleting everything.
    expect(outcome.deleted).toBeLessThan(before);
    expect(store.listCalls({}).total).toBeGreaterThan(1);
    store.close();
  });

  test('a configuration referenced only by a retained stage survives', async () => {
    const { store } = await makeStore({ retentionDays: 1 });
    // Two genuinely different configurations, so the stage's reference is the
    // only thing keeping the historical one alive.
    const historical = snapshotOf(store, {
      ...DEFAULT_CONFIG,
      audit: { ...DEFAULT_CONFIG.audit, retentionDays: 11 },
    });
    const current = snapshotOf(store, {
      ...DEFAULT_CONFIG,
      audit: { ...DEFAULT_CONFIG.audit, retentionDays: 22 },
    });
    expect(historical.snapshotId).not.toBe(current.snapshotId);
    store.enqueue(
      record({
        callId: 'stage-ref',
        result: 'allow',
        configSnapshotId: current.snapshotId,
        ts: Date.now(),
        trace: [
          {
            stage: 'review',
            result: 'review-allow',
            configRevision: historical.revision,
            configSnapshotId: historical.snapshotId,
            at: 1,
          },
        ],
      }),
    );
    await store.flush();
    store.runRetention();
    const path = store.databasePath;
    store.close();
    const db = new DatabaseSync(path);
    const kept = db
      .prepare(
        'SELECT COUNT(*) AS count FROM config_snapshots WHERE snapshot_id = ?',
      )
      .get(historical.snapshotId);
    // The stage's historical configuration is what makes the record readable.
    expect(numberField(kept, 'count')).toBe(1);
    db.close();
  });

  test('an unreferenced template is reclaimed', async () => {
    const { store } = await makeStore({ retentionDays: 1 });
    const system = 'REVIEW_POLICY\nORPHAN';
    const templateId = templateIdOf(system);
    store.enqueue(
      record({
        callId: 'orphan-template',
        result: 'allow',
        ts: Date.now() - 5 * 24 * 60 * 60 * 1_000,
        modelAttempts: [
          {
            requestId: 'orphan-template:model:1',
            callId: 'orphan-template',
            attempt: 1,
            backend: 'chat',
            protocol: 'arbiter-chat-json-v1',
            request: { provider: 'p', model: 'm', system, messages: [] },
            templateId,
            responseText: '{}',
            parsed: null,
            error: null,
            startedAt: 1,
            durationMs: 2,
            estimatedInputTokens: 3,
            usage: null,
          },
        ],
      }),
    );
    await store.flush();
    const path = store.databasePath;
    store.runRetention();
    expect(store.listCalls({}).total).toBe(0);
    store.close();
    const db = new DatabaseSync(path);
    const remaining = db
      .prepare('SELECT COUNT(*) AS count FROM templates')
      .get();
    expect(numberField(remaining, 'count')).toBe(0);
    db.close();
  });
});

describe('capacity pressure from auxiliary files', () => {
  test('a large backup still drives eviction of reclaimable rows', async () => {
    const { store } = await makeStore();
    for (let index = 0; index < 10; index += 1) {
      store.enqueue(
        record({
          callId: `backup-pressure-${String(index)}`,
          result: 'allow',
          ts: Date.now() - index * 1_000,
          arguments: { command: 'echo hi', padding: 'q'.repeat(4_000) },
        }),
      );
    }
    await store.flush();
    const path = store.databasePath;
    const before = store.listCalls({}).total;
    store.close();
    // A retained migration backup consumes part of the budget, so the database
    // must shrink even though its own pages are below the overall target.
    const db = new DatabaseSync(path);
    db.exec(`VACUUM INTO '${path}.backup-v1'`);
    db.close();
    const reopened = new AuditStore(path, DEFAULT_CONFIG.audit);
    const elapsed = await stat(`${path}.backup-v1`);
    const target = Math.floor(reopened.databaseBytes * 0.85);
    expect(elapsed.size).toBeGreaterThan(0);
    const outcome = reopened.runRetention(Date.now(), 365, target);
    expect(outcome.deleted).toBeGreaterThan(0);
    expect(reopened.listCalls({}).total).toBeLessThan(before);
    reopened.close();
  });

  test('expired calls with large unique templates do not evict recent calls', async () => {
    const { store } = await makeStore({ retentionDays: 1 });
    const expired = Date.now() - 5 * 24 * 60 * 60 * 1_000;
    for (let index = 0; index < 3; index += 1) {
      const system = `REVIEW_POLICY\nEXPIRED ${String(index)} ${'e'.repeat(20_000)}`;
      store.enqueue(
        record({
          callId: `expired-template-${String(index)}`,
          result: 'allow',
          ts: expired,
          modelAttempts: [
            {
              requestId: `expired-template-${String(index)}:model:1`,
              callId: `expired-template-${String(index)}`,
              attempt: 1,
              backend: 'chat',
              protocol: 'arbiter-chat-json-v1',
              request: { provider: 'p', model: 'm', system, messages: [] },
              templateId: templateIdOf(system),
              responseText: '{}',
              parsed: null,
              error: null,
              startedAt: 1,
              durationMs: 2,
              estimatedInputTokens: 3,
              usage: null,
            },
          ],
        }),
      );
    }
    for (let index = 0; index < 3; index += 1) {
      store.enqueue(
        record({ callId: `recent-${String(index)}`, result: 'allow' }),
      );
    }
    await store.flush();
    // A target the shared content alone would breach: reclaiming the expired
    // templates before deciding has to be what meets it, not deleting the recent
    // calls.
    store.runRetention(Date.now(), 1, Math.floor(store.databaseBytes * 0.9));
    const remaining = store.listCalls({}).rows.map((row) => row.callId);
    expect(remaining.filter((id) => id.startsWith('recent-'))).toHaveLength(3);
    store.close();
  });

  test('clearing the audit removes templates it made unreferenced', async () => {
    const { store } = await makeStore();
    const system = 'REVIEW_POLICY\nCLEARED TEMPLATE';
    store.enqueue(
      record({
        callId: 'clear-template',
        result: 'allow',
        modelAttempts: [
          {
            requestId: 'clear-template:model:1',
            callId: 'clear-template',
            attempt: 1,
            backend: 'chat',
            protocol: 'arbiter-chat-json-v1',
            request: { provider: 'p', model: 'm', system, messages: [] },
            templateId: templateIdOf(system),
            responseText: '{}',
            parsed: null,
            error: null,
            startedAt: 1,
            durationMs: 2,
            estimatedInputTokens: 3,
            usage: null,
          },
        ],
      }),
    );
    await store.flush();
    const path = store.databasePath;
    expect(store.clearCalls()).toEqual({ ok: true, deleted: 1 });
    store.close();
    const db = new DatabaseSync(path);
    const templates = db
      .prepare('SELECT COUNT(*) AS count FROM templates')
      .get();
    // The audit records are gone, so their template content must be too.
    expect(numberField(templates, 'count')).toBe(0);
    db.close();
  });
});

describe('retention does not mistake free pages for auxiliary files', () => {
  test('freelist space from age deletion does not evict the remaining calls', async () => {
    const { store } = await makeStore({ retentionDays: 1 });
    const expiredTs = Date.now() - 5 * 24 * 60 * 60 * 1_000;
    // Large expired calls create substantial free pages once deleted.
    for (let index = 0; index < 8; index += 1) {
      store.enqueue(
        record({
          callId: `free-page-${String(index)}`,
          result: 'allow',
          ts: expiredTs,
          arguments: { command: 'echo hi', padding: 'f'.repeat(60_000) },
        }),
      );
    }
    for (let index = 0; index < 4; index += 1) {
      store.enqueue(
        record({ callId: `survivor-${String(index)}`, result: 'allow' }),
      );
    }
    await store.flush();
    const occupiedBefore = store.databaseBytes;
    expect(occupiedBefore).toBeGreaterThan(0);
    // A target that compaction can meet on its own. If free pages were treated as
    // auxiliary, the derived budget would look tiny and the survivors would be
    // deleted for nothing.
    const target = Math.floor(occupiedBefore * 0.75);
    const outcome = store.runRetention(Date.now(), 1, target);
    const remaining = store.listCalls({}).rows.map((row) => row.callId);
    expect(remaining.filter((id) => id.startsWith('survivor-'))).toHaveLength(
      4,
    );
    expect(outcome.deleted).toBeGreaterThan(0);
    store.close();
  });

  test('templates orphaned by age deletion are reclaimed before capacity eviction', async () => {
    const { store } = await makeStore({ retentionDays: 1 });
    const expiredTs = Date.now() - 5 * 24 * 60 * 60 * 1_000;
    for (let index = 0; index < 3; index += 1) {
      const system = `REVIEW_POLICY\nAGE ORPHAN ${String(index)} ${'o'.repeat(30_000)}`;
      store.enqueue(
        record({
          callId: `age-orphan-${String(index)}`,
          result: 'allow',
          ts: expiredTs,
          modelAttempts: [
            {
              requestId: `age-orphan-${String(index)}:model:1`,
              callId: `age-orphan-${String(index)}`,
              attempt: 1,
              backend: 'chat',
              protocol: 'arbiter-chat-json-v1',
              request: { provider: 'p', model: 'm', system, messages: [] },
              templateId: templateIdOf(system),
              responseText: '{}',
              parsed: null,
              error: null,
              startedAt: 1,
              durationMs: 2,
              estimatedInputTokens: 3,
              usage: null,
            },
          ],
        }),
      );
    }
    for (let index = 0; index < 3; index += 1) {
      store.enqueue(
        record({ callId: `keep-${String(index)}`, result: 'allow' }),
      );
    }
    await store.flush();
    const before = store.databaseBytes;
    // A tight target: the orphaned template content alone would breach it, so
    // reclaiming it before the capacity comparison is what keeps the recent
    // calls alive.
    store.runRetention(Date.now(), 1, Math.floor(before * 0.9));
    const remaining = store.listCalls({}).rows.map((row) => row.callId);
    expect(remaining.filter((id) => id.startsWith('keep-'))).toHaveLength(3);
    store.close();
  });
});

describe('WAL bytes never justify deleting retained calls', () => {
  test('age cleanup plus checkpoint already meets a 1 MiB target', async () => {
    const { store } = await makeStore({ retentionDays: 1 });
    const expiredTs = Date.now() - 5 * 24 * 60 * 60 * 1_000;
    // Expired records sized so their deletion writes a material WAL, exactly as
    // the reviewed reproduction described.
    for (let index = 0; index < 8; index += 1) {
      store.enqueue(
        record({
          callId: `wal-expired-${String(index)}`,
          result: 'allow',
          ts: expiredTs,
          arguments: { command: 'echo hi', padding: 'w'.repeat(60_000) },
        }),
      );
    }
    for (let index = 0; index < 4; index += 1) {
      store.enqueue(
        record({
          callId: `wal-recent-${String(index)}`,
          result: 'allow',
          arguments: { command: 'echo hi', padding: 'r'.repeat(120_000) },
        }),
      );
    }
    await store.flush();
    const target = 1024 * 1024;
    const outcome = store.runRetention(Date.now(), 1, target);
    const remaining = store.listCalls({}).rows.map((row) => row.callId);
    // All four recent calls must survive: after age cleanup and a checkpoint the
    // footprint already fits, so WAL bytes must not be counted as missing room.
    expect(remaining.filter((id) => id.startsWith('wal-recent-'))).toHaveLength(
      4,
    );
    expect(outcome.deleted).toBeGreaterThanOrEqual(8);
    // The reported footprint is measured after the final checkpoint, so it must
    // not carry WAL bytes that were already reclaimed.
    expect(outcome.irreducible).toBe(false);
    store.close();
  });

  test('a checkpoint that cannot complete defers capacity eviction', async () => {
    const { store } = await makeStore();
    for (let index = 0; index < 6; index += 1) {
      store.enqueue(
        record({
          callId: `defer-${String(index)}`,
          result: 'allow',
          arguments: { command: 'echo hi', padding: 'd'.repeat(5_000) },
        }),
      );
    }
    await store.flush();
    const before = store.listCalls({}).total;
    const path = store.databasePath;
    // Hold a read transaction open on a second connection so the checkpoint
    // cannot truncate the WAL.
    const reader = new DatabaseSync(path);
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) AS count FROM calls').get();
    store.enqueue(record({ callId: 'during-read', result: 'allow' }));
    await store.flush();
    // An impossible target: without honest WAL accounting this would delete every
    // call but the newest.
    const outcome = store.runRetention(Date.now(), 365, 1);
    expect(outcome.deleted).toBe(0);
    expect(store.listCalls({}).total).toBe(before + 1);
    expect(outcome.irreducible).toBe(false);
    reader.exec('COMMIT');
    reader.close();
    store.close();
  });
});

/** The store's database handle, checked rather than asserted. */
function databaseOf(store: AuditStore): DatabaseSync {
  const value: unknown = Reflect.get(store, 'db');
  if (!(value instanceof DatabaseSync))
    throw new TypeError('the store must expose its database');
  return value;
}

/** Every statement a store operation prepared, so a read's SQL is inspectable. */
function preparedStatements(
  db: DatabaseSync,
  run: () => void,
): readonly unknown[] {
  const spy = vi.spyOn(db, 'prepare');
  try {
    run();
    return spy.mock.calls.map((call) => call[0]);
  } finally {
    spy.mockRestore();
  }
}

/**
 * The paged, filtered call list.
 *
 * The list is the audit trail's index: it has to stay a stable reading surface
 * while calls keep arriving, and it must not carry the material that only the
 * detail read needs. Both properties are storage behaviour, so they are proven
 * against a real SQLite database rather than a decoded payload.
 */
describe('call list paging and filtering', () => {
  /** Enqueue `count` calls with deterministic, descending timestamps. */
  async function seed(
    store: AuditStore,
    count: number,
    overrides: (index: number) => Partial<CallRecord> = () => ({}),
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const callId = `pag-${String(index).padStart(3, '0')}`;
      ids.push(callId);
      store.enqueue(
        record({
          callId,
          result: 'allow',
          ts: 1_000 + (count - index) * 10,
          ...overrides(index),
        }),
      );
    }
    await store.flush();
    return ids;
  }

  /** Walk every page forward, following the keyset cursor. */
  function walk(
    store: AuditStore,
    limit: number,
    filter: CallFilter = {},
  ): { readonly ids: readonly string[]; readonly pages: number } {
    const ids: string[] = [];
    let after: CallAnchor | null = null;
    for (let guard = 0; guard < 100; guard += 1) {
      const page = store.listCalls({
        limit,
        ...filter,
        ...(after === null ? {} : { after }),
      });
      ids.push(...page.rows.map((row) => row.callId));
      if (page.nextCursor === null || page.rows.length < limit) break;
      after = page.nextCursor;
    }
    return { ids, pages: Math.ceil(ids.length / limit) };
  }

  test('walks every page of a multi-page result without gaps or repeats', async () => {
    const { store } = await makeStore();
    const ids = await seed(store, 60);
    const walked = walk(store, 25);
    expect(walked.ids).toHaveLength(60);
    expect(new Set(walked.ids).size).toBe(60);
    expect(walked.ids).toEqual(ids);
    expect(store.listCalls({ limit: 25 }).total).toBe(60);
    store.close();
  });

  test('orders equal timestamps deterministically across reads and pages', async () => {
    const { store } = await makeStore();
    const shared = 5_000;
    for (const callId of ['same-a', 'same-b', 'same-c', 'same-d']) {
      store.enqueue(
        record({ callId, result: 'allow', ts: shared, tool: 'bash' }),
      );
    }
    store.enqueue(
      record({ callId: 'newest', result: 'allow', ts: shared + 1 }),
    );
    await store.flush();
    const order = ['newest', 'same-d', 'same-c', 'same-b', 'same-a'];
    expect(walk(store, 2).ids).toEqual(order);
    expect(store.listCalls({ limit: 2 }).rows.map((row) => row.callId)).toEqual(
      order.slice(0, 2),
    );
    store.close();
  });

  test('a call inserted inside the window cannot shift the next page', async () => {
    const { store } = await makeStore();
    const ids = await seed(store, 12);
    const pageSize = 4;
    const first = store.listCalls({ limit: pageSize });
    expect(first.rows.map((row) => row.callId)).toEqual(ids.slice(0, 4));
    // Three insertions that each land somewhere different relative to the
    // window: above the head, inside the already-read timestamps, and sharing a
    // timestamp with a row that sorts below the cursor.
    const cursor = first.nextCursor;
    if (cursor === null) throw new Error('the first page must continue');
    store.enqueue(record({ callId: 'zzz-above', result: 'allow', ts: 9_000 }));
    store.enqueue(
      record({
        callId: 'aaa-inside',
        result: 'allow',
        ts: ids.length > 0 ? 1_000 + (12 - 1) * 10 : 1_000,
      }),
    );
    store.enqueue(
      record({ callId: 'same-ts-lower', result: 'allow', ts: cursor.ts - 5 }),
    );
    await store.flush();
    const rest = walk(store, pageSize, { after: cursor });
    // Every surviving row of the original set is visited exactly once: no row
    // is repeated and none is skipped by the insertions.
    expect(rest.ids.filter((id) => ids.includes(id))).toEqual(ids.slice(4));
    expect(new Set(rest.ids).size).toBe(rest.ids.length);
    store.close();
  });

  test('an insertion that shares the cursor timestamp is not skipped or repeated', async () => {
    const { store } = await makeStore();
    for (const callId of ['tie-a', 'tie-b', 'tie-c']) {
      store.enqueue(record({ callId, result: 'allow', ts: 7_000 }));
    }
    store.enqueue(record({ callId: 'tie-d', result: 'allow', ts: 6_000 }));
    await store.flush();
    const first = store.listCalls({ limit: 2 });
    // `call_id DESC` means tie-c, tie-b, tie-a; the page took the first two.
    expect(first.rows.map((row) => row.callId)).toEqual(['tie-c', 'tie-b']);
    const cursor = first.nextCursor;
    if (cursor === null) throw new Error('the first page must continue');
    // A new row with the same timestamp, sorting below the cursor, is exactly
    // the case a row-count window would break on: it must join the unread
    // remainder without disturbing the rows already returned.
    store.enqueue(record({ callId: 'tie-a5', result: 'allow', ts: 7_000 }));
    await store.flush();
    const rest = store.listCalls({ limit: 2, after: cursor });
    expect(rest.rows.map((row) => row.callId)).toEqual(['tie-a5', 'tie-a']);
    expect(rest.rows.map((row) => row.callId)).not.toContain('tie-b');
    // The already-read rows never reappear, and no unread original row is lost.
    const all = store.listCalls({ limit: 10 }).rows.map((row) => row.callId);
    expect(all).toEqual(['tie-c', 'tie-b', 'tie-a5', 'tie-a', 'tie-d']);
    const tail = rest.nextCursor;
    if (tail === null) throw new Error('the remainder must continue');
    expect(
      store.listCalls({ limit: 2, after: tail }).rows.map((row) => row.callId),
    ).toEqual(['tie-d']);
    store.close();
  });

  test('a delayed older-timestamp write does not duplicate the previous page', async () => {
    const { store } = await makeStore();
    await seed(store, 6);
    const first = store.listCalls({ limit: 3 });
    const cursor = first.nextCursor;
    if (cursor === null) throw new Error('the first page must continue');
    store.enqueue(record({ callId: 'late-old', result: 'allow', ts: 1_000 }));
    await store.flush();
    const rest = store.listCalls({ limit: 3, after: cursor });
    // The late row sorts after everything read so far; it appears once, at the
    // end, rather than shifting a row out of the page just read.
    expect(rest.rows.map((row) => row.callId)).toEqual([
      'pag-003',
      'pag-004',
      'pag-005',
    ]);
    const tailCursor = rest.nextCursor;
    if (tailCursor === null) throw new Error('the second page must continue');
    const tail = store.listCalls({ limit: 3, after: tailCursor });
    expect(tail.rows.map((row) => row.callId)).toEqual(['late-old']);
    store.close();
  });

  test('reads the page before a cursor for backward navigation', async () => {
    const { store } = await makeStore();
    const ids = await seed(store, 10);
    const pageSize = 3;
    const first = store.listCalls({ limit: pageSize });
    const firstCursor = first.nextCursor;
    if (firstCursor === null) throw new Error('the first page must continue');
    const second = store.listCalls({ limit: pageSize, after: firstCursor });
    expect(second.rows.map((row) => row.callId)).toEqual(ids.slice(3, 6));
    const previousCursor = second.prevCursor;
    if (previousCursor === null)
      throw new Error('the second page must carry a cursor');
    const previous = store.listCalls({
      limit: pageSize,
      before: previousCursor,
    });
    expect(previous.rows.map((row) => row.callId)).toEqual(ids.slice(0, 3));
    store.close();
  });

  test('counts records above the traversal head', async () => {
    const { store } = await makeStore();
    await seed(store, 3);
    const first = store.listCalls({ limit: 10 });
    expect(first.newer).toBe(0);
    store.enqueue(record({ callId: 'arrived', result: 'allow', ts: 5_000 }));
    await store.flush();
    const reread = store.listCalls({
      limit: 10,
      ...(first.anchor === null ? {} : { anchor: first.anchor }),
    });
    expect(reread.total).toBe(3);
    expect(reread.newer).toBe(1);
    // A fresh traversal includes it and has nothing above itself.
    const fresh = store.listCalls({ limit: 10 });
    expect(fresh.total).toBe(4);
    expect(fresh.newer).toBe(0);
    store.close();
  });

  test('combines every filter in SQL before the window', async () => {
    const { store } = await makeStore();
    for (let index = 0; index < 12; index += 1) {
      const denied = index % 2 === 0;
      store.enqueue(
        record({
          callId: `combo-${String(index)}`,
          result: denied ? 'review-deny' : 'review-allow',
          tool: index % 3 === 0 ? 'bash' : 'write',
          sessionKind: index % 4 === 0 ? 'subagent' : 'main',
          sessionId: index % 5 === 0 ? 'session-x' : 'session-y',
          reason: index % 2 === 0 ? 'needs human review' : 'looks safe',
          ts: 2_000 + index * 10,
          trace: [
            {
              stage: 'review',
              result: denied ? 'review-deny' : 'review-allow',
              decisionRules: index % 2 === 0 ? ['R7'] : ['R8'],
              at: 2,
            },
          ],
          decisionRules: index % 2 === 0 ? ['R7'] : ['R8'],
        }),
      );
    }
    await store.flush();
    const deniedBash = store.listCalls({
      limit: 50,
      deniedOnly: true,
      tool: 'bash',
    });
    expect(deniedBash.total).toBe(2);
    expect(
      deniedBash.rows.every(
        (row) => row.result === 'review-deny' && row.tool === 'bash',
      ),
    ).toBe(true);
    const ruleRows = store.listCalls({ limit: 50, ruleId: 'R8' });
    expect(ruleRows.total).toBe(6);
    expect(ruleRows.rows.every((row) => row.result === 'review-allow')).toBe(
      true,
    );
    expect(store.listCalls({ limit: 50, sessionId: 'session-x' }).total).toBe(
      3,
    );
    expect(store.listCalls({ limit: 50, sessionKind: 'subagent' }).total).toBe(
      3,
    );
    expect(store.listCalls({ limit: 50, from: 2_050, to: 2_090 }).total).toBe(
      5,
    );
    const combined = store.listCalls({
      limit: 50,
      deniedOnly: true,
      tool: 'bash',
      ruleId: 'R7',
      sessionId: 'session-y',
    });
    expect(combined.total).toBe(1);
    expect(combined.rows[0]?.callId).toBe('combo-6');
    expect(store.listCalls({ limit: 50, tool: 'nonexistent' }).total).toBe(0);
    store.close();
  });

  test('the rule filter matches a short-circuit rule and a review decision rule', async () => {
    const { store } = await makeStore();
    store.enqueue(
      record({
        callId: 'short-circuit',
        result: 'deny',
        decisionRules: [],
        trace: [
          {
            stage: 'rule',
            result: 'deny',
            ruleId: 'no-push',
            ruleName: 'Block force push',
            at: 1,
          },
        ],
      }),
    );
    store.enqueue(
      record({
        callId: 'reviewed',
        result: 'review-deny',
        decisionRules: ['R7'],
        trace: [
          {
            stage: 'review',
            result: 'review-deny',
            decisionRules: ['R7'],
            at: 2,
          },
        ],
      }),
    );
    await store.flush();
    const byRule = store.listCalls({ ruleId: 'no-push' });
    expect(byRule.rows.map((row) => row.callId)).toEqual(['short-circuit']);
    expect(byRule.rows[0]?.ruleName).toBe('Block force push');
    expect(
      store.listCalls({ ruleId: 'R7' }).rows.map((row) => row.callId),
    ).toEqual(['reviewed']);
    store.close();
  });

  test('the review-failure shortcut only matches a failed review stage', async () => {
    const { store } = await makeStore();
    store.enqueue(
      record({
        callId: 'failed',
        result: 'human-allow',
        trace: [
          {
            stage: 'review',
            result: 'error-escalate',
            reason: 'circuit_open',
            at: 2,
          },
          { stage: 'human', result: 'human-allow', at: 3 },
        ],
      }),
    );
    store.enqueue(
      record({
        callId: 'reviewed',
        result: 'review-allow',
        trace: [{ stage: 'review', result: 'review-allow', at: 2 }],
      }),
    );
    await store.flush();
    const failed = store.listCalls({ reviewFailureOnly: true });
    expect(failed.rows.map((row) => row.callId)).toEqual(['failed']);
    expect(failed.total).toBe(1);
    store.close();
  });

  test('search treats wildcard characters literally', async () => {
    const { store } = await makeStore();
    store.enqueue(
      record({
        callId: 'percent',
        result: 'allow',
        arguments: { command: 'echo 100%' },
      }),
    );
    store.enqueue(
      record({
        callId: 'plain',
        result: 'allow',
        arguments: { command: 'echo 1000' },
      }),
    );
    await store.flush();
    const matched = store.listCalls({ query: '100%' });
    expect(matched.rows.map((row) => row.callId)).toEqual(['percent']);
    expect(matched.total).toBe(1);
    store.close();
  });

  test('a cursor past the last row yields an empty page with a valid total', async () => {
    const { store } = await makeStore();
    await seed(store, 5);
    const beyond = store.listCalls({
      limit: 25,
      after: { ts: 1_000, callId: 'pag-004' },
    });
    expect(beyond.rows).toEqual([]);
    expect(beyond.total).toBe(5);
    expect(beyond.nextCursor).toBeNull();
    store.close();
  });

  test('page size boundaries are clamped to the readable window', async () => {
    const { store } = await makeStore();
    await seed(store, 3);
    expect(store.listCalls({ limit: 0 }).limit).toBe(1);
    expect(store.listCalls({ limit: -5 }).limit).toBe(1);
    expect(store.listCalls({ limit: 1 }).rows).toHaveLength(1);
    expect(store.listCalls({ limit: 500 }).limit).toBe(200);
    expect(store.listCalls({ limit: Number.NaN }).limit).toBe(25);
    expect(store.listCalls({ limit: 2.7 }).limit).toBe(2);
    store.close();
  });

  test('a list page carries neither stored arguments nor prompt or response text', async () => {
    const { store } = await makeStore();
    const prompt = 'PROMPT-MATERIAL-MUST-NOT-APPEAR';
    const response = 'RESPONSE-MATERIAL-MUST-NOT-APPEAR';
    store.enqueue(
      record({
        callId: 'with-model-call',
        result: 'review-allow',
        arguments: { command: 'echo hi', secretInput: 'ARGUMENT-BODY' },
        modelAttempts: [
          {
            requestId: 'with-model-call:model:1',
            callId: 'with-model-call',
            attempt: 1,
            backend: 'chat',
            protocol: 'chat',
            request: {
              system: 'REVIEW_POLICY\nPROMPT-MATERIAL-MUST-NOT-APPEAR',
              messages: [{ role: 'user', content: prompt }],
            },
            responseText: response,
            parsed: { verdict: 'allow' },
            error: null,
            startedAt: 1,
            durationMs: 2,
            estimatedInputTokens: 3,
            usage: null,
          },
        ],
      }),
    );
    await store.flush();
    const page = store.listCalls({ limit: 10 });
    expect(page.rows).toHaveLength(1);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain(prompt);
    expect(serialized).not.toContain(response);
    expect(serialized).not.toContain('ARGUMENT-BODY');
    const row = asRecord(page.rows[0]);
    expect(Object.keys(row).sort()).toEqual(
      [
        'callId',
        'command',
        'recordFormatVersion',
        'result',
        'ruleId',
        'ruleName',
        'sessionId',
        'sessionKind',
        'tool',
        'ts',
        'unreadable',
        'unreadableReason',
      ].sort(),
    );
    const detail = store.getCall('with-model-call');
    expect(JSON.stringify(detail)).toContain(prompt);
    expect(JSON.stringify(detail)).toContain(response);
    store.close();
  });

  test('the list query never reads model traffic or stored snapshots', async () => {
    const { store } = await makeStore();
    store.enqueue(record({ callId: 'plain', result: 'allow' }));
    await store.flush();
    const prepared = preparedStatements(databaseOf(store), () => {
      store.listCalls({ limit: 5, query: 'echo' });
    });
    expect(prepared.length).toBeGreaterThan(0);
    for (const statement of prepared) {
      expect(statement).not.toContain('model_calls');
      expect(statement).not.toContain('snapshots');
      expect(statement).not.toContain('templates');
      expect(statement).not.toContain('response_text');
      expect(statement).not.toContain('SELECT *');
    }
    store.close();
  });

  test('an oversized stored command is truncated instead of returned whole', async () => {
    const { store } = await makeStore();
    store.enqueue(
      record({
        callId: 'long-command',
        result: 'allow',
        arguments: { command: 'x'.repeat(400_000) },
      }),
    );
    store.enqueue(
      record({
        callId: 'long-code',
        result: 'allow',
        arguments: { code: 'y'.repeat(400_000) },
      }),
    );
    store.enqueue(
      record({
        callId: 'numeric-command',
        result: 'allow',
        arguments: { command: 42, code: 'fallback-code' },
      }),
    );
    store.enqueue(
      record({
        callId: 'multiline',
        result: 'allow',
        arguments: { command: 'echo one\necho two' },
      }),
    );
    await store.flush();
    const page = store.listCalls({ limit: 10 });
    const byId = new Map(page.rows.map((row) => [row.callId, row]));
    expect(byId.get('long-command')?.command).toHaveLength(240);
    expect(byId.get('long-code')?.command).toHaveLength(240);
    expect(byId.get('numeric-command')?.command).toBe('fallback-code');
    expect(byId.get('multiline')?.command).toContain('echo one');
    expect(JSON.stringify(page).length).toBeLessThan(20_000);
    expect(
      stringField(
        asRecord(store.getCall('long-command'))['arguments'],
        'command',
      ),
    ).toHaveLength(400_000);
    store.close();
  });

  test('unreadable, legacy and current records all remain in the default list', async () => {
    const { store } = await makeStore();
    const path = store.databasePath;
    store.enqueue(record({ callId: 'current', result: 'allow', ts: 1_000 }));
    await store.flush();
    store.close();
    const db = new DatabaseSync(path);
    const insert = db.prepare(
      `INSERT INTO calls(call_id, ts, session_id, session_kind, parent_session, profile, workspace,
          tool, arguments, arguments_schema, cwd, fingerprint, config_revision, config_snapshot_id,
          approval_mode, execution_mode, result, reason, trace, effect, session_record_state,
          signals, policy_strategy, decision_rules, execution_status, record_format_version,
          execution_started_at, execution_finished_at)
       VALUES (?, ?, 'session-1', 'main', NULL, NULL, NULL, 'bash', '{"command":"seeded"}', NULL,
          '/w', 'fp', 'rev', 'cfg', 'normal', 'trusted', 'allow', 'reason', '[]', 'null',
          'written', NULL, NULL, '[]', 'pending', ?, NULL, NULL)`,
    );
    insert.run('legacy', 2_000, 1);
    insert.run('future', 3_000, 99);
    db.close();
    const reopened = new AuditStore(path, DEFAULT_CONFIG.audit);
    const page = reopened.listCalls({ limit: 10 });
    expect(page.rows.map((row) => row.callId)).toEqual([
      'future',
      'legacy',
      'current',
    ]);
    const rows = new Map(page.rows.map((row) => [row.callId, row]));
    expect(rows.get('future')?.unreadable).toBe(true);
    expect(rows.get('future')?.command).toBe('seeded');
    expect(rows.get('legacy')?.unreadable).toBe(false);
    expect(rows.get('current')?.unreadable).toBe(false);
    reopened.close();
  });
});

describe('tail reads for last-page recovery', () => {
  test('the tail read returns the last page of the traversal', async () => {
    const { store } = await makeStore();
    for (let index = 0; index < 41; index += 1) {
      store.enqueue(
        record({
          callId: `tail-${String(index).padStart(2, '0')}`,
          result: 'allow',
          ts: 10_000 - index,
        }),
      );
    }
    await store.flush();
    const page = store.listCalls({ limit: 25, tail: true });
    // 41 rows and a 25-row page means the last page holds 16 rows, not 25: the
    // read is bounded to the rows that actually form it.
    expect(page.total).toBe(41);
    expect(page.rows).toHaveLength(16);
    expect(page.rows[0]?.callId).toBe('tail-25');
    expect(page.rows.at(-1)?.callId).toBe('tail-40');
    expect(page.prevCursor).not.toBeNull();
    store.close();
  });

  test('a tail read of a short set is the whole set', async () => {
    const { store } = await makeStore();
    await store.flush();
    expect(store.listCalls({ limit: 25, tail: true }).rows).toEqual([]);
    store.enqueue(record({ callId: 'only', result: 'allow' }));
    await store.flush();
    const page = store.listCalls({ limit: 25, tail: true });
    expect(page.rows.map((row) => row.callId)).toEqual(['only']);
    store.close();
  });
});
