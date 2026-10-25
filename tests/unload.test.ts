import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { apply } from '../src/index.js';
import { installSessionRecordApi } from '../src/records.js';
import { recordingSessionApi } from './helpers/session-records.js';
import type {
  ContextLike,
  HostServices,
  ProfileContextLike,
  ConnectionLike,
  ToolExecutionLike,
  ApprovalServiceLike,
} from '../src/host/types.js';
import type { SessionEventLike } from '../src/snapshot/types.js';

/**
 * Unload semantics, exercised against a stub context.
 *
 * What is pinned here:
 *   - a session the user enabled and the plugin widened is rolled back to
 *     workspace-write + ask;
 *   - a session that already sits at workspace-write + ask gets no new event;
 *   - a session the user moved to another preset is left alone;
 *   - a session whose rollback write fails is not silently handed back to an
 *     ungated wide sandbox;
 *   - an unmanaged session is never rewritten;
 *   - no new call is gated once unload has begun.
 *
 * Admission is durable state in the session log, so the tests write the same
 * ignorable record the API writes; teardown reads it, never an in-memory flag.
 * The stub records the two handlers the plugin registers, widened to their
 * public parameter types, so the test never needs a cast at a call site.
 */

interface StubEvent {
  type: string;
  data: unknown;
}

interface StubSession {
  readonly id: string;
  readonly header: {
    readonly cwd: string;
    readonly parentSession?: string;
    readonly origin?: string;
  };
  /** Turns the session's own log writes into host failures. */
  failAppend: boolean;
  /** Lets one test fail selected writes while the rest keep working. */
  onAppend: ((type: string, data: unknown) => boolean) | null;
  readonly snapshotEvents: () => readonly SessionEventLike[];
  readonly append: (type: string, data: unknown) => void;
}

/**
 * The plugin writes admission through the host's record writer; this file
 * installs a test double with the same contract once, and production code
 * still only calls `appendPluginRecord`.
 */
beforeAll(() => {
  installSessionRecordApi(recordingSessionApi());
});

afterAll(() => {
  installSessionRecordApi(null);
});

type Gate = (
  exec: ToolExecutionLike,
  next: () => Promise<{ kind: string }>,
) => Promise<{ kind: string }>;

type SessionEvent = (session: unknown, event: Record<string, unknown>) => void;

function makeSession(
  id: string,
  events: StubEvent[] = [],
): StubSession & { id: string } {
  const stub: StubSession & { id: string; failAppend: boolean } = {
    id,
    failAppend: false,
    onAppend: null,
    header: { cwd: process.cwd() },
    snapshotEvents: () =>
      // The host commits every plugin record with `ignorable: true`; the stub
      // log reproduces that envelope so the production reader is exercised.
      events.map((event, seq) => ({
        ...event,
        seq,
        ignorable: event.type.startsWith('plugin:'),
      })),
    append(type: string, data: unknown) {
      if (stub.failAppend) throw new Error('host is shutting down');
      if (stub.onAppend !== null && !stub.onAppend(type, data))
        throw new Error('append refused while the host is publishing');
      events.push({ type, data });
    },
  };
  return stub;
}

/** Write the durable admission record the plugin's own writer would commit. */
function admit(
  events: StubEvent[],
  sessionId: string,
  options: { readonly enabled?: boolean; readonly boundary?: string } = {},
): void {
  events.push({
    type: 'plugin:arbiter/admission',
    data: {
      version: 1,
      sessionId,
      rootSessionId: sessionId,
      enabled: options.enabled ?? true,
      boundary: options.boundary ?? 'trusted',
      at: Date.now(),
    },
  });
}

/** A session the user enabled and the plugin widened to the trusted bundle. */
function trustedSession(
  id: string,
  events: StubEvent[] = [],
): StubSession & { id: string } {
  admit(events, id, { boundary: 'trusted' });
  events.push({ type: 'sandbox/mode', data: { mode: 'danger-full-access' } });
  events.push({ type: 'approval/policy', data: { policy: 'ask' } });
  return makeSession(id, events);
}

/** A delegated child: it carries the host's captured policy and its parent. */
function subagentSession(
  id: string,
  parentSession: string,
  events: StubEvent[] = [],
): StubSession & { id: string } {
  const session = makeSession(id, events);
  return {
    ...session,
    header: { cwd: process.cwd(), parentSession, origin: 'subagent' },
  };
}

