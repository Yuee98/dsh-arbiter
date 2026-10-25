/**
 * The decision chain under configuration change, concurrency and cancellation.
 *
 * What is pinned here, all through the plugin's real `tools/pre-execute`
 * listener and its real settlement path:
 *   - `normal` and `strict` reach the same review verdict; `strict` only turns
 *     a human-required call into `fallback-deny`;
 *   - a human question that is already outstanding keeps waiting across a mode
 *     switch, and its answer still settles the call;
 *   - a model response is interpreted under the protocol that produced it while
 *     the decision uses the configuration effective when it forms;
 *   - a call settles exactly once, even when an answer and a cancel race;
 *   - a missing approval channel falls back instead of hanging;
 *   - two calls in one session are independent.
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
import { capturingGate, createStubContext } from '../helpers/host-stub.js';
import type { Gate } from '../helpers/host-stub.js';
import type { HostServices } from '../../src/host/types.js';
import type { SessionEventLike } from '../../src/snapshot.js';

const homes: string[] = [];
let previousHome: string | undefined;

beforeEach(async () => {
  previousHome = process.env['DSH_HOME'];
  const home = await mkdtemp(join(tmpdir(), 'arbiter-decision-chain-'));
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

beforeAll(() => {
  installSessionRecordApi(recordingSessionApi());
});

afterAll(() => {
  installSessionRecordApi(null);
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
  requestHeader(): {
    readonly config: { readonly provider: string; readonly model: string };
  };
}

function makeSession(id: string, parentSession?: string): StubSession {
  const events: SessionEventLike[] = [];
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
    append(type, data) {
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

/** One model answer, in the chat protocol's shape. */
function chatAnswer(answer: {
  readonly risk: number;
  readonly authorized: number;
  readonly destructive?: boolean;
  readonly bulk?: boolean;
}): HostServices['llm'] {
  const text = JSON.stringify({
    risk: answer.risk,
    authorized: answer.authorized,
    secrets: false,
    destructive: answer.destructive ?? false,
    egress: false,
    bulk: answer.bulk ?? false,
  });
  return {
    stream: () => {
      return (async function* () {
        await Promise.resolve();
        yield { type: 'text-delta', text };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}

interface HarnessOptions {
  readonly sessions: readonly StubSession[];
  readonly llm: HostServices['llm'];
  readonly approval?: HostServices['approval'];
  readonly modes?: { readonly main: string; readonly subagent: string };
  readonly name?: string;
}

interface Harness {
  readonly gate: Gate;
  readonly apply: (config: unknown) => void;
  readonly dispose: () => void;
}

function createHarness(options: HarnessOptions): Harness {
  const capture = capturingGate();
  const byId = new Map(options.sessions.map((s) => [s.id, s]));
  const { ctx, disposers } = createStubContext(
    {
      profileContext: {
        home: process.env['DSH_HOME'] ?? '',
        dir: process.cwd(),
        name: options.name ?? 'decision-chain',
      },
      sandboxPolicy: { defaultMode: 'workspace-write' },
      sessions: {
        get: (id: string) => byId.get(id),
        list: () => [...options.sessions],
      },
      llm: options.llm,
      approval: options.approval ?? {
        config: { policy: 'ask' },
        request: () => Promise.resolve('unavailable'),
      },
      permissionPresets: { registerAuto: () => () => undefined },
      workingDirectory: { ensure: () => Promise.resolve(process.cwd()) },
    },
    { on: capture.on },
  );
  // A subagent is managed through its parent, so the parent is admitted first;
  // the child has no record of its own and inherits the parent's admission.
  for (const session of options.sessions) {
    if (session.header.parentSession === undefined) admitSession(session);
  }
  const push = (config: unknown): void => {
    apply(ctx, config);
  };
  push({
    modes: options.modes ?? { main: 'normal', subagent: 'strict' },
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
  });
  return {
    gate: capture.gate(),
    apply: push,
    dispose: () => {
      for (const dispose of disposers) Reflect.apply(dispose, undefined, []);
    },
  };
}

function call(
  session: StubSession,
  callId: string,
  signal: AbortSignal = new AbortController().signal,
  args: unknown = { command: 'echo hi' },
): Parameters<Gate>[0] {
  return {
    callId,
    name: 'bash',
    arguments: args,
    signal,
    agent: { session },
  };
}

const allowNext = (): Promise<{ kind: string }> =>
  Promise.resolve({ kind: 'allow' });

/** The stage results the audit store persisted for one call. */
async function storedTrace(callId: string): Promise<readonly string[]> {
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
      if (row !== null && typeof row === 'object') {
        const stages: unknown = Reflect.get(row, 'stages');
        if (Array.isArray(stages)) {
          return stages.map((stage) =>
            typeof stage === 'object' && stage !== null
              ? String(Reflect.get(stage, 'result'))
              : '',
          );
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no persisted trace for ${callId}`);
  } finally {
    store.close();
  }
}

describe('mode equivalence on the real gate', () => {
  test('normal and strict reach the same review verdict', async () => {
    const medium = makeSession('m-medium');
    const strict = makeSession('m-strict');
    const normalHarness = createHarness({
      sessions: [medium],
      llm: chatAnswer({ risk: 5, authorized: 8 }),
      modes: { main: 'normal', subagent: 'strict' },
      name: 'normal-mode',
    });
    const strictHarness = createHarness({
      sessions: [strict],
      llm: chatAnswer({ risk: 5, authorized: 8 }),
      modes: { main: 'strict', subagent: 'strict' },
      name: 'strict-mode',
    });
    try {
      expect(
        (await normalHarness.gate(call(medium, 'm1'), allowNext)).kind,
      ).toBe('allow');
      expect(
        (await strictHarness.gate(call(strict, 'm2'), allowNext)).kind,
      ).toBe('allow');
      expect(await storedTrace('m1')).toContain('review-allow');
      expect(await storedTrace('m2')).toContain('review-allow');
    } finally {
      normalHarness.dispose();
      strictHarness.dispose();
    }
  });

  test('strict turns a human-required review into fallback-deny', async () => {
    const session = makeSession('m-escalate');
    const asked: string[] = [];
    const harness = createHarness({
      sessions: [session],
      llm: chatAnswer({ risk: 7, authorized: 2 }),
      modes: { main: 'strict', subagent: 'strict' },
      approval: {
        config: { policy: 'ask' },
        request: () => {
          asked.push('asked');
          return Promise.resolve('rejected' as const);
        },
      },
    });
    try {
      const decision = await harness.gate(call(session, 'm3'), allowNext);
      expect(decision.kind).toBe('deny');
      expect(decision.reason).toContain('fallback-deny');
      // The automatic mode must not even open the question.
      expect(asked).toHaveLength(0);
      expect(await storedTrace('m3')).toEqual([
        'review(default)',
        'review-escalate',
        'fallback-deny',
      ]);
    } finally {
      harness.dispose();
    }
  });
});

describe('a shown approval survives a configuration change', () => {
  test('switching to strict does not withdraw an outstanding question', async () => {
    const session = makeSession('a-open');
    let release: ((answer: 'allowed-once' | 'rejected') => void) | undefined;
    let asked = 0;
    const harness = createHarness({
      sessions: [session],
      llm: chatAnswer({ risk: 7, authorized: 2 }),
      modes: { main: 'normal', subagent: 'strict' },
      approval: {
        config: { policy: 'ask' },
        request: () => {
          asked += 1;
          return new Promise((resolve) => {
            release = (answer) => {
              resolve(answer);
            };
          });
        },
      },
    });
    try {
      const pending = harness.gate(call(session, 'a1'), allowNext);
      // The review escalates and the question is on screen.
      for (let attempt = 0; attempt < 100 && asked === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(asked).toBe(1);
      // The user switches to strict while the question still waits.
      harness.apply({
        modes: { main: 'strict', subagent: 'strict' },
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
      });
      // The answer the user gives must still decide this call.
      if (release === undefined)
        throw new Error('the approval was never asked');
      release('allowed-once');
      expect((await pending).kind).toBe('allow');
      expect(await storedTrace('a1')).toEqual([
        'review(default)',
        'review-escalate',
        'human-allow',
      ]);
    } finally {
      harness.dispose();
    }
  });

  test('a decision not yet made uses the newly effective mode', async () => {
    const session = makeSession('a-late');
    let asked = 0;
    const harness = createHarness({
      sessions: [session],
      llm: chatAnswer({ risk: 7, authorized: 2 }),
      modes: { main: 'normal', subagent: 'strict' },
      approval: {
        config: { policy: 'ask' },
        request: () => {
          asked += 1;
          return Promise.resolve('rejected' as const);
        },
      },
    });
    try {
      // Switch to strict before this call reaches its review.
      harness.apply({
        modes: { main: 'strict', subagent: 'strict' },
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
      });
      const decision = await harness.gate(call(session, 'a2'), allowNext);
      expect(decision.reason).toContain('fallback-deny');
      expect(asked).toBe(0);
    } finally {
      harness.dispose();
    }
  });
});

describe('one settlement per call', () => {
  test('a close racing an answer settles once as an abort', async () => {
    const session = makeSession('r-race');
    const controller = new AbortController();
    let release: ((answer: 'allowed-once') => void) | undefined;
    const harness = createHarness({
      sessions: [session],
      llm: chatAnswer({ risk: 7, authorized: 2 }),
      approval: {
        config: { policy: 'ask' },
        request: () => {
          return new Promise((resolve) => {
            release = (answer) => {
              resolve(answer);
            };
          });
        },
      },
    });
    try {
      const pending = harness.gate(
        call(session, 'r1', controller.signal),
        allowNext,
      );
      for (
        let attempt = 0;
        attempt < 100 && release === undefined;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // The user closes the prompt and the answer arrives in the same tick.
      controller.abort();
      if (release === undefined)
        throw new Error('the approval was never asked');
      release('allowed-once');
      const decision = await pending;
      expect(decision.kind).toBe('deny');
      expect(decision.reason).toContain('human-abort');
      // Exactly one terminal stage, so no second write happened.
      const trace = await storedTrace('r1');
      expect(trace.filter((stage) => stage.startsWith('human-'))).toHaveLength(
        1,
      );
      expect(trace.at(-1)).toBe('human-abort');
    } finally {
      harness.dispose();
    }
  });

  test('a cancel before the question is asked denies nothing and allows nothing', async () => {
    const session = makeSession('r-cancel');
    const controller = new AbortController();
    controller.abort();
    const harness = createHarness({
      sessions: [session],
      llm: chatAnswer({ risk: 7, authorized: 2 }),
      approval: {
        config: { policy: 'ask' },
        request: () => Promise.resolve('rejected' as const),
      },
    });
    try {
      const decision = await harness.gate(
        call(session, 'r2', controller.signal),
        allowNext,
      );
      expect(decision.kind).toBe('cancel');
    } finally {
      harness.dispose();
    }
  });
});

describe('missing approval channel', () => {
  test('a subagent and a host-pinned never policy both fall back', async () => {
    const parent = makeSession('c-parent');
    const child = makeSession('c-sub', 'c-parent');
    const pinned = makeSession('c-pinned');
    const harness = createHarness({
      sessions: [parent, child, pinned],
      llm: chatAnswer({ risk: 7, authorized: 2 }),
      approval: {
        config: { policy: 'ask' },
        overrideOf: (session) =>
          session.id === 'c-pinned' ? 'never' : undefined,
        request: () => Promise.resolve('rejected' as const),
      },
    });
    try {
      // The subagent mode is `strict`, so the mode check answers first: either
      // reason is a fallback, and neither opens a question.
      const childDecision = await harness.gate(call(child, 'c1'), allowNext);
      expect(childDecision.kind).toBe('deny');
      expect(childDecision.reason).toContain('fallback-deny');
      expect(childDecision.reason).toContain('does not open approval requests');
      const pinnedDecision = await harness.gate(call(pinned, 'c2'), allowNext);
      expect(pinnedDecision.reason).toContain('fallback-deny');
      expect(pinnedDecision.reason).toContain('approval policy');
    } finally {
      harness.dispose();
    }
  });
});

describe('parallel independent calls', () => {
  test('two calls in one session settle independently', async () => {
    const session = makeSession('p-session');
    const answers: ((answer: 'allowed-once' | 'rejected') => void)[] = [];
    const harness = createHarness({
      sessions: [session],
      llm: chatAnswer({ risk: 7, authorized: 2 }),
      approval: {
        config: { policy: 'ask' },
        request: () =>
          new Promise((resolve) => {
            answers.push((answer) => {
              resolve(answer);
            });
          }),
      },
    });
    try {
      const first = harness.gate(call(session, 'p1'), allowNext);
      const second = harness.gate(call(session, 'p2'), allowNext);
      for (let attempt = 0; attempt < 100 && answers.length < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(answers).toHaveLength(2);
      // Answer them in the opposite order they were asked.
      answers[1]?.('rejected');
      answers[0]?.('allowed-once');
      expect((await first).kind).toBe('allow');
      expect((await second).kind).toBe('deny');
      expect(await storedTrace('p1')).toContain('human-allow');
      expect(await storedTrace('p2')).toContain('human-deny');
    } finally {
      harness.dispose();
    }
  });
});

describe('protocol of the response versus strategy of the decision', () => {
  test('a chat response is still decided by the newly effective thresholds', async () => {
    const session = makeSession('b-switch');
    let release: (() => void) | undefined;
    const gateStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowLlm: HostServices['llm'] = {
      stream: () => {
        return (async function* () {
          await gateStarted;
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              risk: 7,
              authorized: 2,
              secrets: false,
              destructive: false,
              egress: false,
              bulk: false,
            }),
          };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    };
    const harness = createHarness({
      sessions: [session],
      llm: slowLlm,
      modes: { main: 'normal', subagent: 'strict' },
    });
    try {
      const pending = harness.gate(call(session, 'b1'), allowNext);
      // The review request is out; the user switches the backend and mode.
      await new Promise((resolve) => setTimeout(resolve, 20));
      harness.apply({
        modes: { main: 'strict', subagent: 'strict' },
        reviewer: {
          type: 'decision',
          decision: {
            url: 'http://127.0.0.1:1/unreachable',
            model: 'x',
            apiKeyRef: '',
            timeoutMs: 1_000,
            maxRepairRetries: 1,
          },
        },
      });
      release?.();
      // The old chat response is interpreted as a chat response; the decision
      // then uses the now-effective strict mode, so it falls back rather than
      // asking.
      const decision = await pending;
      expect(decision.reason).toContain('fallback-deny');
      const trace = await storedTrace('b1');
      expect(trace).toContain('review-escalate');
      expect(trace.at(-1)).toBe('fallback-deny');
    } finally {
      harness.dispose();
    }
  });
});

describe('the configuration one stage actually used', () => {
  test('a change during the cwd wait is what the rule evaluation uses', async () => {
    const session = makeSession('s-cwd');
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const capture = capturingGate();
    const { ctx, disposers } = createStubContext(
      {
        profileContext: {
          home: process.env['DSH_HOME'] ?? '',
          dir: process.cwd(),
          name: 'stage-cwd',
        },
        sandboxPolicy: { defaultMode: 'workspace-write' },
        sessions: { get: () => session, list: () => [session] },
        llm: chatAnswer({ risk: 5, authorized: 8 }),
        approval: {
          config: { policy: 'ask' },
          request: () => Promise.resolve('rejected' as const),
        },
        permissionPresets: { registerAuto: () => () => undefined },
        workingDirectory: {
          ensure: async () => {
            await held;
            return process.cwd();
          },
        },
      },
      { on: capture.on },
    );
    admitSession(session);
    const reviewer = {
      type: 'chat',
      chat: {
        provider: 'session',
        model: '',
        temperature: 0,
        maxTokens: 400,
        timeoutMs: 8_000,
        maxRepairRetries: 1,
      },
    };
    // Start with no rule at all: the call would be reviewed, not denied.
    apply(ctx, {
      rules: [],
      modes: { main: 'normal', subagent: 'strict' },
      reviewer,
    });
    try {
      const pending = capture.gate()(
        {
          callId: 's1',
          name: 'bash',
          arguments: { command: 'echo hi' },
          signal: new AbortController().signal,
          agent: { session },
        },
        allowNext,
      );
      // The deny rule appears while the gate is still waiting for its cwd.
      apply(ctx, {
        rules: [
          {
            id: 'deny-echo',
            match: { node: 'command', kind: 'exact', pattern: 'echo hi' },
            verdict: 'deny',
          },
        ],
        modes: { main: 'normal', subagent: 'strict' },
        reviewer,
      });
      release?.();
      const decision = await pending;
      // The rule that is effective when evaluation runs decides the call.
      expect(decision.kind).toBe('deny');
      expect(decision.reason).toContain('deny-echo');
      expect(await storedTrace('s1')).toEqual(['deny']);
    } finally {
      for (const dispose of disposers) Reflect.apply(dispose, undefined, []);
    }
  });
});

describe('both orderings of the answer race', () => {
  test('an answer that wins first keeps its human outcome', async () => {
    const session = makeSession('o-answer');
    const controller = new AbortController();
    const harness = createHarness({
      sessions: [session],
      llm: chatAnswer({ risk: 7, authorized: 2 }),
      approval: {
        config: { policy: 'ask' },
        request: () => Promise.resolve('allowed-once' as const),
      },
    });
    try {
      // The answer resolves; the abort arrives after it was already applied.
      const decision = await harness.gate(
        call(session, 'o1', controller.signal),
        allowNext,
      );
      expect(decision.kind).toBe('allow');
      controller.abort();
      const trace = await storedTrace('o1');
      expect(trace.at(-1)).toBe('human-allow');
      expect(trace.filter((stage) => stage.startsWith('human-'))).toHaveLength(
        1,
      );
    } finally {
      harness.dispose();
    }
  });
});

describe('stage attribution', () => {
  test('the persisted snapshot names the revision the request was built under', async () => {
    const session = makeSession('t-rev');
    const harness = createHarness({
      sessions: [session],
      llm: chatAnswer({ risk: 3, authorized: 8 }),
      name: 'stage-attribution',
    });
    try {
      await harness.gate(call(session, 't1'), allowNext);
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
        let revision: unknown;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const row: unknown = store.getCall('t1');
          if (row !== null && typeof row === 'object') {
            const snapshot: unknown = Reflect.get(row, 'snapshot');
            if (snapshot !== null && typeof snapshot === 'object') {
              revision = Reflect.get(snapshot, 'configRevision');
              if (typeof revision === 'string') break;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(typeof revision).toBe('string');
        expect(revision).not.toBe('');
      } finally {
        store.close();
      }
    } finally {
      harness.dispose();
    }
  });
});
