import { describe, expect, test } from 'vitest';

import { DEFAULT_CONFIG } from '../src/config.js';
import {
  PROBE_SNAPSHOT,
  renderUser,
  runReviewerProbe,
} from '../src/reviewer.js';
import type { ArbiterConfig } from '../src/types.js';

/**
 * The one-shot connection test.
 *
 * A pass means the answer satisfied the production parser, never that an action
 * would be allowed, and the probe must not borrow real history or leave any
 * runtime side effect. These cases drive the real `runChatReviewer` /
 * `runDecisionReviewer` through a stub transport.
 */

function configWith(
  overrides: Partial<ArbiterConfig['reviewer']> = {},
): ArbiterConfig {
  return {
    ...DEFAULT_CONFIG,
    reviewer: { ...DEFAULT_CONFIG.reviewer, ...overrides },
  };
}

function chatConfig(provider = 'p', model = 'm'): ArbiterConfig {
  return configWith({
    type: 'chat',
    chat: {
      ...DEFAULT_CONFIG.reviewer.chat,
      provider,
      model,
      maxRepairRetries: 1,
      timeoutMs: 1_000,
    },
  });
}

function decisionConfig(): ArbiterConfig {
  return configWith({
    type: 'decision',
    decision: {
      ...DEFAULT_CONFIG.reviewer.decision,
      url: 'https://reviewer.test/probe',
      apiKeyRef: 'PROBE_KEY',
      timeoutMs: 1_000,
    },
  });
}

const VALID_CHAT = JSON.stringify({
  risk: 1,
  authorized: 8,
  secrets: false,
  destructive: false,
  egress: false,
  bulk: false,
});

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

