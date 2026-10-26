import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';

import { apply } from '../../src/index.js';
import { appendRecord } from '../../src/records.js';
import { applyConfig } from '../../src/host/runtime.js';
import { parseDocument } from '../../src/config.js';
import { OFFICIAL_AUTO_REVIEW_MODULE } from '../../src/host/coexistence-detect.js';
import { installSessionRecordApi } from '../../src/records.js';
import type {
  ConnectionLike,
  ContextLike,
  FetchRouteLike,
  HostServices,
  ToolExecutionLike,
} from '../../src/host/types.js';
import type { SessionEventLike } from '../../src/snapshot.js';
import { recordingSessionApi } from '../helpers/session-records.js';

/**
 * Approval-provider coexistence through the real plugin entry point.
 *
 * The cases are the contract, not the helper: a blocked takeover writes nothing
 * and grants nothing, a running conflict keeps deciding and keeps its gate, and
 * another plugin's listener or a host guard is never attributed to Arbiter.
 */

const homes: string[] = [];
let previousHome: string | undefined;

beforeAll(() => {
  installSessionRecordApi(recordingSessionApi());
});

afterAll(() => {
  installSessionRecordApi(null);
});

beforeEach(async () => {
  previousHome = process.env['DSH_HOME'];
  const home = await mkdtemp(join(tmpdir(), 'arbiter-coexistence-'));
  homes.push(home);
  process.env['DSH_HOME'] = home;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env['DSH_HOME'];
  else process.env['DSH_HOME'] = previousHome;
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
});

interface StubSession {
  readonly id: string;
  readonly header: { readonly id: string; readonly cwd: string };
  readonly events: SessionEventLike[];
  readonly append: (type: string, data: unknown) => void;
  readonly snapshotEvents: () => readonly SessionEventLike[];
}

function makeSession(id: string): StubSession {
  const events: SessionEventLike[] = [
    { type: 'sandbox/mode', seq: 0, data: { mode: 'workspace-write' } },
    { type: 'approval/policy', seq: 1, data: { policy: 'ask' } },
  ];
  return {
    id,
    header: { id, cwd: process.cwd() },
    events,
    append(type, data) {
      events.push({
        type,
        seq: events.length,
        data,
        ignorable: type.startsWith('plugin:'),
      });
    },
    snapshotEvents: () => events,
  };
}

interface StubOfficial {
  /** Remove the official entry entirely, as an uninstalled plugin would be. */
  remove(): void;
  /** Keep the entry but mark its fiber failed, as a refused load would. */
  fail(): void;
  /** Load and activate the official entry. */
  activate(): void;
}

