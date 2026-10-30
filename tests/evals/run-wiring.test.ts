/**
 * The three wiring gaps RQ-15 had to close before a real pilot could run.
 *
 * Each section states the *capability* rather than the implementation, because that is
 * what the resource decision recorded as missing:
 *
 *   §4.1  an endpoint that authenticates nobody is expressible, and no fabricated bearer
 *         is ever sent on its behalf.
 *   §4.2  a headless run reaches a chat model through its own HTTP service, with the
 *         provider's real usage recorded and the credential never leaving the adapter.
 *   §4.3  a plan can name a candidate, and the cells are rendered and read by that
 *         candidate's package rather than production's.
 *
 * Nothing here reaches a network or a provider: the chat service takes its fetch, and the
 * decision cells are answered by a scripted socket.
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { compileRunCheckers } from '../../evals/src/run/schemas.js';
import type { CellRecord, RunFixture } from '../../evals/src/run/types.js';
import {
  createRun,
  readExisting,
  resumeRun,
} from '../../evals/src/run/lifecycle.js';
import { readRun } from '../../evals/src/run/artifact.js';
import { planProblems } from '../../evals/src/run/plan.js';
import {
  chatRouteProblems,
  headlessChatService,
} from '../../evals/src/run/chat-service.js';
import { candidateOf } from '../../evals/src/run/candidate.js';
import { PRODUCTION_VARIANT } from '../../src/reviewer/variant.js';
import { coreCases, VERSIONS } from './helpers/report-run.js';
import {
  cellIdOf,
  chatAnswer,
  chatTarget,
  decisionAnswer,
  decisionTarget,
  fixtureCell,
  fixtureOf,
  planOf,
  withArea,
} from './helpers/run.js';

/** One SSE body from a list of payloads, in the provider's own framing. */
function sseBody(payloads: readonly unknown[]): ReadableStream<Uint8Array> {
  const text = [
    ...payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`),
    'data: [DONE]\n\n',
  ].join('');
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** A fetch that answers with one scripted SSE body and records what it was sent. */
function recordingFetch(payloads: readonly unknown[]): {
  readonly fetch: typeof fetch;
  readonly calls: {
    readonly url: string;
    readonly authorization: string | undefined;
    readonly body: unknown;
  }[];
} {
  const calls: {
    readonly url: string;
    readonly authorization: string | undefined;
    readonly body: unknown;
  }[] = [];
  const impl: typeof fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url:
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      authorization: headers.get('authorization') ?? undefined,
      body:
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as unknown)
          : null,
    });
    return Promise.resolve(
      new Response(sseBody(payloads), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
  };
  return { fetch: impl, calls };
}

/** The chunk sequence an OpenAI-compatible streamed call produces. */
function chatStream(text: string): readonly unknown[] {
  return [
    {
      id: 'gen-1',
      object: 'chat.completion.chunk',
      model: 'deepseek-flash',
      choices: [{ index: 0, delta: { role: 'assistant', content: '' } }],
    },
    {
      id: 'gen-1',
      object: 'chat.completion.chunk',
      model: 'deepseek-flash',
      choices: [{ index: 0, delta: { content: text } }],
    },
    {
      id: 'gen-1',
      object: 'chat.completion.chunk',
      model: 'deepseek-flash',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1234,
        completion_tokens: 56,
        total_tokens: 1290,
        prompt_cache_hit_tokens: 1024,
      },
    },
  ];
}

/** Run one plan to completion in a directory and read its records back. */
async function dispatchPlan(parts: {
  readonly directory: string;
  readonly plan: ReturnType<typeof planOf>;
  readonly fixture: RunFixture;
  readonly llm: Parameters<typeof resumeRun>[0]['llm'];
  readonly readCredential: (name: string) => string | undefined;
}): Promise<readonly CellRecord[]> {
  const checkers = await compileRunCheckers();
  const loaded = await coreCases();
  const created = await createRun({
    directory: parts.directory,
    runId: 'wiring-run',
    plan: parts.plan,
    cases: loaded.cases,
    datasetDigest: loaded.digest,
    versions: VERSIONS,
    fixture: parts.fixture,
    now: () => 0,
  });
  if (!created.ok) throw new Error(created.problems.join('; '));
  const existing = await readExisting(parts.directory, parts.plan, checkers);
  if (!existing.ok) throw new Error(existing.problems.join('; '));
  await resumeRun({
    directory: parts.directory,
    existing: existing.existing,
    cases: loaded.cases,
    fixture: parts.fixture,
    versions: VERSIONS,
    checkers,
    llm: parts.llm,
    readCredential: parts.readCredential,
    signal: new AbortController().signal,
    continuation: false,
    now: () => 1_000,
  });
  const read = await readRun(parts.directory, checkers);
  if (!read.ok) throw new Error(JSON.stringify(read.problems));
  return read.artifact.records;
}

describe('§4.1 an endpoint that authenticates nobody is expressible', () => {
  it('sends a decision cell through a no-credential target and scores it', async () => {
    // The empty reference is the case that used to be refused before a cell was written.
    // The plan is legal, the preflight passes, and the cell produces a real outcome.
    await withArea(async (area) => {
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'decision-local',
        protocol: 'decision',
      });
      const target = decisionTarget('decision-local');
      const plan = planOf({
        transport: 'offline',
        protocols: ['decision'],
        // Both reference sites empty: the plan states the endpoint needs no credential.
        targets: [
          {
            ...target,
            credentialRef: '',
            decision:
              target.decision === null
                ? null
                : { ...target.decision, apiKeyRef: '' },
          },
        ],
      });
      const fixture = fixtureOf({
        [cellId]: fixtureCell({
          decision: [decisionAnswer({ '1': 1 }, { '9': 1 })],
        }),
      });
      const records = await dispatchPlan({
        directory: join(area.path, 'run'),
        plan,
        fixture,
        llm: null,
        readCredential: () => undefined,
      });
      expect(records).toHaveLength(1);
      expect(records[0]?.status).toBe('reviewed');
      expect(records[0]?.outcome?.status).toBe('scored');
      // No credential means none was sent: the record says so by carrying an empty
      // reference rather than a name that resolved to nothing.
      expect(records[0]?.target.costTier).toBe('free');
    });
  });

  it('accepts the empty reference in the plan check instead of refusing the plan', () => {
    const target = decisionTarget('decision-local');
    const plan = planOf({
      transport: 'live',
      protocols: ['decision'],
      targets: [
        {
          ...target,
          credentialRef: '',
          decision:
            target.decision === null
              ? null
              : { ...target.decision, apiKeyRef: '' },
        },
      ],
      fixture: null,
    });
    expect(planProblems(plan)).toEqual([]);
  });

  it('keeps a named-but-unset credential a refusal, with no request sent', async () => {
    // The empty case is an exception, not a relaxation. A plan that names a variable and
    // cannot resolve it must still stop: the CLI refuses the whole run in its preflight,
    // and a caller that skipped that preflight gets a decided cell with no attempt rather
    // than a request carrying an empty bearer.
    await withArea(async (area) => {
      const target = decisionTarget('decision-remote');
      const plan = planOf({
        transport: 'live',
        protocols: ['decision'],
        targets: [
          {
            ...target,
            credentialRef: 'PROBE_KEY',
            decision:
              target.decision === null
                ? null
                : { ...target.decision, apiKeyRef: 'PROBE_KEY' },
          },
        ],
        fixture: null,
      });
      const records = await dispatchPlan({
        directory: join(area.path, 'run'),
        plan,
        fixture: fixtureOf({}),
        llm: null,
        readCredential: () => undefined,
      });
      expect(records).toHaveLength(1);
      expect(records[0]?.status).toBe('failed');
      expect(records[0]?.attempts).toEqual([]);
      expect(records[0]?.stopReason).toContain('PROBE_KEY');
    });
  });
});

describe('§4.2 a headless run reaches a chat model through its own service', () => {
  it('streams text and reports the provider usage, without leaking the credential', async () => {
    const recorded = recordingFetch(chatStream('{"risk":2,"authorization":9}'));
    const chat = headlessChatService({
      read: (name) =>
        name === 'DEEPSEEK_API_KEY' ? 'sk-test-value' : undefined,
      fetch: recorded.fetch,
    });
    const chunks: Record<string, unknown>[] = [];
    for await (const chunk of chat.stream({
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      system: 'system text',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'user text' }] },
      ],
      temperature: 0,
      maxTokens: 400,
    })) {
      chunks.push(chunk);
    }
    // The vocabulary production's collector reads: one text delta, one usage, one finish.
    expect(
      chunks.filter((chunk) => chunk['type'] === 'text-delta'),
    ).toHaveLength(1);
    expect(
      chunks.find((chunk) => chunk['type'] === 'usage')?.['usage'],
    ).toEqual({
      prompt_tokens: 1234,
      completion_tokens: 56,
      total_tokens: 1290,
      prompt_cache_hit_tokens: 1024,
    });
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } });
    const call = recorded.calls[0];
    expect(call?.url).toBe('https://api.deepseek.com/chat/completions');
    expect(call?.authorization).toBe('Bearer sk-test-value');
    // The wire body carries the system prompt as its first message and asks for usage,
    // which is what makes a streamed call recordable at all.
    expect(call?.body).toMatchObject({
      model: 'deepseek-flash',
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: 'system text' },
        { role: 'user', content: 'user text' },
      ],
    });
  });

  it('drives a real chat cell end to end and records the provider usage', async () => {
    // The whole path: plan → material → production renderer → this service → production
    // parser → N0 → record. The record's usage must be the provider's own numbers, mapped
    // by the shared mapping, and the response must not carry the key.
    await withArea(async (area) => {
      const recorded = recordingFetch(
        chatStream('{"risk":2,"authorization":9}'),
      );
      const chat = headlessChatService({
        read: (name) =>
          name === 'DEEPSEEK_API_KEY' ? 'sk-test-value' : undefined,
        fetch: recorded.fetch,
      });
      // A live plan, so the headless service is what sends: an offline plan would replay
      // the fixture instead and this would measure the scripted socket.
      const plan = planOf({
        transport: 'live',
        protocols: ['chat'],
        fixture: null,
        targets: [
          {
            ...chatTarget('chat-deepseek'),
            provider: 'deepseek-account',
            model: 'deepseek-flash',
            chat: {
              provider: 'deepseek-account',
              model: 'deepseek-flash',
              temperature: 0,
              maxTokens: 400,
              timeoutMs: 5_000,
              maxRepairRetries: 0,
            },
          },
        ],
      });
      const records = await dispatchPlan({
        directory: join(area.path, 'run'),
        plan,
        fixture: fixtureOf({}),
        llm: chat,
        readCredential: () => undefined,
      });
      const record = records[0];
      expect(record?.status).toBe('reviewed');
      expect(record?.outcome?.status).toBe('scored');
      // Narrowed rather than asserted: the other two outcomes carry no verdict, and
      // reading one off them would be the conflation this contract forbids.
      expect(
        record?.outcome?.status === 'scored' ? record.outcome.verdict : null,
      ).toBe('review-allow');
      // The provider reported its own counts, and the mapping read them.
      expect(record?.usage?.totals.inputTokens.total).toBe(1234);
      expect(record?.usage?.totals.outputTokens.total).toBe(56);
      expect(record?.usage?.totals.totalTokens.total).toBe(1290);
      // DeepSeek reports cache hits under `prompt_cache_hit_tokens`, which the shared
      // `review-usage-v1` mapping does not cover. It therefore stays null (unknown, not
      // zero) while the raw payload is preserved on the attempt, so a later mapping can
      // re-normalize it. Asserting the gap keeps it visible instead of rounding it to 0.
      expect(record?.usage?.totals.cacheReadTokens.total).toBeNull();
      expect(record?.attempts[0]?.rawUsage).toMatchObject({
        prompt_cache_hit_tokens: 1024,
      });
      // The credential never appears in a stored response.
      expect(JSON.stringify(record)).not.toContain('sk-test-value');
      expect(recorded.calls).toHaveLength(1);
    });
  });

  it('reports a provider refusal as a refusal, with no text read as an answer', async () => {
    const chat = headlessChatService({
      read: () => 'sk-test-value',
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'bad key' } }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    });
    const chunks: Record<string, unknown>[] = [];
    await expect(
      (async () => {
        for await (const chunk of chat.stream({
          provider: 'deepseek-account',
          model: 'deepseek-flash',
          system: 's',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'u' }] }],
        })) {
          chunks.push(chunk);
        }
      })(),
    ).rejects.toThrow(/refused the call with HTTP 401/u);
    // Nothing was yielded: a refusal is not an answer with empty text.
    expect(chunks).toEqual([]);
  });

  it('names a provider it cannot route instead of guessing an endpoint', () => {
    const chat = headlessChatService({ read: () => 'sk-test-value' });
    expect(() =>
      chat.stream({
        provider: 'workbuddy',
        model: 'glm-5.3-flash',
        system: 's',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'u' }] }],
      }),
    ).toThrow(/no headless route/u);
  });

  it('reports an unset key rather than sending an empty bearer', () => {
    const chat = headlessChatService({ read: () => undefined });
    expect(() =>
      chat.stream({
        provider: 'deepseek-account',
        model: 'deepseek-flash',
        system: 's',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'u' }] }],
      }),
    ).toThrow(/DEEPSEEK_API_KEY is not set/u);
  });

  it('refuses a plan whose chat provider it cannot route, and says what it can', () => {
    const chat = headlessChatService({ read: () => 'sk-test-value' });
    const problems = chatRouteProblems(chat, ['workbuddy'], () => 'x');
    expect(problems.join('\n')).toContain('has no headless route');
    expect(problems.join('\n')).toContain('deepseek-account');
  });

  it('refuses a plan whose route exists but whose key is unset', () => {
    const chat = headlessChatService({ read: () => undefined });
    expect(
      chatRouteProblems(chat, ['deepseek-account'], () => undefined),
    ).toEqual([expect.stringContaining('needs DEEPSEEK_API_KEY')]);
  });

  it('reports a stream that ended with no finish as a transport fault', async () => {
    // A provider that closes the connection mid-answer must not be read as an empty
    // review: the collector would otherwise call it a parser failure.
    const bytes = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"partial answer"}}]}\n\n',
    );
    const chat = headlessChatService({
      read: () => 'sk-test-value',
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes);
                controller.close();
              },
            }),
            { status: 200 },
          ),
        ),
    });
    await expect(
      (async () => {
        for await (const _chunk of chat.stream({
          provider: 'deepseek-account',
          model: 'deepseek-flash',
          system: 's',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'u' }] }],
        })) {
          // The delta is yielded before the error; the error is the point.
          expect(_chunk).toBeDefined();
        }
      })(),
    ).rejects.toThrow(/without a finish reason/u);
  });
});

describe('§4.3 a plan can name the package it measures', () => {
  it('measures production’s own package object when the plan names no candidate', () => {
    const resolved = candidateOf(planOf());
    expect(resolved.candidateId).toBeNull();
    expect(resolved.isBaseline).toBe(true);
    expect(resolved.variantId).toBe(PRODUCTION_VARIANT.variantId);
  });

  it('derives the candidate package from the plan’s axes', () => {
    const resolved = candidateOf(
      planOf({
        candidate: {
          candidateId: 'B',
          prompt: 'recovery-probe',
          structure: 'full',
          history: 'current-turn',
          scale: 'complete',
        },
      }),
    );
    expect(resolved.candidateId).toBe('B');
    expect(resolved.variantId).toBe(
      'rq14/recovery-probe.complete.current-turn.full',
    );
    expect(resolved.isBaseline).toBe(false);
    expect(resolved.pkg.asksProbe).toBe(true);
  });

  it('refuses a candidate whose axes are all at their baseline', () => {
    const problems = planProblems(
      planOf({
        candidate: {
          candidateId: 'A-lookalike',
          prompt: 'no-probe',
          structure: 'full',
          history: 'current-turn',
          scale: 'complete',
        },
      }),
    );
    expect(problems.join('\n')).toContain(
      'declares every axis at its baseline',
    );
  });

  it('renders and reads a cell with the candidate’s package, not production’s', async () => {
    // The fingerprint is the evidence: two candidates over one case produce different
    // requests, which is the whole point of the axis.
    await withArea(async (area) => {
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-candidate',
        protocol: 'chat',
      });
      const fixture = fixtureOf({
        [cellId]: fixtureCell({ chat: [chatAnswer(2, 9)] }),
      });
      const baseline = await dispatchPlan({
        directory: join(area.path, 'baseline'),
        plan: planOf(),
        fixture,
        llm: null,
        readCredential: () => undefined,
      });
      const candidate = await dispatchPlan({
        directory: join(area.path, 'candidate'),
        plan: planOf({
          candidate: {
            candidateId: 'B',
            prompt: 'recovery-probe',
            structure: 'full',
            history: 'current-turn',
            scale: 'complete',
          },
        }),
        fixture,
        llm: null,
        readCredential: () => undefined,
      });
      // Different request for the same case: the probe moved the prompt.
      expect(candidate[0]?.material?.promptFingerprint).not.toBe(
        baseline[0]?.material?.promptFingerprint,
      );
      // A baseline plan's fingerprint is the production renderer's, so a candidate cannot
      // differ for a reason other than its own axes.
      expect(baseline[0]?.material?.promptFingerprint).toBeTruthy();
    });
  });
});
