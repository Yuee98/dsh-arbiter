import { describe, expect, test } from 'vitest';

import {
  aggregateUsage,
  normalizeUsage,
  USAGE_FIELDS,
  USAGE_MAPPING_VERSION,
} from '../src/reviewer/usage.js';
import type { ReviewSnapshot } from '../src/types.js';

/**
 * The shared usage contract.
 *
 * This interface is handed to #68 (production records), #74 (run artifacts) and
 * #75 (reports), so these cases pin the properties those consumers rely on rather
 * than one provider's field names:
 *
 *   - a missing field is null, never 0, and an explicitly reported 0 stays 0;
 *   - a sub-count is never added into its parent, and the inclusion it has is
 *     stated or left unknown;
 *   - a total's coverage is reported beside it, so a partial sum cannot pass for
 *     a complete one;
 *   - aggregation dedupes by attempt identity instead of summing a record twice.
 */

describe('normalization', () => {
  test('reads the host chat vocabulary', () => {
    const usage = normalizeUsage('chat', {
      inputTokens: 900,
      outputTokens: 20,
      totalTokens: 920,
    });
    expect(usage?.tokens).toEqual({
      inputTokens: 900,
      outputTokens: 20,
      totalTokens: 920,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    });
    expect(usage?.mappingVersion).toBe(USAGE_MAPPING_VERSION);
    expect(usage?.source).toBe('chat');
  });

  test('reads the decision vendors snake_case vocabulary', () => {
    const usage = normalizeUsage('decision', {
      input_tokens: 847,
      output_tokens: 98,
    });
    expect(usage?.tokens.inputTokens).toBe(847);
    expect(usage?.tokens.outputTokens).toBe(98);
    // The vendor did not report a total, so it is unknown and not derived.
    expect(usage?.tokens.totalTokens).toBeNull();
  });

  test('reads OpenAI-compatible naming a compatible service may forward', () => {
    const usage = normalizeUsage('decision', {
      prompt_tokens: 1000,
      completion_tokens: 64,
      total_tokens: 1064,
    });
    expect(usage?.tokens).toMatchObject({
      inputTokens: 1000,
      outputTokens: 64,
      totalTokens: 1064,
    });
  });

  test('an explicitly reported zero stays zero', () => {
    // The captured Cloudflare answer really reported output_tokens: 0. That is a
    // different fact from an absent field, and a report that prints both as 0 is
    // wrong about one of them.
    const usage = normalizeUsage('decision', {
      input_tokens: 1000,
      output_tokens: 0,
    });
    expect(usage?.tokens.outputTokens).toBe(0);
    expect(usage?.tokens.totalTokens).toBeNull();
  });

  test('nothing reported at all is null, not an empty summary', () => {
    expect(normalizeUsage('chat', null)).toBeNull();
    expect(normalizeUsage('chat', undefined)).toBeNull();
  });

  test('a payload that reported nothing readable is kept as all-unknown', () => {
    const usage = normalizeUsage('decision', { unrelated: 1 });
    expect(usage).not.toBeNull();
    for (const field of USAGE_FIELDS) {
      expect(usage?.tokens[field]).toBeNull();
    }
    // The payload is preserved even though no bucket could be filled, so a reader
    // can see what the provider actually sent.
    expect(usage?.raw).toEqual({ unrelated: 1 });
  });

  test('values the contract cannot read are reported rather than dropped', () => {
    const usage = normalizeUsage('decision', {
      input_tokens: '1200',
      output_tokens: -5,
    });
    expect(usage?.tokens.inputTokens).toBeNull();
    expect(usage?.tokens.outputTokens).toBeNull();
    expect(usage?.ignored).toEqual(['input_tokens', 'output_tokens']);
  });

  test('records where each bucket came from', () => {
    const usage = normalizeUsage('decision', {
      prompt_tokens: 1000,
      completion_tokens_details: { reasoning_tokens: 120 },
    });
    expect(usage?.sources).toEqual(
      expect.arrayContaining([
        { field: 'inputTokens', path: 'prompt_tokens' },
        {
          field: 'reasoningTokens',
          path: 'completion_tokens_details.reasoning_tokens',
        },
      ]),
    );
  });

  test('the first spelling that matches wins, so one bucket is filled once', () => {
    // A payload carrying a deprecated alias beside the current field must not
    // resolve twice; which one wins is fixed by the mapping order.
    const usage = normalizeUsage('decision', {
      input_tokens: 11,
      prompt_tokens: 22,
    });
    expect(usage?.tokens.inputTokens).toBe(11);
    expect(
      usage?.sources.filter((source) => source.field === 'inputTokens'),
    ).toHaveLength(1);
  });
});

