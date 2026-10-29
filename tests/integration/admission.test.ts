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
  options: {
    readonly parentSession?: string;
    /** Refuse `sandbox/mode` writes while still accepting records. */
    readonly refuseSandboxWrites?: boolean;
    /** Seed the host sandbox the session already had before admission. */
    readonly initialSandbox?: string;
  } = {},
): StubSession {
  const events: SessionEventLike[] = [
    ...(options.initialSandbox === undefined
      ? []
      : [
          {
            type: 'sandbox/mode',
            seq: 0,
            data: { mode: options.initialSandbox },
          },
        ]),
  ];
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
      if (type === 'sandbox/mode' && options.refuseSandboxWrites === true) {
        throw new Error('append refused while the host is publishing');
      }
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
      conditions: [
        {
          target: 'command' as const,
          kind: 'exact' as const,
          pattern: 'echo hi',
        },
      ],
      verdict: 'allow' as const,
    },
  ],
};

const DENY_ECHO = {
  rules: [
    {
      id: 'deny-echo',
      conditions: [
        {
          target: 'command' as const,
          kind: 'exact' as const,
          pattern: 'echo hi',
        },
      ],
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
  options: {
    readonly blockAudit?: boolean;
    /** Refuse every sandbox write, as a host stuck mid-publish would. */
    readonly refuseSandboxWrites?: boolean;
  } = {},
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

describe('failed activation and master switch', () => {
  test('a guarded activation the host cannot confine is withdrawn', async () => {
    // The host reports full access and every sandbox write is refused, so the
    // plugin cannot make the guarded promise true.
    const session = makeSession('s-unconfined', {
      refuseSandboxWrites: true,
      initialSandbox: 'danger-full-access',
    });
    const harness = createHarness([session], ALLOW_ECHO, {
      refuseSandboxWrites: true,
    });
    try {
      const result = await harness.request('/api/arbiter/sessions', {
        method: 'POST',
        body: { sessionId: 's-unconfined', action: 'enable' },
      });
      expect(result.status).toBe(409);
      expect(String(result.body['message'])).toContain('workspace confinement');
      // No durable record may claim an effective guarded admission.
      expect(admissions(session).at(-1)?.['enabled']).toBe(false);
      // With the admission withdrawn the session is simply unmanaged: the
      // plugin does not gate it, and it keeps no record claiming guarded.
      expect(
        await harness.gate(call(session, 'unconfined-call'), allow),
      ).toEqual({
        kind: 'allow',
      });
      expect(
        decisions(session).filter(
          (entry) => entry['callId'] === 'unconfined-call',
        ),
      ).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });

  test('turning the master switch off narrows admitted sessions', async () => {
    const main = makeSession('s-off-root');
    main.append('sandbox/mode', { mode: 'workspace-write' });
    main.append('approval/policy', { policy: 'ask' });
    const child = makeSession('s-off-child', { parentSession: 's-off-root' });
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
        body: { sessionId: 's-off-root', action: 'enable' },
      });
      expect(modeEvents(main).at(-1)).toEqual({ mode: 'danger-full-access' });
      // The plugin is disabled in the effective configuration: the gate stops,
      // so the session must not keep the sandbox the plugin widened.
      harness.reread({ ...ALLOW_ECHO, enabled: false, boundary: 'trusted' });
      expect(modeEvents(main).at(-1)).toEqual({ mode: 'workspace-write' });
      // A main session also returns to `ask`; the child keeps the approval the
      // host pinned at delegation and only loses its captured sandbox.
      expect(approvalEvents(main).at(-1)).toEqual({ policy: 'ask' });
      expect(modeEvents(child).at(-1)).toEqual({ mode: 'workspace-write' });
      expect(approvalEvents(child).at(-1)).toEqual({
        policy: 'never',
        source: 'delegation',
      });
      expect(await harness.gate(call(main, 'off-call'), allow)).toMatchObject({
        kind: 'allow',
      });
    } finally {
      harness.dispose();
    }
  });
});

describe('API disable must not leave an ungated wide session', () => {
  test('a refused narrowing keeps the session admitted', async () => {
    const session = makeSession('s-i08', {
      refuseSandboxWrites: true,
      initialSandbox: 'danger-full-access',
    });
    session.append('approval/policy', { policy: 'ask' });
    // The admission record was committed by an earlier process; the host now
    // refuses the narrowing write but keeps accepting records.
    session.append('plugin:arbiter/admission', {
      version: 1,
      sessionId: 's-i08',
      rootSessionId: 's-i08',
      enabled: true,
      boundary: 'trusted',
      at: Date.now(),
    });
    const harness = createHarness([session], {
      ...ALLOW_ECHO,
      boundary: 'trusted',
    });
    try {
      const disabled = await harness.request('/api/arbiter/sessions', {
        method: 'POST',
        body: { sessionId: 's-i08', action: 'disable' },
      });
      expect(disabled.status).toBe(409);
      expect(disabled.body['code']).toBe('boundary-unconfirmed');
      // No disable record was committed, so the session stays admitted.
      expect(admissions(session).at(-1)?.['enabled']).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  test('an inherited child disabled through the API is narrowed first', async () => {
    const main = makeSession('s-i09-root');
    main.append('sandbox/mode', { mode: 'workspace-write' });
    main.append('approval/policy', { policy: 'ask' });
    const child = makeSession('s-i09-child', { parentSession: 's-i09-root' });
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
        body: { sessionId: 's-i09-root', action: 'enable' },
      });
      // The child has no record of its own; disabling it must still narrow the
      // sandbox before the new disabled record removes gate protection.
      const disabled = await harness.request('/api/arbiter/sessions', {
        method: 'POST',
        body: { sessionId: 's-i09-child', action: 'disable' },
      });
      expect(disabled.status).toBe(200);
      expect(modeEvents(child).at(-1)).toEqual({ mode: 'workspace-write' });
      expect(approvalEvents(child).at(-1)).toEqual({
        policy: 'never',
        source: 'delegation',
      });
      const view = await harness.request(
        '/api/arbiter/sessions?sessionId=s-i09-child',
      );
      expect(viewOf(view.body)).toMatchObject({
        enabled: false,
        managed: false,
        reason: 'session-disabled',
      });
      // The parent is untouched and still admitted.
      const parentView = await harness.request(
        '/api/arbiter/sessions?sessionId=s-i09-root',
      );
      expect(viewOf(parentView.body)).toMatchObject({
        enabled: true,
        managed: true,
      });
      // The parent keeps its own widened permission: only the disabled child
      // narrows. Disabling a child must not silently exit the parent.
      expect(modeEvents(main).at(-1)).toEqual({ mode: 'danger-full-access' });
      // The child's next call is ungated by design, but its captured sandbox is
      // gone, so it cannot execute outside the workspace.
      expect((await harness.gate(call(child, 'child-after'), allow)).kind).toBe(
        'allow',
      );
      expect(
        decisions(child).filter((entry) => entry['callId'] === 'child-after'),
      ).toHaveLength(0);
      expect(modeEvents(child).at(-1)).toEqual({ mode: 'workspace-write' });
    } finally {
      harness.dispose();
    }
  });
});

describe('API disable reaches unobserved descendants', () => {
  test('a live child that never called the gate is narrowed too', async () => {
    const main = makeSession('s-d-root');
    main.append('sandbox/mode', { mode: 'workspace-write' });
    main.append('approval/policy', { policy: 'ask' });
    const child = makeSession('s-d-child', { parentSession: 's-d-root' });
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
        body: { sessionId: 's-d-root', action: 'enable' },
      });
      // The child never calls the gate, so it is only known from the list.
      const disabled = await harness.request('/api/arbiter/sessions', {
        method: 'POST',
        body: { sessionId: 's-d-root', action: 'disable' },
      });
      expect(disabled.status).toBe(200);
      expect(modeEvents(child).at(-1)).toEqual({ mode: 'workspace-write' });
      expect(approvalEvents(child).at(-1)).toEqual({
        policy: 'never',
        source: 'delegation',
      });
    } finally {
      harness.dispose();
    }
  });
});