interface Harness {
  readonly official: StubOfficial;
  readonly request: (
    path: string,
    init?: { readonly method?: string; readonly body?: unknown },
  ) => Promise<{
    readonly status: number;
    readonly body: Record<string, unknown>;
  }>;
  readonly gate: (
    exec: ToolExecutionLike,
    next: () => Promise<{ kind: string; reason?: string }>,
  ) => Promise<{ kind: string; reason?: string }>;
  readonly dispose: () => void;
  /** Make one more session live, as reopening a stored session does. */
  readonly addSession: (session: StubSession) => void;
  /** Activate a new configuration through the production activation path. */
  readonly reconfigure: (config: unknown) => void;
  /** Add a foreign approval-capable pre-execute listener to the load-time view. */
  readonly addForeignListener: (moduleName: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const ALLOW_ECHO = {
  rules: [
    {
      id: 'allow-echo',
      match: {
        node: 'command' as const,
        kind: 'exact' as const,
        pattern: 'echo hi',
      },
      verdict: 'allow' as const,
    },
  ],
};

type Listener = (...args: never[]) => unknown;

function createHarness(
  initialSessions: readonly StubSession[],
  config: unknown,
  options: { readonly autoSlotTaken?: boolean } = {},
): Harness {
  // A live list, so a case can restore a session after the plugin started —
  // the path a refused resume has to keep refusing.
  const sessions = [...initialSessions];
  const routes = new Map<string, FetchRouteLike>();
  const disposers: (() => unknown)[] = [];
  let gate:
    | ((
        exec: ToolExecutionLike,
        next: () => Promise<{ kind: string }>,
      ) => Promise<{ kind: string; reason?: string }>)
    | undefined;
  const home = process.env['DSH_HOME'] ?? '';
  const foreign: { moduleName: string }[] = [];
  const selfFiber = { name: 'arbiter', state: 2 };
  let officialPhase: 'active' | 'failed' | null = null;

  const officialEntries = (): readonly unknown[] =>
    officialPhase === null
      ? []
      : [
          {
            id: 'auto-review',
            options: { name: OFFICIAL_AUTO_REVIEW_MODULE },
            fiber: { state: officialPhase === 'active' ? 2 : 3 },
          },
        ];
  const loader = {
    *entries(): Generator {
      yield* officialEntries();
    },
  };
  const events = {
    get _hooks(): unknown {
      return {
        'tools/pre-execute': [
          // This plugin's own gate: excluded by fiber identity.
          { ctx: { fiber: selfFiber }, callback: () => undefined },
          ...foreign.map((item) => ({
            ctx: {
              fiber: {
                state: 2,
                inject: { approval: true },
                entry: {
                  id: item.moduleName,
                  options: { name: item.moduleName },
                },
              },
            },
            callback: () => undefined,
          })),
        ],
      };
    },
  };

  function get(key: 'profileContext'): {
    readonly home: string;
    readonly dir: string;
    readonly name: string;
  };
  function get(key: 'sandboxPolicy'): { readonly defaultMode?: string };
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
    if (key === 'loader') return loader;
    if (key === 'profileContext') return { home, dir: home, name: 'coexist' };
    if (key === 'sandboxPolicy') return { defaultMode: 'workspace-write' };
    if (key === 'sessions') {
      return {
        get: (id: string) => sessions.find((session) => session.id === id),
        list: () => [...sessions],
      };
    }
    if (key === 'approval') {
      return {
        config: { policy: 'ask' },
        request: () => Promise.resolve('unavailable'),
      };
    }
    if (key === 'permissionPresets') {
      return {
        registerAuto: () => {
          // The host throws when another integration already owns the slot.
          if (options.autoSlotTaken === true)
            throw new Error('permission: preset "auto" is already registered');
          return () => undefined;
        },
      };
    }
    if (key === 'workingDirectory') {
      return { ensure: () => Promise.resolve(process.cwd()) };
    }
    if (key === 'connection') return connection;
    return undefined;
  }

  const connection: ConnectionLike = {
    fetch: {
      register: (route) => {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  };
  const ctx: ContextLike = {
    get,
    events,
    fiber: selfFiber,
    on(event: string, handler: Listener) {
      if (event === 'tools/pre-execute') {
        gate = async (exec, next) => {
          const decision: unknown = await Reflect.apply(handler, undefined, [
            exec,
            next,
          ]);
          if (!isRecord(decision) || typeof decision['kind'] !== 'string')
            throw new TypeError('gate returned an invalid decision');
          return { ...decision, kind: decision['kind'] };
        };
      }
      return () => undefined;
    },
    effect(fn) {
      const dispose: unknown = fn();
      if (typeof dispose === 'function')
        disposers.push(() => Reflect.apply(dispose, undefined, []));
    },
    inject(_services, callback) {
      return callback(ctx);
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };

  // The permission lifecycle proves the Auto slot through the registration it
  // ran, so this harness needs no second source for it.
  const host = apply(ctx, config);
  return {
    official: {
      remove: () => {
        officialPhase = null;
      },
      fail: () => {
        officialPhase = 'failed';
      },
      activate: () => {
        officialPhase = 'active';
      },
    },
    addForeignListener: (moduleName) => {
      foreign.push({ moduleName });
    },
    request: async (path, init = {}) => {
      const route = routes.get(path.split('?')[0] ?? path);
      if (route === undefined)
        throw new Error(`route ${path} is not registered`);
      const response = await route.fetch(
        new Request(`http://localhost${path}`, {
          method: init.method ?? 'GET',
          ...(init.body === undefined
            ? {}
            : { body: JSON.stringify(init.body) }),
        }),
      );
      const payload: unknown = await response.json();
      if (!isRecord(payload)) throw new TypeError('response must be an object');
      return { status: response.status, body: payload };
    },
    gate: (exec, next) => {
      if (gate === undefined) throw new Error('gate was not registered');
      return gate(exec, next);
    },
    dispose: () => {
      for (const dispose of disposers) dispose();
    },
    addSession: (session) => {
      sessions.push(session);
    },
    reconfigure: (next) => {
      // Same path a UI save or file reload takes: parse, commit, notify.
      const parsed = parseDocument(next);
      if (parsed.errors.length > 0) throw new Error('invalid test config');
      applyConfig(host, parsed.config, 'ui');
    },
  };
}

const allow = (): Promise<{ kind: string }> =>
  Promise.resolve({ kind: 'allow' });

function call(session: StubSession, callId = 'call-1'): ToolExecutionLike {
  return {
    callId,
    name: 'bash',
    arguments: { command: 'echo hi' },
    signal: new AbortController().signal,
    agent: { session },
  };
}

function admissions(session: StubSession): readonly Record<string, unknown>[] {
  return session.events
    .filter((event) => event.type === 'plugin:arbiter/admission')
    .map((event) => (isRecord(event.data) ? event.data : {}));
}

function decisions(session: StubSession): readonly Record<string, unknown>[] {
  return session.events
    .filter((event) => event.type === 'plugin:arbiter/decision')
    .map((event) => (isRecord(event.data) ? event.data : {}));
}

function modeEvents(session: StubSession): readonly unknown[] {
  return session.events
    .filter((event) => event.type === 'sandbox/mode')
    .map((event) => event.data);
}

function approvalEvents(session: StubSession): readonly unknown[] {
  return session.events
    .filter((event) => event.type === 'approval/policy')
    .map((event) => event.data);
}

/** The decoded notice objects of one coexistence view, without assertions. */
function noticesOf(
  view: Record<string, unknown>,
): readonly Record<string, unknown>[] {
  const value = view['notices'];
  if (!Array.isArray(value)) throw new TypeError('notices is not an array');
  const items: readonly unknown[] = value;
  return items.map((item) => {
    if (!isRecord(item)) throw new TypeError('notice is not an object');
    return item;
  });
}

function coexistenceOf(body: Record<string, unknown>): Record<string, unknown> {
  const value = body['coexistence'];
  if (!isRecord(value)) throw new TypeError('no coexistence view in the body');
  return value;
}

async function enable(harness: Harness, sessionId: string) {
  return harness.request('/api/arbiter/sessions', {
    method: 'POST',
    body: { sessionId, action: 'enable' },
  });
}

describe('blocked takeover before any write', () => {
  test('the official plugin running refuses enable and grants nothing', async () => {
    const session = makeSession('s-blocked');
    const harness = createHarness([session], ALLOW_ECHO);
    try {
      harness.official.activate();
      const refused = await enable(harness, 's-blocked');
      expect(refused.status).toBe(409);
      expect(refused.body['code']).toBe('coexistence-blocked');
      const detail = refused.body['detail'];
      expect(isRecord(detail)).toBe(true);
      expect(detail).toMatchObject({
        reason: 'official-running',
        source: OFFICIAL_AUTO_REVIEW_MODULE,
        guidance: 'disable-official-auto-review',
      });
      // No admission record and no permission change: nothing was taken over.
      expect(admissions(session)).toEqual([]);
      expect(modeEvents(session)).toEqual([{ mode: 'workspace-write' }]);
      // The session stays unmanaged, so the gate hands the call back untouched.
      expect(await harness.gate(call(session), allow)).toEqual({
        kind: 'allow',
      });
      expect(decisions(session)).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  test('an installed but not running official plugin does not block', async () => {
    const session = makeSession('s-installed');
    const harness = createHarness([session], ALLOW_ECHO);
    try {
      harness.official.fail();
      const enabled = await enable(harness, 's-installed');
      expect(enabled.status).toBe(200);
      expect(admissions(session).at(-1)?.['enabled']).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  test('another approval listener only warns and the takeover proceeds', async () => {
    const session = makeSession('s-warn');
    const harness = createHarness([session], ALLOW_ECHO);
    try {
      harness.addForeignListener('third-party-reviewer');
      const enabled = await enable(harness, 's-warn');
      expect(enabled.status).toBe(200);
      const state = await harness.request('/api/arbiter/state');
      const coexistence = coexistenceOf(state.body);
      expect(coexistence['blocked']).toBe(false);
      const conflicts = coexistence['conflicts'];
      expect(Array.isArray(conflicts)).toBe(true);
      expect(conflicts).toMatchObject([
        {
          kind: 'approval-hook',
          severity: 'warning',
          source: 'third-party-reviewer',
        },
      ]);
      // Arbiter keeps deciding under its own mode.
      expect((await harness.gate(call(session), allow)).kind).toBe('allow');
      expect(decisions(session).at(-1)?.['result']).toBe('allow');
    } finally {
      harness.dispose();
    }
  });
});

describe('running conflict keeps the gate', () => {
  test('a conflict appearing after enable does not withdraw admission or widen anything', async () => {
    // A second, never-enabled session is the "new takeover" the conflict must
    // refuse; it exists from the start so the runtime can resolve it.
    const fresh = makeSession('s-fresh');
    const session = makeSession('s-running');
    const harness = createHarness([session, fresh], ALLOW_ECHO);
    try {
      const enabled = await enable(harness, 's-running');
      expect(enabled.status).toBe(200);
      const policyBefore = session.events.filter(
        (event) => event.type === 'approval/policy',
      ).length;
      harness.official.activate();
      // The existing session keeps deciding: no force-ask, no allow-everything.
      expect((await harness.gate(call(session, 'mid'), allow)).kind).toBe(
        'allow',
      );
      expect(decisions(session).at(-1)).toMatchObject({
        callId: 'mid',
        result: 'allow',
      });
      expect(admissions(session).at(-1)?.['enabled']).toBe(true);
      // The mode and the permission are untouched by detection.
      expect(
        session.events.filter((event) => event.type === 'approval/policy'),
      ).toHaveLength(policyBefore);
      expect(modeEvents(session)).toEqual([{ mode: 'workspace-write' }]);
      // Re-confirming a session this plugin already gates is not a new
      // takeover: the selector may call enable idempotently, so it keeps
      // working. A session that is not yet managed is the blocked entry point.
      expect((await enable(harness, 's-running')).status).toBe(200);
      expect(admissions(session).at(-1)?.['enabled']).toBe(true);

      expect((await enable(harness, 's-fresh')).status).toBe(409);
      expect(admissions(fresh)).toEqual([]);
      expect(modeEvents(fresh)).toEqual([{ mode: 'workspace-write' }]);
    } finally {
      harness.dispose();
    }
  });

  test('an existing deny rule still denies while a conflict is present', async () => {
    const session = makeSession('s-deny');
    const denyConfig = {
      rules: [
        {
          id: 'deny-echo',
          match: {
            node: 'command' as const,
            kind: 'exact' as const,
            pattern: 'echo hi',
          },
          verdict: 'deny' as const,
        },
      ],
    };
    const harness = createHarness([session], denyConfig);
    try {
      expect((await enable(harness, 's-deny')).status).toBe(200);
      harness.official.activate();
      const decision = await harness.gate(call(session, 'denied'), allow);
      expect(decision.kind).toBe('deny');
      expect(decisions(session).at(-1)?.['result']).toBe('deny');
      // The gate is intact, and the conflict never turns a rule denial into a
      // review failure.
      expect(
        decisions(session).some((item) => item['result'] === 'error-escalate'),
      ).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  test('a host guard denial after an Arbiter allow is not recorded as Arbiter verdict', async () => {
    const session = makeSession('s-guard');
    const harness = createHarness([session], ALLOW_ECHO);
    try {
      harness.addForeignListener('host-guard');
      expect((await enable(harness, 's-guard')).status).toBe(200);
      const decision = await harness.gate(call(session, 'guarded-call'), () =>
        Promise.resolve({
          kind: 'deny',
          reason: 'host guard: path outside the workspace',
        }),
      );
      // Arbiter's own listener allowed; the monotonic host guard decided
      // afterwards and this plugin never saw or claimed that outcome.
      expect(decision.kind).toBe('allow');
      const records = decisions(session);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        callId: 'guarded-call',
        result: 'allow',
      });
      expect(
        records.some(
          (record) =>
            record['result'] === 'deny' ||
            record['result'] === 'error-escalate',
        ),
      ).toBe(false);
    } finally {
      harness.dispose();
    }
  });
});

describe('conflict state and reminders', () => {
  test('state reports the official conflict and one reminder; acknowledging keeps it', async () => {
    const session = makeSession('s-view');
    const harness = createHarness([session], ALLOW_ECHO);
    try {
      harness.official.activate();
      const first = coexistenceOf(
        (await harness.request('/api/arbiter/state')).body,
      );
      expect(first).toMatchObject({
        detection: 'complete',
        blocked: true,
        reason: 'official-running',
        autoSlot: 'arbiter',
      });
      const notices = noticesOf(first);
      const notice = notices[0];
      if (notice === undefined) throw new TypeError('missing notice');
      expect(notice).toMatchObject({
        conflictId: 'official-auto-review',
        severity: 'blocking',
        acknowledged: false,
      });
      // A second state read does not add a reminder for the same period.
      const second = coexistenceOf(
        (await harness.request('/api/arbiter/state')).body,
      );
      expect(noticesOf(second)).toHaveLength(1);

      const acknowledged = await harness.request('/api/arbiter/coexistence', {
        method: 'POST',
        body: { noticeIds: [notice['id']] },
      });
      expect(acknowledged.status).toBe(200);
      const view = coexistenceOf(acknowledged.body);
      expect(noticesOf(view)[0]).toMatchObject({ acknowledged: true });
      // Read, not resolved.
      expect(view['blocked']).toBe(true);
      expect(view['conflicts']).toHaveLength(1);
    } finally {
      harness.dispose();
    }
  });

  test('a cleared conflict drops the block on the next read', async () => {
    const session = makeSession('s-cleared');
    const harness = createHarness([session], ALLOW_ECHO);
    try {
      harness.official.activate();
      expect(
        coexistenceOf((await harness.request('/api/arbiter/state')).body)[
          'blocked'
        ],
      ).toBe(true);
      harness.official.remove();
      const cleared = coexistenceOf(
        (await harness.request('/api/arbiter/state')).body,
      );
      expect(cleared['blocked']).toBe(false);
      expect(cleared['conflicts']).toEqual([]);
      expect((await enable(harness, 's-cleared')).status).toBe(200);
    } finally {
      harness.dispose();
    }
  });

  test('a missing host surface is reported as partial, not as no conflict', async () => {
    const session = makeSession('s-partial');
    const harness = createHarness([session], ALLOW_ECHO);
    try {
      const state = coexistenceOf(
        (await harness.request('/api/arbiter/state')).body,
      );
      // This harness exposes both surfaces, so the answer is complete here.
      expect(state['detection']).toBe('complete');
      expect(state['missing']).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  test('the coexistence route rejects a malformed acknowledgement', async () => {
    const session = makeSession('s-bad-ack');
    const harness = createHarness([session], ALLOW_ECHO);
    try {
      const missing = await harness.request('/api/arbiter/coexistence', {
        method: 'POST',
        body: { noticeIds: 'nope' },
      });
      expect(missing.status).toBe(400);
      expect(missing.body['code']).toBe('invalid-notice-ids');
    } finally {
      harness.dispose();
    }
  });
});

describe('resuming a retained admission under a running conflict', () => {
  test('turning the master switch back on does not resume coverage', async () => {
    const session = makeSession('s-resume');
    // A retained admission is still in the log from a previous runtime.
    appendRecord(session, 'plugin:arbiter/admission', {
      version: 1,
      sessionId: 's-resume',
      rootSessionId: 's-resume',
      enabled: true,
      boundary: 'trusted',
      at: Date.now(),
    });
    session.append('sandbox/mode', { mode: 'danger-full-access' });
    const harness = createHarness([session], { ...ALLOW_ECHO, enabled: false });
    try {
      harness.official.activate();
      // Re-enabling the plugin reconciles retained admissions. Starting
      // coverage again is a takeover, so under a running conflict it must not
      // begin: no gate decision, no widening, and the retained record is
      // closed as disabled.
      harness.reconfigure({
        ...ALLOW_ECHO,
        enabled: true,
        boundary: 'trusted',
      });
      expect(modeEvents(session).at(-1)).toEqual({ mode: 'workspace-write' });
      expect(admissions(session).at(-1)?.['enabled']).toBe(false);
      expect((await harness.gate(call(session), allow)).kind).toBe('allow');
      expect(decisions(session)).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  test('with no conflict the configured trusted boundary is applied as before', async () => {
    const session = makeSession('s-trusted-resume');
    appendRecord(session, 'plugin:arbiter/admission', {
      version: 1,
      sessionId: 's-trusted-resume',
      rootSessionId: 's-trusted-resume',
      enabled: true,
      boundary: 'guarded',
      at: Date.now(),
    });
    const harness = createHarness([session], {
      ...ALLOW_ECHO,
      boundary: 'trusted',
    });
    try {
      expect((await harness.gate(call(session), allow)).kind).toBe('allow');
      expect(modeEvents(session).at(-1)).toEqual({
        mode: 'danger-full-access',
      });
    } finally {
      harness.dispose();
    }
  });
});

describe('cold restore under a running conflict', () => {
  test('a lazy boundary re-apply never widens while the official plugin runs', async () => {
    const session = makeSession('s-cold');
    appendRecord(session, 'plugin:arbiter/admission', {
      version: 1,
      sessionId: 's-cold',
      rootSessionId: 's-cold',
      enabled: true,
      // The record says trusted, so a cold sync would widen without the veto.
      boundary: 'trusted',
      at: Date.now(),
    });
    const harness = createHarness([session], {
      ...ALLOW_ECHO,
      boundary: 'trusted',
    });
    try {
      harness.official.activate();
      // The first call after a reload is where the boundary is re-applied.
      expect((await harness.gate(call(session), allow)).kind).toBe('allow');
      expect(modeEvents(session).at(-1)).toEqual({ mode: 'workspace-write' });
      expect(decisions(session)).toHaveLength(1);
    } finally {
      harness.dispose();
    }
  });
});

describe('Auto-slot capability after a cleared conflict', () => {
  test('a failed registration stays reported even with no official conflict', async () => {
    const session = makeSession('s-slot');
    const harness = createHarness([session], ALLOW_ECHO, {
      autoSlotTaken: true,
    });
    try {
      const view = coexistenceOf(
        (await harness.request('/api/arbiter/state')).body,
      );
      expect(view['blocked']).toBe(false);
      expect(view['autoSlot']).toBe('other');
      expect(view['autoSlotProblem']).toMatchObject({
        kind: 'registration-failed',
        recovery: 'reload-plugin',
      });
      // The capability problem is not a takeover block: the session still works.
      expect((await enable(harness, 's-slot')).status).toBe(200);
    } finally {
      harness.dispose();
    }
  });
});

describe('recovery after the conflict clears', () => {
  test('the same session takes over again once the official plugin stops', async () => {
    const session = makeSession('s-recover');
    const harness = createHarness([session], ALLOW_ECHO);
    try {
      harness.official.activate();
      expect((await enable(harness, 's-recover')).status).toBe(409);
      expect(admissions(session)).toEqual([]);
      harness.official.remove();
      const enabled = await enable(harness, 's-recover');
      expect(enabled.status).toBe(200);
      expect(admissions(session).at(-1)?.['enabled']).toBe(true);
      // The status read confirms the clearing without a restart.
      const view = coexistenceOf(
        (await harness.request('/api/arbiter/state')).body,
      );
      expect(view).toMatchObject({ blocked: false, conflicts: [] });
    } finally {
      harness.dispose();
    }
  });
});

describe('a withheld widening stays withheld', () => {
  test('the lazy boundary sync does not grant what enable() withheld', async () => {
    const session = makeSession('s-held');
    appendRecord(session, 'plugin:arbiter/admission', {
      version: 1,
      sessionId: 's-held',
      rootSessionId: 's-held',
      enabled: true,
      boundary: 'guarded',
      at: Date.now(),
    });
    session.append('sandbox/mode', { mode: 'workspace-write' });
    const harness = createHarness([session], {
      ...ALLOW_ECHO,
      boundary: 'trusted',
    });
    try {
      harness.official.activate();
      // Confirming an already-managed session under a conflict withholds the
      // widening, and the record must keep describing the host.
      expect((await enable(harness, 's-held')).status).toBe(200);
      expect(admissions(session).at(-1)).toMatchObject({
        enabled: true,
        boundary: 'guarded',
      });
      // The very next ordinary call is the lazy sync that would otherwise grant
      // it: no sandbox write may follow, and the call is still decided.
      expect((await harness.gate(call(session, 'held'), allow)).kind).toBe(
        'allow',
      );
      expect(modeEvents(session).at(-1)).toEqual({ mode: 'workspace-write' });
      expect(
        modeEvents(session).filter(
          (event) => isRecord(event) && event['mode'] === 'danger-full-access',
        ),
      ).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  test('the hold is released once the conflict clears', async () => {
    const session = makeSession('s-released');
    appendRecord(session, 'plugin:arbiter/admission', {
      version: 1,
      sessionId: 's-released',
      rootSessionId: 's-released',
      enabled: true,
      boundary: 'guarded',
      at: Date.now(),
    });
    session.append('sandbox/mode', { mode: 'workspace-write' });
    const harness = createHarness([session], {
      ...ALLOW_ECHO,
      boundary: 'trusted',
    });
    try {
      harness.official.activate();
      expect((await enable(harness, 's-released')).status).toBe(200);
      expect(modeEvents(session).at(-1)).toEqual({ mode: 'workspace-write' });
      harness.official.remove();
      // The next call applies the configured boundary again; withholding was
      // never a permanent decision.
      expect((await harness.gate(call(session, 'released'), allow)).kind).toBe(
        'allow',
      );
      expect(modeEvents(session).at(-1)).toEqual({
        mode: 'danger-full-access',
      });
    } finally {
      harness.dispose();
    }
  });

  test('a withheld widening still writes the approval policy it needed', async () => {
    const session = makeSession('s-policy');
    appendRecord(session, 'plugin:arbiter/admission', {
      version: 1,
      sessionId: 's-policy',
      rootSessionId: 's-policy',
      enabled: true,
      boundary: 'guarded',
      at: Date.now(),
    });
    session.append('sandbox/mode', { mode: 'workspace-write' });
    session.append('approval/policy', { policy: 'never' });
    const harness = createHarness([session], {
      ...ALLOW_ECHO,
      boundary: 'trusted',
    });
    try {
      harness.official.activate();
      expect((await enable(harness, 's-policy')).status).toBe(200);
      // The sandbox widening is withheld, the approval policy is not: the
      // record still says guarded, which is what the host actually has.
      expect(approvalEvents(session).at(-1)).toEqual({ policy: 'ask' });
      const boundaries = admissions(session).map((item) => item['boundary']);
      expect(boundaries).not.toContain('trusted');
    } finally {
      harness.dispose();
    }
  });
});

describe('a refused resume covers sessions restored later', () => {
  test('a session reopened after the refusal is not gated', async () => {
    const session = makeSession('s-late-restore');
    appendRecord(session, 'plugin:arbiter/admission', {
      version: 1,
      sessionId: 's-late-restore',
      rootSessionId: 's-late-restore',
      enabled: true,
      boundary: 'trusted',
      at: Date.now(),
    });
    session.append('sandbox/mode', { mode: 'danger-full-access' });
    // The plugin starts disabled, so the session is not yet live in the list.
    const harness = createHarness([], { ...ALLOW_ECHO, enabled: false });
    try {
      harness.official.activate();
      harness.reconfigure({ ...ALLOW_ECHO, enabled: true });
      // Reopening the session after the refusal must not begin coverage.
      harness.addSession(session);
      expect((await harness.gate(call(session), allow)).kind).toBe('allow');
      expect(decisions(session)).toEqual([]);
      expect(modeEvents(session).at(-1)).toEqual({ mode: 'workspace-write' });
    } finally {
      harness.dispose();
    }
  });
});

describe('refusal never widens a stricter host choice', () => {
  test('a read-only session stays read-only when the resume is refused', () => {
    const session = makeSession('s-readonly');
    appendRecord(session, 'plugin:arbiter/admission', {
      version: 1,
      sessionId: 's-readonly',
      rootSessionId: 's-readonly',
      enabled: true,
      boundary: 'trusted',
      at: Date.now(),
    });
    session.append('sandbox/mode', { mode: 'read-only' });
    session.append('approval/policy', { policy: 'never' });
    const harness = createHarness([session], { ...ALLOW_ECHO, enabled: false });
    try {
      harness.official.activate();
      harness.reconfigure({ ...ALLOW_ECHO, enabled: true });
      // Neither knob may move after the fixture's own history: the refusal only
      // withdraws what this plugin granted, and a stricter host choice was never
      // its to change.
      expect(modeEvents(session).at(-1)).toEqual({ mode: 'read-only' });
      expect(approvalEvents(session).at(-1)).toEqual({ policy: 'never' });
      // Nothing was appended at all, so the initial values are still the latest.
      expect(modeEvents(session)).toEqual([
        { mode: 'workspace-write' },
        { mode: 'read-only' },
      ]);
      expect(approvalEvents(session)).toEqual([
        { policy: 'ask' },
        { policy: 'never' },
      ]);
    } finally {
      harness.dispose();
    }
  });
});
