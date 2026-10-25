import { writeFileSync } from 'node:fs';
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
import { installSessionRecordApi } from '../../src/records.js';
import type {
  ConnectionLike,
  ContextLike,
  FetchRouteLike,
  HostServices,
  ProfileContextLike,
  ToolExecutionLike,
} from '../../src/host/types.js';
import type { SessionEventLike } from '../../src/snapshot.js';
import { recordingSessionApi } from '../helpers/session-records.js';

/**
 * Session admission through the real plugin entry point.
 *
 * The API, the gate and teardown are exercised together because the product
 * contract is end-to-end: the backend confirms a session switch, the gate
 * honours only that confirmed state, and every write survives a cold read of
 * the session log without the audit database.
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
  const home = await mkdtemp(join(tmpdir(), 'arbiter-admission-'));
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
  readonly header: {
    readonly id: string;
    readonly cwd: string;
    readonly parentSession?: string;
    readonly origin?: string;
  };
  readonly events: SessionEventLike[];
  readonly append: (type: string, data: unknown) => void;
  readonly snapshotEvents: () => readonly SessionEventLike[];
}

function makeSession(
  id: string,
  options: { readonly parentSession?: string } = {},
): StubSession {
  const events: SessionEventLike[] = [];
  return {
    id,
    header: {
      id,
      cwd: process.cwd(),
      ...(options.parentSession === undefined
        ? {}
        : { parentSession: options.parentSession, origin: 'subagent' }),
    },
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

/** The session/event payload the host passes its observers. */
interface StubEventPayload {
  readonly type: string;
  readonly data: unknown;
}

type Gate = (
  exec: ToolExecutionLike,
  next: () => Promise<{ kind: string }>,
) => Promise<{ kind: string; reason?: string }>;

