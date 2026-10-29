import { describe, expect, test } from 'vitest';
import {
  CAPTURED_CLOUDFLARE,
  CAPTURED_TYPESAFE,
} from './helpers/decision-captures.js';

import { DEFAULT_CONFIG } from '../src/config.js';
import {
  renderUser,
  extractJsonObject,
  parseChatText,
  parseDecisionResponse,
  signalsFromChat,
  runChatReviewer,
  runDecisionReviewer,
} from '../src/reviewer.js';
import { decideReview } from '../src/policy.js';
import type { ReviewSnapshot } from '../src/types.js';
import type { StreamOptionsLike } from '../src/reviewer/chat.js';

const thresholds = DEFAULT_CONFIG.policy.normal;

describe('chat reviewer output', () => {
  test('accepts the exact six-member object', () => {
    const parsed = parseChatText(
      '{"risk":2,"authorized":6,"secrets":false,"destructive":false,"egress":false,"bulk":false}',
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.raw?.risk).toBe(2);
    if (parsed.raw === undefined) throw new Error('Missing parsed signals');
    expect(signalsFromChat(parsed.raw, 0)).toMatchObject({
      riskPoint: 2,
      authPoint: 6,
      source: 'chat',
    });
  });

  test('extracts a fenced object with surrounding prose', () => {
    const parsed = parseChatText(
      'Here you go:\n```json\n{"risk":1,"authorized":8,"secrets":false,"destructive":false,"egress":false,"bulk":false}\n```\nDone.',
    );
    expect(parsed.ok).toBe(true);
  });

  test('rejects extra members and non-integer scores', () => {
    expect(
      parseChatText(
        '{"risk":2,"authorized":6,"secrets":false,"destructive":false,"egress":false,"bulk":false,"decision":"allow"}',
      ).ok,
    ).toBe(false);
    expect(
      parseChatText(
        '{"risk":2.5,"authorized":6,"secrets":false,"destructive":false,"egress":false,"bulk":false}',
      ).ok,
    ).toBe(false);
    expect(
      parseChatText(
        '{"risk":"2","authorized":6,"secrets":false,"destructive":false,"egress":false,"bulk":false}',
      ).ok,
    ).toBe(false);
  });

  test('accepts risk/probe combinations the shared rubric permits', () => {
    // These two were repair failures under the earlier contract, which required
    // low risk to exclude destruction and high risk to include it. The rubric
    // grades consequences: disposable data can be destroyed at negligible cost,
    // and a critical objective can be lost without destroying data or reading
    // credentials. Rejecting either reports a failure for a legal classification.
    const lowDestructive = parseChatText(
      '{"risk":2,"authorized":6,"secrets":false,"destructive":true,"egress":false,"bulk":false}',
    );
    expect(lowDestructive.ok).toBe(true);
    const highClean = parseChatText(
      '{"risk":10,"authorized":6,"secrets":false,"destructive":false,"egress":false,"bulk":false}',
    );
    expect(highClean.ok).toBe(true);
  });

  test('rejects a score outside the public 1..10 scale', () => {
    // The public scale starts at 1, where 1 means an effective prohibition. An
    // answer of 0 names no band at all, so it is a failed read rather than a
    // lowest score.
    const zero = parseChatText(
      '{"risk":0,"authorized":6,"secrets":false,"destructive":false,"egress":false,"bulk":false}',
    );
    expect(zero.ok).toBe(false);
    const eleven = parseChatText(
      '{"risk":11,"authorized":6,"secrets":false,"destructive":false,"egress":false,"bulk":false}',
    );
    expect(eleven.ok).toBe(false);
  });

  test('extraction finds the first balanced object', () => {
    expect(extractJsonObject('text {"a":1} tail')).toBe('{"a":1}');
  });
});

