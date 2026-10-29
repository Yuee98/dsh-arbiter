/**
 * An effective prohibition must deny through the *real* gate, in both protocols.
 *
 * This is the regression for the one semantic gap the shared contract exposed: the
 * legacy thresholds treated a low-risk call with no usable authorization as
 * ordinary — fine for the old scale, where the lowest value meant "no evidence",
 * but wrong for the new one, where band 1 is a prohibition. A parser test cannot
 * prove the gate honours it, so these cases drive the plugin's actual
 * `tools/pre-execute` listener and its real settlement path.
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
let harnessSeq = 0;

beforeEach(async () => {
  previousHome = process.env['DSH_HOME'];
  const home = await mkdtemp(join(tmpdir(), 'arbiter-prohibition-'));
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
  readonly header: { readonly id: string; readonly cwd: string };
  readonly events: SessionEventLike[];
  readonly append: (type: string, data: unknown) => void;
  readonly snapshotEvents: () => readonly SessionEventLike[];
  requestHeader(): {
    readonly config: { readonly provider: string; readonly model: string };
  };
}

function makeSession(id: string): StubSession {
  const events: SessionEventLike[] = [];
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
    requestHeader: () => ({ config: { provider: 'stub', model: 'stub' } }),
  };
}

/** A chat-protocol reviewer that always answers with one fixed pair. */
function chatAnswer(answer: {
  readonly risk: number;
  readonly authorized: number;
}): HostServices['llm'] {
  const text = JSON.stringify({
    risk: answer.risk,
    authorized: answer.authorized,
    secrets: false,
    destructive: false,
    egress: false,
    bulk: false,
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

/** A decision-protocol reviewer that answers with two native distributions. */
function decisionAnswer(answer: {
  readonly risk: Record<string, number>;
  readonly authorization: Record<string, number>;
}): typeof fetch {
  const body = {
    model: 'clef',
    answers: {
      risk: { type: 'score', probabilities: answer.risk, score: 1 },
      authorized: {
        type: 'score',
        probabilities: answer.authorization,
        score: 1,
      },
      secrets: { type: 'noul', noul: 0.01 },
      destructive: { type: 'noul', noul: 0.01 },
      egress: { type: 'noul', noul: 0.01 },
      bulk: { type: 'noul', noul: 0.01 },
    },
    usage: { input_tokens: 10, output_tokens: 0 },
  };
  // One function with the global's own signature, so no assertion is needed.
  const stub: typeof fetch = () =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  return stub;
}

interface Harness {
  readonly gate: Gate;
  readonly dispose: () => void;
}

function createHarness(options: {
  readonly session: StubSession;
  readonly llm: HostServices['llm'];
  readonly name: string;
  readonly reviewer?: { readonly type: 'decision'; readonly url: string };
  readonly modes?: { readonly main: string; readonly subagent: string };
}): Harness {
  const capture = capturingGate();
  const { ctx, disposers } = createStubContext(
    {
      profileContext: {
        home: process.env['DSH_HOME'] ?? '',
        dir: process.cwd(),
        name: options.name,
      },
      sandboxPolicy: { defaultMode: 'workspace-write' },
      sessions: { get: () => options.session, list: () => [options.session] },
      llm: options.llm,
      approval: {
        config: { policy: 'ask' },
        request: () => Promise.resolve('unavailable'),
      },
      permissionPresets: { registerAuto: () => () => undefined },
      workingDirectory: { ensure: () => Promise.resolve(process.cwd()) },
      // The decision backend requires a credential reference, and the resolver is
      // what turns it into a value. A fixed stub keeps the run deterministic and
      // never touches a real secret.
      credentials: {
        resolve: () => Promise.resolve({ value: 'test-credential' }),
      },
    },
    { on: capture.on },
  );
  admitSession(options.session);
  const reviewer =
    options.reviewer === undefined
      ? {
          type: 'chat' as const,
          chat: {
            provider: 'session',
            model: '',
            temperature: 0,
            maxTokens: 400,
            timeoutMs: 8_000,
            maxRepairRetries: 1,
          },
        }
      : {
          type: 'decision' as const,
          decision: {
            url: options.reviewer.url,
            model: 'clef',
            apiKeyRef: 'TEST_KEY',
            timeoutMs: 8_000,
            maxRepairRetries: 0,
          },
        };
  apply(ctx, {
    modes: options.modes ?? { main: 'normal', subagent: 'strict' },
    reviewer,
  });
  return {
    gate: capture.gate(),
    dispose: () => {
      for (const dispose of disposers) Reflect.apply(dispose, undefined, []);
    },
  };
}

function call(session: StubSession, callId: string): Parameters<Gate>[0] {
  return {
    callId,
    name: 'bash',
    arguments: { command: 'echo hi' },
    signal: new AbortController().signal,
    agent: { session },
  };
}

const allowNext = (): Promise<{ kind: string }> =>
  Promise.resolve({ kind: 'allow' });

describe('an effective prohibition through the real gate', () => {
  test('a chat answer of A1 denies a low-risk call', async () => {
    // Risk 1 with A1 is the case the old engine allowed: the low-risk fast path
    // never asked for authorization, and `authorized: 0` (the old "no evidence")
    // mapped to the same class as a prohibition.
    const session = makeSession('p-chat-a1');
    const harness = createHarness({
      session,
      llm: chatAnswer({ risk: 1, authorized: 1 }),
      name: `prohibition-chat-${String(harnessSeq++)}`,
    });
    try {
      const outcome = await harness.gate(call(session, 'pc1'), allowNext);
      expect(outcome.kind).toBe('deny');
      // The reason names the prohibition rather than a weak authorization, so the
      // agent's recovery hint points at the right thing.
      expect(outcome.reason).toContain('prohibit');
    } finally {
      harness.dispose();
    }
  });

  test('a decision distribution whose lower median is A1 denies', async () => {
    // Native authorization {"0": 0.6, "9": 0.4} is A1 by the lower median even
    // though 40% of the mass sits on A10. This distinguishes the median rule from
    // a tail test and from the legacy `none` class label.
    const session = makeSession('p-dec-a1');
    const realFetch = globalThis.fetch;
    globalThis.fetch = decisionAnswer({
      risk: { '0': 1 },
      authorization: { '0': 0.6, '9': 0.4 },
    });
    const harness = createHarness({
      session,
      llm: chatAnswer({ risk: 1, authorized: 2 }),
      name: `prohibition-decision-${String(harnessSeq++)}`,
      reviewer: { type: 'decision', url: 'http://127.0.0.1:9/review' },
    });
    try {
      const outcome = await harness.gate(call(session, 'pd1'), allowNext);
      expect(outcome.kind).toBe('deny');
    } finally {
      harness.dispose();
      globalThis.fetch = realFetch;
    }
  });

  test('the A1/A10 boundary answer allows at low risk', async () => {
    // The published example: 40% A1 with 60% A10 is A10, which permits risk 1.
    // Without this case a guard keyed on "any mass at band 1" would pass the deny
    // test and wrongly refuse this call.
    const session = makeSession('p-dec-a10');
    const realFetch = globalThis.fetch;
    globalThis.fetch = decisionAnswer({
      risk: { '0': 1 },
      authorization: { '0': 0.4, '9': 0.6 },
    });
    const harness = createHarness({
      session,
      llm: chatAnswer({ risk: 1, authorized: 2 }),
      name: `prohibition-boundary-${String(harnessSeq++)}`,
      reviewer: { type: 'decision', url: 'http://127.0.0.1:9/review' },
    });
    try {
      const outcome = await harness.gate(call(session, 'pb1'), allowNext);
      expect(outcome.kind).toBe('allow');
    } finally {
      harness.dispose();
      globalThis.fetch = realFetch;
    }
  });

  test('A2 still allows a low-risk call', async () => {
    // The guard must be keyed on band 1 exactly. A2 means "no applicable
    // permission", which the matrix permits at risk 1-2; refusing it would deny
    // ordinary reads.
    const session = makeSession('p-chat-a2');
    const harness = createHarness({
      session,
      llm: chatAnswer({ risk: 1, authorized: 2 }),
      name: `prohibition-a2-${String(harnessSeq++)}`,
    });
    try {
      const outcome = await harness.gate(call(session, 'pa2'), allowNext);
      expect(outcome.kind).toBe('allow');
    } finally {
      harness.dispose();
    }
  });
});

describe('the decision adapter publishes public keys to the engine', () => {
  test('a parsed distribution is keyed 1..10, not 0..9', async () => {
    // The live engine reads public bands. An adapter that published native keys
    // would make the prohibition guard read the wrong band, so the numbering is
    // asserted on the persisted signals rather than inferred from a verdict.
    const session = makeSession('p-keys');
    const realFetch = globalThis.fetch;
    globalThis.fetch = decisionAnswer({
      risk: { '0': 1 },
      authorization: { '0': 0.4, '9': 0.6 },
    });
    const harness = createHarness({
      session,
      llm: chatAnswer({ risk: 1, authorized: 2 }),
      name: `prohibition-keys-${String(harnessSeq++)}`,
      reviewer: { type: 'decision', url: 'http://127.0.0.1:9/review' },
    });
    try {
      await harness.gate(call(session, 'pk1'), allowNext);
      const signals = await storedSignals('pk1');
      const authDist = readDistribution(signals['authDist']);
      const keys = Object.keys(authDist)
        .map(Number)
        .sort((a, b) => a - b);
      // The adapter publishes the public band for each submitted level. The two
      // levels that carried mass are 1 and 10 — native 0 and 9 shifted by one —
      // and no key sits outside 1..10, which is what tells this apart from the
      // native numbering.
      expect(keys).toEqual([1, 10]);
      for (const key of keys) {
        expect(key).toBeGreaterThanOrEqual(1);
        expect(key).toBeLessThanOrEqual(10);
      }
      expect(Object.values(authDist).reduce((a, b) => a + b, 0)).toBeCloseTo(
        1,
        10,
      );
      expect(signals['authPoint']).toBeNull();
      expect(signals['riskPoint']).toBeNull();
    } finally {
      harness.dispose();
      globalThis.fetch = realFetch;
    }
  });
});

/** The persisted signal object for one call, once the audit row exists. */
async function storedSignals(callId: string): Promise<Record<string, unknown>> {
  const module = await import('../../src/audit.js');
  const store = new module.AuditStore(
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
        const signals: unknown = Reflect.get(row, 'signals');
        const record = readRecord(signals);
        if (record !== null) return record;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no persisted signals for ${callId}`);
  } finally {
    store.close();
  }
}

/** A plain record from an unknown persisted value, or null. */
function readRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = item;
  return out;
}

/** A number-keyed distribution from an unknown persisted value. */
function readDistribution(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (value === null || typeof value !== 'object') return out;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'number') out[key] = item;
  }
  return out;
}