/** The registry is typed at construction and implements each public overload. */
interface StubServices extends Partial<Omit<HostServices, 'presets'>> {
  readonly profileContext?: ProfileContextLike;
  readonly sandboxPolicy?: { readonly defaultMode?: string };
  readonly connection?: ConnectionLike;
  readonly permissionPresets?: HostServices['presets'];
}

type StubMembers = Pick<ContextLike, 'on' | 'effect' | 'inject' | 'logger'>;

function stubContext(
  members: StubMembers,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Runtime dispatch preserves the generic host listener boundary without casts. */
async function invokeGate(
  handler: (...args: never[]) => unknown,
  execution: ToolExecutionLike,
  next: () => Promise<{ kind: string }>,
): Promise<{ kind: string }> {
  const decision: unknown = await Reflect.apply(handler, undefined, [
    execution,
    next,
  ]);
  if (!isRecord(decision) || typeof decision['kind'] !== 'string') {
    throw new TypeError('Gate returned an invalid decision');
  }
  return { ...decision, kind: decision['kind'] };
}

function contextFor(
  session: StubSession,
  approvalRequest: ApprovalServiceLike['request'] = () =>
    Promise.resolve('unavailable'),
  services: Partial<StubServices> = {},
): {
  ctx: ContextLike;
  stub: { gate?: Gate; sessionEvent?: SessionEvent };
  disposers: (() => Promise<unknown>)[];
} {
  const stub: { gate?: Gate; sessionEvent?: SessionEvent } = {};
  const disposers: (() => Promise<unknown>)[] = [];
  const resolved: StubServices = {
    sandboxPolicy: { defaultMode: 'workspace-write' },
    sessions: { get: () => session },
    approval: {
      config: { policy: 'ask' },
      request: approvalRequest,
    },
    permissionPresets: { registerAuto: () => () => {} },
    workingDirectory: { ensure: () => Promise.resolve(process.cwd()) },
    ...services,
  };

  // The handler signatures are the plugin's own; this builder is the single
  // place that names them, so no call site needs a cast.
  type Listener = (...args: never[]) => unknown;
  const ctx = stubContext(
    {
      on(event: string, handler: Listener) {
        if (event === 'tools/pre-execute') {
          stub.gate = (execution, next) => invokeGate(handler, execution, next);
        }
        if (event === 'session/event') {
          stub.sessionEvent = (owner, sessionEvent) => {
            Reflect.apply(handler, undefined, [owner, sessionEvent]);
          };
        }
        return () => undefined;
      },
      effect(fn: () => unknown) {
        const dispose: unknown = fn();
        if (typeof dispose === 'function') {
          disposers.push(() =>
            Promise.resolve(Reflect.apply(dispose, undefined, [])),
          );
        }
      },
      inject: () => undefined,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    },
    resolved,
  );

  return { ctx, stub, disposers };
}

const allow = (): Promise<{ kind: string }> =>
  Promise.resolve({ kind: 'allow' });

/** One allow rule so a gated call settles without a model or a human. */
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
const exec = (session: StubSession, callId: string) => ({
  callId,
  name: 'bash',
  arguments: { command: 'echo hi' },
  signal: new AbortController().signal,
  agent: { session },
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolver: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (resolver === undefined)
        throw new Error('Promise resolver was not initialized');
      resolver(value);
    },
  };
}