describe('decision reviewer output', () => {
  test('reads answers from the Cloudflare envelope', () => {
    const parsed = parseDecisionResponse(CAPTURED_CLOUDFLARE, thresholds);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const signals = parsed.signals;
    expect(signals.source).toBe('decision');
    // Normalization is the parser's job, not the vendor's: the distribution is
    // renormalized to sum to one even though the provider already reports that.
    const total = Object.values(signals.riskDist ?? {}).reduce(
      (sum, value) => sum + value,
      0,
    );
    expect(total).toBeCloseTo(1, 10);
    // The weighted band is a public-scale diagnostic: the native capture averages
    // 3.8154 over levels 0..9, which is 4.8154 once the ten bands are numbered 1..10.
    // It is derived from the distribution rather than read from the vendor's own
    // `score` field, so the assertion is against the arithmetic, not the capture.
    const captured = CAPTURED_CLOUDFLARE.result.answers.risk.probabilities;
    const publicWeighted = Object.entries(captured).reduce(
      (sum, [level, probability]) => sum + (Number(level) + 1) * probability,
      0,
    );
    expect(publicWeighted).toBeCloseTo(4.8154, 3);
    expect(signals.riskScore).toBeCloseTo(publicWeighted, 10);
    // The probes are the captured probabilities thresholded at one half. The
    // expected booleans are written out because the capture is a literal: the
    // comparison would be constant-folded, and a fold cannot drift when the
    // fixture changes but a literal that disagrees with it can.
    const answers = CAPTURED_CLOUDFLARE.result.answers;
    expect([answers.secrets.noul, answers.destructive.noul]).toEqual([
      0.0099, 0.512,
    ]);
    expect([answers.egress.noul, answers.bulk.noul]).toEqual([0.0084, 0.6548]);
    expect([signals.secrets, signals.destructive]).toEqual([false, true]);
    expect([signals.egress, signals.bulk]).toEqual([false, true]);
  });

  test('reads answers from a native response that has no envelope', () => {
    const parsed = parseDecisionResponse(CAPTURED_TYPESAFE, thresholds);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const signals = parsed.signals;
    const answers = CAPTURED_TYPESAFE.answers;
    // Recompute the public weighted band from the capture's own probabilities
    // rather than trusting the vendor's `score` field, which is diagnostic input
    // the contract does not read.
    const probabilities = answers.risk.probabilities;
    const weighted = Object.entries(probabilities).reduce(
      (sum, [level, probability]) => sum + (Number(level) + 1) * probability,
      0,
    );
    expect(signals.riskScore).toBeCloseTo(weighted, 10);
    expect(
      [answers.secrets.noul, answers.destructive.noul].map(
        (value) => value >= 0.5,
      ),
    ).toEqual([signals.secrets, signals.destructive]);
    expect(
      [answers.egress.noul, answers.bulk.noul].map((value) => value >= 0.5),
    ).toEqual([signals.egress, signals.bulk]);
  });

  test('rejects missing answers and invalid probabilities', () => {
    expect(parseDecisionResponse({}, thresholds).ok).toBe(false);
    // The `result.response` shape this file used to assert never existed at any
    // endpoint; it is gone rather than preserved as a tolerated variant.
    expect(
      parseDecisionResponse(
        { result: { response: { risk: { type: 'score' } } } },
        thresholds,
      ).ok,
    ).toBe(false);
    const parsed = parseDecisionResponse(
      {
        result: {
          answers: {
            risk: { type: 'score' },
            authorized: { type: 'score' },
          },
        },
      },
      thresholds,
    );
    expect(parsed.ok).toBe(false);
  });
});

const snapshot: ReviewSnapshot = {
  version: 1,
  createdAt: 0,
  configRevision: 'test',
  callId: 'call-1',
  sessionId: 'session-1',
  sessionKind: 'main',
  turn: 1,
  tool: 'bash',
  cwd: '/tmp',
  action: { name: 'bash', arguments: { command: 'echo hi' } },
  facts: null,
  projectRules: null,
  customRules: '',
  materials: [
    {
      id: 'project-rules',
      enabled: true,
      present: false,
      chars: 0,
      limit: 2_000,
      truncated: false,
    },
    {
      id: 'custom-rules',
      enabled: true,
      present: false,
      chars: 0,
      limit: 2_000,
      truncated: false,
    },
  ],
  evidence: [],
  evidenceTruncated: false,
  parentAuthorizationPresent: null,
  context: [],
  checkpoints: [],
  contextTruncated: false,
  priorVerdicts: [],
  historyTruncated: false,
  historyStatus: {
    coverage: 'known-empty',
    windowTruncated: false,
    reason: null,
    sources: {
      memory: { read: 0, unavailable: null },
      session: { read: 0, unavailable: null },
      audit: { read: 0, unavailable: null },
    },
    reset: false,
  },
  completeness: { status: 'complete', items: [], gaps: [], note: null },
  missing: [],
  budget: {
    maxInputTokens: 1000,
    estimatedInputTokens: 10,
    truncatedSegments: [],
  },
};

function streamOf(
  chunks: readonly Record<string, unknown>[],
): AsyncIterable<Record<string, unknown>> {
  return (async function* () {
    for (const chunk of chunks) {
      await Promise.resolve();
      yield chunk;
    }
  })();
}

const session = {
  requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
};

