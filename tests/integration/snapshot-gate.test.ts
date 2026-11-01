import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { vi } from 'vitest';
import { NEW_SCALE_TYPESAFE } from '../helpers/decision-captures.js';
import {
  renderChatUser,
  renderDecisionRequest,
} from '../../src/reviewer/prompt.js';
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
import { renderChatRequest } from '../../src/reviewer.js';
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
function reviewerLlm(answer: { risk: number; authorization: number }): {
  llm: HostServices['llm'];
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const text = JSON.stringify({
    risk: answer.risk,
    authorization: answer.authorization,
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
  const reviewer = reviewerLlm({ risk: 3, authorization: 8 });
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
    modes: { main: 'ask', subagent: 'no-ask' },
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
      // Above the shared contract's own preamble, so the action is what yields.
      maxInputTokens: 3_400,
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
    const rendered = renderChatRequest(snapshot);
    // The chat transport sends the contract as `system` and the material as the
    // user message; the stub captures only `messages[0]`, which is the material.
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
    const rendered = renderChatRequest(snapshot);
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
    const reviewer = reviewerLlm({ risk: 3, authorization: 8 });
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
      modes: { main: 'ask', subagent: 'no-ask' },
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
    const reviewer = reviewerLlm({ risk: 3, authorization: 8 });
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
      modes: { main: 'ask', subagent: 'no-ask' },
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

/** Actual gate + local HTTP endpoint + production SQLite writer, with synthetic secrets. */
async function credentialEndpoint() {
  const received: { body: unknown; authorization: string | undefined }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push({ body, authorization: request.headers.authorization });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(NEW_SCALE_TYPESAFE));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('no endpoint port');
  return {
    received,
    url: `http://127.0.0.1:${String(address.port)}/decision`,
    stop: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
}
function credentialGate(
  session: StubSession,
  url: string,
  resolve: NonNullable<HostServices['credentials']>['resolve'],
  maxInputTokens = 20_000,
  type: 'chat' | 'decision' = 'decision',
  onEnsure?: () => void,
) {
  const llm = reviewerLlm({ risk: 3, authorization: 8 });
  const stub = stubContext({
    profileContext: {
      home: process.env['DSH_HOME'] ?? '',
      dir: process.cwd(),
      name: 'credential-profile',
    },
    sandboxPolicy: { defaultMode: 'workspace-write' },
    sessions: {
      get: (id: string) => (id === session.id ? session : undefined),
    },
    llm: llm.llm,
    credentials: { resolve },
    approval: {
      config: { policy: 'ask' },
      request: () => Promise.resolve('unavailable'),
    },
    permissionPresets: { registerAuto: () => () => undefined },
    workingDirectory: {
      ensure: () => {
        onEnsure?.();
        return Promise.resolve(process.cwd());
      },
    },
  });
  admitSession(session);
  const host = apply(stub.ctx, {
    modes: { main: 'no-ask', subagent: 'no-ask' },
    reviewer: {
      type,
      chat: { provider: 'stub', model: 'stub', maxRepairRetries: 0 },
      decision: {
        url,
        model: 'test-model',
        apiKeyRef: 'synthetic-reference',
        timeoutMs: 5_000,
      },
    },
    context: { maxInputTokens },
  });
  const run = (
    callId: string,
    args: unknown,
    signal = new AbortController().signal,
  ) =>
    stub.gate()(
      { callId, name: 'bash', arguments: args, signal, agent: { session } },
      allow,
    );
  return { host, run, captured: llm.captured };
}
describe('credential preparation at actual production boundaries', () => {
  test('late-known credential is removed before every cap; exact wire snapshot and real auth survive rotation', async () => {
    const secret = 'synthetic-known-boundary-original-credential';
    const endpoint = await credentialEndpoint();
    const events = [
      human(
        1,
        1,
        `${'x'.repeat(3990)}${secret}\nOnly send 4 files to support@example.test`,
      ),
      { type: 'turn/start', seq: 2, data: { turn: 1 } },
    ];
    const session = makeSession('credential-root', events);
    const resolve = vi.fn(() =>
      Promise.resolve({
        value:
          resolve.mock.calls.length === 1
            ? secret
            : 'rotated-should-never-be-resolved',
      }),
    );
    const harness = credentialGate(session, endpoint.url, resolve);
    const args = {
      command: `printf '${secret}'`,
      count: 4,
      recipient: 'support@example.test',
      path: '/tmp/key-document',
    };
    try {
      await harness.run('credential-wire', args);
      await harness.host.currentAudit()?.flush();
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(endpoint.received).toHaveLength(1);
      expect(endpoint.received[0]?.authorization).toBe(`Bearer ${secret}`);
      const wire = endpoint.received[0]?.body;
      expect(JSON.stringify(wire)).not.toContain(secret);
      expect(JSON.stringify(wire)).not.toContain('synthetic-known-boundary');
      expect(JSON.stringify(wire)).toContain('support@example.test');
      expect(JSON.stringify(wire)).toContain('/tmp/key-document');
      const stored = await persistedCall('credential-wire');
      expect(wire).toMatchObject({
        state: renderDecisionRequest(renderChatUser(stored.snapshot)).state,
      });
      expect(stored.snapshot.evidence[0]?.source).toEqual({
        kind: 'session-human',
        sessionId: session.id,
      });
      expect(stored.snapshot.action.arguments).toMatchObject({
        count: 4,
        recipient: 'support@example.test',
        path: '/tmp/key-document',
      });
      expect(args.command).toContain(secret);
      const db = new DatabaseSync(
        harness.host.currentAudit()?.databasePath ?? '',
      );
      try {
        for (const table of ['calls', 'stages', 'snapshots', 'model_calls']) {
          const rows = db.prepare(`SELECT * FROM ${table}`).all();
          expect(rows.length).toBeGreaterThan(0);
          expect(JSON.stringify(rows)).not.toContain(secret);
          expect(JSON.stringify(rows)).not.toContain(
            'synthetic-known-boundary',
          );
        }
      } finally {
        db.close();
      }
    } finally {
      harness.host.currentAudit()?.close();
      await endpoint.stop();
    }
  });
  test.each([
    ['M0', 'deny', 'insufficient'],
    ['OVER_BUDGET', 'deny', 'input_budget_exceeded'],
    ['breaker', 'deny', 'circuit_open'],
    ['chat', 'allow', 'review-allow'],
  ] as const)(
    '%s does not resolve decision credentials',
    async (path, expectedKind, expectedCode) => {
      const session = makeSession(`early-${path}`, [
        human(1, 1, 'only inspect local files'),
      ]);
      let unreadable = false;
      const target =
        path === 'M0'
          ? {
              ...session,
              snapshotEvents: (): readonly SessionEventLike[] => {
                if (unreadable) throw new Error('source unavailable');
                return session.snapshotEvents();
              },
            }
          : session;
      const resolve = vi.fn(() =>
        Promise.resolve({ value: 'unused-synthetic-credential' }),
      );
      const harness = credentialGate(
        target,
        'http://127.0.0.1:1/unused',
        resolve,
        path === 'OVER_BUDGET' ? 1000 : 20_000,
        path === 'chat' ? 'chat' : 'decision',
        () => {
          unreadable = path === 'M0';
        },
      );
      if (path === 'breaker')
        harness.host.runtime.breakers.set(target.id, {
          denials: Array.from({ length: 20 }, () => Date.now()),
        });
      const controller = new AbortController();
      try {
        const result = await harness.run(
          `early-call-${path}`,
          { command: 'echo local' },
          controller.signal,
        );
        await harness.host.currentAudit()?.flush();
        expect(resolve).not.toHaveBeenCalled();
        expect(result.kind).toBe(expectedKind);
        const raw: unknown = harness.host
          .currentAudit()
          ?.getCall(`early-call-${path}`);
        expect(JSON.stringify(raw)).not.toContain(
          'credential could not be resolved',
        );
        expect(JSON.stringify(raw)).toContain(expectedCode);
      } finally {
        unreadable = false;
        harness.host.currentAudit()?.close();
      }
    },
  );
  test.each(['missing', 'throw'] as const)(
    '%s credential result is reused once and retains review-failure classification',
    async (kind) => {
      const resolve = vi.fn(async () => {
        await Promise.resolve();
        if (kind === 'throw')
          throw new Error('never echo synthetic-secret-lookup-error');
        return undefined;
      });
      const session = makeSession(`credential-${kind}`, [
        human(1, 1, 'inspect files'),
      ]);
      const harness = credentialGate(
        session,
        'http://127.0.0.1:1/unused',
        resolve,
      );
      try {
        await harness.run(`credential-${kind}`, { command: 'echo inspect' });
        await harness.host.currentAudit()?.flush();
        expect(resolve).toHaveBeenCalledTimes(1);
        const row: unknown = harness.host
          .currentAudit()
          ?.getCall(`credential-${kind}`);
        expect(JSON.stringify(row)).toContain('error-escalate');
        expect(JSON.stringify(row)).not.toContain('snapshot_error');
        expect(JSON.stringify(row)).not.toContain(
          'synthetic-secret-lookup-error',
        );
      } finally {
        harness.host.currentAudit()?.close();
      }
    },
  );
  test('cancellation during credential resolution sends and settles nothing', async () => {
    let release: ((value: { value: string }) => void) | undefined;
    let signalReady: () => void = () => {
      throw new Error('resolver signal missing');
    };
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const resolve = vi.fn(() => {
      signalReady();
      return new Promise<{ value: string }>((done) => {
        release = done;
      });
    });
    const session = makeSession('cancel-credential', [
      human(1, 1, 'inspect files'),
    ]);
    const endpoint = await credentialEndpoint();
    const harness = credentialGate(session, endpoint.url, resolve);
    const controller = new AbortController();
    try {
      const pending = harness.run(
        'cancel-in-resolver',
        { command: 'echo inspect' },
        controller.signal,
      );
      await ready;
      controller.abort();
      if (release === undefined) throw new Error('resolver not entered');
      release({ value: 'cancelled-credential' });
      expect((await pending).kind).toBe('cancel');
      await harness.host.currentAudit()?.flush();
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(endpoint.received).toEqual([]);
      expect(
        harness.host.currentAudit()?.getCall('cancel-in-resolver'),
      ).toBeNull();
    } finally {
      harness.host.currentAudit()?.close();
      await endpoint.stop();
    }
  });
});

describe('concurrent credential review preparation', () => {
  test('resolutions stay separate and final views use the captured source cutoff', async () => {
    const first = 'synthetic-parallel-first';
    const second = 'synthetic-parallel-second';
    const releases: ((value: { value: string }) => void)[] = [];
    let signalReady: () => void = () => {
      throw new Error('missing signal');
    };
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const resolve = vi.fn(
      () =>
        new Promise<{ value: string }>((done) => {
          releases.push(done);
          if (releases.length === 2) signalReady();
        }),
    );
    const session = makeSession('parallel-credential-root', [
      human(1, 1, 'inspect only 4 files'),
      { type: 'turn/start', seq: 2, data: { turn: 1 } },
    ]);
    const endpoint = await credentialEndpoint();
    const harness = credentialGate(session, endpoint.url, resolve);
    try {
      const a = harness.run('parallel-a', {
        command: 'echo one',
        token: first,
      });
      const b = harness.run('parallel-b', {
        command: 'echo two',
        token: second,
      });
      await ready;
      session.events.push(
        human(3, 3, 'future message after captured source cutoff'),
      );
      if (releases[0] === undefined || releases[1] === undefined)
        throw new Error('missing concurrent resolutions');
      releases[1]({ value: second });
      releases[0]({ value: first });
      await Promise.all([a, b]);
      await harness.host.currentAudit()?.flush();
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(endpoint.received).toHaveLength(2);
      expect(
        new Set(endpoint.received.map((item) => item.authorization)),
      ).toEqual(new Set([`Bearer ${first}`, `Bearer ${second}`]));
      const bodies = JSON.stringify(endpoint.received.map((item) => item.body));
      expect(bodies).not.toContain(first);
      expect(bodies).not.toContain(second);
      expect(bodies).not.toContain(
        'future message after captured source cutoff',
      );
      const storedA = await persistedCall('parallel-a');
      const storedB = await persistedCall('parallel-b');
      const views = [storedA.snapshot, storedB.snapshot].map(
        (view) => renderDecisionRequest(renderChatUser(view)).state,
      );
      const wireStates = endpoint.received.map((item) =>
        isRecord(item.body) ? item.body['state'] : undefined,
      );
      expect(new Set(wireStates)).toEqual(new Set(views));
    } finally {
      harness.host.currentAudit()?.close();
      await endpoint.stop();
    }
  });
});
