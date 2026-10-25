import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { apply } from '../src/index.js';
import type { ContextLike } from '../src/index.js';

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
  readonly snapshotEvents: () => readonly unknown[];
  readonly append: (type: string, data: unknown) => void;
}

type Gate = (
  exec: unknown,
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
    snapshotEvents: () => events,
    append(type: string, data: unknown) {
      events.push({ type, data });
    },
  };
}

/**
 * Assemble a stub context for `apply()`.
 *
 * `ContextLike.get` is a list of exact overloads, which a permissive test
 * double cannot satisfy structurally. This factory is the single documented
 * place where a plain services table is adapted to that interface; every
 * handler member is still checked by the object literal below.
 */
type StubMembers = {
  on: (event: string, handler: (...args: never[]) => unknown) => () => void;
  effect: (fn: () => unknown) => void;
  inject: () => undefined;
  logger: { info: () => void; warn: () => void; error: () => void };
};

function stubContext(
  members: StubMembers,
  services: Record<string, unknown>,
): ContextLike {
  // The services table answers every overload of `get`; the plugin only reads
  // the keys this test seeds.
  const get = (key: string): unknown => services[key];
  return { ...members, get } as unknown as ContextLike;
}

function isGate(value: unknown): value is Gate {
  return typeof value === 'function';
}

function isSessionEvent(value: unknown): value is SessionEvent {
  return typeof value === 'function';
}

function contextFor(session: StubSession): {
  ctx: ContextLike;
  stub: { gate?: Gate; sessionEvent?: SessionEvent };
  disposers: (() => Promise<unknown>)[];
} {
  const stub: { gate?: Gate; sessionEvent?: SessionEvent } = {};
  const disposers: (() => Promise<unknown>)[] = [];
  const services: Record<string, unknown> = {
    sandboxPolicy: { defaultMode: 'workspace-write' },
    sessions: { get: () => session, list: () => [session] },
    approval: { config: { policy: 'ask' } },
    permissionPresets: { registerAuto: () => () => {} },
    workingDirectory: { ensure: () => Promise.resolve(process.cwd()) },
  };

  // The handler signatures are the plugin's own; this builder is the single
  // place that names them, so no call site needs a cast.
  type Listener = (...args: never[]) => unknown;
  const ctx = stubContext(
    {
      on(event: string, handler: Listener) {
        if (event === 'tools/pre-execute' && isGate(handler))
          stub.gate = handler;
        if (event === 'session/event' && isSessionEvent(handler)) {
          stub.sessionEvent = handler;
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
    // Regression for a real escape: with rollback after the drain, a call that
    // arrived once admission stopped ran under the OLD permission (still
    // danger-full-access) because no rollback had been written yet. The session
    // log proves the order: the rollback event must be appended while an
    // in-flight call is still active.
    // The trace is the authoritative ordering witness: it is written by the
    // production disposer itself, so this asserts the real sequence rather than
    // a side effect that a differently-ordered implementation could mimic.
    const tracePath = join(
      tmpdir(),
      `arbiter-unload-order-${String(Date.now())}.jsonl`,
    );
    process.env['ARBITER_TRACE_PATH'] = tracePath;
    try {
      const events: StubEvent[] = [];
      const session = makeSession('s5', events);
      const { ctx, stub, disposers } = contextFor(session);
      apply(ctx, { modes: { main: 'normal' } });

      // Gate one call and hold it inside the gate, so `active` stays > 0
      // while the unload disposer runs.
      let releaseGate: (() => void) | undefined;
      const holdingNext = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      const pending = stub.gate?.(exec(session, 'c5'), async () => {
        await holdingNext;
        return { kind: 'allow' };
      });

      events.push({
        type: 'sandbox/mode',
        data: { mode: 'danger-full-access' },
      });
      events.push({ type: 'approval/policy', data: { policy: 'never' } });
      const unloadStarted = disposers.map((dispose) => dispose());

      // Let the disposer reach its first await.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const tracelines = readFileSync(tracePath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event: string });
      const names = tracelines.map((e) => e.event);
      const stopAt = names.indexOf('unload/stop-admission');
      const rollbackAt = names.indexOf('unload/rollback');
      const drainedAt = names.indexOf('unload/drained');
      // The gate was entered, so the drain would have waited for it.
      expect(names).toContain('gate/entered');
      expect(stopAt).toBeGreaterThan(-1);
      // The point: rollback happens while the call is still in flight, before
      // the drain wait finishes.
      expect(rollbackAt).toBeGreaterThan(stopAt);
      expect(drainedAt === -1 || drainedAt > rollbackAt).toBe(true);

      releaseGate?.();
      await pending;
      await Promise.all(unloadStarted);
    } finally {
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
