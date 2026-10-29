import { createServer } from 'node:http';

import { afterEach, describe, expect, test } from 'vitest';

import { review } from '../../src/reviewer/service.js';
import type { ReviewSnapshot } from '../../src/types.js';
import { NEW_SCALE_TYPESAFE } from '../helpers/decision-captures.js';

/**
 * The reviewer service over a real HTTP connection.
 *
 * The unit cases use a scripted `fetch`, which proves the parsing and the
 * envelope choice but not that the request survives a real socket: a body that is
 * not actually serialized, or a header the server rejects, would pass there and
 * fail here. This case starts a real server and reads what it received, so the
 * wire form is observed rather than assumed.
 */

interface Received {
  readonly path: string;
  readonly contentType: string | null;
  readonly authorization: string | null;
  readonly body: unknown;
}

const servers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of servers.splice(0)) await stop();
});

/**
 * A local endpoint that records one request and answers with a fixed body.
 *
 * Every path is served, so the same fixture exercises the wrapped and the flat
 * envelope by changing only the URL.
 */
async function startEndpoint(body: string): Promise<{
  readonly origin: string;
  readonly received: Received[];
}> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      received.push({
        path: request.url ?? '',
        contentType: request.headers['content-type'] ?? null,
        authorization: request.headers.authorization ?? null,
        body: JSON.parse(text === '' ? '{}' : text),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  servers.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  );
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new TypeError('expected a TCP address');
  }
  return { origin: `http://127.0.0.1:${String(address.port)}`, received };
}

function snapshot(): ReviewSnapshot {
  return {
    version: 1,
    createdAt: 0,
    configRevision: 'rev-int',
    callId: 'call-int',
    sessionId: 'main',
    sessionKind: 'main',
    turn: 1,
    tool: 'bash',
    cwd: '/work/project',
    action: { name: 'bash', arguments: { command: 'ls' } },
    facts: null,
    projectRules: null,
    customRules: '',
    materials: [],
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
      maxInputTokens: 10_000,
      estimatedInputTokens: 0,
      truncatedSegments: [],
    },
  };
}

describe('the decision transport over a real connection', () => {
  test('a native endpoint receives the flat body and the credential as a header', async () => {
    const endpoint = await startEndpoint(JSON.stringify(NEW_SCALE_TYPESAFE));
    const result = await review({
      snapshot: snapshot(),
      callId: 'call-int',
      signal: new AbortController().signal,
      backend: {
        kind: 'decision',
        transport: {
          fetch: globalThis.fetch,
          credentials: {
            resolve: () => Promise.resolve({ value: 'sk-integration' }),
          },
          decision: {
            url: `${endpoint.origin}/v1/systemone`,
            model: 'jev-1.13.0',
            apiKeyRef: 'INTEGRATION_KEY',
            timeoutMs: 5_000,
            costTier: 'free',
          },
          signal: new AbortController().signal,
        },
      },
    });
    expect(result.outcome.status).toBe('scored');
    expect(endpoint.received).toHaveLength(1);
    const seen = endpoint.received[0];
    expect(seen?.contentType).toContain('application/json');
    expect(seen?.authorization).toBe('Bearer sk-integration');
    // Flat: state and questions are siblings of the model, and no wrapper.
    expect(Object.keys(bodyOf(seen?.body)).sort()).toEqual([
      'model',
      'questions',
      'state',
    ]);
  });

  test('the generic run entry receives the wrapped body', async () => {
    const endpoint = await startEndpoint(JSON.stringify(NEW_SCALE_TYPESAFE));
    const result = await review({
      snapshot: snapshot(),
      callId: 'call-int',
      signal: new AbortController().signal,
      backend: {
        kind: 'decision',
        transport: {
          fetch: globalThis.fetch,
          credentials: undefined,
          decision: {
            // The pathname is what selects the wrapper, so the endpoint's own
            // path is the thing under test here.
            url: `${endpoint.origin}/accounts/acct/ai/run`,
            model: 'clef',
            apiKeyRef: '',
            timeoutMs: 5_000,
            costTier: 'free',
          },
          signal: new AbortController().signal,
        },
      },
    });
    expect(result.outcome.status).toBe('scored');
    const seen = endpoint.received[0];
    expect(Object.keys(bodyOf(seen?.body)).sort()).toEqual(['input', 'model']);
    // No credential reference means no authorization header was invented.
    expect(seen?.authorization).toBeNull();
  });

  test('a refused request keeps its HTTP status and reported usage', async () => {
    const endpoint = await startEndpoint(
      JSON.stringify({
        errors: [{ message: 'criteria list is malformed' }],
        result: { usage: { input_tokens: 300, output_tokens: 0 } },
      }),
    );
    const result = await review({
      snapshot: snapshot(),
      callId: 'call-int',
      signal: new AbortController().signal,
      backend: {
        kind: 'decision',
        transport: {
          fetch: async (input, init) => {
            const response = await globalThis.fetch(input, init);
            // Re-wrap the served body with a failure status: the endpoint fixture
            // answers 200, and the status is part of what this case checks.
            return new Response(await response.text(), {
              status: 422,
              headers: { 'content-type': 'application/json' },
            });
          },
          credentials: undefined,
          decision: {
            url: `${endpoint.origin}/v1/systemone`,
            model: 'jev',
            apiKeyRef: '',
            timeoutMs: 5_000,
            costTier: 'free',
          },
          signal: new AbortController().signal,
        },
      },
    });
    expect(result.outcome.status).toBe('review-failure');
    if (result.outcome.status !== 'review-failure') {
      throw new Error('expected a failure');
    }
    expect(result.outcome.reason).toContain('HTTP 422');
    expect(result.outcome.reason).toContain('criteria list is malformed');
    expect(result.attempts[0]?.normalizedUsage?.tokens.inputTokens).toBe(300);
  });

  test('the usage summary counts this review and reports its mapping version', async () => {
    const endpoint = await startEndpoint(JSON.stringify(NEW_SCALE_TYPESAFE));
    const result = await review({
      snapshot: snapshot(),
      callId: 'call-int',
      signal: new AbortController().signal,
      backend: {
        kind: 'decision',
        transport: {
          fetch: globalThis.fetch,
          credentials: undefined,
          decision: {
            url: `${endpoint.origin}/v1/systemone`,
            model: 'jev',
            apiKeyRef: '',
            timeoutMs: 5_000,
            costTier: 'free',
          },
          signal: new AbortController().signal,
        },
      },
    });
    expect(result.usage.attempts).toBe(1);
    expect(result.usage.withUsage).toBe(1);
    // The payload carried input and output counts but no total, so the total is
    // unknown rather than derived from the two.
    expect(result.usage.totals.inputTokens.total).toBe(900);
    expect(result.usage.totals.outputTokens.total).toBe(120);
    expect(result.usage.totals.totalTokens.total).toBeNull();
    expect(result.usage.mappingVersion).toBe('review-usage-v1');
  });
});

function bodyOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('expected a request body');
  }
  return Object.fromEntries(Object.entries(value));
}