describe('chat reviewer run', () => {
  test('repairs one invalid answer and reports the repair count', async () => {
    let call = 0;
    const llm = {
      stream: () => {
        call += 1;
        return call === 1
          ? streamOf([
              { type: 'text-delta', text: 'not json' },
              { type: 'finish', reason: { kind: 'stop' } },
            ])
          : streamOf([
              {
                type: 'text-delta',
                text: '{"risk":1,"authorized":8,"secrets":false,"destructive":false,"egress":false,"bulk":false}',
              },
              { type: 'finish', reason: { kind: 'stop' } },
            ]);
      },
    };
    const result = await runChatReviewer(
      {
        llm,
        session,
        chat: {
          provider: 'session',
          model: '',
          temperature: 0,
          maxTokens: 300,
          timeoutMs: 1000,
          maxRepairRetries: 1,
        },
        thresholds: thresholds,
        signal: new AbortController().signal,
      },
      snapshot,
      { system: 'sys', user: 'user', estimatedInputTokens: 5 },
      'call-1',
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toHaveLength(2);
    expect(result.ok ? result.signals.repairs : null).toBe(1);
  });

  test('does not retry a provider failure', async () => {
    const llm = {
      stream: () =>
        streamOf([
          {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { code: 'AUTH', message: 'bad key' },
            },
          },
        ]),
    };
    const result = await runChatReviewer(
      {
        llm,
        session,
        chat: {
          provider: 'session',
          model: '',
          temperature: 0,
          maxTokens: 300,
          timeoutMs: 1000,
          maxRepairRetries: 1,
        },
        thresholds,
        signal: new AbortController().signal,
      },
      snapshot,
      { system: 'sys', user: 'user', estimatedInputTokens: 5 },
      'call-1',
    );
    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(1);
  });

  test('forwards reasoning effort when the caller supplies one', async () => {
    const seen: StreamOptionsLike[] = [];
    const llm = {
      stream: (options: StreamOptionsLike) => {
        seen.push({ ...options });
        return streamOf([
          {
            type: 'text-delta',
            text: '{"risk":1,"authorized":8,"secrets":false,"destructive":false,"egress":false,"bulk":false}',
          },
          { type: 'finish', reason: { kind: 'stop' } },
        ]);
      },
    };
    await runChatReviewer(
      {
        llm,
        session,
        chat: {
          provider: 'session',
          model: '',
          temperature: 0,
          maxTokens: 300,
          timeoutMs: 1000,
          maxRepairRetries: 0,
        },
        thresholds,
        signal: new AbortController().signal,
        reasoningEffort: 'off',
      },
      snapshot,
      { system: 'sys', user: 'user', estimatedInputTokens: 5 },
      'call-1',
    );
    expect(seen[0]?.reasoningEffort).toBe('off');
  });

  test('leaves reasoning effort absent when the caller has no opinion', async () => {
    const seen: StreamOptionsLike[] = [];
    const llm = {
      stream: (options: StreamOptionsLike) => {
        seen.push({ ...options });
        return streamOf([
          {
            type: 'text-delta',
            text: '{"risk":1,"authorized":8,"secrets":false,"destructive":false,"egress":false,"bulk":false}',
          },
          { type: 'finish', reason: { kind: 'stop' } },
        ]);
      },
    };
    await runChatReviewer(
      {
        llm,
        session,
        chat: {
          provider: 'session',
          model: '',
          temperature: 0,
          maxTokens: 300,
          timeoutMs: 1000,
          maxRepairRetries: 0,
        },
        thresholds,
        signal: new AbortController().signal,
      },
      snapshot,
      { system: 'sys', user: 'user', estimatedInputTokens: 5 },
      'call-1',
    );
    // The host falls back to its own chain when the key is missing. An explicit
    // `undefined` is still a present key to code that inspects presence, so the
    // assertion is absence rather than `undefined` equality.
    expect(Object.hasOwn(seen[0] ?? {}, 'reasoningEffort')).toBe(false);
  });
});