describe('sub-count inclusion', () => {
  test('an encapsulated cache read is declared contained in the input count', () => {
    const usage = normalizeUsage('decision', {
      prompt_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 400 },
    });
    expect(usage?.tokens.cacheReadTokens).toBe(400);
    // Adding 400 to 1000 would bill the cached tokens twice, so the relationship
    // is stated instead of summed.
    expect(usage?.inclusions.cacheRead).toBe('contained');
    expect(usage?.tokens.inputTokens).toBe(1000);
  });

  test('a separately reported cache read is declared separate', () => {
    const usage = normalizeUsage('decision', {
      input_tokens: 500,
      cache_read_input_tokens: 1200,
      cache_creation_input_tokens: 300,
    });
    expect(usage?.inclusions.cacheRead).toBe('separate');
    expect(usage?.inclusions.cacheWrite).toBe('separate');
    // The parent is untouched: 500 is what the provider called input.
    expect(usage?.tokens.inputTokens).toBe(500);
  });

  test('reasoning tokens inside the completion count are contained', () => {
    const usage = normalizeUsage('decision', {
      completion_tokens: 500,
      completion_tokens_details: { reasoning_tokens: 320 },
    });
    expect(usage?.inclusions.reasoning).toBe('contained');
    expect(usage?.tokens.outputTokens).toBe(500);
    expect(usage?.tokens.reasoningTokens).toBe(320);
  });

  test('an inclusion the payload does not establish stays unknown', () => {
    const usage = normalizeUsage('decision', {
      reasoning_tokens: 320,
    });
    // Gemini reports reasoning beside the candidate count; a bare
    // `reasoning_tokens` says nothing either way.
    expect(usage?.tokens.reasoningTokens).toBe(320);
    expect(usage?.inclusions.reasoning).toBe('unknown');
  });
});