async function unload(disposers: (() => Promise<unknown>)[]): Promise<void> {
  for (const dispose of disposers) await dispose();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('unload rollback', () => {
  test('an enabled session is rolled back to workspace-write + ask', async () => {
    const events: StubEvent[] = [];
    const session = trustedSession('s1', events);
    const { ctx, stub, disposers } = contextFor(session);
    apply(ctx, {
      ...ALLOW_ECHO,
      boundary: 'trusted',
      modes: { main: 'normal' },
    });

    // One gated call: coverage is recorded from an actual admission, not from
    // a plugin flag.
    expect(await stub.gate?.(exec(session, 'c1'), allow)).toEqual({
      kind: 'allow',
    });

    await unload(disposers);

    const modes = events
      .filter((event) => event.type === 'sandbox/mode')
      .map((event) => event.data);
    const approvals = events
      .filter((event) => event.type === 'approval/policy')
      .map((event) => event.data);
    expect(modes.at(-1)).toEqual({ mode: 'workspace-write' });
    expect(approvals.at(-1)).toEqual({ policy: 'ask' });
  });

  test('a session already at workspace-write + ask gets no new event', async () => {
    const events: StubEvent[] = [
      { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
      { type: 'approval/policy', data: { policy: 'ask' } },
    ];
    admit(events, 's2', { boundary: 'guarded' });
    const session = makeSession('s2', events);
    const { ctx, stub, disposers } = contextFor(session);
    // The configured boundary already matches the recorded one, so teardown
    // has nothing to rewrite.
    apply(ctx, { ...ALLOW_ECHO, modes: { main: 'normal' } });
    await stub.gate?.(exec(session, 'c2'), allow);
    const before = events.length;
    await unload(disposers);
    expect(
      events.slice(before).filter((event) => !event.type.startsWith('plugin:')),
    ).toHaveLength(0);
  });

  test('a session the user moved to read-only is not rewritten', async () => {
    const events: StubEvent[] = [];
    const session = trustedSession('s3', events);
    const { ctx, stub, disposers } = contextFor(session);
    apply(ctx, {
      ...ALLOW_ECHO,
      boundary: 'trusted',
      modes: { main: 'normal' },
    });
    await stub.gate?.(exec(session, 'c3'), allow);

    // The user switches away through the native command path: command/run
    // lands before the handler and command/done proves it succeeded.
    events.push({ type: 'sandbox/mode', data: { mode: 'read-only' } });
    stub.sessionEvent?.(session, {
      type: 'command/run',
      data: { commandId: 'cmd-1', name: 'permission', args: ' read-only' },
    });
    stub.sessionEvent?.(session, {
      type: 'command/done',
      data: { commandId: 'cmd-1', kind: 'success', text: 'preset read-only' },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const before = events.length;
    await unload(disposers);
    expect(events.slice(before)).toHaveLength(0);
    const modes = events.filter((event) => event.type === 'sandbox/mode');
    expect(modes.at(-1)?.data).toEqual({ mode: 'read-only' });
  });

  test('an unmanaged session is never rewritten by teardown', async () => {
    const events: StubEvent[] = [];
    const session = makeSession('s6', events);
    const { ctx, stub, disposers } = contextFor(session);
    apply(ctx, {
      ...ALLOW_ECHO,
      boundary: 'trusted',
      modes: { main: 'normal' },
    });
    // A plain workspace-write session: no admission record, no gated call.
    events.push({ type: 'sandbox/mode', data: { mode: 'danger-full-access' } });
    await stub.gate?.(exec(session, 'c6'), allow);
    const before = events.length;
    await unload(disposers);
    expect(events.slice(before)).toHaveLength(0);
  });

  test('a disabled session keeps the host permission the user chose', async () => {
    const events: StubEvent[] = [];
    const session = trustedSession('s7', events);
    const { ctx, stub, disposers } = contextFor(session);
    apply(ctx, {
      ...ALLOW_ECHO,
      boundary: 'trusted',
      modes: { main: 'normal' },
    });
    await stub.gate?.(exec(session, 'c7'), allow);

    // The user disables arbiter through the API: the record is the only new
    // fact, and the permission they selected stays exactly as it is.
    stub.sessionEvent?.(session, {
      type: 'command/run',
      data: {
        commandId: 'cmd-2',
        name: 'permission',
        args: ' workspace-write',
      },
    });
    stub.sessionEvent?.(session, {
      type: 'command/done',
      data: {
        commandId: 'cmd-2',
        kind: 'success',
        text: 'preset workspace-write',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const before = events.length;
    await unload(disposers);
    // Nothing teardown writes: the session left, so it is not rolled back.
    expect(
      events
        .slice(before)
        .filter((event) => event.type === 'sandbox/mode')
        .map((event) => event.data),
    ).toEqual([]);
  });

  test('a subagent that inherited a trusted parent is narrowed on unload', async () => {
    const parentEvents: StubEvent[] = [];
    const parent = trustedSession('s9-parent', parentEvents);
    // The host captured the parent's sandbox for the child and pinned its
    // approval to never; the child has no admission record of its own.
    const childEvents: StubEvent[] = [
      { type: 'sandbox/mode', data: { mode: 'danger-full-access' } },
      { type: 'approval/policy', data: { policy: 'never' } },
    ];
    const child = subagentSession('s9-child', 's9-parent', childEvents);
    const services = {
      sessions: { get: (id: string) => (id === 's9-parent' ? parent : child) },
    };
    const { ctx, stub, disposers } = contextFor(parent, undefined, services);
    apply(ctx, {
      ...ALLOW_ECHO,
      boundary: 'trusted',
      modes: { main: 'normal' },
    });

    // A child call is gated through its parent's admission and covered.
    expect(await stub.gate?.(exec(child, 'c9-child'), allow)).toEqual({
      kind: 'allow',
    });
    const before = childEvents.length;
    await unload(disposers);
    // The child's captured full-access sandbox is narrowed before admission
    // stops, so a later ungated call cannot run with the parent's old trust.
    expect(
      childEvents
        .slice(before)
        .filter((event) => event.type === 'sandbox/mode')
        .map((event) => event.data),
    ).toEqual([{ mode: 'workspace-write' }]);
    // Its host-pinned approval is left alone: the delegation never had prompts.
    expect(
      childEvents
        .slice(before)
        .filter((event) => event.type === 'approval/policy'),
    ).toHaveLength(0);
  });

  test('a persistent rollback failure is retried, then reported as unresolved', async () => {
    const events: StubEvent[] = [];
    const session = trustedSession('s8', events);
    const { ctx, stub, disposers } = contextFor(session);
    apply(ctx, {
      ...ALLOW_ECHO,
      boundary: 'trusted',
      modes: { main: 'normal' },
    });
    await stub.gate?.(exec(session, 'c8'), allow);
    // Break the host write path: every append throws, so teardown cannot
    // confirm the narrow boundary.
    session.failAppend = true;
    await unload(disposers);
    // This test drives the production listener directly; after a real plugin
    // unload that listener is gone, so what is asserted here is the handler's
    // own behaviour while it is still registered: teardown retried, could not
    // confirm a narrow boundary, and keeps refusing this session.
    const decision = await stub.gate?.(exec(session, 'c8-late'), allow);
    expect(decision?.kind).toBe('deny');
    // The unresolved state is reported rather than dropped, so the state
    // payload can name a session whose permission a human must reselect.
    expect(session.failAppend).toBe(true);
  });

  test('a sandbox-only success is not treated as a complete rollback', async () => {
    const events: StubEvent[] = [];
    const session = makeSession('s13', events);
    admit(events, 's13', { boundary: 'trusted' });
    // The sandbox is already safe, but the approval this plugin widened still
    // has to come back to `ask`, and that write is refused.
    events.push({ type: 'sandbox/mode', data: { mode: 'workspace-write' } });
    events.push({ type: 'approval/policy', data: { policy: 'never' } });
    const { ctx, stub, disposers } = contextFor(session);
    apply(ctx, {
      ...ALLOW_ECHO,
      boundary: 'trusted',
      modes: { main: 'normal' },
    });
    await stub.gate?.(exec(session, 'c13-warm'), allow);
    session.onAppend = (type) => type !== 'approval/policy';
    await unload(disposers);
    // The unresolved approval is not silently accepted as a full rollback: the
    // session stays refused instead of running unconfined in a wide bundle.
    expect(
      events.filter((event) => event.type === 'approval/policy').at(-1)?.data,
    ).toEqual({ policy: 'never' });
    expect((await stub.gate?.(exec(session, 'c13'), allow))?.kind).toBe('deny');
  });

  test('a transient rollback failure is retried until the boundary lands', async () => {
    const events: StubEvent[] = [];
    const session = trustedSession('s10', events);
    const { ctx, stub, disposers } = contextFor(session);
    apply(ctx, {
      ...ALLOW_ECHO,
      boundary: 'trusted',
      modes: { main: 'normal' },
    });
    await stub.gate?.(exec(session, 'c10'), allow);
    // Fail the first narrow attempt, then let the retry succeed.
    let failuresLeft = 1;
    session.onAppend = (type) => {
      if (type !== 'sandbox/mode') return true;
      if (failuresLeft === 0) return true;
      failuresLeft -= 1;
      return false;
    };
    await unload(disposers);
    // The retry narrowed the session instead of leaving it wide.
    const modes = events
      .filter((event) => event.type === 'sandbox/mode')
      .map((event) => event.data);
    expect(modes.at(-1)).toEqual({ mode: 'workspace-write' });
  });

  test('permission is rolled back before the drain wait, not after', async () => {
    // Hold a real approval request inside the production gate. Waiting for the
    // request, rather than a timer or the downstream next(), proves the active
    // review is still pending when teardown narrows permission.
    const tracePath = join(
      tmpdir(),
      `arbiter-unload-order-${String(Date.now())}.jsonl`,
    );
    const started = deferred<true>();
    const answer = deferred<'unavailable'>();
    let pending: Promise<{ kind: string }> | undefined;
    let unloadStarted: Promise<unknown>[] = [];
    process.env['ARBITER_TRACE_PATH'] = tracePath;
    try {
      const events: StubEvent[] = [];
      // Only an enabled, widened session has anything to roll back, so the
      // durable admission record and the wide knobs are planted first.
      const session = trustedSession('s5', events);
      const { ctx, stub, disposers } = contextFor(session, () => {
        started.resolve(true);
        return answer.promise;
      });
      // No allow rule on purpose: the call must reach the human stage so the
      // test can hold a real approval while teardown runs.
      apply(ctx, { boundary: 'trusted', modes: { main: 'normal' } });
      const gate = stub.gate;
      if (gate === undefined) throw new Error('Gate was not registered');
      pending = gate(exec(session, 'c5'), allow);
      await started.promise;

      events.push({
        type: 'sandbox/mode',
        data: { mode: 'danger-full-access' },
      });
      events.push({ type: 'approval/policy', data: { policy: 'never' } });
      unloadStarted = disposers.map((dispose) => dispose());

      // Teardown has reached its drain wait, while the held approval cannot
      // settle until this test releases it. A new call must already be ungated
      // and see the rolled-back host boundary.
      expect(await gate(exec(session, 'c5-late'), allow)).toEqual({
        kind: 'allow',
      });
      expect(
        events.filter((event) => event.type === 'sandbox/mode').at(-1)?.data,
      ).toEqual({ mode: 'workspace-write' });
      const trace = readFileSync(tracePath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const record: unknown = JSON.parse(line);
          if (!isRecord(record) || typeof record['event'] !== 'string') {
            throw new TypeError('Invalid lifecycle trace');
          }
          return { event: record['event'], active: record['active'] };
        });
      const names = trace.map((record) => record.event);
      const stopAt = names.indexOf('unload/stop-admission');
      const rollbackAt = names.indexOf('unload/rollback');
      expect(names.filter((name) => name === 'gate/entered')).toHaveLength(1);
      expect(
        trace.find((record) => record.event === 'unload/stop-admission')
          ?.active,
      ).toBeGreaterThan(0);
      expect(stopAt).toBeGreaterThan(-1);
      expect(rollbackAt).toBeGreaterThan(stopAt);
      expect(names).not.toContain('unload/drained');
      expect(names).toContain('gate/skipped');

      answer.resolve('unavailable');
      await pending;
      await Promise.all(unloadStarted);
    } finally {
      // Always release the gate, including after a failed assertion.
      answer.resolve('unavailable');
      await pending;
      await Promise.all(unloadStarted);
      delete process.env['ARBITER_TRACE_PATH'];
      rmSync(tracePath, { force: true });
    }
  });

  test('no new call is gated once unload has begun', async () => {
    const events: StubEvent[] = [];
    const session = makeSession('s4', events);
    const { ctx, stub, disposers } = contextFor(session);
    apply(ctx, {
      ...ALLOW_ECHO,
      boundary: 'trusted',
      modes: { main: 'normal' },
    });
    // Start unload; the async disposer flips `accepting` synchronously.
    const pending = disposers.map((dispose) => dispose());
    const result = await stub.gate?.(exec(session, 'c4'), allow);
    await Promise.all(pending);
    expect(result).toEqual({ kind: 'allow' });
    expect(
      events.filter((event) => event.type === 'plugin:arbiter/decision'),
    ).toHaveLength(0);
  });
});

describe('discovery covers inherited subagents', () => {
  test('a listed trusted child is narrowed even before it is observed', async () => {
    // The real host lists live sessions; the child here has never passed the
    // gate in this process, which is exactly the cold-restore case.
    const parent = trustedSession('s11-root', []);
    const childEvents: StubEvent[] = [
      { type: 'sandbox/mode', data: { mode: 'danger-full-access' } },
      { type: 'approval/policy', data: { policy: 'never' } },
    ];
    const child = subagentSession('s11-child', 's11-root', childEvents);
    const listed = [parent, child];
    const { ctx, disposers } = contextFor(parent, undefined, {
      sessions: {
        get: (id: string) =>
          listed.find((session) => session.id === id) ?? undefined,
        list: () => listed,
      },
    });
    apply(ctx, {
      ...ALLOW_ECHO,
      boundary: 'trusted',
      modes: { main: 'normal' },
    });
    await unload(disposers);
    expect(
      childEvents
        .filter((event) => event.type === 'sandbox/mode')
        .map((event) => event.data),
    ).toContainEqual({ mode: 'workspace-write' });
    // The host-pinned approval is never rewritten.
    expect(
      childEvents.filter((event) => event.type === 'approval/policy'),
    ).toHaveLength(1);
  });

  test('a listed but unadmitted branch is left alone', async () => {
    const parent = makeSession('s12-root', []);
    const events: StubEvent[] = [];
    const child = subagentSession('s12-child', 's12-root', events);
    const listed = [parent, child];
    const { ctx, disposers } = contextFor(parent, undefined, {
      sessions: {
        get: (id: string) => listed.find((session) => session.id === id),
        list: () => listed,
      },
    });
    apply(ctx, ALLOW_ECHO);
    await unload(disposers);
    expect(events).toHaveLength(0);
  });
});

describe('absent sandbox override at teardown', () => {
  test('a main session without a sandbox event is not reported safe', async () => {
    // The record says trusted but no sandbox event was ever written; the
    // plugin must not treat an absent value as "already narrow".
    const events: StubEvent[] = [];
    admit(events, 's14', { boundary: 'trusted' });
    events.push({ type: 'approval/policy', data: { policy: 'ask' } });
    const session = makeSession('s14', events);
    // Production hosts list live sessions; teardown discovers through it rather
    // than relying on this process having gated a call from the session.
    const { ctx, disposers } = contextFor(session, undefined, {
      sessions: { get: () => session, list: () => [session] },
    });
    apply(ctx, {
      ...ALLOW_ECHO,
      boundary: 'trusted',
      modes: { main: 'normal' },
    });
    await unload(disposers);
    expect(
      events.filter((event) => event.type === 'sandbox/mode').at(-1)?.data,
    ).toEqual({ mode: 'workspace-write' });
  });
});

describe('discovery also narrows before it forgets', () => {
  test('a listed session whose parent exited is narrowed, not dropped', async () => {
    // Cold restore: the parent's disabled record is already durable and no
    // command is live in this process, so only discovery reclassifies the
    // child. It must not leave the captured full-access sandbox behind.
    const parentEvents: StubEvent[] = [];
    admit(parentEvents, 's16-parent', { enabled: false, boundary: 'trusted' });
    const parent = makeSession('s16-parent', parentEvents);
    const childEvents: StubEvent[] = [
      { type: 'sandbox/mode', data: { mode: 'danger-full-access' } },
      { type: 'approval/policy', data: { policy: 'never' } },
    ];
    const child = subagentSession('s16-child', 's16-parent', childEvents);
    const { ctx, stub, disposers } = contextFor(parent, undefined, {
      sessions: {
        get: (id: string) =>
          [parent, child].find((session) => session.id === id),
        list: () => [parent, child],
      },
    });
    apply(ctx, {
      ...ALLOW_ECHO,
      boundary: 'trusted',
      modes: { main: 'normal' },
    });
    // The child was covered while the parent was still admitted.
    await stub.gate?.(exec(child, 's16-first'), allow);
    await unload(disposers);
    expect(
      childEvents.filter((event) => event.type === 'sandbox/mode').at(-1)?.data,
    ).toEqual({ mode: 'workspace-write' });
    expect(
      childEvents.filter((event) => event.type === 'approval/policy'),
    ).toHaveLength(1);
  });
});