interface Harness {
  readonly routes: ReadonlyMap<string, FetchRouteLike>;
  readonly dispose: () => void;
  readonly gate: (
    exec: ToolExecutionLike,
    next: () => Promise<{ kind: string }>,
  ) => Promise<{ kind: string; reason?: string }>;
  /** Deliver one committed event to the plugin's observer, as the host does. */
  readonly emit: (session: StubSession, event: StubEventPayload) => void;
  readonly state: () => Promise<{
    readonly status: number;
    readonly body: Record<string, unknown>;
  }>;
  readonly request: (
    path: string,
    init?: { readonly method?: string; readonly body?: unknown },
  ) => Promise<{
    readonly status: number;
    readonly body: Record<string, unknown>;
  }>;
  /** Re-apply the plugin against the same live sessions (cold restore). */
  readonly reread: (config: unknown) => Harness;
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

const DENY_ECHO = {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface StubServices extends Partial<Omit<HostServices, 'presets'>> {
  readonly profileContext?: ProfileContextLike;
  readonly sandboxPolicy?: { readonly defaultMode?: string };
  readonly connection?: ConnectionLike;
  readonly permissionPresets?: HostServices['presets'];
}

function stubContext(
  members: Pick<ContextLike, 'on' | 'effect' | 'inject' | 'logger'>,
  services: StubServices,
): ContextLike {
  const registry: Readonly<Record<string, unknown>> = { ...services };
  function get(key: 'profileContext'): StubServices['profileContext'];
  function get(key: 'sandboxPolicy'): StubServices['sandboxPolicy'];
  function get(key: 'sessions'): StubServices['sessions'];
  function get(key: 'llm'): StubServices['llm'];
  function get(key: 'approval'): StubServices['approval'];
  function get(key: 'permissionPresets'): StubServices['permissionPresets'];
  function get(key: 'workingDirectory'): StubServices['workingDirectory'];
  function get(key: 'credentials'): StubServices['credentials'];
  function get(key: 'configEditor'): StubServices['configEditor'];
  function get(key: 'commands'): StubServices['commands'];
  function get(key: 'connection'): StubServices['connection'];
  function get(key: string): unknown;
  function get(key: string): unknown {
    return registry[key];
  }
  return { ...members, get };
}

function createHarness(
  sessions: readonly StubSession[],
  config: unknown,
  options: { readonly blockAudit?: boolean } = {},
): Harness {
  const routes = new Map<string, FetchRouteLike>();
  const disposers: (() => unknown)[] = [];
  let gate: Gate | undefined;
  let sessionEvent:
    ((session: StubSession, event: StubEventPayload) => void) | undefined;
  const home = process.env['DSH_HOME'] ?? '';

  if (options.blockAudit === true) {
    // A file where the audit directory belongs: SQLite cannot open it, and the
    // plugin must still restore admission from the session log alone.
    writeFileSync(join(home, 'arbiter'), 'not a directory');
  }

  type Listener = (...args: never[]) => unknown;
  const ctx = stubContext(
    {
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
        if (event === 'session/event') {
          sessionEvent = (session, payload) => {
            Reflect.apply(handler, undefined, [session, payload]);
          };
        }
        return () => undefined;
      },
      effect(fn) {
        const dispose: unknown = fn();
        if (typeof dispose === 'function')
          disposers.push(() => Reflect.apply(dispose, undefined, []));
      },
      // The plugin registers routes from an injected connection scope; the
      // stub has no service graph, so the callback receives the same context.
      inject(_services, callback) {
        return callback(ctx);
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    },
    {
      profileContext: { home, dir: home, name: 'admission-test' },
      sandboxPolicy: { defaultMode: 'workspace-write' },
      sessions: {
        get: (id) => sessions.find((session) => session.id === id),
        list: () => [...sessions],
      },
      approval: {
        config: { policy: 'ask' },
        request: () => Promise.resolve('unavailable'),
      },
      permissionPresets: { registerAuto: () => () => {} },
      workingDirectory: { ensure: () => Promise.resolve(process.cwd()) },
      connection: {
        fetch: {
          register: (route) => {
            routes.set(route.path, route);
            return () => routes.delete(route.path);
          },
        },
      },
    },
  );

  const request = async (
    path: string,
    init: { readonly method?: string; readonly body?: unknown } = {},
  ): Promise<{
    readonly status: number;
    readonly body: Record<string, unknown>;
  }> => {
    // Routes are registered without the query string; the request keeps it.
    const route = routes.get(path.split('?')[0] ?? path);
    if (route === undefined) throw new Error(`route ${path} is not registered`);
    const response = await route.fetch(
      new Request(`http://localhost${path}`, {
        method: init.method ?? 'GET',
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    );
    const payload: unknown = await response.json();
    if (!isRecord(payload)) throw new TypeError('response must be an object');
    return { status: response.status, body: payload };
  };

  const dispose = (): void => {
    for (const disposeEffect of disposers) disposeEffect();
  };

  apply(ctx, config);

  const harness: Harness = {
    routes,
    dispose,
    gate: (exec, next) => {
      if (gate === undefined) throw new Error('gate was not registered');
      return gate(exec, next);
    },
    emit: (session, payload) => {
      if (sessionEvent === undefined)
        throw new Error('session observer was not registered');
      sessionEvent(session, payload);
    },
    state: () => request('/api/arbiter/state'),
    request,
    reread: (nextConfig) => {
      dispose();
      return createHarness(sessions, nextConfig, options);
    },
  };
  return harness;
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

/** Let the plugin's deferred writes run, as a later host turn would. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function viewOf(body: Record<string, unknown>): Record<string, unknown> {
  const admission = body['admission'];
  if (!isRecord(admission))
    throw new TypeError('response carries no admission view');
  return admission;
}

describe('session admission API', () => {
  test('an unenabled session takes zero gate and reports no admission', async () => {
    const session = makeSession('s-main');
    session.append('sandbox/mode', { mode: 'workspace-write' });
    const harness = createHarness([session], DENY_ECHO);
    try {
      // The deny rule would stop the call if the gate took over; it must not.
      expect(await harness.gate(call(session), allow)).toEqual({
        kind: 'allow',
      });
      expect(decisions(session)).toHaveLength(0);
      const view = await harness.request(
        '/api/arbiter/sessions?sessionId=s-main',
      );
      expect(view.status).toBe(200);
      expect(viewOf(view.body)).toMatchObject({
        sessionId: 's-main',
        enabled: false,
        managed: false,
        reason: 'no-admission',
        admissionRevision: null,
        seq: null,
      });
      expect(admissions(session)).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });

  test('a session without an agent is never gated', async () => {
    const session = makeSession('s-noagent');
    const harness = createHarness([session], DENY_ECHO);
    try {
      // Enabling the session must not turn an agentless call into a decision:
      // the declared coverage gap says such a call goes back to the host.
      await harness.request('/api/arbiter/sessions', {
        method: 'POST',
        body: { sessionId: 's-noagent', action: 'enable' },
      });
      const decision = await harness.gate(
        {
          callId: 'no-agent',
          name: 'bash',
          arguments: { command: 'echo hi' },
          signal: new AbortController().signal,
        },
        allow,
      );
      expect(decision).toEqual({ kind: 'allow' });
      expect(decisions(session)).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });

  test('enabling a guarded session gates it without widening the sandbox', async () => {
    const session = makeSession('s-guarded');
    session.append('sandbox/mode', { mode: 'workspace-write' });
    session.append('approval/policy', { policy: 'ask' });
    const harness = createHarness([session], ALLOW_ECHO);
    try {
      const enabled = await harness.request('/api/arbiter/sessions', {
        method: 'POST',
        body: { sessionId: 's-guarded', action: 'enable' },
      });
      expect(enabled.status).toBe(200);
      expect(viewOf(enabled.body)).toMatchObject({
        sessionId: 's-guarded',
        enabled: true,
        boundary: 'guarded',
        managed: true,
        reason: 'session-enabled',
      });
      // Enabling does not change permissions the user already selected.
      expect(modeEvents(session)).toEqual([{ mode: 'workspace-write' }]);
      expect(approvalEvents(session)).toEqual([{ policy: 'ask' }]);

      expect((await harness.gate(call(session), allow)).kind).toBe('allow');
      expect(decisions(session).at(-1)?.['result']).toBe('allow');
    } finally {
      harness.dispose();
    }
  });

  test('a trusted session is widened only after the durable record lands', async () => {
    const session = makeSession('s-trusted');
    session.append('sandbox/mode', { mode: 'workspace-write' });
    session.append('approval/policy', { policy: 'ask' });
    const harness = createHarness([session], {
      ...ALLOW_ECHO,
      boundary: 'trusted',
    });
    try {
      const registered = await harness.request('/api/arbiter/sessions', {
        method: 'POST',
        body: { sessionId: 's-trusted', action: 'enable' },
      });
      expect(registered.status).toBe(200);
      expect(modeEvents(session).at(-1)).toEqual({
        mode: 'danger-full-access',
      });
      expect(approvalEvents(session).at(-1)).toEqual({ policy: 'ask' });
      // The gate already covered the session when the sandbox widened.
      const enabledAt = session.events.findIndex(
        (event) =>
          event.type === 'plugin:arbiter/admission' &&
          isRecord(event.data) &&
          event.data['enabled'] === true,
      );
      const widenedAt = session.events.findIndex(
        (event) =>
          event.type === 'sandbox/mode' &&
          isRecord(event.data) &&
          event.data['mode'] === 'danger-full-access',
      );
      expect(enabledAt).toBeGreaterThan(-1);
      expect(widenedAt).toBeGreaterThan(enabledAt);
    } finally {
      harness.dispose();
    }
  });

  test('the API rejects unknown sessions, bad actions and a per-session boundary', async () => {
    const session = makeSession('s-bad');
    const harness = createHarness([session], ALLOW_ECHO);
    try {
      expect(
        (await harness.request('/api/arbiter/sessions?sessionId=ghost')).status,
      ).toBe(404);
      expect(
        (
          await harness.request('/api/arbiter/sessions', {
            method: 'POST',
            body: { sessionId: 'ghost', action: 'enable' },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await harness.request('/api/arbiter/sessions', {
            method: 'POST',
            body: { sessionId: 's-bad', action: 'pause' },
          })
        ).status,
      ).toBe(400);
      const overridden = await harness.request('/api/arbiter/sessions', {
        method: 'POST',
        body: { sessionId: 's-bad', action: 'enable', boundary: 'trusted' },
      });
      expect(overridden.status).toBe(400);
      expect(overridden.body['code']).toBe('boundary-not-overridable');
      expect(overridden.body['revision']).toEqual(expect.any(String));
      // Nothing was written by the rejected requests.
      expect(admissions(session)).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });

  test('an explicit API disable narrows a trusted session before dropping the gate', async () => {
    const session = makeSession('s-exit');
    session.append('sandbox/mode', { mode: 'workspace-write' });
    session.append('approval/policy', { policy: 'ask' });
    const harness = createHarness([session], {
      ...ALLOW_ECHO,
      boundary: 'trusted',
    });
    try {
      await harness.request('/api/arbiter/sessions', {
        method: 'POST',
        body: { sessionId: 's-exit', action: 'enable' },
      });
      const widenedIndex = session.events.length - 1;
      const disabled = await harness.request('/api/arbiter/sessions', {
        method: 'POST',
        body: { sessionId: 's-exit', action: 'disable' },
      });
      expect(disabled.status).toBe(200);
      expect(viewOf(disabled.body)).toMatchObject({
        enabled: false,
        managed: false,
      });
      // The narrowing write precedes the disable record: no call can be
      // ungated while full access is still in force.
      const narrowIndex = session.events.findIndex(
        (event, index) =>
          index > widenedIndex &&
          event.type === 'sandbox/mode' &&
          isRecord(event.data) &&
          event.data['mode'] === 'workspace-write',
      );
      const disabledIndex = session.events.findIndex(
        (event) =>
          event.type === 'plugin:arbiter/admission' &&
          isRecord(event.data) &&
          event.data['enabled'] === false,
      );
      expect(narrowIndex).toBeGreaterThan(widenedIndex);
      expect(disabledIndex).toBeGreaterThan(narrowIndex);
      expect(modeEvents(session).at(-1)).toEqual({ mode: 'workspace-write' });
      // A later call is not gated at all.
      expect(await harness.gate(call(session, 'late'), allow)).toEqual({
        kind: 'allow',
      });
    } finally {
      harness.dispose();
    }
  });

  test('enable is refused while the plugin master switch is off', async () => {
    const session = makeSession('s-off');
    session.append('sandbox/mode', { mode: 'workspace-write' });
    const harness = createHarness([session], { ...ALLOW_ECHO, enabled: false });
    try {
      const refused = await harness.request('/api/arbiter/sessions', {
        method: 'POST',
        body: { sessionId: 's-off', action: 'enable' },
      });
      expect(refused.status).toBe(409);
      expect(refused.body['code']).toBe('plugin-disabled');
      expect(modeEvents(session)).toEqual([{ mode: 'workspace-write' }]);
      expect(admissions(session)).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });
});

describe('native permission commands', () => {
  test('a successful same-value /permission command exits admission', async () => {
    const session = makeSession('s-native');
    session.append('sandbox/mode', { mode: 'workspace-write' });
    session.append('approval/policy', { policy: 'ask' });
    const harness = createHarness([session], ALLOW_ECHO);
    try {
      await harness.request('/api/arbiter/sessions', {
        method: 'POST',
        body: { sessionId: 's-native', action: 'enable' },
      });
      // The guarded same-value switch writes no permission event at all; only
      // the command pair proves the user left.
      harness.emit(session, {
        type: 'command/run',
        data: {
          commandId: 'cmd-1',
          name: 'permission',
          args: ' workspace-write',
          source: { kind: 'user' },
        },
      });
      harness.emit(session, {
        type: 'command/done',
        data: {
          commandId: 'cmd-1',
          kind: 'success',
          text: 'preset workspace-write',
        },
      });
      await settle();
      expect(admissions(session).at(-1)?.['enabled']).toBe(false);
      expect(await harness.gate(call(session, 'after-exit'), allow)).toEqual({
        kind: 'allow',
      });
      expect(
        decisions(session).some(
          (decision) => decision['callId'] === 'after-exit',
        ),
      ).toBe(false);
      // The host permission the user chose is untouched.
      expect(modeEvents(session)).toEqual([{ mode: 'workspace-write' }]);
    } finally {
      harness.dispose();
    }
  });

  test('a failed or bare command keeps admission', async () => {
    const session = makeSession('s-failed');
    session.append('sandbox/mode', { mode: 'workspace-write' });
    const harness = createHarness([session], ALLOW_ECHO);
    try {
      await harness.request('/api/arbiter/sessions', {
        method: 'POST',
        body: { sessionId: 's-failed', action: 'enable' },
      });
      harness.emit(session, {
        type: 'command/run',
        data: { commandId: 'cmd-2', name: 'permission', args: ' unknown' },
      });
      harness.emit(session, {
        type: 'command/done',
        data: { commandId: 'cmd-2', kind: 'error', text: 'unknown preset' },
      });
      // A bare command only reports the preset and is not a switch.
      harness.emit(session, {
        type: 'command/run',
        data: { commandId: 'cmd-3', name: 'permission', args: '' },
      });
      harness.emit(session, {
        type: 'command/done',
        data: { commandId: 'cmd-3', kind: 'success', text: 'current preset' },
      });
      await settle();
      expect(admissions(session).at(-1)?.['enabled']).toBe(true);
      expect((await harness.gate(call(session), allow)).kind).toBe('allow');
      expect(decisions(session)).toHaveLength(1);
    } finally {
      harness.dispose();
    }
  });

  test('a failing command does not exit through its own preset write', async () => {
    const session = makeSession('s-partial');
    session.append('sandbox/mode', { mode: 'workspace-write' });
    const harness = createHarness([session], ALLOW_ECHO);
    try {
      await harness.request('/api/arbiter/sessions', {
        method: 'POST',
        body: { sessionId: 's-partial', action: 'enable' },
      });
      // The host writes command/run, then the preset inside the handler, then
      // settles the command as an error. The in-flight command owns the
      // decision, so the preset must not exit admission on its own.
      harness.emit(session, {
        type: 'command/run',
        data: {
          commandId: 'cmd-partial',
          name: 'permission',
          args: ' read-only',
        },
      });
      harness.emit(session, {
        type: 'permission/preset',
        data: { preset: 'read-only' },
      });
      await settle();
      harness.emit(session, {
        type: 'command/done',
        data: {
          commandId: 'cmd-partial',
          kind: 'error',
          text: 'switch failed',
        },
      });
      await settle();
      expect(admissions(session).at(-1)?.['enabled']).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  test('a preset written with no command open still exits admission', async () => {
    const session = makeSession('s-picker');
    session.append('sandbox/mode', { mode: 'workspace-write' });
    const harness = createHarness([session], ALLOW_ECHO);
    try {
      await harness.request('/api/arbiter/sessions', {
        method: 'POST',
        body: { sessionId: 's-picker', action: 'enable' },
      });
      // Another surface selecting a preset directly, with no command pair.
      harness.emit(session, {
        type: 'permission/preset',
        data: { preset: 'read-only' },
      });
      await settle();
      expect(admissions(session).at(-1)?.['enabled']).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  test('a rejected native auto entry preserves admission and records itself', async () => {
    const session = makeSession('s-auto');
    session.append('sandbox/mode', { mode: 'workspace-write' });
    const harness = createHarness([session], ALLOW_ECHO);
    try {
      await harness.request('/api/arbiter/sessions', {
        method: 'POST',
        body: { sessionId: 's-auto', action: 'enable' },
      });
      harness.emit(session, {
        type: 'command/run',
        data: { commandId: 'cmd-auto', name: 'permission', args: ' auto' },
      });
      harness.emit(session, {
        type: 'command/done',
        data: {
          commandId: 'cmd-auto',
          kind: 'error',
          text: '此入口不受 Arbiter 支持。请在会话权限菜单中选择"自动审查（Arbiter）"。',
        },
      });
      await settle();
      expect(admissions(session).at(-1)?.['enabled']).toBe(true);
      // Rejection is not an exit: the session stays gated and no permission
      // event was written by the failed command.
      expect(modeEvents(session)).toEqual([{ mode: 'workspace-write' }]);
      expect((await harness.gate(call(session), allow)).kind).toBe('allow');
      expect(decisions(session)).toHaveLength(1);
    } finally {
      harness.dispose();
    }
  });
});

describe('restore and scope', () => {
  test('a cold restart restores admission from the session log alone', async () => {
    const session = makeSession('s-cold');
    session.append('sandbox/mode', { mode: 'workspace-write' });
    const first = createHarness([session], ALLOW_ECHO);
    try {
      await first.request('/api/arbiter/sessions', {
        method: 'POST',
        body: { sessionId: 's-cold', action: 'enable' },
      });
      expect(decisions(session)).toHaveLength(0);
    } finally {
      first.dispose();
    }
    // Re-apply the plugin over the same live session log, as a host restart
    // would with a restored session. No audit row is read.
    const restored = createHarness([session], ALLOW_ECHO);
    try {
      const view = await restored.request(
        '/api/arbiter/sessions?sessionId=s-cold',
      );
      expect(viewOf(view.body)).toMatchObject({
        enabled: true,
        managed: true,
        boundary: 'guarded',
      });
      expect(
        (await restored.gate(call(session, 'post-restart'), allow)).kind,
      ).toBe('allow');
      expect(decisions(session).at(-1)?.['callId']).toBe('post-restart');
    } finally {
      restored.dispose();
    }
  });

  test('a missing audit database does not change the restored admission', async () => {
    const session = makeSession('s-noaudit');
    session.append('sandbox/mode', { mode: 'workspace-write' });
    const blocked = createHarness([session], ALLOW_ECHO, { blockAudit: true });
    try {
      const enabled = await blocked.request('/api/arbiter/sessions', {
        method: 'POST',
        body: { sessionId: 's-noaudit', action: 'enable' },
      });
      expect(enabled.status).toBe(200);
      // The state route must report the effective revision even while the
      // audit store is unusable.
      const state = await blocked.state();
      expect(state.status).toBe(200);
      expect(isRecord(state.body['audit'])).toBe(true);
      expect((await blocked.gate(call(session, 'no-audit'), allow)).kind).toBe(
        'allow',
      );
    } finally {
      blocked.dispose();
    }
  });

  test('an enabled parent covers its subagent but not an unmanaged one', async () => {
    const parent = makeSession('s-parent');
    parent.append('sandbox/mode', { mode: 'workspace-write' });
    const child = makeSession('s-child', { parentSession: 's-parent' });
    const other = makeSession('s-other');
    const strayChild = makeSession('s-stray-child', {
      parentSession: 's-other',
    });
    const harness = createHarness(
      [parent, child, other, strayChild],
      ALLOW_ECHO,
    );
    try {
      await harness.request('/api/arbiter/sessions', {
        method: 'POST',
        body: { sessionId: 's-parent', action: 'enable' },
      });
      expect((await harness.gate(call(child, 'child-call'), allow)).kind).toBe(
        'allow',
      );
      expect(
        decisions(child).some(
          (decision) => decision['callId'] === 'child-call',
        ),
      ).toBe(true);
      // The subagent's own knobs are the host's delegation decision; the
      // plugin must not widen or rewrite them.
      expect(
        child.events.filter((event) => event.type === 'sandbox/mode'),
      ).toHaveLength(0);
      // An unmanaged parent's child is not covered.
      expect(
        (await harness.gate(call(strayChild, 'stray-call'), allow)).kind,
      ).toBe('allow');
      expect(decisions(strayChild)).toHaveLength(0);
      const view = await harness.request(
        '/api/arbiter/sessions?sessionId=s-stray-child',
      );
      expect(viewOf(view.body)).toMatchObject({
        managed: false,
        reason: 'parent-not-admitted',
      });
    } finally {
      harness.dispose();
    }
  });

  test('a trusted-to-guarded change narrows a running subagent', async () => {
    const main = makeSession('s-b-root');
    main.append('sandbox/mode', { mode: 'workspace-write' });
    const child = makeSession('s-b-child', { parentSession: 's-b-root' });
    // The host captured the parent's trusted sandbox at delegation.
    child.append('sandbox/mode', {
      mode: 'danger-full-access',
      source: 'delegation',
    });
    child.append('approval/policy', { policy: 'never', source: 'delegation' });
    const harness = createHarness([main, child], {
      ...ALLOW_ECHO,
      boundary: 'trusted',
    });
    try {
      await harness.request('/api/arbiter/sessions', {
        method: 'POST',
        body: { sessionId: 's-b-root', action: 'enable' },
      });
      // The child is covered through the parent and its call is gated.
      await harness.gate(call(child, 'child-first'), allow);
      const restricted = harness.reread({ ...ALLOW_ECHO, boundary: 'guarded' });
      try {
        // The first covered call after the change reconciles the child's
        // captured sandbox; it has no admission record of its own.
        await restricted.gate(call(child, 'child-after-change'), allow);
        expect(modeEvents(child).at(-1)).toEqual({ mode: 'workspace-write' });
        // Its host-pinned approval stays exactly as the delegation set it.
        expect(approvalEvents(child).at(-1)).toEqual({
          policy: 'never',
          source: 'delegation',
        });
      } finally {
        restricted.dispose();
      }
    } finally {
      harness.dispose();
    }
  });

  test('a deep subagent reports the main session as its root', async () => {
    const main = makeSession('s-root');
    main.append('sandbox/mode', { mode: 'workspace-write' });
    const child = makeSession('s-mid', { parentSession: 's-root' });
    const grandchild = makeSession('s-leaf', { parentSession: 's-mid' });
    const harness = createHarness([main, child, grandchild], ALLOW_ECHO);
    try {
      await harness.request('/api/arbiter/sessions', {
        method: 'POST',
        body: { sessionId: 's-root', action: 'enable' },
      });
      const view = await harness.request(
        '/api/arbiter/sessions?sessionId=s-leaf',
      );
      // The public root is the main session, not the intermediate parent, and
      // the call is still covered through the whole chain.
      expect(viewOf(view.body)).toMatchObject({
        sessionId: 's-leaf',
        rootSessionId: 's-root',
        managed: true,
        reason: 'parent-session-enabled',
      });
      expect(
        (await harness.gate(call(grandchild, 'leaf-call'), allow)).kind,
      ).toBe('allow');
      expect(
        decisions(grandchild).some((entry) => entry['callId'] === 'leaf-call'),
      ).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  test('a boundary change reaches enabled sessions only', async () => {
    const enabled = makeSession('s-enabled');
    enabled.append('sandbox/mode', { mode: 'workspace-write' });
    const plain = makeSession('s-plain');
    plain.append('sandbox/mode', { mode: 'workspace-write' });
    const harness = createHarness([enabled, plain], ALLOW_ECHO);
    try {
      await harness.request('/api/arbiter/sessions', {
        method: 'POST',
        body: { sessionId: 's-enabled', action: 'enable' },
      });
      // A configuration change to trusted applies to the enabled session and
      // leaves the plain workspace-write session untouched.
      const trusted = harness.reread({ ...ALLOW_ECHO, boundary: 'trusted' });
      try {
        await trusted.gate(call(enabled, 'after-config'), allow);
        expect(modeEvents(enabled).at(-1)).toEqual({
          mode: 'danger-full-access',
        });
        expect(modeEvents(plain)).toEqual([{ mode: 'workspace-write' }]);
      } finally {
        trusted.dispose();
      }
    } finally {
      harness.dispose();
    }
  });
});