function answer(text: string): AsyncIterable<Record<string, unknown>> {
  return streamOf([
    { type: 'text-delta', text },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
}

/**
 * A contracted decision answer.
 *
 * The wire format carries a probability distribution per scored answer and a
 * `noul` probability per boolean probe, as the production parser expects.
 */
function decisionAnswer(): Response {
  const probabilities = Object.fromEntries(
    Array.from({ length: 11 }, (_, index) => [
      String(index),
      index === 6 ? 1 : 0,
    ]),
  );
  return new Response(
    JSON.stringify({
      response: {
        risk: { type: 'score', probabilities, score: 6 },
        authorized: { type: 'score', probabilities, score: 6 },
        secrets: { noul: 0 },
        destructive: { noul: 0 },
        egress: { noul: 1 },
        bulk: { noul: 0 },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function credentials(value: string | undefined) {
  return {
    resolve: () => Promise.resolve(value === undefined ? undefined : { value }),
  };
}

describe('probe input', () => {
  test('is a fixed synthetic sample with no real history or project material', () => {
    expect(PROBE_SNAPSHOT.callId).toBe('reviewer-probe');
    expect(PROBE_SNAPSHOT.sessionId).toBe('reviewer-probe');
    expect(PROBE_SNAPSHOT.evidence).toEqual([]);
    expect(PROBE_SNAPSHOT.context).toEqual([]);
    expect(PROBE_SNAPSHOT.checkpoints).toEqual([]);
    expect(PROBE_SNAPSHOT.priorVerdicts).toEqual([]);
    expect(PROBE_SNAPSHOT.customRules).toBe('');
    expect(PROBE_SNAPSHOT.projectRules).toBeNull();
    expect(PROBE_SNAPSHOT.missing).toEqual([]);
    expect(PROBE_SNAPSHOT.budget.truncatedSegments).toEqual([]);
    // The probe never carries a caller's session identity.
    expect(renderUser(PROBE_SNAPSHOT)).toContain('printf arbiter-probe');
  });

  test('the rendered material is stable across runs', () => {
    const first = renderUser(PROBE_SNAPSHOT);
    // `createdAt` is not part of the material, so a different clock value must
    // not change what the model is asked.
    const second = renderUser({ ...PROBE_SNAPSHOT, createdAt: 999 });
    expect(second).toBe(first);
  });
});

describe('chat probe', () => {
  test('a first-time valid answer passes and reports the real route', async () => {
    const result = await runReviewerProbe({
      config: chatConfig('deepseek-official', 'deepseek-flash'),
      llm: { stream: () => answer(VALID_CHAT) },
      credentials: undefined,
      fetch: globalThis.fetch,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('passed');
    expect(result.model).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    });
    expect(result.backend).toBe('chat');
    expect(result.protocol).toBe('arbiter-chat-json-v1');
    if (result.status !== 'passed') throw new Error('expected a pass');
    expect(result.repairs).toBe(0);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.responseText).toBe(VALID_CHAT);
    // Material is the probe's own synthetic action, not a caller snapshot.
    expect(JSON.stringify(result.attempts[0]?.request)).toContain(
      'printf arbiter-probe',
    );
  });

  test('one invalid answer is repaired, and both attempts are kept', async () => {
    let call = 0;
    const result = await runReviewerProbe({
      config: chatConfig(),
      llm: {
        stream: () => {
          call += 1;
          return call === 1 ? answer('not json at all') : answer(VALID_CHAT);
        },
      },
      credentials: undefined,
      fetch: globalThis.fetch,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('passed');
    if (result.status !== 'passed') throw new Error('expected a pass');
    expect(result.repairs).toBe(1);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.error).toContain('not valid JSON');
    expect(result.attempts[1]?.error).toBeNull();
    // The repair prompt is the formal one, so the second request carries it.
    expect(JSON.stringify(result.attempts[1]?.request)).toContain(
      'previous answer was rejected',
    );
  });

  test('an answer that classifies as deny still passes the protocol test', async () => {
    // High risk and no authorization: the formal policy would deny this, but the
    // connection test only asks whether the output contract was met.
    const deny = JSON.stringify({
      risk: 9,
      authorized: 0,
      secrets: true,
      destructive: true,
      egress: true,
      bulk: false,
    });
    const result = await runReviewerProbe({
      config: chatConfig(),
      llm: { stream: () => answer(deny) },
      credentials: undefined,
      fetch: globalThis.fetch,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('passed');
    if (result.status !== 'passed') throw new Error('expected a pass');
    expect(result.signals.riskClass).toBe('high');
    expect(result.signals.authClass).toBe('none');
  });

  test('a provider error fails without consuming a repair attempt', async () => {
    let calls = 0;
    const result = await runReviewerProbe({
      config: chatConfig(),
      llm: {
        stream: () => {
          calls += 1;
          return streamOf([
            {
              type: 'finish',
              reason: {
                kind: 'failure',
                failure: { code: 'AUTH', message: 'invalid api key' },
              },
            },
          ]);
        },
      },
      credentials: undefined,
      fetch: globalThis.fetch,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    // The provider named its own failure code (AUTH), which the diagnostic maps
    // to the stage it describes rather than calling it a network fault.
    expect(result.failure).toBe('unauthorized');
    // Provider failures are not retried: only format failures are.
    expect(calls).toBe(1);
    expect(result.attempts).toHaveLength(1);
  });

  test('output that never becomes valid reports invalid-output after the last attempt', async () => {
    const result = await runReviewerProbe({
      config: chatConfig(),
      llm: { stream: () => answer('still not json') },
      credentials: undefined,
      fetch: globalThis.fetch,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.failure).toBe('invalid-output');
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.every((entry) => entry.responseText !== null)).toBe(
      true,
    );
  });

  test('following the session is refused before any request', async () => {
    let called = false;
    const result = await runReviewerProbe({
      config: chatConfig('session', ''),
      llm: {
        stream: () => {
          called = true;
          return answer(VALID_CHAT);
        },
      },
      credentials: undefined,
      fetch: globalThis.fetch,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.failure).toBe('model-required');
    expect(called).toBe(false);
    expect(result.attempts).toEqual([]);
  });

  test('a pre-aborted signal reports cancelled without a request', async () => {
    let called = false;
    const abort = new AbortController();
    abort.abort();
    const result = await runReviewerProbe({
      config: chatConfig(),
      llm: {
        stream: () => {
          called = true;
          return answer(VALID_CHAT);
        },
      },
      credentials: undefined,
      fetch: globalThis.fetch,
      signal: abort.signal,
    });
    expect(result.status).toBe('cancelled');
    expect(called).toBe(false);
  });

  test('a stream aborted mid-flight reports cancelled, not a backend failure', async () => {
    const abort = new AbortController();
    const result = await runReviewerProbe({
      config: chatConfig(),
      llm: {
        stream: () => {
          abort.abort();
          return streamOf([
            {
              type: 'finish',
              reason: { kind: 'failure', failure: { code: 'ABORTED' } },
            },
          ]);
        },
      },
      credentials: undefined,
      fetch: globalThis.fetch,
      signal: abort.signal,
    });
    expect(result.status).toBe('cancelled');
  });
});

describe('chat probe termination branches', () => {
  test('every allowed attempt being invalid fails without a protocol pass', async () => {
    let calls = 0;
    const result = await runReviewerProbe({
      config: chatConfig(),
      llm: {
        stream: () => {
          calls += 1;
          return answer(`attempt ${String(calls)} is not json`);
        },
      },
      credentials: undefined,
      fetch: globalThis.fetch,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.failure).toBe('invalid-output');
    // One initial attempt plus the configured repair.
    expect(calls).toBe(2);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.map((entry) => entry.error === null)).toEqual([
      false,
      false,
    ]);
    // Both raw answers are preserved for diagnosis.
    expect(result.attempts[0]?.responseText).toContain('attempt 1');
    expect(result.attempts[1]?.responseText).toContain('attempt 2');
  });

  test('an adapter-internal timeout is timed-out, not cancelled', async () => {
    // The formal chat adapter wraps each attempt with its own timeout. An
    // AbortError from that timer must not be reported as a user cancellation.
    const result = await runReviewerProbe({
      config: chatConfig(),
      llm: {
        stream: () => {
          throw new DOMException('The operation timed out.', 'TimeoutError');
        },
      },
      credentials: undefined,
      fetch: globalThis.fetch,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.failure).toBe('timed-out');
  });

  test('an AbortError without a cancelled caller signal is not a cancellation', async () => {
    // A provider may raise AbortError for its own reasons; only the caller's
    // signal proves the user ended the run.
    const result = await runReviewerProbe({
      config: chatConfig(),
      llm: {
        stream: () => {
          throw new DOMException('aborted by provider', 'AbortError');
        },
      },
      credentials: undefined,
      fetch: globalThis.fetch,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.failure).toBe('network');
  });

  test('a cancel that races a successful answer still reports cancelled', async () => {
    const abort = new AbortController();
    const result = await runReviewerProbe({
      config: chatConfig(),
      llm: {
        stream: () => {
          // The answer is already on its way when the caller cancels.
          abort.abort();
          return answer(VALID_CHAT);
        },
      },
      credentials: undefined,
      fetch: globalThis.fetch,
      signal: abort.signal,
    });
    expect(result.status).toBe('cancelled');
    expect(JSON.stringify(result)).not.toContain('"status":"passed"');
  });
});

describe('chat provider classification', () => {
  test.each([
    ['AUTH', 'unauthorized'],
    ['INVALID_API_KEY', 'unauthorized'],
    ['QUOTA_EXCEEDED', 'rate-limited'],
    ['RATE_LIMIT', 'rate-limited'],
    ['TIMEOUT', 'timed-out'],
    ['SOMETHING_ELSE', 'unknown'],
  ])('a provider failure code %s maps to %s', async (code, expected) => {
    const result = await runReviewerProbe({
      config: chatConfig(),
      llm: {
        stream: () =>
          streamOf([
            {
              type: 'finish',
              reason: {
                kind: 'failure',
                failure: { code, message: 'provider said no' },
              },
            },
          ]),
      },
      credentials: undefined,
      fetch: globalThis.fetch,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.failure).toBe(expected);
  });

  test('a real adapter timer abort is reported as timed-out, not network', async () => {
    // The stub waits for the signal the adapter itself aborts, so the timeout is
    // the adapter's real timer rather than a hand-written error message.
    const result = await runReviewerProbe({
      config: {
        ...chatConfig(),
        reviewer: {
          ...chatConfig().reviewer,
          chat: { ...chatConfig().reviewer.chat, timeoutMs: 30 },
        },
      },
      llm: {
        stream: (options) =>
          (async function* () {
            await new Promise<void>((resolve) => {
              options.signal?.addEventListener('abort', () => {
                resolve();
              });
            });
            yield { type: 'text-delta', text: 'late' };
          })(),
      },
      credentials: undefined,
      fetch: globalThis.fetch,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.failure).toBe('timed-out');
    expect(result.attempts[0]?.error).toContain('timed out');
  });
});

describe('diagnostic material boundary', () => {
  test('a decision provider echoing the credential cannot carry it into the result', async () => {
    const secret = 'sk-live-echoed-by-provider';
    const result = await runReviewerProbe({
      config: decisionConfig(),
      llm: undefined,
      credentials: credentials(secret),
      fetch: () =>
        Promise.resolve(
          new Response(`upstream rejected Authorization: Bearer ${secret}`, {
            status: 502,
          }),
        ),
      signal: new AbortController().signal,
    });
    const material = JSON.stringify(result);
    expect(material).not.toContain(secret);
    expect(material).toContain('[redacted]');
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.failure).toBe('unavailable');
  });

  test('a throwing decision transport cannot carry the credential out', async () => {
    const secret = 'sk-live-in-exception';
    const result = await runReviewerProbe({
      config: decisionConfig(),
      llm: undefined,
      credentials: credentials(secret),
      fetch: () => Promise.reject(new Error(`socket failed for ${secret}`)),
      signal: new AbortController().signal,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.status).toBe('failed');
  });

  test('the credential that authenticated the call is the one redacted', async () => {
    // A resolver may return a different value on a second call (a rotation). The
    // probe pins the first value and the adapter sends that same one, so the
    // echoed secret is always the one being masked.
    const first = 'sk-first-rotation-value';
    const second = 'sk-second-rotation-value';
    let calls = 0;
    let sent: string | null = null;
    const result = await runReviewerProbe({
      config: decisionConfig(),
      llm: undefined,
      credentials: {
        resolve: () => {
          calls += 1;
          return Promise.resolve({
            value: calls === 1 ? first : second,
          });
        },
      },
      fetch: (_input, init) => {
        sent = new Headers(init?.headers).get('authorization');
        return Promise.resolve(
          new Response(`rejected ${first}`, { status: 502 }),
        );
      },
      signal: new AbortController().signal,
    });
    const material = JSON.stringify(result);
    // Exactly one resolution, so the request could only carry the pinned value.
    expect(calls).toBe(1);
    expect(sent).toBe(`Bearer ${first}`);
    // The echoed secret is masked; the never-sent rotation value is not a
    // credential this run handled.
    expect(material).not.toContain(first);
    expect(material).toContain('[redacted]');
  });

  test('a chat provider echoing an authorization header cannot publish it', async () => {
    const result = await runReviewerProbe({
      config: chatConfig(),
      llm: {
        stream: () =>
          streamOf([
            {
              type: 'finish',
              reason: {
                kind: 'failure',
                failure: {
                  code: 'AUTH',
                  message:
                    'upstream said Authorization: Bearer sk-header-secret',
                },
              },
            },
          ]),
      },
      credentials: undefined,
      fetch: globalThis.fetch,
      signal: new AbortController().signal,
    });
    const material = JSON.stringify(result);
    expect(material).not.toContain('sk-header-secret');
    expect(material).toContain('[redacted]');
  });

  test('a resolved credential never appears in the submitted request material', async () => {
    const secret = 'sk-live-request-material';
    const result = await runReviewerProbe({
      config: decisionConfig(),
      llm: undefined,
      credentials: credentials(secret),
      fetch: () =>
        Promise.resolve(
          new Response('{"response":{"risk":"nope"}}', { status: 200 }),
        ),
      signal: new AbortController().signal,
    });
    const material = JSON.stringify(result.attempts);
    expect(material).not.toContain(secret);
    expect(material).not.toContain('Authorization');
  });
});

describe('decision probe', () => {
  test('a valid decision answer passes and reports the configured model', async () => {
    const result = await runReviewerProbe({
      config: decisionConfig(),
      llm: undefined,
      credentials: credentials('probe-secret-value'),
      fetch: () => Promise.resolve(decisionAnswer()),
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('passed');
    expect(result.model).toEqual({
      provider: 'decision',
      model: DEFAULT_CONFIG.reviewer.decision.model,
    });
    expect(result.backend).toBe('decision');
    if (result.status !== 'passed') throw new Error('expected a pass');
    // The decision protocol has no repair loop.
    expect(result.repairs).toBe(0);
    expect(result.attempts).toHaveLength(1);
    const material = JSON.stringify(result.attempts[0]);
    // The credential authenticates the call and never becomes material.
    expect(material).not.toContain('probe-secret-value');
    expect(material).toContain('printf arbiter-probe');
  });

  test('a missing credential fails without issuing a request', async () => {
    let called = false;
    const result = await runReviewerProbe({
      config: decisionConfig(),
      llm: undefined,
      credentials: credentials(undefined),
      fetch: () => {
        called = true;
        return Promise.resolve(decisionAnswer());
      },
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.failure).toBe('credential-missing');
    expect(called).toBe(false);
    expect(result.attempts).toEqual([]);
  });

  test.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [429, 'rate-limited'],
    [503, 'unavailable'],
    [400, 'unavailable'],
  ])('HTTP %i fails as %s while keeping the raw body', async (status, kind) => {
    const result = await runReviewerProbe({
      config: decisionConfig(),
      llm: undefined,
      credentials: credentials('probe-secret-value'),
      fetch: () =>
        Promise.resolve(new Response('upstream refused', { status })),
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.failure).toBe(kind);
    expect(result.attempts[0]?.error).toBe(`HTTP ${String(status)}`);
    expect(result.attempts[0]?.responseText).toBe('upstream refused');
  });

  test('a malformed decision body fails the output contract', async () => {
    const result = await runReviewerProbe({
      config: decisionConfig(),
      llm: undefined,
      credentials: credentials('probe-secret-value'),
      fetch: () =>
        Promise.resolve(
          new Response('{"response":{"risk":"nope"}}', { status: 200 }),
        ),
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.failure).toBe('invalid-output');
  });

  test('a cancel during credential resolution is cancelled, not credential-missing', async () => {
    const abort = new AbortController();
    const result = await runReviewerProbe({
      config: decisionConfig(),
      llm: undefined,
      credentials: {
        resolve: async () => {
          abort.abort();
          return Promise.resolve(undefined);
        },
      },
      fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
      signal: abort.signal,
    });
    expect(result.status).toBe('cancelled');
    expect(JSON.stringify(result)).not.toContain('credential-missing');
  });

  test('a network throw is a request failure, not an invalid answer', async () => {
    const result = await runReviewerProbe({
      config: decisionConfig(),
      llm: undefined,
      credentials: credentials('probe-secret-value'),
      fetch: () => Promise.reject(new Error('ECONNREFUSED 127.0.0.1:9')),
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.failure).toBe('network');
  });
});
