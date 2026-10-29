/**
 * Gate + reviewer integration for review input.
 *
 * What is pinned here:
 *   - a long pending program is trimmed and still reaches a normal review, with
 *     the same stage chain as a short one (truncation adds no chain token and no
 *     error-escalate);
 *   - the snapshot persisted for the call is the structure that was actually
 *     submitted, not a later re-read of the session;
 *   - a sibling subagent's verdicts never enter this session's prior verdicts,
 *     while the parent's original words remain readable as their own source.
 */

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

import { AuditStore } from '../../src/audit.js';
import { apply } from '../../src/index.js';
import { installSessionRecordApi } from '../../src/records.js';
import {
  admitSession,
  recordingSessionApi,
} from '../helpers/session-records.js';
import type {
  ConnectionLike,
  ContextLike,
  HostServices,
  ProfileContextLike,
  ToolExecutionLike,
} from '../../src/host/types.js';
import type { SessionEventLike } from '../../src/snapshot.js';
import { renderRequest } from '../../src/reviewer.js';
import type { ReviewSnapshot } from '../../src/types.js';

const homes: string[] = [];
let previousHome: string | undefined;

beforeEach(async () => {
  previousHome = process.env['DSH_HOME'];
  const home = await mkdtemp(join(tmpdir(), 'arbiter-snapshot-gate-'));
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
  /** The session's committed log, as the host appends to it. */
  readonly events: SessionEventLike[];
  readonly append: (type: string, data: unknown) => void;
  readonly snapshotEvents: () => readonly SessionEventLike[];
  requestHeader(): {
    readonly config: { readonly provider: string; readonly model: string };
  };
}

/**
 * The plugin writes admission through the host's record writer. These cases
 * need an enabled session to reach the gate at all, so the tests install the
 * same-contract double once and let the production writer path run.
 */
beforeAll(() => {
  installSessionRecordApi(recordingSessionApi());
});

afterAll(() => {
  installSessionRecordApi(null);
});

function makeSession(
  id: string,
  log: readonly SessionEventLike[],
  parentSession?: string,
): StubSession {
  // This harness needs a session the plugin can admit itself through: a real
  // host would carry the user's switch as an ignorable plugin record, so the
  // stub log grows the same way and the plugin's own writer gets a target.
  const events: SessionEventLike[] = [...log];
  return {
    id,
    header: {
      id,
      cwd: process.cwd(),
      ...(parentSession === undefined
        ? {}
        : { parentSession, origin: 'subagent' }),
    },
    events,
    append(type: string, data: unknown) {
      events.push({
        type,
        seq: events.length,
        data,
        ignorable: type.startsWith('plugin:'),
      });
    },
    snapshotEvents: () => events,
    requestHeader: () => ({ config: { provider: 'stub', model: 'stub' } }),
  };
}

function human(seq: number, time: number, text: string): SessionEventLike {
  return {
    seq,
    time,
    type: 'user/message',
    data: {
      source: { kind: 'user', rpcId: `rpc-${String(seq)}` },
      content: [{ type: 'text', text }],
    },
  };
}

interface Captured {
  system: string;
  user: string;
}

/** One stub model stream that records the exact request it received. */
function reviewerLlm(answer: { risk: number; authorized: number }): {
  llm: HostServices['llm'];
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const text = JSON.stringify({
    risk: answer.risk,
    authorized: answer.authorized,
    secrets: false,
    destructive: false,
    egress: false,
    bulk: false,
  });
  return {
    captured,
    llm: {
      stream: (options) => {
        captured.push({
          system: options.system,
          user: options.messages[0]?.content[0]?.text ?? '',
        });
        return (async function* () {
          await Promise.resolve();
          yield { type: 'text-delta', text };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type Gate = (
  exec: ToolExecutionLike,
  next: () => Promise<{ kind: string }>,
) => Promise<{ kind: string }>;

function stubContext(services: Record<string, unknown>): {
  ctx: ContextLike;
  gate: () => Gate;
  emit: (session: StubSession, event: SessionEventLike) => void;
} {
  let gate: Gate | undefined;
  const sessionListeners: ((
    session: StubSession,
    event: SessionEventLike,
  ) => void)[] = [];
  const registry = services;
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
    return registry[key];
  }
  type Listener = (...args: never[]) => unknown;
  const ctx: ContextLike = {
    get,
    on(event: string, listener: Listener) {
      if (event === 'session/event') {
        // The observer is invoked reflectively by the host, so its declared
        // parameter list is not the shape this harness calls it with.
        sessionListeners.push((target, payload) => {
          Reflect.apply(listener, undefined, [target, payload]);
        });
        return () => undefined;
      }
      if (event !== 'tools/pre-execute') return () => undefined;
      gate = async (execution, next) => {
        const decision: unknown = await Reflect.apply(listener, undefined, [
          execution,
          next,
        ]);
        if (!isRecord(decision) || typeof decision['kind'] !== 'string') {
          throw new TypeError('Gate returned an invalid decision');
        }
        return { ...decision, kind: decision['kind'] };
      };
      return () => undefined;
    },
    effect() {
      return undefined;
    },
    inject() {
      return undefined;
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
  return {
    ctx,
    gate: () => {
      if (gate === undefined) throw new Error('gate was not registered');
      return gate;
    },
    emit(session, event) {
      for (const listener of sessionListeners) listener(session, event);
    },
  };
}

const allow = (): Promise<{ kind: string }> =>
  Promise.resolve({ kind: 'allow' });

/** Structural check for the documented ReviewSnapshot shape. */
function isReviewSnapshot(value: unknown): value is ReviewSnapshot {
  if (!isRecord(value)) return false;
  if (value['version'] !== 1) return false;
  const action = value['action'];
  const budget = value['budget'];
  if (!isRecord(action) || !isRecord(budget)) return false;
  for (const key of [
    'callId',
    'sessionId',
    'sessionKind',
    'tool',
    'cwd',
  ] as const) {
    if (typeof value[key] !== 'string') return false;
  }
  for (const key of [
    'materials',
    'evidence',
    'context',
    'checkpoints',
    'priorVerdicts',
    'missing',
  ] as const) {
    if (!Array.isArray(value[key])) return false;
  }
  return (
    typeof budget['maxInputTokens'] === 'number' &&
    Array.isArray(budget['truncatedSegments'])
  );
}

/** The persisted trace stages of one call, in order. */
interface StageRecord {
  readonly stage: string;
  readonly result: string;
  readonly reason?: string;
}

function isStageList(value: unknown): value is readonly StageRecord[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry['stage'] === 'string' &&
        typeof entry['result'] === 'string',
    )
  );
}

interface StoredCall {
  readonly snapshot: ReviewSnapshot;
  readonly trace: readonly StoredTraceStage[];
}

/** Read back the snapshot and stage list the audit store actually persisted. */
async function persistedCall(callId: string): Promise<StoredCall> {
  const store = new AuditStore(
    join(process.env['DSH_HOME'] ?? '', 'arbiter', 'arbiter.db'),
    {
      enabled: true,
      retentionDays: 30,
      retentionBytes: 1_073_741_824,
      maxQueue: 500,
    },
  );
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const row: unknown = store.getCall(callId);
      if (isRecord(row)) {
        const snapshot = row['snapshot'];
        const stages = row['stages'];
        if (isReviewSnapshot(snapshot) && isStageList(stages)) {
          return { snapshot, trace: stages };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no persisted snapshot for ${callId}`);
  } finally {
    store.close();
  }
}

interface StoredTraceStage {
  readonly stage: string;
  readonly result: string;
  readonly reason?: string;
}

interface RunOptions {
  readonly session: StubSession;
  readonly sessions: Record<string, StubSession>;
  readonly maxInputTokens: number;
  readonly name: string;
  readonly callId: string;
  readonly tool: string;
  readonly args: unknown;
}

async function reviewCall(options: RunOptions): Promise<{
  readonly decision: { readonly kind: string };
  readonly captured: Captured[];
  readonly snapshot: ReviewSnapshot;
  readonly trace: readonly StoredTraceStage[];
}> {
  const reviewer = reviewerLlm({ risk: 3, authorized: 8 });
  const { ctx, gate } = stubContext({
    profileContext: {
      home: process.env['DSH_HOME'] ?? '',
      dir: process.cwd(),
      name: options.name,
    },
    sandboxPolicy: { defaultMode: 'workspace-write' },
    sessions: {
      get: (id: string) =>
        id === options.session.id ? options.session : options.sessions[id],
    },
    llm: reviewer.llm,
    approval: {
      config: { policy: 'ask' },
      request: () => Promise.resolve('unavailable'),
    },
    permissionPresets: { registerAuto: () => () => undefined },
    workingDirectory: { ensure: () => Promise.resolve(process.cwd()) },
  });
  // The user enabled this session; without that the gate correctly steps
  // aside and none of the review paths below would run.
  admitSession(options.session);
  apply(ctx, {
    modes: { main: 'normal', subagent: 'strict' },
    reviewer: {
      type: 'chat',
      chat: {
        provider: 'session',
        model: '',
        temperature: 0,
        maxTokens: 400,
        timeoutMs: 8_000,
        maxRepairRetries: 1,
      },
    },
    context: { maxInputTokens: options.maxInputTokens },
  });
  const decision: { kind: string } = await gate()(
    {
      callId: options.callId,
      name: options.tool,
      arguments: options.args,
      signal: new AbortController().signal,
      agent: { session: options.session },
    },
    allow,
  );
  const stored = await persistedCall(options.callId);
  return {
    decision,
    captured: reviewer.captured,
    snapshot: stored.snapshot,
    trace: stored.trace,
  };
}

describe('gate review input', () => {
  test('outer run_code and its inner call are gated separately', async () => {
    const events = [human(1, 1, 'run the helper program')];
    const program = 'const r = await tools.bash({ command: "echo inner" });';
    const outer = await reviewCall({
      session: makeSession('outer', events),
      sessions: {},
      maxInputTokens: 200_000,
      name: 'outer-profile',
      callId: 'call-outer',
      tool: 'run_code',
      args: { code: program, description: 'inner call' },
    });
    const inner = await reviewCall({
      session: makeSession('outer', events),
      sessions: {},
      maxInputTokens: 200_000,
      name: 'outer-profile',
      callId: 'call-outer:inner:1',
      tool: 'bash',
      args: { command: 'echo inner' },
    });
    // Two independent admissions, each with its own snapshot and chain.
    expect(outer.snapshot.callId).toBe('call-outer');
    expect(outer.snapshot.tool).toBe('run_code');
    expect(inner.snapshot.callId).toBe('call-outer:inner:1');
    expect(inner.snapshot.tool).toBe('bash');
    expect(outer.snapshot.action.truncated).toBeUndefined();
    expect(outer.trace.map((stage) => stage.stage)).toContain('review');
    expect(inner.trace.map((stage) => stage.stage)).toContain('review');
    // The inner call is not folded into the outer snapshot's prior verdicts.
    expect(inner.snapshot.priorVerdicts).toEqual([]);
  });

  test('a long program is trimmed, still reviewed, and keeps the stage chain', async () => {
    const events = [human(1, 1, 'run the helper program')];
    const program = 'console.log("payload");\n'.repeat(3_000);
    const large = await reviewCall({
      session: makeSession('long', events),
      sessions: {},
      maxInputTokens: 2_000,
      name: 'long-input',
      callId: 'call-long',
      tool: 'run_code',
      args: { code: program, description: 'helper' },
    });
    expect(large.decision.kind).toBe('allow');
    expect(large.captured).toHaveLength(1);
    const snapshot = large.snapshot;
    expect(snapshot.action.truncated?.field).toBe('code');
    expect(snapshot.budget.truncatedSegments).toContain('ACTION');
    // The submitted text is what was rendered from this snapshot, including the
    // truncation facts the reviewer was told about.
    const rendered = renderRequest(snapshot);
    expect(large.captured[0]?.system).toBe(rendered.system);
    expect(large.captured[0]?.user).toBe(rendered.user);
    expect(large.captured[0]?.user).toContain('"field": "code"');

    const small = await reviewCall({
      session: makeSession('short', events),
      sessions: {},
      maxInputTokens: 200_000,
      name: 'small-input',
      callId: 'call-short',
      tool: 'run_code',
      args: { code: 'console.log("small")', description: 'helper' },
    });
    expect(small.snapshot.action.truncated).toBeUndefined();
    // Same review chain: truncation is not a stage and not an error escalate.
    expect(large.trace.map((stage) => stage.result)).toEqual(
      small.trace.map((stage) => stage.result),
    );
    expect(large.trace.map((stage) => stage.stage)).toEqual(
      small.trace.map((stage) => stage.stage),
    );
    expect(large.trace.some((stage) => stage.result === 'error-escalate')).toBe(
      false,
    );
  });

  test('an unsatisfiable request never reaches the reviewer', async () => {
    const events = [human(1, 1, 'clean the build')];
    const run = await reviewCall({
      session: makeSession('tight', events),
      sessions: {},
      // The fixed review contract alone exceeds this budget.
      maxInputTokens: 1_000,
      name: 'tight-profile',
      callId: 'call-tight',
      tool: 'bash',
      args: { command: 'echo hi' },
    });
    expect(run.snapshot.budget.truncatedSegments).toContain('OVER_BUDGET');
    // No model call: a request that cannot be assembled is a preparation
    // failure, not a decision.
    expect(run.captured).toHaveLength(0);
    expect(
      run.trace.some(
        (stage) =>
          stage.stage === 'review' &&
          stage.result === 'error-escalate' &&
          stage.reason === 'input_budget_exceeded',
      ),
    ).toBe(true);
    expect(run.decision.kind).not.toBe('allow');
  });

  test('the persisted snapshot is the submitted structure', async () => {
    const parent = makeSession('parent', [
      human(1, 1, 'delete only /workspace/app/build'),
    ]);
    const child = makeSession(
      'child',
      [
        human(1, 10, 'clean the build directory'),
        {
          seq: 2,
          time: 11,
          type: 'user/message',
          data: {
            source: { kind: 'agent-message', senderSessionId: 'parent' },
            content: [{ type: 'text', text: '父会话确认过范围' }],
          },
        },
      ],
      'parent',
    );
    const run = await reviewCall({
      session: child,
      sessions: { parent },
      maxInputTokens: 200_000,
      name: 'child-profile',
      callId: 'call-child',
      tool: 'bash',
      args: { command: 'rm -rf build' },
    });
    const snapshot = run.snapshot;
    expect(snapshot.parentAuthorizationPresent).toBe(true);
    expect(snapshot.evidence.map((item) => item.source.kind)).toEqual(
      expect.arrayContaining(['session-human', 'parent-human', 'parent-relay']),
    );
    const kinds = snapshot.evidence.map((item) => item.source.kind);
    expect(kinds.indexOf('session-human')).toBeLessThan(
      kinds.indexOf('parent-human'),
    );
    // The stored structure is exactly what the model received, so the detail
    // view cannot show a different input than the review saw.
    const rendered = renderRequest(snapshot);
    expect(run.captured[0]?.system).toBe(rendered.system);
    expect(run.captured[0]?.user).toBe(rendered.user);
    expect(snapshot.materials.map((item) => item.id)).toEqual([
      'project-rules',
      'custom-rules',
    ]);
  });

  test('a sibling verdict is not this session history', async () => {
    const parent = makeSession('parent', [human(1, 1, 'clean the build')]);
    const sibling = makeSession(
      'sibling',
      [human(1, 2, 'clean the build')],
      'parent',
    );
    const target = makeSession(
      'target',
      [human(1, 3, 'clean the build')],
      'parent',
    );
    await reviewCall({
      session: sibling,
      sessions: { parent },
      maxInputTokens: 200_000,
      name: 'sibling-profile',
      callId: 'call-sibling',
      tool: 'bash',
      args: { command: 'rm -rf build' },
    });
    const run = await reviewCall({
      session: target,
      sessions: { parent, sibling },
      maxInputTokens: 200_000,
      name: 'target-profile',
      callId: 'call-target',
      tool: 'bash',
      args: { command: 'rm -rf build' },
    });
    // Same parent, different session: no borrowed verdict, no borrowed denial.
    expect(run.snapshot.priorVerdicts).toEqual([]);
    // The parent's original words are still readable under their own source.
    expect(
      run.snapshot.evidence.some(
        (item) =>
          item.source.kind === 'parent-human' && item.evidence === 'explicit',
      ),
    ).toBe(true);
  });
  test('the current turn is the host turn, not the newest tool call', async () => {
    // Two turns, and the pending call is in the second. The host announces the
    // turn through `turn/start`; the gate reads it there because this call's own
    // event is written only after the decision.
    const events: SessionEventLike[] = [
      { seq: 1, time: 1, type: 'turn/start', data: { turn: 1 } },
      human(2, 1, 'first task'),
      {
        seq: 3,
        time: 2,
        type: 'tool/call',
        data: {
          turn: 1,
          step: 1,
          callId: 'old-1',
          name: 'bash',
          arguments: { command: 'echo old' },
        },
      },
      {
        seq: 4,
        time: 2,
        type: 'tool/result',
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'tool',
            toolCallId: 'old-1',
            isError: false,
            source: { kind: 'tool', callId: 'old-1' },
            content: [{ type: 'text', text: 'old' }],
          },
        },
      },
      {
        seq: 5,
        time: 3,
        type: 'turn/end',
        data: { turn: 1, reason: 'completed' },
      },
      { seq: 6, time: 4, type: 'turn/start', data: { turn: 2 } },
      human(7, 4, 'second task'),
      {
        seq: 8,
        time: 5,
        type: 'tool/call',
        data: {
          turn: 2,
          step: 1,
          callId: 'new-1',
          name: 'bash',
          arguments: { command: 'echo new' },
        },
      },
      {
        seq: 9,
        time: 5,
        type: 'tool/result',
        data: {
          turn: 2,
          step: 1,
          message: {
            role: 'tool',
            toolCallId: 'new-1',
            isError: false,
            source: { kind: 'tool', callId: 'new-1' },
            content: [{ type: 'text', text: 'new' }],
          },
        },
      },
    ];
    const run = await reviewCall({
      session: makeSession('turns', events),
      sessions: {},
      maxInputTokens: 200_000,
      name: 'turns-profile',
      callId: 'call-turns',
      tool: 'bash',
      args: { command: 'echo current' },
    });
    expect(run.snapshot.turn).toBe(2);
    // Only the current turn's call is material; the earlier turn is an
    // ordinary exclusion, and the review still reached the model.
    expect(run.snapshot.context.map((call) => call.arguments)).toEqual([
      '{"command":"echo new"}',
    ]);
    expect(run.snapshot.completeness.status).not.toBe('insufficient');
    expect(run.captured).toHaveLength(1);
    // The submitted payload describes the exclusion, not a missing source.
    expect(run.captured[0]?.user).toContain('"turn": 2');
  });

  test('insufficient material escalates instead of scoring', async () => {
    // A subagent whose direct parent cannot be read: the parent's original
    // words are the only explicit authorization this call could have, and the
    // host cannot supply them. Admission still works because this session's own
    // log is readable — which is exactly the case a real host can reach.
    const child = makeSession(
      'child',
      [
        human(1, 1, 'run the delegated task'),
        {
          seq: 2,
          time: 2,
          type: 'user/message',
          data: {
            source: { kind: 'agent-message', senderSessionId: 'parent' },
            content: [{ type: 'text', text: 'the user approved the deletion' }],
          },
        },
      ],
      'parent',
    );
    const parent = makeSession('parent', [human(1, 1, 'delete build')]);
    const broken = {
      ...parent,
      snapshotEvents: () => {
        throw new Error('parent log unreadable');
      },
    };
    const reviewer = reviewerLlm({ risk: 3, authorized: 8 });
    const { ctx, gate } = stubContext({
      profileContext: {
        home: process.env['DSH_HOME'] ?? '',
        dir: process.cwd(),
        name: 'unreadable-parent',
      },
      sandboxPolicy: { defaultMode: 'workspace-write' },
      sessions: { get: (id: string) => (id === 'parent' ? broken : child) },
      llm: reviewer.llm,
      approval: {
        config: { policy: 'ask' },
        request: () => Promise.resolve('unavailable'),
      },
      permissionPresets: { registerAuto: () => () => undefined },
      workingDirectory: { ensure: () => Promise.resolve(process.cwd()) },
    });
    admitSession(child);
    apply(ctx, {
      modes: { main: 'normal', subagent: 'strict' },
      reviewer: {
        type: 'chat',
        chat: {
          provider: 'session',
          model: '',
          temperature: 0,
          maxTokens: 400,
          timeoutMs: 8_000,
          maxRepairRetries: 1,
        },
      },
      context: { maxInputTokens: 200_000 },
    });
    const decision: { kind: string } = await gate()(
      {
        callId: 'call-unreadable-parent',
        name: 'bash',
        arguments: { command: 'rm -rf build' },
        signal: new AbortController().signal,
        agent: { session: child },
      },
      allow,
    );
    // No model call: an answer to an incomplete submission cannot be a verdict,
    // and spending the request would only produce a number to discard.
    expect(reviewer.captured).toHaveLength(0);
    expect(decision.kind).not.toBe('allow');
    const stored = await persistedCall('call-unreadable-parent');
    const review = stored.trace.find((stage) => stage.stage === 'review');
    expect(review?.result).toBe('review-escalate');
    expect(review?.reason ?? '').toContain('insufficient_material');
    expect(stored.snapshot.completeness.status).toBe('insufficient');
    expect(stored.snapshot.completeness.gaps[0]?.source).toBe('parent-human');
    // The relay is still evidence with its own ceiling, and presence is unknown
    // rather than "the parent never had human input".
    expect(stored.snapshot.evidence[0]?.evidence).toBe('implied');
    expect(stored.snapshot.parentAuthorizationPresent).toBeNull();
    // The persisted structure is what the detail view reads, so both the
    // escalation and the gap are explainable after the fact.
    expect(stored.snapshot.missing.join(' ')).toContain('parent session');
  });
});

describe('the host turn clock', () => {
  test('an announced turn is used, and a closed turn is not', async () => {
    const events = [human(1, 1, 'clean the build')];
    const target = makeSession('clock', events);
    const reviewer = reviewerLlm({ risk: 3, authorized: 8 });
    const { ctx, gate, emit } = stubContext({
      profileContext: {
        home: process.env['DSH_HOME'] ?? '',
        dir: process.cwd(),
        name: 'clock-profile',
      },
      sandboxPolicy: { defaultMode: 'workspace-write' },
      sessions: { get: () => target },
      llm: reviewer.llm,
      approval: {
        config: { policy: 'ask' },
        request: () => Promise.resolve('unavailable'),
      },
      permissionPresets: { registerAuto: () => () => undefined },
      workingDirectory: { ensure: () => Promise.resolve(process.cwd()) },
    });
    admitSession(target);
    apply(ctx, {
      modes: { main: 'normal', subagent: 'strict' },
      reviewer: {
        type: 'chat',
        chat: {
          provider: 'session',
          model: '',
          temperature: 0,
          maxTokens: 400,
          timeoutMs: 8_000,
          maxRepairRetries: 1,
        },
      },
      context: { maxInputTokens: 200_000 },
    });
    // The host announces the turn; the observer runs a microtask later, exactly
    // as it does inside the host's own commit.
    emit(target, { seq: 90, time: 90, type: 'turn/start', data: { turn: 5 } });
    await Promise.resolve();
    await gate()(
      {
        callId: 'call-clock-on',
        name: 'bash',
        arguments: { command: 'echo hi' },
        signal: new AbortController().signal,
        agent: { session: target },
      },
      allow,
    );
    expect((await persistedCall('call-clock-on')).snapshot.turn).toBe(5);

    // A closed turn is no longer current: the next call must not inherit it.
    emit(target, { seq: 91, time: 91, type: 'turn/end', data: { turn: 5 } });
    await Promise.resolve();
    await gate()(
      {
        callId: 'call-clock-off',
        name: 'bash',
        arguments: { command: 'echo hi' },
        signal: new AbortController().signal,
        agent: { session: target },
      },
      allow,
    );
    const after = await persistedCall('call-clock-off');
    // With no announced turn and no turn identity in the log, the snapshot says
    // so rather than reusing the closed number.
    expect(after.snapshot.turn).toBeNull();
    expect(after.snapshot.context).toEqual([]);
  });
});
