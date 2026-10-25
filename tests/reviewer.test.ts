import { describe, expect, test } from 'vitest';

import { DEFAULT_CONFIG } from '../src/config.js';
import {
  extractJsonObject,
  parseChatText,
  parseDecisionResponse,
  signalsFromChat,
  runChatReviewer,
  runDecisionReviewer,
} from '../src/reviewer.js';
import type { ReviewSnapshot } from '../src/types.js';

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

  test('detects contradictions that require a repair', () => {
    const lowDestructive = parseChatText(
      '{"risk":2,"authorized":6,"secrets":false,"destructive":true,"egress":false,"bulk":false}',
    );
    expect(lowDestructive.ok).toBe(false);
    expect(lowDestructive.error).toContain('contradiction');
    const highClean = parseChatText(
      '{"risk":10,"authorized":6,"secrets":false,"destructive":false,"egress":false,"bulk":false}',
    );
    expect(highClean.ok).toBe(false);
  });

  test('extraction finds the first balanced object', () => {
    expect(extractJsonObject('text {"a":1} tail')).toBe('{"a":1}');
  });
});

describe('decision reviewer output', () => {
  test('maps score distributions and noul answers', () => {
    const body = {
      result: {
        response: {
          risk: {
            type: 'score',
            score: 2.1,
            probabilities: { '1': 0.2, '5': 0.7, '9': 0.1 },
          },
          authorized: {
            type: 'score',
            score: 8.4,
            probabilities: { '8': 0.8, '9': 0.2 },
          },
          secrets: { type: 'noul', noul: 0.1 },
          destructive: { type: 'noul', noul: 0.1 },
          egress: { type: 'noul', noul: 0.2 },
          bulk: { type: 'noul', noul: 0.1 },
        },
      },
    };
    const parsed = parseDecisionResponse(body, thresholds);
    expect(parsed.ok).toBe(true);
    const signals = parsed.ok ? parsed.signals : null;
    expect(signals?.source).toBe('decision');
    expect(signals?.riskClass).toBe('medium');
    expect(signals?.authClass).toBe('explicit');
    expect(signals?.secrets).toBe(false);
  });

  test('rejects missing answers and invalid probabilities', () => {
    expect(parseDecisionResponse({}, thresholds).ok).toBe(false);
    const parsed = parseDecisionResponse(
      { response: { risk: { type: 'score' }, authorized: { type: 'score' } } },
      thresholds,
    );
    expect(parsed.ok).toBe(false);
  });
});

const snapshot: ReviewSnapshot = {
  version: 1,
  createdAt: 0,
  callId: 'call-1',
  sessionId: 'session-1',
  sessionKind: 'main',
  tool: 'bash',
  cwd: '/tmp',
  action: { name: 'bash', arguments: { command: 'echo hi' } },
  facts: null,
  projectRules: null,
  customRules: '',
  evidence: [],
  evidenceTruncated: false,
  parentAuthorizationPresent: null,
  context: [],
  checkpoints: [],
  contextTruncated: false,
  priorVerdicts: [],
  historyTruncated: false,
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
});

describe('decision reviewer run', () => {
  test('posts state and questions and maps a distribution response', async () => {
    const response = new Response(
      JSON.stringify({
        response: {
          risk: {
            type: 'score',
            score: 2,
            probabilities: { '1': 0.2, '5': 0.7, '9': 0.1 },
          },
          authorized: {
            type: 'score',
            score: 8,
            probabilities: { '8': 0.8, '9': 0.2 },
          },
          secrets: { type: 'noul', noul: 0.1 },
          destructive: { type: 'noul', noul: 0.1 },
          egress: { type: 'noul', noul: 0.2 },
          bulk: { type: 'noul', noul: 0.1 },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
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
      { user: 'STATE', estimatedInputTokens: 10 },
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
