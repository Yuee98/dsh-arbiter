import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, test } from 'vitest';

import { AuditStore, fingerprintOf } from '../../src/audit.js';
import type { CallRecord } from '../../src/audit.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { apply } from '../../src/index.js';
import type {
  ConnectionLike,
  ContextLike,
  FetchRouteLike,
  HostServices,
  ProfileContextLike,
} from '../../src/host/types.js';

/**
 * The `/api/arbiter/logs` boundary.
 *
 * The store tests prove the query; this file proves the HTTP contract the log
 * page actually depends on: the window a response reports, the traversal
 * anchor, and — most importantly — that an unreadable database is not answered
 * as a successful empty page. Saying "no records" when the read failed would
 * tell the operator their audit trail is gone.
 */

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

function stubContext(services: Readonly<Record<string, unknown>>): ContextLike {
  function get(key: 'profileContext'): ProfileContextLike | undefined;
  function get(
    key: 'sandboxPolicy',
  ): { readonly defaultMode?: string } | undefined;
  function get(key: 'sessions'): HostServices['sessions'];
  function get(key: 'llm'): HostServices['llm'];
  function get(key: 'approval'): HostServices['approval'];
  function get(key: 'permissionPresets'): HostServices['presets'];
  function get(key: 'workingDirectory'): HostServices['workingDirectory'];
  function get(key: 'credentials'): HostServices['credentials'];
  function get(key: 'configEditor'): HostServices['configEditor'];
  function get(key: 'commands'): HostServices['commands'];
  function get(key: 'connection'): ConnectionLike | undefined;
  function get(key: string): unknown;
  function get(key: string): unknown {
    return services[key];
  }
  return {
    get,
    on: () => () => undefined,
    effect: (callback) => callback(),
    inject: (names, callback) =>
      names.every((name) => services[name] !== undefined)
        ? callback(stubContext(services))
        : undefined,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
}

function recordOf(
  callId: string,
  overrides: Partial<CallRecord> = {},
): CallRecord {
  return {
    callId,
    ts: Date.now(),
    sessionId: 'session-1',
    sessionKind: 'main',
    parentSession: null,
    profile: 'logs',
    workspace: '/workspace/app',
    tool: 'bash',
    arguments: { command: `echo ${callId}` },
    cwd: '/workspace/app',
    fingerprint: fingerprintOf('bash', { command: `echo ${callId}` }),
    configRevision: 'rev-1',
    configSnapshotId: 'cfg-1',
    approvalMode: 'ask',
    executionMode: 'trusted',
    result: 'review-allow',
    reason: 'allowed by rule keep-me',
    trace: [],
    effect: null,
    sessionRecordState: 'written',
    snapshot: null,
    modelAttempts: [],
    scores: null,
    reviewStage: null,
    usage: null,
    decisionRules: [],
    executionStatus: 'success',
    ...overrides,
  };
}

async function bodyOf(response: Response): Promise<unknown> {
  return JSON.parse(await response.text()) as unknown;
}

/** A page's rows, checked as a list instead of asserted. */
function rowsOf(page: unknown): readonly unknown[] {
  const rows = memberOf(page, 'rows');
  if (!Array.isArray(rows)) throw new TypeError('a page must carry rows');
  return rows;
}

function memberOf(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return null;
  return Object.hasOwn(value, key) ? Reflect.get(value, key) : null;
}

interface StartedHost {
  readonly home: string;
  readonly routes: ReadonlyMap<string, FetchRouteLike>;
}

/** Start the plugin routes on one seeded audit database. */
async function startHost(
  seed: (store: AuditStore) => Promise<void>,
): Promise<StartedHost> {
  const home = await mkdtemp(join(tmpdir(), 'arbiter-logs-route-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const seeded = new AuditStore(join(home, 'arbiter', 'arbiter.db'), {
    ...DEFAULT_CONFIG.audit,
    enabled: true,
  });
  await seed(seeded);
  seeded.close();
  const routes = new Map<string, FetchRouteLike>();
  const connection: ConnectionLike = {
    fetch: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  };
  const configured = {
    format: 'arbiter-config-v2',
    rules: [],
    audit: DEFAULT_CONFIG.audit,
  };
  const entry = { options: { id: 'arbiter', config: configured } };
  apply(
    stubContext({
      profileContext: { home, dir: join(home, 'logs'), name: 'logs' },
      sandboxPolicy: { defaultMode: 'workspace-write' },
      sessions: { get: () => undefined },
      approval: {
        config: { policy: 'ask' },
        request: () => Promise.resolve('unavailable'),
      },
      permissionPresets: { registerAuto: () => () => undefined },
      workingDirectory: { ensure: () => Promise.resolve(home) },
      connection,
      configEditor: {
        documentPath: join(home, 'cordis.patch.yml'),
        entries: () => [entry],
        edit: () => Promise.resolve(),
      },
    }),
    configured,
  );
  return { home, routes };
}

function logsRouteOf(
  routes: ReadonlyMap<string, FetchRouteLike>,
): FetchRouteLike {
  const route = routes.get('/api/arbiter/logs');
  if (route === undefined) throw new Error('the logs route was not registered');
  return route;
}

async function readPage(
  route: FetchRouteLike,
  query: string,
): Promise<unknown> {
  return bodyOf(
    await route.fetch(new Request(`http://fixture/api/arbiter/logs?${query}`)),
  );
}

describe('logs route paging contract', () => {
  test('reports the window it read, its cursors and the traversal head', async () => {
    const { routes } = await startHost(async (store) => {
      // Recent timestamps: the store applies its retention policy when the
      // plugin opens the database, and a 1970 row would be deleted before the
      // request under test ever ran.
      const base = Date.now();
      for (let index = 0; index < 40; index += 1) {
        store.enqueue(
          recordOf(`row-${String(index).padStart(2, '0')}`, {
            ts: base - index * 1_000,
          }),
        );
      }
      await store.flush();
    });
    const route = logsRouteOf(routes);
    const first = await readPage(route, 'limit=15');
    expect(first).toMatchObject({ ok: true, total: 40, limit: 15 });
    expect(memberOf(first, 'anchor')).not.toBeNull();
    const cursor = memberOf(first, 'nextCursor');
    expect(cursor).not.toBeNull();
    // The second page continues after the first page's last row, not from a
    // row count, so it is exactly the following window.
    const second = await readPage(
      route,
      `limit=15&afterTs=${String(memberOf(cursor, 'ts'))}&afterCallId=${String(memberOf(cursor, 'callId'))}`,
    );
    expect(second).toMatchObject({ ok: true, total: 40, limit: 15 });
    expect(memberOf(second, 'anchor')).toEqual(memberOf(first, 'anchor'));
    const firstRows = rowsOf(first);
    const secondRows = rowsOf(second);
    expect(firstRows).toHaveLength(15);
    expect(secondRows).toHaveLength(15);
    expect(secondRows[0]).not.toEqual(firstRows[0]);
    // Reading backwards from the second page returns the first page's rows.
    const back = memberOf(second, 'prevCursor');
    const previous = await readPage(
      route,
      `limit=15&beforeTs=${String(memberOf(back, 'ts'))}&beforeCallId=${String(memberOf(back, 'callId'))}`,
    );
    expect(rowsOf(previous).map((row) => memberOf(row, 'callId'))).toEqual(
      firstRows.map((row) => memberOf(row, 'callId')),
    );
  });

  test('clamps unusable numeric parameters instead of failing the read', async () => {
    const { routes } = await startHost(async (store) => {
      store.enqueue(recordOf('only', { ts: Date.now() }));
      await store.flush();
    });
    const route = logsRouteOf(routes);
    expect(await readPage(route, 'limit=abc')).toMatchObject({
      ok: true,
      limit: 25,
      total: 1,
    });
    expect(await readPage(route, 'limit=0')).toMatchObject({
      ok: true,
      limit: 1,
    });
    expect(await readPage(route, 'limit=100000')).toMatchObject({
      ok: true,
      limit: 200,
    });
    // A half cursor is not a position: it starts a traversal rather than moving
    // the reader into an unbounded window.
    const half = await readPage(route, 'afterTs=12345');
    expect(half).toMatchObject({ ok: true, total: 1 });
    expect(rowsOf(half)).toHaveLength(1);
  });

  test('a tail request returns the oldest page for last-page recovery', async () => {
    const { routes } = await startHost(async (store) => {
      const base = Date.now();
      for (let index = 0; index < 12; index += 1) {
        store.enqueue(
          recordOf(`row-${String(index).padStart(2, '0')}`, {
            ts: base - index * 1_000,
          }),
        );
      }
      await store.flush();
    });
    const page = await readPage(logsRouteOf(routes), 'limit=5&tail=1');
    expect(page).toMatchObject({ ok: true, total: 12 });
    expect(rowsOf(page)).toHaveLength(2);
    expect(memberOf(rowsOf(page)[0], 'callId')).toBe('row-10');
  });

  test('passes the confirmed filters through and omits the rest', async () => {
    const { routes } = await startHost(async (store) => {
      store.enqueue(
        recordOf('denied', {
          result: 'review-deny',
          tool: 'write',
          sessionId: 'session-2',
          sessionKind: 'subagent',
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
      store.enqueue(recordOf('allowed', { result: 'review-allow' }));
      await store.flush();
    });
    const route = logsRouteOf(routes);
    expect(await readPage(route, 'denied=1')).toMatchObject({ total: 1 });
    expect(await readPage(route, 'tool=write')).toMatchObject({ total: 1 });
    expect(await readPage(route, 'session=session-2')).toMatchObject({
      total: 1,
    });
    expect(await readPage(route, 'sessionKind=subagent')).toMatchObject({
      total: 1,
    });
    expect(await readPage(route, 'rule=R7')).toMatchObject({ total: 1 });
    expect(await readPage(route, 'q=denied')).toMatchObject({ total: 1 });
    expect(await readPage(route, 'reviewFailure=1')).toMatchObject({
      total: 0,
    });
  });

  test('counts records newer than the traversal anchor', async () => {
    const { home, routes } = await startHost(async (store) => {
      store.enqueue(recordOf('one', { ts: Date.now() - 60_000 }));
      await store.flush();
    });
    const route = logsRouteOf(routes);
    const first = await readPage(route, 'limit=10');
    const anchor = memberOf(first, 'anchor');
    // A call arrives after the reader started: it is counted, not inserted into
    // the traversal.
    const writer = new AuditStore(join(home, 'arbiter', 'arbiter.db'), {
      ...DEFAULT_CONFIG.audit,
      enabled: true,
    });
    writer.enqueue(recordOf('two', { ts: Date.now() }));
    await writer.flush();
    writer.close();
    const reread = await readPage(
      route,
      `limit=10&anchorTs=${String(memberOf(anchor, 'ts'))}&anchorCallId=${String(memberOf(anchor, 'callId'))}`,
    );
    expect(reread).toMatchObject({ total: 1, newer: 1 });
    expect(await readPage(route, 'limit=10')).toMatchObject({
      total: 2,
      newer: 0,
    });
  });
});

describe('logs route failure states', () => {
  test('an unreadable database is a failure, not an empty history', async () => {
    const { home, routes } = await startHost(async (store) => {
      store.enqueue(recordOf('kept'));
      await store.flush();
    });
    // Break the structure the route reads, after the store opened.
    const db = new DatabaseSync(join(home, 'arbiter', 'arbiter.db'));
    db.exec('DROP TABLE calls');
    db.close();
    const route = logsRouteOf(routes);
    const response = await route.fetch(
      new Request('http://fixture/api/arbiter/logs?limit=10'),
    );
    // The reported status and code must be distinguishable from an empty page:
    // an operator cannot act on "no records" if the read actually failed.
    expect(response.status).toBe(503);
    const body = await bodyOf(response);
    expect(memberOf(body, 'ok')).toBe(false);
    expect(memberOf(body, 'code')).toBe('audit-unavailable');
    expect(memberOf(body, 'rows')).toEqual([]);
    expect(memberOf(body, 'total')).toBe(0);
  });

  test('a successful empty search is a normal empty page', async () => {
    const { routes } = await startHost(async (store) => {
      store.enqueue(recordOf('kept'));
      await store.flush();
    });
    const body = await readPage(logsRouteOf(routes), 'q=no-such-text');
    expect(body).toMatchObject({ ok: true, total: 0, rows: [] });
    expect(memberOf(body, 'code')).toBeNull();
    expect(memberOf(body, 'anchor')).toBeNull();
  });
});
