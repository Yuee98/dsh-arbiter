import type * as NodeFs from 'node:fs';
import type { PathLike } from 'node:fs';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { AuditStore, type ToolResultReceipt } from '../../src/audit.js';
import { writeCallRecord } from '../../src/audit/writer.js';
import {
  resultCall,
  resultFile,
  resultFixture,
  resultObservation,
} from './tool-result-helpers.js';

const fault = vi.hoisted(() => ({ blocked: null as string | null }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    unlinkSync(path: PathLike) {
      if (String(path) === fault.blocked)
        throw Object.assign(new Error('synthetic unlink denied'), {
          code: 'EACCES',
        });
      actual.unlinkSync(path);
    },
  };
});
let fixture: ReturnType<typeof resultFixture>;
beforeEach(() => {
  fixture = resultFixture();
});
afterEach(() => {
  fault.blocked = null;
  fixture.close();
});
function save(
  store: AuditStore,
  callId: string,
  observedAt = Date.now(),
): ToolResultReceipt {
  const result = store.saveToolResult(
    resultObservation({
      callId,
      observedAt,
      parts: [{ kind: 'text', channel: 'stdout', text: 'x'.repeat(220_000) }],
    }),
  );
  if (result.state !== 'saved' || result.receipt === null)
    throw new Error('fixture body was not saved');
  return result.receipt;
}
const DAY = 86_400_000;

