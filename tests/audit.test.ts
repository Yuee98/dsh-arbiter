import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { AuditStore, fingerprintOf, type CallRecord } from '../src/audit.js';
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
    expect(prior.map((item) => item.callId)).toEqual(['denied']);
    expect(prior[0]?.result).toBe('review-deny');
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
    expect(nullableNumberField(done, 'executionStartedAt')).toBe(
      1_700_000_000_000,
    );
    expect(nullableNumberField(done, 'executionFinishedAt')).toBe(
      1_700_000_000_000,
    );
    // Recording an execution result never rewrites the permission verdict.
    expect(stringField(done, 'result')).toBe('review-allow');
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
    expect(store.clearCalls()).toBe(1);
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
    const deleted = store.clearCalls();
    expect(deleted).toBe(0);
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
    store.clearCalls();
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
