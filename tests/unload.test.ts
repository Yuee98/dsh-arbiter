import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { apply } from '../src/index.js';
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
 *   - a session the plugin gated is rolled back to workspace-write + ask;
 *   - a session that already sits at workspace-write + ask gets no new event;
 *   - a session the user moved to another preset is left alone;
 *   - no new call is gated once unload has begun.
 *
 * The stub records the two handlers the plugin registers, widened to their
 * public parameter types, so the test never needs a cast at a call site.
 */

interface StubEvent {
  type: string;
  data: unknown;
}

interface StubSession {
  readonly id: string;
  readonly header: { readonly cwd: string };
  readonly snapshotEvents: () => readonly SessionEventLike[];
  readonly append: (type: string, data: unknown) => void;
}

type Gate = (
  exec: ToolExecutionLike,
  next: () => Promise<{ kind: string }>,
) => Promise<{ kind: string }>;

type SessionEvent = (session: unknown, event: Record<string, unknown>) => void;

function makeSession(
  id: string,
  events: StubEvent[] = [],
): StubSession & { id: string } {
  return {
    id,
    header: { cwd: process.cwd() },
    snapshotEvents: () => events.map((event, seq) => ({ ...event, seq })),
    append(type: string, data: unknown) {
      events.push({ type, data });
    },
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
): {
  ctx: ContextLike;
  stub: { gate?: Gate; sessionEvent?: SessionEvent };
  disposers: (() => Promise<unknown>)[];
} {
  const stub: { gate?: Gate; sessionEvent?: SessionEvent } = {};
  const disposers: (() => Promise<unknown>)[] = [];
  const services: StubServices = {
    sandboxPolicy: { defaultMode: 'workspace-write' },
    sessions: { get: () => session },
    approval: {
      config: { policy: 'ask' },
      request: approvalRequest,
    },
    permissionPresets: { registerAuto: () => () => {} },
    workingDirectory: { ensure: () => Promise.resolve(process.cwd()) },
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
    services,
  );

  return { ctx, stub, disposers };
}

const allow = (): Promise<{ kind: string }> =>
  Promise.resolve({ kind: 'allow' });
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
  test('a gated session is rolled back to workspace-write + ask', async () => {
    const events: StubEvent[] = [];
    const session = makeSession('s1', events);
    const { ctx, stub, disposers } = contextFor(session);
    apply(ctx, { modes: { main: 'normal' } });

    await stub.gate?.(exec(session, 'c1'), allow);

    // Widen the permission as a trusted boundary would, then unload.
    events.push({ type: 'sandbox/mode', data: { mode: 'danger-full-access' } });
    events.push({ type: 'approval/policy', data: { policy: 'never' } });

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
    const session = makeSession('s2', events);
    const { ctx, stub, disposers } = contextFor(session);
    apply(ctx, { modes: { main: 'normal' } });
    await stub.gate?.(exec(session, 'c2'), allow);
    const before = events.length;
    await unload(disposers);
    expect(events.length).toBe(before);
  });

  test('a session the user moved to read-only is not rewritten', async () => {
    const events: StubEvent[] = [];
    const session = makeSession('s3', events);
    const { ctx, stub, disposers } = contextFor(session);
    apply(ctx, { modes: { main: 'normal' } });
    await stub.gate?.(exec(session, 'c3'), allow);

    // The user switches away: the preset event is what releases management.
    events.push({ type: 'sandbox/mode', data: { mode: 'read-only' } });
    stub.sessionEvent?.(session, {
      type: 'permission/preset',
      data: { preset: 'read-only' },
    });

    const before = events.length;
    await unload(disposers);
    expect(events.slice(before)).toHaveLength(0);
    const modes = events.filter((event) => event.type === 'sandbox/mode');
    expect(modes.at(-1)?.data).toEqual({ mode: 'read-only' });
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
      const session = makeSession('s5', events);
      const { ctx, stub, disposers } = contextFor(session, () => {
        started.resolve(true);
        return answer.promise;
      });
      apply(ctx, { modes: { main: 'normal' } });
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
    apply(ctx, { modes: { main: 'normal' } });
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