describe('aggregation', () => {
  test('sums buckets and reports coverage beside each total', () => {
    const summary = aggregateUsage([
      {
        attemptId: 'a:1',
        usage: normalizeUsage('chat', { inputTokens: 100, outputTokens: 10 }),
      },
      {
        attemptId: 'a:2',
        usage: normalizeUsage('chat', {
          inputTokens: 200,
          outputTokens: 20,
          totalTokens: 220,
        }),
      },
    ]);
    expect(summary.attempts).toBe(2);
    expect(summary.withUsage).toBe(2);
    expect(summary.totals.inputTokens).toEqual({
      total: 300,
      reported: 2,
      missing: 0,
      complete: true,
    });
    // Only one attempt reported a total, so the sum is a known-partial and says so.
    expect(summary.totals.totalTokens).toEqual({
      total: 220,
      reported: 1,
      missing: 1,
      complete: false,
    });
  });

  test('a bucket no attempt reported is null rather than zero', () => {
    const summary = aggregateUsage([
      {
        attemptId: 'a:1',
        usage: normalizeUsage('chat', { inputTokens: 100, outputTokens: 10 }),
      },
    ]);
    expect(summary.totals.cacheReadTokens).toEqual({
      total: null,
      reported: 0,
      missing: 1,
      complete: false,
    });
    expect(summary.totals.cacheReadTokens.total).not.toBe(0);
  });

  test('an explicit zero counts as reported', () => {
    const summary = aggregateUsage([
      {
        attemptId: 'a:1',
        usage: normalizeUsage('decision', {
          input_tokens: 1000,
          output_tokens: 0,
        }),
      },
    ]);
    expect(summary.totals.outputTokens).toEqual({
      total: 0,
      reported: 1,
      missing: 0,
      complete: true,
    });
  });

  test('an attempt with no usage is missing, not zero', () => {
    const summary = aggregateUsage([
      {
        attemptId: 'a:1',
        usage: normalizeUsage('chat', { inputTokens: 100 }),
      },
      { attemptId: 'a:2', usage: null },
    ]);
    expect(summary.attempts).toBe(2);
    expect(summary.withUsage).toBe(1);
    expect(summary.totals.inputTokens).toEqual({
      total: 100,
      reported: 1,
      missing: 1,
      complete: false,
    });
  });

  test('a failed attempt that reported usage is counted', () => {
    const summary = aggregateUsage([
      {
        attemptId: 'a:1',
        usage: normalizeUsage('decision', { input_tokens: 1200 }),
      },
      { attemptId: 'a:2', usage: null },
    ]);
    expect(summary.totals.inputTokens.total).toBe(1200);
  });

  test('the same attempt identity is counted once', () => {
    const entry = {
      attemptId: 'a:1',
      usage: normalizeUsage('chat', { inputTokens: 100 }),
    };
    const summary = aggregateUsage([entry, entry, entry]);
    expect(summary.attempts).toBe(1);
    expect(summary.duplicateAttempts).toBe(2);
    expect(summary.totals.inputTokens.total).toBe(100);
  });

  test('an inclusion two attempts disagree on cannot be summed either way', () => {
    const summary = aggregateUsage([
      {
        attemptId: 'a:1',
        usage: normalizeUsage('decision', {
          prompt_tokens: 100,
          prompt_tokens_details: { cached_tokens: 50 },
        }),
      },
      {
        attemptId: 'a:2',
        usage: normalizeUsage('decision', {
          input_tokens: 100,
          cache_read_input_tokens: 50,
        }),
      },
    ]);
    // One attempt says the cache read is inside the input, the other beside it;
    // the merge cannot pick one, so it reports that it does not know.
    expect(summary.inclusions.cacheRead).toBe('unknown');
    expect(summary.totals.cacheReadTokens.total).toBe(100);
  });

  test('no attempts at all is a zero-attempt summary, not a zero total', () => {
    const summary = aggregateUsage([]);
    expect(summary.attempts).toBe(0);
    expect(summary.totals.inputTokens.total).toBeNull();
    expect(summary.totals.inputTokens.complete).toBe(false);
  });

  test('the mapping version is reported so a stored record names its era', () => {
    const summary = aggregateUsage([
      { attemptId: 'a:1', usage: normalizeUsage('chat', { inputTokens: 1 }) },
    ]);
    expect(summary.mappingVersion).toBe(USAGE_MAPPING_VERSION);
    expect(USAGE_MAPPING_VERSION).toBe('review-usage-v1');
  });
});

describe('provider vocabularies the mapping must read', () => {
  test('reads the Responses-style cache write and reasoning detail fields', () => {
    // A compatible service may forward this payload unchanged. Both details
    // objects sit beside the parent count, and both `_details` sub-counts are part
    // of it rather than additional to it.
    const usage = normalizeUsage('decision', {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
      output_tokens: 40,
      output_tokens_details: { reasoning_tokens: 30 },
      total_tokens: 140,
    });
    expect(usage?.tokens).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      reasoningTokens: 30,
    });
    expect(usage?.inclusions.cacheWrite).toBe('contained');
    expect(usage?.inclusions.reasoning).toBe('contained');
  });

  test('records Gemini thinking tokens as separate from the candidate count', () => {
    // Gemini counts thinking outside `candidatesTokenCount`, so this relationship
    // is established by the field names and is not inferred.
    const usage = normalizeUsage('decision', {
      candidatesTokenCount: 100,
      thoughtsTokenCount: 50,
      totalTokenCount: 150,
    });
    expect(usage?.tokens.outputTokens).toBe(100);
    expect(usage?.tokens.reasoningTokens).toBe(50);
    expect(usage?.inclusions.reasoning).toBe('separate');
  });

  test('a bare generic reasoning alias does not invent a relationship', () => {
    const usage = normalizeUsage('decision', { reasoning_tokens: 30 });
    expect(usage?.tokens.reasoningTokens).toBe(30);
    expect(usage?.inclusions.reasoning).toBe('unknown');
  });
});