describe('decision reviewer run', () => {
  test('posts state and questions and maps a distribution response', async () => {
    const response = new Response(JSON.stringify(CAPTURED_CLOUDFLARE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    let received: unknown = null;
    const result = await runDecisionReviewer(
      {
        fetch: (_input, init) => {
          received = init?.body;
          return Promise.resolve(response);
        },
        credentials: { resolve: () => Promise.resolve({ value: 'test-key' }) },
        decision: {
          url: 'https://example.test/review',
          model: 'clef-flash',
          apiKeyRef: 'TEST_KEY',
          timeoutMs: 1000,
          costTier: 'free',
        },
        thresholds,
        signal: new AbortController().signal,
      },
      { ...snapshot, customRules: 'SENTINEL_USER_RULE' },
      // Production passes the rendered user payload; the decision state reuses
      // it instead of building a second copy of the same materials.
      {
        user: `${renderUser({ ...snapshot, customRules: 'SENTINEL_USER_RULE' })}\n\nSTATE`,
        estimatedInputTokens: 10,
      },
      'call-1',
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toHaveLength(1);
    expect(result.ok ? result.signals.source : null).toBe('decision');
    expect(result.ok ? result.signals.riskClass : null).toBe('medium');
    expect(received).toContain('STATE');
    expect(received).toContain('SENTINEL_USER_RULE');
  });

  test('reports a missing credential without a request', async () => {
    let called = false;
    const result = await runDecisionReviewer(
      {
        fetch: () => {
          called = true;
          return Promise.resolve(new Response('{}', { status: 200 }));
        },
        credentials: { resolve: () => Promise.resolve(undefined) },
        decision: {
          url: 'https://example.test/review',
          model: 'clef-flash',
          apiKeyRef: 'TEST_KEY',
          timeoutMs: 1000,
          costTier: 'free',
        },
        thresholds,
        signal: new AbortController().signal,
      },
      snapshot,
      { user: 'STATE', estimatedInputTokens: 10 },
      'call-1',
    );
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  test('reports an HTTP failure as a review failure', async () => {
    const result = await runDecisionReviewer(
      {
        fetch: () => Promise.resolve(new Response('nope', { status: 503 })),
        credentials: { resolve: () => Promise.resolve({ value: 'test-key' }) },
        decision: {
          url: 'https://example.test/review',
          model: 'clef-flash',
          apiKeyRef: 'TEST_KEY',
          timeoutMs: 1000,
          costTier: 'free',
        },
        thresholds,
        signal: new AbortController().signal,
      },
      snapshot,
      { user: 'STATE', estimatedInputTokens: 10 },
      'call-1',
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error).toContain('503');
  });
});

describe('credential redaction on a malformed answer', () => {
  // #90/#91 require a credential the provider echoes to stay out of attempt
  // records, returned errors and audit data. The score validator is a place that
  // could reintroduce it: it reads provider-controlled keys and values, so its
  // messages must name a rule class and never repeat what was submitted.
  const SECRET = 'test-credential-xyz';

  const answerWithSecret = (): string =>
    JSON.stringify({
      model: 'clef',
      answers: {
        // A complete ten-level key set so this exercises the *value* check rather
        // than stopping at the key-set check: the secret sits in a value position.
        risk: {
          type: 'score',
          probabilities: {
            '0': SECRET,
            '1': 0,
            '2': 0,
            '3': 0,
            '4': 0,
            '5': 0,
            '6': 0,
            '7': 0,
            '8': 0,
            '9': 0,
          },
          score: 1,
        },
        authorized: { type: 'score', probabilities: { 0: 1 }, score: 1 },
        secrets: { type: 'noul', noul: 0.01 },
        destructive: { type: 'noul', noul: 0.01 },
        egress: { type: 'noul', noul: 0.01 },
        bulk: { type: 'noul', noul: 0.01 },
      },
      usage: {},
    });

  const runWith = async (body: string) =>
    runDecisionReviewer(
      {
        fetch: () => Promise.resolve(new Response(body, { status: 200 })),
        credentials: { resolve: () => Promise.resolve({ value: SECRET }) },
        decision: {
          url: 'https://example.test/review',
          model: 'clef',
          apiKeyRef: 'TEST_KEY',
          timeoutMs: 1000,
          costTier: 'free',
        },
        thresholds,
        signal: new AbortController().signal,
      },
      snapshot,
      { user: 'STATE', estimatedInputTokens: 10 },
      'call-leak',
    );

  test('a secret in a probability value reaches no returned field', async () => {
    const result = await runWith(answerWithSecret());
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    // The failure is still classified, so the reason stays useful.
    expect(result.ok ? '' : result.error).toContain('probability');
  });

  test('a secret in an object key reaches no returned field', async () => {
    const body = JSON.stringify({
      model: 'clef',
      answers: {
        risk: { type: 'score', probabilities: { [SECRET]: 1 }, score: 1 },
        authorized: { type: 'score', probabilities: { 0: 1 }, score: 1 },
        secrets: { type: 'noul', noul: 0.01 },
        destructive: { type: 'noul', noul: 0.01 },
        egress: { type: 'noul', noul: 0.01 },
        bulk: { type: 'noul', noul: 0.01 },
      },
      usage: {},
    });
    const result = await runWith(body);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

/** A minimal request body builder so each shape test reads as one assertion. */
async function postedBody(url: string): Promise<Record<string, unknown>> {
  let received: unknown = null;
  const response = new Response(JSON.stringify(CAPTURED_CLOUDFLARE), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  await runDecisionReviewer(
    {
      fetch: (_input, init) => {
        received = init?.body;
        return Promise.resolve(response);
      },
      credentials: { resolve: () => Promise.resolve({ value: 'test-key' }) },
      decision: {
        url,
        model: 'clef',
        apiKeyRef: 'TEST_KEY',
        timeoutMs: 1000,
        costTier: 'free',
      },
      thresholds,
      signal: new AbortController().signal,
    },
    snapshot,
    { user: 'STATE', estimatedInputTokens: 10 },
    'call-1',
  );
  const parsed: unknown = JSON.parse(String(received));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('the request body must be a JSON object');
  }
  return { ...parsed };
}

describe('decision request shape', () => {
  // The envelope is a property of the entry point. These cases pin the two
  // shapes against the three verified entries plus the custom-endpoint fallback,
  // asserting the parsed body rather than a substring of it.
  test('a Cloudflare model-specific path sends a flat body', async () => {
    const body = await postedBody(
      'https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef',
    );
    expect(Object.keys(body)).toEqual(['model', 'state', 'questions']);
  });

  test('the generic Cloudflare entry wraps the request in input', async () => {
    const body = await postedBody(
      'https://api.cloudflare.com/client/v4/accounts/acct/ai/run',
    );
    // `input` carries the same material the flat body puts at the root, so the
    // wrapper is checked by what it holds rather than by its key alone.
    const input: unknown = body['input'];
    expect(input).toBeDefined();
    expect(Object.keys(body)).toEqual(['model', 'input']);
    expect(JSON.stringify(input)).toContain('STATE');
  });

  test('the native TypeSafe entry sends a flat body', async () => {
    const body = await postedBody('https://api.typesafe.ai/v1/systemone');
    expect(Object.keys(body)).toEqual(['model', 'state', 'questions']);
  });

  test('an unrecognized path keeps the flat body it had before', async () => {
    // A custom compatible service was addressable before this change; wrapping
    // or rejecting it would break a working configuration.
    const body = await postedBody('https://example.test/decision');
    expect(Object.keys(body)).toEqual(['model', 'state', 'questions']);
  });

  test('routing reads the pathname, not the raw URL', async () => {
    const body = await postedBody(
      'https://api.cloudflare.com/client/v4/accounts/acct/ai/run?trace=1',
    );
    expect(Object.keys(body)).toEqual(['model', 'input']);
  });
});

describe('decision failure reporting', () => {
  function refusal(status: number, payload: unknown) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  async function run(fetch: typeof globalThis.fetch, credential = 'test-key') {
    return runDecisionReviewer(
      {
        fetch,
        credentials: { resolve: () => Promise.resolve({ value: credential }) },
        decision: {
          url: 'https://example.test/ai/run',
          model: 'clef',
          apiKeyRef: 'TEST_KEY',
          timeoutMs: 1000,
          costTier: 'free',
        },
        thresholds,
        signal: new AbortController().signal,
      },
      snapshot,
      { user: 'STATE', estimatedInputTokens: 10 },
      'call-1',
    );
  }

  test('a refusal reports the provider explanation in the attempt and the result', async () => {
    const result = await run(() =>
      Promise.resolve(
        refusal(422, {
          errors: [
            { code: 3030, message: 'List should have at most 10 items' },
          ],
          success: false,
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Both consumers matter: the attempt feeds the audit record, the result
    // feeds the error-escalate trace and the human handoff text.
    expect(result.error).toContain('HTTP 422');
    expect(result.error).toContain('at most 10 items');
    expect(result.attempts[0]?.error).toContain('HTTP 422');
    expect(result.attempts[0]?.error).toContain('at most 10 items');
    // The status prefix stays exact so the connection test can still classify it.
    expect(result.attempts[0]?.error).toMatch(/^HTTP 422\b/u);
  });

  test('success:false wins over a structurally valid answer', async () => {
    // A provider that reports failure has not answered, even when it filled the
    // answer fields; trusting the payload would turn a provider fault into a
    // permission verdict.
    const result = await run(() =>
      Promise.resolve(
        refusal(200, {
          ...CAPTURED_CLOUDFLARE,
          success: false,
          errors: [{ message: 'quota exhausted' }],
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('quota exhausted');
    expect(result.attempts[0]?.parsed).toBeNull();
    // A failed request was still billed, so its usage is recorded rather than
    // dropped along with the verdict.
    expect(result.attempts[0]?.usage).toEqual({
      input_tokens: 1000,
      output_tokens: 0,
    });
  });

  test('a native response without a success field is still accepted', async () => {
    const result = await run(() =>
      Promise.resolve(
        new Response(JSON.stringify(CAPTURED_TYPESAFE), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    expect(result.ok).toBe(true);
  });

  test('a non-2xx response keeps the usage it reported', async () => {
    // The earlier failure path returned before reading the body, so a billed
    // refused request lost its token counts. The explanation and the usage come
    // from the same parse, and neither depends on a verdict being accepted.
    const result = await run(() =>
      Promise.resolve(
        refusal(422, {
          result: { usage: { input_tokens: 100, output_tokens: 0 } },
          success: false,
          errors: [{ message: 'Request validation failed' }],
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Request validation failed');
    expect(result.attempts[0]?.usage).toEqual({
      input_tokens: 100,
      output_tokens: 0,
    });
  });

  test('an explanation that crosses the length bound cannot leak a prefix', async () => {
    // Masking must precede bounding. The padding places the credential so the
    // cut lands inside it; asserting the whole value would pass even then,
    // because a cut leaves only a prefix — the assertion therefore targets the
    // exact fragment that survives truncation-before-masking.
    // The sentinel must be the credential this call actually sent: masking is
    // exact-value, so a different string would test nothing.
    const sentinel = 'sk-truncation-sentinel';
    const leaked = sentinel.slice(0, 6);
    const result = await run(
      () =>
        Promise.resolve(
          refusal(422, {
            errors: [{ message: `${'x'.repeat(280)}${sentinel}` }],
          }),
        ),
      sentinel,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain(leaked);
    expect(result.attempts[0]?.error).not.toContain(leaked);
  });

  test('a non-JSON refusal does not quote the body in its error', async () => {
    const result = await run(() =>
      Promise.resolve(new Response('SECRET_SENTINEL', { status: 200 })),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempts[0]?.error).not.toContain('SECRET_SENTINEL');
  });
});

describe('decision usage recording', () => {
  async function usageOf(payload: unknown): Promise<unknown> {
    const result = await runDecisionReviewer(
      {
        fetch: () =>
          Promise.resolve(
            new Response(JSON.stringify(payload), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          ),
        credentials: { resolve: () => Promise.resolve({ value: 'test-key' }) },
        decision: {
          url: 'https://example.test/ai/run',
          model: 'clef',
          apiKeyRef: 'TEST_KEY',
          timeoutMs: 1000,
          costTier: 'free',
        },
        thresholds,
        signal: new AbortController().signal,
      },
      snapshot,
      { user: 'STATE', estimatedInputTokens: 10 },
      'call-1',
    );
    return result.attempts[0]?.usage;
  }

  test('reads usage from the Cloudflare envelope', async () => {
    expect(await usageOf(CAPTURED_CLOUDFLARE)).toEqual({
      input_tokens: 1000,
      output_tokens: 0,
    });
  });

  test('reads usage from a native response', async () => {
    expect(await usageOf(CAPTURED_TYPESAFE)).toEqual({
      input_tokens: 847,
      output_tokens: 98,
    });
  });

  test('reports null when the provider omits usage', async () => {
    const withoutUsage = {
      ...CAPTURED_TYPESAFE,
      usage: undefined,
    } as Record<string, unknown>;
    delete withoutUsage['usage'];
    expect(await usageOf(withoutUsage)).toBeNull();
  });
});

describe('reviewer transport credential boundary', () => {
  // The agreed local-retention contract keeps the original review material but
  // never the transport credential or an auth header. These assertions pin the
  // boundary at the adapter, which is where the credential exists.
  test('a decision request record carries no credential or auth header', async () => {
    const sentinel = 'sk-decision-transport-sentinel';
    let authorization: string | null = null;
    const result = await runDecisionReviewer(
      {
        fetch: (_input, init) => {
          authorization = new Headers(init?.headers).get('authorization');
          return Promise.resolve(
            new Response('{"response":{}}', { status: 200 }),
          );
        },
        credentials: { resolve: () => Promise.resolve({ value: sentinel }) },
        decision: {
          url: 'https://example.test/review',
          model: 'clef-flash',
          apiKeyRef: 'TEST_KEY',
          timeoutMs: 1000,
          costTier: 'free',
        },
        thresholds,
        signal: new AbortController().signal,
      },
      snapshot,
      { user: 'STATE', estimatedInputTokens: 10 },
      'call-cred',
    );
    // The header did carry the credential, so the assertion below is meaningful.
    expect(authorization).toBe(`Bearer ${sentinel}`);
    const stored = JSON.stringify(result.attempts);
    expect(stored).not.toContain(sentinel);
    // The word "authorization" appears legitimately in the review policy text,
    // so the assertion targets a header *value*, not the vocabulary.
    expect(stored).not.toMatch(/authorization\s*[:=]\s*\S/iu);
    expect(stored).not.toMatch(/bearer\s+\S/iu);
  });

  test.each([
    [
      'the response body',
      (secret: string) =>
        new Response(JSON.stringify({ echo: secret }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ],
    [
      'a structured error message',
      (secret: string) =>
        new Response(
          JSON.stringify({ errors: [{ message: `invalid token: ${secret}` }] }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    ],
    [
      'the usage object',
      (secret: string) =>
        new Response(
          JSON.stringify({
            ...CAPTURED_TYPESAFE,
            usage: { input_tokens: 10, note: secret },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ],
    [
      'a usage key',
      (secret: string) =>
        new Response(
          JSON.stringify({
            ...CAPTURED_TYPESAFE,
            usage: { [secret]: 10, input_tokens: 10 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ],
    [
      'a non-JSON body',
      (secret: string) => new Response(secret, { status: 200 }),
    ],
  ])(
    'a credential echoed through %s never reaches the attempt record',
    async (_where, respond) => {
      const sentinel = 'sk-decision-echo-sentinel';
      const result = await runDecisionReviewer(
        {
          fetch: () => Promise.resolve(respond(sentinel)),
          credentials: { resolve: () => Promise.resolve({ value: sentinel }) },
          decision: {
            url: 'https://example.test/ai/run',
            model: 'clef',
            apiKeyRef: 'TEST_KEY',
            timeoutMs: 1000,
            costTier: 'free',
          },
          thresholds,
          signal: new AbortController().signal,
        },
        snapshot,
        { user: 'STATE', estimatedInputTokens: 10 },
        'call-echo',
      );
      // The writer stores each attempt field independently, so one masked field
      // proves nothing about the others; the whole serialized record must be
      // clean whatever route the echo took.
      expect(JSON.stringify(result.attempts)).not.toContain(sentinel);
      expect(result.ok ? '' : result.error).not.toContain(sentinel);
    },
  );

  test('a decision transport error does not echo the credential it sent', async () => {
    const sentinel = 'sk-decision-error-sentinel';
    const result = await runDecisionReviewer(
      {
        // A transport that quotes the header it failed with.
        fetch: () =>
          Promise.reject(
            new Error(
              `connect ECONNREFUSED (Authorization: Bearer ${sentinel})`,
            ),
          ),
        credentials: { resolve: () => Promise.resolve({ value: sentinel }) },
        decision: {
          url: 'https://example.test/review',
          model: 'clef-flash',
          apiKeyRef: 'TEST_KEY',
          timeoutMs: 1000,
          costTier: 'free',
        },
        thresholds,
        signal: new AbortController().signal,
      },
      snapshot,
      { user: 'STATE', estimatedInputTokens: 10 },
      'call-err',
    );
    const stored = JSON.stringify(result);
    expect(stored).not.toContain(sentinel);
    expect(result.ok).toBe(false);
    // The stage is still diagnosable.
    expect(result.ok ? '' : result.error).toContain('ECONNREFUSED');
  });

  test('a credential lookup failure names the reference, not the value', async () => {
    const result = await runDecisionReviewer(
      {
        fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
        credentials: {
          resolve: () => Promise.reject(new Error('vault says sk-leaky-value')),
        },
        decision: {
          url: 'https://example.test/review',
          model: 'clef-flash',
          apiKeyRef: 'TEST_KEY',
          timeoutMs: 1000,
          costTier: 'free',
        },
        thresholds,
        signal: new AbortController().signal,
      },
      snapshot,
      { user: 'STATE', estimatedInputTokens: 10 },
      'call-lookup',
    );
    const stored = JSON.stringify(result);
    expect(stored).not.toContain('sk-leaky-value');
    expect(stored).toContain('TEST_KEY');
  });

  test('an HTTP failure keeps the complete model-visible body', async () => {
    // A long body proves the record is not clipped: the agreed contract keeps
    // the visible response, and an audit size bound decides storage.
    const body = `rejected:${'x'.repeat(20_000)}`;
    const result = await runDecisionReviewer(
      {
        fetch: () => Promise.resolve(new Response(body, { status: 502 })),
        credentials: { resolve: () => Promise.resolve({ value: 'k' }) },
        decision: {
          url: 'https://example.test/review',
          model: 'clef-flash',
          apiKeyRef: 'TEST_KEY',
          timeoutMs: 1000,
          costTier: 'free',
        },
        thresholds,
        signal: new AbortController().signal,
      },
      snapshot,
      { user: 'STATE', estimatedInputTokens: 10 },
      'call-long',
    );
    expect(result.ok).toBe(false);
    expect(result.attempts[0]?.responseText).toBe(body);
  });
});

describe('calibrated cross-protocol parity', () => {
  // The unified authorization standard is a claim about *facts*, not about
  // spellings: the two protocols must reach one verdict for one set of facts.
  // Each pair below states the same authorization and risk situation twice, once
  // as chat point values and once as a decision distribution.
  //
  // Every distribution below is written out as the complete canonical ten levels,
  // because that is what the contract requires of a real answer — a sparse object
  // is rejected rather than read as a shorter distribution. `complete()` below is
  // test scaffolding for that requirement, not a production repair path.
  const complete = (
    mass: Readonly<Record<string, number>>,
  ): Record<string, number> => {
    const out: Record<string, number> = {};
    for (let level = 0; level <= 9; level += 1) {
      out[String(level)] = mass[String(level)] ?? 0;
    }
    return out;
  };
  const pairs = [
    {
      name: 'explicit authorization on a medium in-project write',
      chat: { risk: 5, authorized: 9 },
      decision: {
        risk: { probabilities: complete({ '4': 0.2, '5': 0.6, '6': 0.2 }) },
        authorized: { probabilities: complete({ '8': 0.85, '9': 0.15 }) },
      },
      expected: 'review-allow',
    },
    {
      // A2 on both sides: "no applicable permission" for this write. A1 is a
      // different fact — an effective prohibition — and it denies instead, which
      // the dedicated case below covers.
      name: 'no authorization on the same write',
      chat: { risk: 5, authorized: 2 },
      decision: {
        risk: { probabilities: complete({ '4': 0.2, '5': 0.6, '6': 0.2 }) },
        authorized: { probabilities: complete({ '1': 0.9, '3': 0.1 }) },
      },
      expected: 'review-escalate',
    },
    {
      // One prohibition, stated both ways: the same facts must refuse in both
      // protocols, because an effective prohibition is not a weak authorization.
      name: 'an effective prohibition on the same write',
      chat: { risk: 5, authorized: 1 },
      decision: {
        risk: { probabilities: complete({ '4': 0.2, '5': 0.6, '6': 0.2 }) },
        authorized: { probabilities: complete({ '0': 0.85, '9': 0.15 }) },
      },
      expected: 'review-deny',
    },
    {
      name: 'a goal-level hint on the same write',
      chat: { risk: 5, authorized: 6 },
      decision: {
        risk: { probabilities: complete({ '4': 0.2, '5': 0.6, '6': 0.2 }) },
        authorized: { probabilities: complete({ '5': 0.9, '6': 0.1 }) },
      },
      expected: 'review-escalate',
    },
  ] as const;

  test.each(pairs.map((pair) => [pair.name, pair] as const))(
    '%s reaches one verdict in both protocols',
    (_name, pair) => {
      const chatSignals = signalsFromChat(
        {
          risk: pair.chat.risk,
          authorized: pair.chat.authorized,
          secrets: false,
          destructive: false,
          egress: false,
          bulk: false,
        },
        0,
      );
      const parsed = parseDecisionResponse(
        {
          answers: {
            risk: {
              type: 'score',
              probabilities: pair.decision.risk.probabilities,
            },
            authorized: {
              type: 'score',
              probabilities: pair.decision.authorized.probabilities,
            },
            secrets: { type: 'noul', noul: 0.02 },
            destructive: { type: 'noul', noul: 0.05 },
            egress: { type: 'noul', noul: 0.05 },
            bulk: { type: 'noul', noul: 0.1 },
          },
        },
        thresholds,
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(parsed.error);

      const chat = decideReview(chatSignals, 'normal', thresholds);
      const decision = decideReview(parsed.signals, 'normal', thresholds);
      expect(decision.verdict).toBe(pair.expected);
      expect(chat.verdict).toBe(pair.expected);
      expect(decision.decisionRules).toEqual(chat.decisionRules);
    },
  );
});