describe('unified SQLite and tool body retention', () => {
  test('PR-B01: bounded work remains pending while multiple evictable groups remain', () => {
    const store = fixture.open();
    const now = Date.now();
    expect(
      store.saveToolResult(
        resultObservation({ callId: 'newest', observedAt: now }),
      ).state,
    ).toBe('saved');
    const db = new DatabaseSync(fixture.path);
    const clone =
      db.prepare(`INSERT INTO tool_results(session_id, call_id, result_id, ts, storage, metadata, body)
      SELECT session_id, ?, ?, ?, storage, metadata, body FROM tool_results WHERE call_id = 'newest'`);
    db.exec('BEGIN IMMEDIATE');
    for (let index = 1; index <= 1301; index += 1)
      clone.run(`older-${String(index)}`, randomUUID(), now - index);
    db.exec('COMMIT');
    const first = store.runRetention(now, 30, 1);
    expect(first.irreducible).toBe(false);
    expect(first).toMatchObject({ capacityPending: true });
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM tool_results').get(),
    ).toMatchObject({ count: 22 });
    const next = store.runRetention(now, 30, 1);
    expect(next.irreducible).toBe(true);
    expect(next).not.toHaveProperty('capacityPending');
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM tool_results').get(),
    ).toMatchObject({ count: 1 });
    expect(store.getToolResult('session', 'newest').state).toBe('found');
    db.close();
  }, 30_000);

  test('PR-B03: a replacement cannot commit between capacity selection and deletion of that old candidate', async () => {
    const store = fixture.open();
    const now = Date.now();
    for (const [index, id] of ['A', 'B', 'C'].entries())
      store.enqueue(
        resultCall({ callId: id, ts: now - 30_000 + index * 10_000 }),
      );
    await store.flush();
    const candidate: unknown = Reflect.get(store, 'db');
    if (!(candidate instanceof DatabaseSync))
      throw new Error('missing fixture database');
    const other = new DatabaseSync(fixture.path);
    let attempted = false;
    const interleaving = { deferred: false };
    const replacement = resultCall({
      callId: 'A',
      ts: now + 10_000,
      reason: 'newer committed observation',
    });
    const prepare = candidate.prepare.bind(candidate);
    const spy = vi.spyOn(candidate, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.includes('ORDER BY ts') && !attempted) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, 'all').mockImplementation((...args) => {
          const rows = all(...args);
          if (!attempted) {
            attempted = true;
            try {
              writeCallRecord(other, replacement);
            } catch (error) {
              if (
                !(error instanceof Error) ||
                !/locked|busy/iu.test(error.message)
              )
                throw error;
              interleaving.deferred = true;
            }
          }
          return rows;
        });
      }
      return statement;
    });
    try {
      store.runRetention(now, 30, 1);
      if (interleaving.deferred) writeCallRecord(other, replacement);
    } finally {
      spy.mockRestore();
      other.close();
    }
    expect(attempted).toBe(true);
    expect(store.getCall('A')).toMatchObject({
      ts: now + 10_000,
      reason: 'newer committed observation',
    });
  });

  test('PR-B03: a writer appending reclaimable WAL after checkpoint does not evict valid groups for those bytes', async () => {
    const store = fixture.open();
    for (const id of ['A', 'B', 'C']) store.enqueue(resultCall({ callId: id }));
    await store.flush();
    const candidate: unknown = Reflect.get(store, 'db');
    if (!(candidate instanceof DatabaseSync))
      throw new Error('missing fixture database');
    candidate.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const target = store.databaseBytes;
    const other = new DatabaseSync(fixture.path);
    let appended = false;
    const prepare = candidate.prepare.bind(candidate);
    const spy = vi.spyOn(candidate, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.includes('wal_checkpoint') && !appended) {
        const get = statement.get.bind(statement);
        vi.spyOn(statement, 'get').mockImplementation((...args) => {
          const row = get(...args);
          if (!appended) {
            appended = true;
            other
              .prepare(
                "UPDATE calls SET reason = 'changed' WHERE call_id = 'A'",
              )
              .run();
          }
          return row;
        });
      }
      return statement;
    });
    let deleted: number;
    try {
      deleted = store.runRetention(Date.now(), 30, target).deleted;
    } finally {
      spy.mockRestore();
      other.close();
    }
    expect(appended).toBe(true);
    expect(deleted).toBe(0);
    expect(store.listCalls({}).total).toBe(3);
  });
  test('a failed result retains the actually observed call age anchor', () => {
    const store = fixture.open();
    const now = Date.now();
    expect(
      store.saveToolResult(
        resultObservation({
          callStartedAt: now - 29 * DAY,
          observedAt: now,
          parts: [{ kind: 'json', channel: 'structured', value: 1n }],
        }),
      ).state,
    ).toBe('failed');
    expect(store.getToolResult('session', 'query').state).toBe(
      'storage-failed',
    );
    store.runRetention(now + 2 * DAY);
    expect(store.getToolResult('session', 'query').state).toBe('absent');
  });
  test('expires independent results and releases referenced body files under the same age policy', () => {
    const store = fixture.open();
    const now = Date.now();
    const receipt = save(store, 'old', now - 29 * DAY);
    save(store, 'current', now);
    const oldFile = resultFile(
      store.getToolResult('session', 'old'),
      fixture.path,
    );
    expect(store.runRetention(now + 2 * DAY).cleanupPending).toBeUndefined();
    expect(existsSync(oldFile)).toBe(false);
    expect(store.getToolResult('session', 'old').state).toBe('absent');
    expect(store.getToolResult('session', 'old', receipt).state).toBe(
      'cleared',
    );
    expect(store.getToolResult('session', 'current').state).toBe('found');
  });

  test('a late result cannot pin an expired reviewed call', async () => {
    const store = fixture.open();
    const now = Date.now();
    store.enqueue(resultCall({ ts: now - 29 * DAY }));
    await store.flush();
    save(store, 'query', now);
    save(store, 'unreviewed', now);
    const outcome = store.runRetention(now + 2 * DAY);
    expect(outcome.deleted).toBe(1);
    expect(store.getCall('query')).toBeNull();
    expect(store.getToolResult('session', 'query').state).toBe('absent');
    expect(store.getToolResult('session', 'unreviewed').state).toBe('found');
    expect(readdirSync(`${fixture.path}.results`)).toHaveLength(1);
  });

  test('counts actual body bytes and evicts oldest result-only groups until the shared capacity fits', () => {
    const store = fixture.open();
    const now = Date.now();
    save(store, 'first', now - 3);
    save(store, 'second', now - 2);
    save(store, 'newest', now - 1);
    expect(store.databaseBytes).toBeGreaterThan(660_000);
    const outcome = store.runRetention(now, 30, 500_000);
    expect(outcome.deleted).toBe(0);
    expect(outcome.irreducible).toBe(false);
    expect(store.getToolResult('session', 'first').state).toBe('absent');
    expect(store.getToolResult('session', 'second').state).toBe('absent');
    expect(store.getToolResult('session', 'newest').state).toBe('found');
    expect(store.databaseBytes).toBeLessThanOrEqual(500_000);
    expect(outcome.bytes).toBe(store.databaseBytes);
  });

  test('keeps the newest logical group and honestly reports an irreducible body', () => {
    const store = fixture.open();
    save(store, 'newest');
    const outcome = store.runRetention(Date.now(), 30, 1);
    expect(outcome.irreducible).toBe(true);
    expect(outcome.bytes).toBeGreaterThan(220_000);
    expect(store.getToolResult('session', 'newest').state).toBe('found');
  });

  test('PLAN-B02: an expired file that cannot unlink never causes unrelated recent history to be evicted', () => {
    const store = fixture.open();
    const now = Date.now();
    save(store, 'expired-A', now - 29 * DAY);
    for (const id of ['B', 'C', 'D']) save(store, id, now);
    const file = resultFile(
      store.getToolResult('session', 'expired-A'),
      fixture.path,
    );
    fault.blocked = file;
    const before = store.databaseBytes;
    const outcome = store.runRetention(now + 2 * DAY, 30, 1);
    expect(outcome.cleanupPending).toBe(true);
    expect(outcome.irreducible).toBe(false);
    expect(store.getToolResult('session', 'expired-A').state).toBe('absent');
    expect(readFileSync(file)).toHaveLength(220_000);
    expect(outcome.bytes).toBeGreaterThan(880_000);
    expect(
      ['B', 'C', 'D'].map((id) => store.getToolResult('session', id).state),
    ).toEqual(['found', 'found', 'found']);
    expect(store.health().state).toBe('degraded');
    fault.blocked = null;
    expect(
      store.runRetention(now + 2 * DAY, 30, 1024 ** 3).cleanupPending,
    ).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    expect(store.databaseBytes).toBeLessThan(before);
    expect(
      ['B', 'C', 'D'].map((id) => store.getToolResult('session', id).state),
    ).toEqual(['found', 'found', 'found']);
  });

  test('PLAN-B02: a failure first encountered during capacity eviction stops before another group', () => {
    const store = fixture.open();
    const now = Date.now();
    save(store, 'A', now - 3);
    save(store, 'B', now - 2);
    save(store, 'C', now - 1);
    fault.blocked = resultFile(
      store.getToolResult('session', 'A'),
      fixture.path,
    );
    const outcome = store.runRetention(now, 30, 1);
    expect(outcome.cleanupPending).toBe(true);
    expect(store.getToolResult('session', 'A').state).toBe('absent');
    expect(store.getToolResult('session', 'B').state).toBe('found');
    expect(store.getToolResult('session', 'C').state).toBe('found');
  });

  test('clear commits logical deletion, exposes failed physical reclamation and retries after restart', async () => {
    const owner = fixture.open();
    const follower = fixture.open();
    const oldGeneration = follower.captureToolResultGeneration();
    const receipt = save(owner, 'query');
    const file = resultFile(
      owner.getToolResult('session', 'query'),
      fixture.path,
    );
    follower.enqueue(resultCall({ callId: 'queued-before-clear' }));
    fault.blocked = file;
    expect(owner.clearCalls()).toEqual({ ok: false, deleted: 0 });
    expect(owner.health().lastError).toBe('result-cleanup-pending');
    await follower.flush();
    expect(owner.listCalls({}).total).toBe(0);
    expect(owner.getToolResult('session', 'query', receipt).state).toBe(
      'cleared',
    );
    if (oldGeneration === null) throw new Error('missing fixture generation');
    expect(
      follower.saveToolResult(resultObservation({ generation: oldGeneration }))
        .state,
    ).toBe('stale');
    expect(readFileSync(file)).toHaveLength(220_000);
    fault.blocked = null;
    owner.close();
    follower.close();
    const restarted = fixture.open();
    expect(existsSync(file)).toBe(false);
    expect(restarted.getToolResult('session', 'query').state).toBe('absent');
    expect(restarted.saveToolResult(resultObservation()).state).toBe('saved');
    expect(restarted.getToolResult('session', 'query', receipt).state).toBe(
      'cleared',
    );
  });

  test('a failed SQL clear keeps body metadata, generation and pending call observations intact', async () => {
    const store = fixture.open();
    const receipt = save(store, 'query');
    store.enqueue(resultCall());
    await store.flush();
    const generation = store.captureToolResultGeneration();
    const db = new DatabaseSync(fixture.path);
    db.exec(
      "CREATE TRIGGER deny_clear BEFORE DELETE ON calls BEGIN SELECT RAISE(ABORT, 'synthetic clear denial'); END",
    );
    store.enqueue(resultCall({ callId: 'still-queued' }));
    expect(store.clearCalls()).toEqual({ ok: false, deleted: 0 });
    expect(store.captureToolResultGeneration()).toBe(generation);
    expect(store.getToolResult('session', 'query', receipt).state).toBe(
      'found',
    );
    await store.flush();
    expect(store.getCall('still-queued')).not.toBeNull();
    db.exec('DROP TRIGGER deny_clear');
    db.close();
    expect(store.clearCalls().ok).toBe(true);
  });

  test('a follower reports the full footprint and cannot apply its own cleanup thresholds', () => {
    const owner = fixture.open();
    save(owner, 'query');
    const follower = new AuditStore(fixture.path, {
      ...DEFAULT_CONFIG.audit,
      retentionDays: 1,
      retentionBytes: 1,
    });
    try {
      expect(follower.retention.days).toBe(30);
      expect(
        follower.runRetention(Date.now() + 40 * DAY, 1, 1).bytes,
      ).toBeGreaterThan(220_000);
      expect(owner.getToolResult('session', 'query').state).toBe('found');
      owner.runRetention(Date.now() + 40 * DAY);
      expect(follower.getToolResult('session', 'query').state).toBe('absent');
    } finally {
      follower.close();
    }
  });
});