describe('an inclusion is only claimed when every contribution establishes it', () => {
  test('a known relationship beside an unknown one stays unknown', () => {
    // Attempt A says its cache read sits inside the input count; attempt B reports
    // one under a field whose relationship is not established. The summed value
    // cannot be called contained, because B's half might sit beside the parent.
    const summary = aggregateUsage([
      {
        attemptId: 'a',
        usage: normalizeUsage('decision', {
          prompt_tokens: 100,
          prompt_tokens_details: { cached_tokens: 20 },
        }),
      },
      {
        attemptId: 'b',
        usage: normalizeUsage('decision', {
          input_tokens: 100,
          cache_read_tokens: 80,
        }),
      },
    ]);
    expect(summary.totals.cacheReadTokens.total).toBe(100);
    expect(summary.inclusions.cacheRead).toBe('unknown');
  });

  test('cache write and reasoning follow the same rule', () => {
    const summary = aggregateUsage([
      {
        attemptId: 'a',
        usage: normalizeUsage('decision', {
          input_tokens: 10,
          cache_creation_input_tokens: 5,
          completion_tokens: 10,
          completion_tokens_details: { reasoning_tokens: 4 },
        }),
      },
      {
        attemptId: 'b',
        usage: normalizeUsage('decision', {
          cache_write_tokens: 5,
          reasoning_tokens: 4,
        }),
      },
    ]);
    expect(summary.inclusions.cacheWrite).toBe('unknown');
    expect(summary.inclusions.reasoning).toBe('unknown');
  });

  test('an attempt that reported no value adds no constraint', () => {
    // Attempt B reported no cache read at all, so its silence says nothing about
    // how the summed value relates to its parent.
    const summary = aggregateUsage([
      {
        attemptId: 'a',
        usage: normalizeUsage('decision', {
          prompt_tokens: 100,
          prompt_tokens_details: { cached_tokens: 20 },
        }),
      },
      {
        attemptId: 'b',
        usage: normalizeUsage('decision', { input_tokens: 100 }),
      },
    ]);
    expect(summary.totals.cacheReadTokens.total).toBe(20);
    expect(summary.inclusions.cacheRead).toBe('contained');
  });
});

describe('a stream that fails after reporting usage keeps it', () => {
  test('an iterator exception mid-stream carries the usage it already saw', async () => {
    const { review } = await import('../src/reviewer/service.js');
    const { offlineChatBackend } = await import('../src/reviewer/offline.js');
    const result = await review({
      snapshot: snapshotForUsage(),
      callId: 'call-stream',
      signal: new AbortController().signal,
      backend: {
        kind: 'chat',
        transport: {
          llm: {
            stream: () =>
              (async function* () {
                await Promise.resolve();
                yield { type: 'usage', usage: { inputTokens: 120 } };
                throw new Error('connection reset');
              })(),
          },
          chat: {
            provider: 'offline',
            model: 'offline-model',
            temperature: 0,
            maxTokens: 100,
            timeoutMs: 5_000,
            maxRepairRetries: 0,
          },
          signal: new AbortController().signal,
        },
      },
    });
    expect(result.outcome.status).toBe('review-failure');
    // The attempt is a failure, but what it cost is still known: discarding it
    // here would make the consumption unrecoverable for #74 and #75.
    expect(result.attempts[0]?.normalizedUsage?.tokens.inputTokens).toBe(120);
    expect(result.usage.totals.inputTokens.total).toBe(120);
    expect(offlineChatBackend).toBeDefined();
  });
});

/** A minimal snapshot for the usage cases that need a full review. */
function snapshotForUsage(): ReviewSnapshot {
  return {
    version: 1,
    createdAt: 0,
    configRevision: 'usage',
    callId: 'call-stream',
    sessionId: 'main',
    sessionKind: 'main',
    turn: 1,
    tool: 'bash',
    cwd: '/work',
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