describe('a session opened after the master switch is off', () => {
  test('its first call narrows it instead of running wide and ungated', async () => {
    const late = makeSession('s-late', {
      initialSandbox: 'danger-full-access',
    });
    late.append('approval/policy', { policy: 'ask' });
    // The record is from an earlier run: the session is trusted and admitted,
    // but it was closed when the plugin started with the master switch off.
    late.append('plugin:arbiter/admission', {
      version: 1,
      sessionId: 's-late',
      rootSessionId: 's-late',
      enabled: true,
      boundary: 'trusted',
      at: Date.now(),
    });
    const harness = createHarness([late], {
      ...ALLOW_ECHO,
      enabled: false,
      boundary: 'trusted',
    });
    try {
      const decision = await harness.gate(call(late, 'late-call'), allow);
      // The gate steps aside (the plugin is disabled) but only after the
      // sandbox the plugin widened was taken back.
      expect(decision.kind).toBe('allow');
      expect(modeEvents(late).at(-1)).toEqual({ mode: 'workspace-write' });
      expect(
        decisions(late).filter((entry) => entry['callId'] === 'late-call'),
      ).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });

  test('an unadmitted session is untouched by the bypass', async () => {
    const plain = makeSession('s-plain');
    plain.append('sandbox/mode', { mode: 'read-only' });
    const harness = createHarness([plain], {
      ...ALLOW_ECHO,
      enabled: false,
    });
    try {
      expect((await harness.gate(call(plain, 'plain-call'), allow)).kind).toBe(
        'allow',
      );
      // Its own permission is the user's, not this plugin's.
      expect(modeEvents(plain)).toEqual([{ mode: 'read-only' }]);
    } finally {
      harness.dispose();
    }
  });
});

describe('guarded confinement that cannot be re-established', () => {
  test('the call is refused rather than approved under full access', async () => {
    // Trusted admission from an earlier run, host-wide sandbox, and every
    // further sandbox write refused: the guarded configuration cannot be made
    // true, so no call may be approved for it.
    const session = makeSession('s-i02-late', {
      refuseSandboxWrites: true,
      initialSandbox: 'danger-full-access',
    });
    session.append('approval/policy', { policy: 'ask' });
    session.append('plugin:arbiter/admission', {
      version: 1,
      sessionId: 's-i02-late',
      rootSessionId: 's-i02-late',
      enabled: true,
      boundary: 'trusted',
      at: Date.now(),
    });
    const harness = createHarness([session], ALLOW_ECHO);
    try {
      const decision = await harness.gate(call(session, 'guarded-late'), allow);
      expect(decision.kind).toBe('deny');
      expect(JSON.stringify(decision)).toContain('boundary-unconfirmed');
      expect(
        decisions(session).filter(
          (entry) => entry['callId'] === 'guarded-late',
        ),
      ).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });
});

describe('an absent sandbox override is not proof of confinement', () => {
  test('guarded admission writes an explicit boundary before approving', async () => {
    // No sandbox event at all and a full-access deployment default: the plugin
    // must state the boundary explicitly instead of assuming the default.
    const session = makeSession('s-absent');
    const harness = createHarness([session], ALLOW_ECHO);
    try {
      const enabled = await harness.request('/api/arbiter/sessions', {
        method: 'POST',
        body: { sessionId: 's-absent', action: 'enable' },
      });
      expect(enabled.status).toBe(200);
      expect(modeEvents(session)).toEqual([{ mode: 'workspace-write' }]);
      expect(approvalEvents(session)).toEqual([{ policy: 'ask' }]);
    } finally {
      harness.dispose();
    }
  });

  test('guarded reconciliation cannot skip a missing override', async () => {
    // A trusted record from an earlier run, no sandbox event, guarded now: the
    // first call must establish the boundary before it can be approved.
    const session = makeSession('s-absent-late');
    session.append('plugin:arbiter/admission', {
      version: 1,
      sessionId: 's-absent-late',
      rootSessionId: 's-absent-late',
      enabled: true,
      boundary: 'trusted',
      at: Date.now(),
    });
    const harness = createHarness([session], ALLOW_ECHO);
    try {
      expect(
        (await harness.gate(call(session, 'absent-call'), allow)).kind,
      ).toBe('allow');
      expect(modeEvents(session).at(-1)).toEqual({ mode: 'workspace-write' });
      expect(approvalEvents(session).at(-1)).toEqual({ policy: 'ask' });
    } finally {
      harness.dispose();
    }
  });
});

describe('native exit with a live delegated child', () => {
  test('the parent keeps its own choice and the child is narrowed', async () => {
    const parent = makeSession('n-parent');
    parent.append('sandbox/mode', { mode: 'workspace-write' });
    parent.append('approval/policy', { policy: 'ask' });
    const child = makeSession('n-child', { parentSession: 'n-parent' });
    // The host captured the parent's trusted sandbox at delegation.
    child.append('sandbox/mode', {
      mode: 'danger-full-access',
      source: 'delegation',
    });
    child.append('approval/policy', { policy: 'never', source: 'delegation' });
    const harness = createHarness([parent, child], {
      ...ALLOW_ECHO,
      boundary: 'trusted',
    });
    try {
      await harness.request('/api/arbiter/sessions', {
        method: 'POST',
        body: { sessionId: 'n-parent', action: 'enable' },
      });
      // The child is covered through the parent and really is wide.
      await harness.gate(call(child, 'n-first'), allow);
      expect(modeEvents(child).at(-1)).toEqual({
        mode: 'danger-full-access',
        source: 'delegation',
      });

      // The user leaves through the native command: the host writes the parent
      // sandbox itself, then the command settles.
      parent.append('permission/preset', { preset: 'workspace-write' });
      parent.append('sandbox/mode', { mode: 'workspace-write' });
      harness.emit(parent, {
        type: 'command/run',
        data: {
          commandId: 'cmd-n1',
          name: 'permission',
          args: ' workspace-write',
        },
      });
      harness.emit(parent, {
        type: 'permission/preset',
        data: { preset: 'workspace-write' },
      });
      harness.emit(parent, {
        type: 'command/done',
        data: { commandId: 'cmd-n1', kind: 'success' },
      });
      await settle();

      // The child must no longer run with the parent's old privilege.
      expect(modeEvents(child).at(-1)).toEqual({ mode: 'workspace-write' });
      // Its host-pinned approval is untouched.
      const approvals = child.events.filter(
        (event) => event.type === 'approval/policy',
      );
      expect(approvals).toHaveLength(1);
      // The parent's own chosen permission is not overwritten by us.
      expect(approvals).toHaveLength(1);
      expect(modeEvents(parent).at(-1)).toEqual({ mode: 'workspace-write' });
      // The exit is durable through the command pair, so the effective view is
      // disabled even though no extra record had to be written.
      const view = await harness.request(
        '/api/arbiter/sessions?sessionId=n-parent',
      );
      expect(viewOf(view.body)).toMatchObject({
        enabled: false,
        managed: false,
      });
    } finally {
      harness.dispose();
    }
  });
});

describe('re-enabling cannot withdraw protection', () => {
  test('a failed guarded re-enable leaves the session protected', async () => {
    const session = makeSession('re-late', {
      refuseSandboxWrites: true,
      initialSandbox: 'danger-full-access',
    });
    session.append('approval/policy', { policy: 'ask' });
    // An earlier process admitted it as trusted; the plugin now runs guarded,
    // and the host refuses every sandbox write.
    session.append('plugin:arbiter/admission', {
      version: 1,
      sessionId: 're-late',
      rootSessionId: 're-late',
      enabled: true,
      boundary: 'trusted',
      at: Date.now(),
    });
    const harness = createHarness([session], ALLOW_ECHO);
    try {
      const again = await harness.request('/api/arbiter/sessions', {
        method: 'POST',
        body: { sessionId: 're-late', action: 'enable' },
      });
      expect(again.status).toBe(409);
      // The previously managed session must not become an ungated wide one.
      const view = await harness.request(
        '/api/arbiter/sessions?sessionId=re-late',
      );
      expect(viewOf(view.body)['managed']).toBe(true);
      expect(modeEvents(session).at(-1)).toEqual({
        mode: 'danger-full-access',
      });
      const decision = await harness.gate(call(session, 're-call'), allow);
      expect(decision.kind).toBe('deny');
    } finally {
      harness.dispose();
    }
  });
});

describe('fail-closed is released once recovery is confirmed', () => {
  test('a master-off reconcile that failed can be repaired on a later call', async () => {
    const refusal = { active: true };
    const base = makeSession('fc-late', {
      initialSandbox: 'danger-full-access',
    });
    base.append('approval/policy', { policy: 'ask' });
    base.append('plugin:arbiter/admission', {
      version: 1,
      sessionId: 'fc-late',
      rootSessionId: 'fc-late',
      enabled: true,
      boundary: 'trusted',
      at: Date.now(),
    });
    // A host that refuses permission writes while `refusal.active` is set.
    const session: StubSession = {
      ...base,
      append(type, data) {
        if (
          refusal.active &&
          (type === 'sandbox/mode' || type === 'approval/policy')
        ) {
          throw new Error('append refused while the host is publishing');
        }
        base.append(type, data);
      },
    };
    // Startup reconcile with the master switch off cannot narrow: the session
    // must stay refused rather than run wide and ungated.
    const harness = createHarness([session], {
      ...ALLOW_ECHO,
      enabled: false,
      boundary: 'trusted',
    });
    try {
      expect((await harness.gate(call(session, 'fc-denied'), allow)).kind).toBe(
        'deny',
      );
      // The host recovers. The marker must not be sticky: the next call has to
      // re-check and, once the boundary is confirmed, be released.
      refusal.active = false;
      expect(
        (await harness.gate(call(session, 'fc-allowed'), allow)).kind,
      ).toBe('allow');
      expect(modeEvents(session).at(-1)).toEqual({ mode: 'workspace-write' });
      expect(approvalEvents(session).at(-1)).toEqual({ policy: 'ask' });
    } finally {
      harness.dispose();
    }
  });
});

describe('dropping coverage never leaves a widened sandbox', () => {
  test('a session that stops being admitted is narrowed first', async () => {
    const parent = makeSession('drop-parent');
    parent.append('sandbox/mode', { mode: 'workspace-write' });
    parent.append('approval/policy', { policy: 'ask' });
    const child = makeSession('drop-child', { parentSession: 'drop-parent' });
    child.append('sandbox/mode', {
      mode: 'danger-full-access',
      source: 'delegation',
    });
    child.append('approval/policy', { policy: 'never', source: 'delegation' });
    const harness = createHarness([parent, child], {
      ...ALLOW_ECHO,
      boundary: 'trusted',
    });
    try {
      await harness.request('/api/arbiter/sessions', {
        method: 'POST',
        body: { sessionId: 'drop-parent', action: 'enable' },
      });
      // The child is covered while the parent is admitted.
      await harness.gate(call(child, 'drop-first'), allow);
      // The parent's exit is already durable — a cold restore sees it this way
      // — with no live command for this process to observe. Discovery is then
      // the only thing that reclassifies the child, and it must not leave the
      // captured full-access sandbox behind.
      parent.append('plugin:arbiter/admission', {
        version: 1,
        sessionId: 'drop-parent',
        rootSessionId: 'drop-parent',
        enabled: false,
        boundary: 'trusted',
        at: Date.now(),
      });
      const decision = await harness.gate(call(child, 'drop-after'), allow);
      expect(decision.kind).toBe('allow');
      expect(modeEvents(child).at(-1)).toEqual({ mode: 'workspace-write' });
      // Its host-pinned approval is never rewritten.
      expect(
        child.events.filter((event) => event.type === 'approval/policy'),
      ).toHaveLength(1);
    } finally {
      harness.dispose();
    }
  });
});
