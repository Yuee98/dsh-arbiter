import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
 * First-release scope: offline rule suggestions are deferred.
 *
 * What is pinned here:
 *   - no public route starts analysis or accepts/rejects a candidate, so the
 *     attempted operation has no handler and cannot reach the config editor;
 *   - the effective rules stay exactly as configured;
 *   - first-release operations (state, rule test, validation, logs) keep
 *     working, and previously stored audit rows are still returned.
 *
 * The fixture registers the production routes on a stub connection and issues
 * real `Request` objects, so this asserts the host boundary rather than a
 * client rendering detail.
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

function recordOf(callId: string, command: string): CallRecord {
  return {
    callId,
    ts: Date.now(),
    sessionId: 'session-1',
    sessionKind: 'main',
    parentSession: null,
    profile: 'scope',
    workspace: '/workspace/app',
    tool: 'bash',
    arguments: { command },
    cwd: '/workspace/app',
    fingerprint: fingerprintOf('bash', { command }),
    configRevision: 'rev-1',
    configSnapshotId: 'cfg-1',
    approvalMode: 'normal',
    executionMode: 'trusted',
    result: 'review-allow',
    reason: 'allowed by rule keep-me',
    trace: [],
    effect: null,
    sessionRecordState: 'written',
    snapshot: null,
    modelAttempts: [],
    signals: null,
    policyStrategy: null,
    decisionRules: [],
    executionStatus: 'success',
  };
}

interface StartedHost {
  readonly routes: ReadonlyMap<string, FetchRouteLike>;
  readonly edits: readonly string[];
}

const EXISTING_RULE = {
  id: 'keep-me',
  conditions: [
    { target: 'command', kind: 'regex', pattern: 'gh pr view(?: .*)?' },
  ],
  verdict: 'allow',
};

async function startHost(): Promise<StartedHost> {
  const home = await mkdtemp(join(tmpdir(), 'arbiter-scope-routes-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));

  // Pre-existing audit rows must survive the scope change untouched.
  const seeded = new AuditStore(join(home, 'arbiter', 'arbiter.db'), {
    ...DEFAULT_CONFIG.audit,
    enabled: true,
  });
  seeded.enqueue(recordOf('existing-call', 'gh pr view 42'));
  await seeded.flush();
  seeded.close();

  const routes = new Map<string, FetchRouteLike>();
  const edits: string[] = [];
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
    rules: [EXISTING_RULE],
    audit: DEFAULT_CONFIG.audit,
  };
  const entry = { options: { id: 'arbiter', config: configured } };
  apply(
    stubContext({
      profileContext: { home, dir: join(home, 'scope'), name: 'scope' },
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
        edit: () => {
          edits.push('edit');
          return Promise.resolve();
        },
      },
    }),
    configured,
  );
  return { routes, edits };
}

/** Read a response body as untrusted JSON instead of the `any` from `.json()`. */
async function bodyOf(response: Response): Promise<unknown> {
  return JSON.parse(await response.text()) as unknown;
}

function memberOf(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return null;
  return Object.hasOwn(value, key) ? Reflect.get(value, key) : null;
}

function rulesOf(value: unknown): unknown {
  return memberOf(memberOf(value, 'config'), 'rules');
}

describe('first-release route scope', () => {
  test('registers first-release routes and no suggestion action routes', async () => {
    const { routes } = await startHost();
    expect([...routes.keys()]).toEqual(
      expect.arrayContaining([
        '/api/arbiter/state',
        '/api/arbiter/config/save',
        '/api/arbiter/validate',
        '/api/arbiter/credentials',
        '/api/arbiter/test',
        '/api/arbiter/logs',
        '/api/arbiter/log',
      ]),
    );
    for (const path of [
      '/api/arbiter/analyze',
      '/api/arbiter/suggestions',
      '/api/arbiter/suggestions/act',
      '/api/arbiter/replay',
    ]) {
      expect(routes.has(path)).toBe(false);
    }
    // The rule log clear operation is a first-release log feature and stays.
    expect(routes.has('/api/arbiter/clear')).toBe(true);
  });

  test('an attempted candidate acceptance is unroutable and leaves rules untouched', async () => {
    const { routes, edits } = await startHost();
    const state = routes.get('/api/arbiter/state');
    if (state === undefined) throw new Error('state route was not registered');
    const before = await bodyOf(
      await state.fetch(new Request('http://fixture/api/arbiter/state')),
    );
    expect(rulesOf(before)).toEqual([EXISTING_RULE]);

    // Neither analysis nor acceptance has a handler, and no request reaches it.
    expect(routes.get('/api/arbiter/analyze')).toBeUndefined();
    expect(routes.get('/api/arbiter/suggestions/act')).toBeUndefined();
    expect(edits).toEqual([]);

    const after = await bodyOf(
      await state.fetch(new Request('http://fixture/api/arbiter/state')),
    );
    expect(rulesOf(after)).toEqual([EXISTING_RULE]);
  });

  test('keeps rule testing, validation and existing audit rows working', async () => {
    const { routes } = await startHost();
    const testRoute = routes.get('/api/arbiter/test');
    const validateRoute = routes.get('/api/arbiter/validate');
    const logsRoute = routes.get('/api/arbiter/logs');
    if (
      testRoute === undefined ||
      validateRoute === undefined ||
      logsRoute === undefined
    ) {
      throw new Error('first-release routes were not registered');
    }

    const tested = await bodyOf(
      await testRoute.fetch(
        new Request('http://fixture/api/arbiter/test', {
          method: 'POST',
          body: JSON.stringify({ inputs: ['gh pr view 42'] }),
        }),
      ),
    );
    expect(tested).toMatchObject({ ok: true });
    expect(JSON.stringify(tested)).toContain('keep-me');

    const validated = await bodyOf(
      await validateRoute.fetch(
        new Request('http://fixture/api/arbiter/validate', {
          method: 'POST',
          body: JSON.stringify({ config: {} }),
        }),
      ),
    );
    expect(validated).toMatchObject({ ok: true, errors: [] });

    const logs = await bodyOf(
      await logsRoute.fetch(
        new Request('http://fixture/api/arbiter/logs?limit=10'),
      ),
    );
    expect(logs).toMatchObject({ ok: true, total: 1 });
    expect(JSON.stringify(logs)).toContain('existing-call');
  });
});
