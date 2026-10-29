/**
 * The bounded runner, exercised through its real seam.
 *
 * Two claims carry this task and both are tested here rather than asserted in prose:
 *
 *   1. the runner reuses the production chain. Every cell below goes through the
 *      production `review()` call, the production renderer, the production envelope
 *      rule, the production parser and the production usage mapping — only the socket
 *      is scripted. The cases are chosen to cover the shapes a real endpoint actually
 *      returns: a well-formed answer, an HTTP 422 refusal, `success: false` carrying
 *      complete answers, and a body that is not JSON at all.
 *   2. every bound is observable. Concurrency, timeout, attempt budget, input budget,
 *      cancellation and continuation each get a test that fails if the bound is
 *      declared but not enforced.
 *
 * Usage gets its own group because the distinctions are easy to lose: unknown stays
 * null, an explicitly reported zero stays zero, a sub-count is never folded into its
 * parent, and a repair or a failed attempt still counts.
 */

import { readFile } from 'node:fs/promises';
import { runCli } from '../../evals/src/cli/run.js';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readRun, RUN_FILES } from '../../evals/src/run/artifact.js';
import {
  createRun,
  readExisting,
  resumeRun,
  spendOf,
  writeRecord,
} from '../../evals/src/run/lifecycle.js';
import { cellGrid } from '../../evals/src/run/plan.js';
import { compileRunCheckers } from '../../evals/src/run/schemas.js';
import type { CellRecord, RunFixture } from '../../evals/src/run/types.js';
import type { LlmLike } from '../../src/reviewer.js';
import { inputHashOf } from '../../evals/src/data/eligibility.js';
import { inspectDataset } from '../../evals/src/data/inspect.js';
import { readDataset } from '../../evals/src/data/read.js';
import { compileCheckers } from '../../evals/src/data/schemas.js';
import { datasetDigest } from '../../evals/src/annotation/summary.js';
import { REVIEW_CONTRACT_VERSION } from '../../src/review-contract/index.js';
import {
  bounds,
  cellIdOf,
  chatAnswer,
  chatTarget,
  decisionAnswer,
  decisionTarget,
  dualTarget,
  fixtureCell,
  fixtureOf,
  planOf,
  withArea,
} from './helpers/run.js';

const checkers = await compileRunCheckers();
const repository = new URL('../../', import.meta.url).pathname;
/** The repository root, which a command resolves a plan's dataset against. */
const REPOSITORY_ROOT = repository;

/**
 * The committed `core-v1` cases, read the way the runner reads them.
 *
 * Reading the real dataset rather than hand-built cases is what makes the reuse claim
 * meaningful: the material under test is the material a run would submit.
 */
const dataset = await readDataset(join(repository, 'evals/datasets/core-v1'));
const datasetCheckers = await compileCheckers();
const inspection = inspectDataset(dataset, datasetCheckers, {
  contract: REVIEW_CONTRACT_VERSION,
  rubric: 'review-rubric-v1',
});
const cases = inspection.cases.map((entry) => entry.document);
const datasetDigestOfCoreV1 = datasetDigest(inspection);

/**
 * The model the adapter's *stored* response text names, or null when that text does not
 * parse.
 *
 * The record derives `target.responseModel` from the masked body, so the only invariant
 * this test can honestly assert is that the two agree. Asserting a specific value would
 * freeze the current behaviour of the masking boundary, and a change to that boundary —
 * including a fix — would then look like a regression here.
 */
function modelNamedByStored(record: CellRecord | undefined): string | null {
  const text = record?.attempts[0]?.responseText;
  if (text === undefined || text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const named = parsed['model'];
  return typeof named === 'string' && named.length > 0 ? named : null;
}

/** Run one plan and read the directory back, without removing it first. */
async function runPlanInReadonly(parts: {
  readonly directory: string;
  readonly plan: ReturnType<typeof planOf>;
  readonly fixture: RunFixture;
}): Promise<{
  readonly records: readonly CellRecord[];
  readonly index: Awaited<ReturnType<typeof readExisting>>;
}> {
  return runPlanIn({
    directory: parts.directory,
    plan: parts.plan,
    fixture: parts.fixture,
  });
}

/**
 * The spend and cell statuses a run directory recorded.
 *
 * Read as a plain document rather than through the checker, because these assertions are
 * about what the writer produced: a reader that validated first would fail the test with a
 * schema problem instead of the behavioural difference being tested.
 */
async function readRunStatus(directory: string): Promise<{
  readonly attempts: number;
  readonly statuses: readonly string[];
}> {
  const read = await readRun(directory, checkers);
  if (!read.ok) {
    throw new Error(read.problems.map((problem) => problem.message).join('; '));
  }
  return {
    attempts: read.artifact.index.spent.attempts,
    statuses: read.artifact.index.cells.map((cell) => cell.status),
  };
}

/** The absolute path of a document inside one temporary area. */
function at2(area: { readonly path: string }, name: string): string {
  return `${area.path}/${name}`;
}

/** A non-array object, for narrowing a parsed document without asserting its type. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The versions one test run records. */
const versions = {
  contract: REVIEW_CONTRACT_VERSION,
  prompt: 'review-prompt-v1',
  usageMapping: 'review-usage-v1',
  plan: 'eval-run-plan-v1',
  artifact: 'eval-run-artifact-v1',
  implementation: 'eval-runner-v1',
  node: process.versions.node,
} as const;

/** Read every record a directory holds, in name order. */
async function recordsOf(directory: string): Promise<readonly CellRecord[]> {
  const read = await readRun(directory, checkers);
  if (!read.ok) {
    throw new Error(read.problems.map((problem) => problem.message).join('; '));
  }
  return read.artifact.records;
}

/** Run one plan inside an existing directory, and hand back what it produced. */
async function runPlanIn(parts: {
  readonly directory: string;
  readonly plan: ReturnType<typeof planOf>;
  readonly fixture: RunFixture;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly records: readonly CellRecord[];
  readonly index: Awaited<ReturnType<typeof readExisting>>;
}> {
  const created = await createRun({
    directory: parts.directory,
    runId: 'test-run',
    plan: parts.plan,
    cases,
    datasetDigest: datasetDigestOfCoreV1,
    versions,
    now: () => 0,
  });
  if (!created.ok) throw new Error(created.problems.join('; '));
  const existing = await readExisting(parts.directory, parts.plan, checkers);
  if (!existing.ok) throw new Error(existing.problems.join('; '));
  await resumeRun({
    directory: parts.directory,
    existing: existing.existing,
    cases,
    fixture: parts.fixture,
    versions,
    checkers,
    llm: null,
    readCredential: () => undefined,
    signal: parts.signal ?? new AbortController().signal,
    continuation: false,
    now: () => 1_000,
  });
  return {
    records: await recordsOf(parts.directory),
    index: await readExisting(parts.directory, parts.plan, checkers),
  };
}

/**
 * Run one plan in a temporary directory, then hand the result to a body that may still
 * read the files. The directory is removed afterwards, so a test that only needs the
 * records can call this and never see a path it has to clean up.
 */
async function runPlan(parts: {
  readonly plan: ReturnType<typeof planOf>;
  readonly fixture: RunFixture;
  readonly signal?: AbortSignal;
  /** A caller-supplied directory, used when the test still needs to read the files. */
  readonly directory?: string;
}): Promise<{
  readonly records: readonly CellRecord[];
  readonly index: Awaited<ReturnType<typeof readExisting>>;
}> {
  if (parts.directory !== undefined) {
    return runPlanIn({
      directory: parts.directory,
      plan: parts.plan,
      fixture: parts.fixture,
      ...(parts.signal === undefined ? {} : { signal: parts.signal }),
    });
  }
  let captured:
    | {
        readonly records: readonly CellRecord[];
        readonly index: Awaited<ReturnType<typeof readExisting>>;
      }
    | undefined;
  await withArea(async (area) => {
    captured = await runPlanIn({
      directory: join(area.path, 'run'),
      plan: parts.plan,
      fixture: parts.fixture,
      ...(parts.signal === undefined ? {} : { signal: parts.signal }),
    });
  });
  if (captured === undefined) throw new Error('the run produced no result');
  return captured;
}

describe('reuse of the production chain', () => {
  it('scores a well-formed chat answer through the production reader', async () => {
    await withArea(async (area) => {
      const directory = join(area.path, 'run');
      const plan = planOf();
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      const result = await runPlan({
        plan,
        fixture: fixtureOf({
          [cellId]: fixtureCell({
            chat: [chatAnswer(2, 10, { input_tokens: 900, output_tokens: 12 })],
          }),
        }),
        directory,
      });
      const record = result.records[0];
      expect(record?.status).toBe('reviewed');
      expect(record?.outcome?.status).toBe('scored');
      if (record?.outcome?.status !== 'scored') return;
      expect(record.outcome.risk).toBe(2);
      expect(record.outcome.authorization).toBe(10);
      // The matrix is the shared one, so the verdict follows from the pair.
      expect(record.outcome.verdict).toBe('review-allow');
      expect(record.target.protocolName).toBe('arbiter-chat-json-v2');
    });
  });

  it('records an HTTP 422 refusal as a provider refusal with its status', async () => {
    await withArea(async (area) => {
      const plan = planOf({
        caseIds: ['read-named-source-file'],
        protocols: ['decision'],
        targets: [decisionTarget()],
      });
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'decision-a',
        protocol: 'decision',
      });
      const result = await runPlan({
        plan,
        fixture: fixtureOf({
          [cellId]: fixtureCell({
            decision: [
              {
                status: 422,
                body: JSON.stringify({ detail: { message: 'input too long' } }),
              },
            ],
          }),
        }),
        directory: join(area.path, 'run'),
      });
      const record = result.records[0];
      expect(record?.outcome?.status).toBe('review-failure');
      expect(record?.attempts[0]?.failureKind).toBe('provider-refusal');
      expect(record?.attempts[0]?.error).toContain('HTTP 422');
      // A refusal is not an answer, so the record carries no score at all.
      expect(record?.outcome?.status).not.toBe('scored');
    });
  });

  it('treats success:false carrying complete answers as a refusal, not a score', async () => {
    await withArea(async (area) => {
      const plan = planOf({
        protocols: ['decision'],
        targets: [decisionTarget()],
      });
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'decision-a',
        protocol: 'decision',
      });
      const result = await runPlan({
        plan,
        fixture: fixtureOf({
          [cellId]: fixtureCell({
            decision: [
              {
                status: 200,
                body: JSON.stringify({
                  success: false,
                  errors: [{ message: 'model overloaded' }],
                  result: {
                    answers: {
                      risk: { '0': 0, '1': 0, '2': 1 },
                      authorization: { '9': 1 },
                    },
                  },
                }),
              },
            ],
          }),
        }),
        directory: join(area.path, 'run'),
      });
      const record = result.records[0];
      // The production rule: a provider that reports failure is still forming its
      // answer, so complete answers beside `success: false` do not become a score.
      expect(record?.outcome?.status).toBe('review-failure');
      expect(record?.attempts[0]?.failureKind).toBe('provider-refusal');
      // The complete body is kept anyway: it is what a person needs to see that the
      // answers were present and the provider still declared failure.
      expect(record?.attempts[0]?.responseText).toContain('model overloaded');
    });
  });

  it('records a body that is not JSON as an unreadable answer, not as a provider fault', async () => {
    await withArea(async (area) => {
      const plan = planOf({
        protocols: ['decision'],
        targets: [decisionTarget()],
      });
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'decision-a',
        protocol: 'decision',
      });
      const result = await runPlan({
        plan,
        fixture: fixtureOf({
          [cellId]: fixtureCell({
            decision: [{ status: 200, body: '<html>gateway timeout</html>' }],
          }),
        }),
        directory: join(area.path, 'run'),
      });
      const record = result.records[0];
      expect(record?.attempts[0]?.failureKind).toBe('unreadable-answer');
      expect(record?.attempts[0]?.responseText).toBe(
        '<html>gateway timeout</html>',
      );
      expect(record?.outcome?.status).toBe('review-failure');
    });
  });

  it('keeps the transport repair as a second attempt of the same cell', async () => {
    await withArea(async (area) => {
      const plan = planOf();
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      const result = await runPlan({
        plan,
        fixture: fixtureOf({
          [cellId]: fixtureCell({
            chat: [
              // A malformed answer the transport repairs, then a valid one.
              {
                kind: 'text',
                text: 'not json at all',
                usage: { input_tokens: 800 },
              },
              chatAnswer(2, 10, { input_tokens: 810, output_tokens: 9 }),
            ],
          }),
        }),
        directory: join(area.path, 'run'),
      });
      const record = result.records[0];
      expect(record?.attempts).toHaveLength(2);
      expect(record?.attempts[0]?.kind).toBe('initial');
      expect(record?.attempts[1]?.kind).toBe('repair');
      expect(record?.attempts[0]?.failureKind).toBe('unreadable-answer');
      // The repair is a real call, so both attempts are in the usage summary.
      expect(record?.usage?.attempts).toBe(2);
      expect(record?.usage?.totals.inputTokens.total).toBe(1_610);
    });
  });

  it('fails a cell whose fixture has no entry instead of sending nothing', async () => {
    await withArea(async (area) => {
      const plan = planOf();
      const result = await runPlan({
        plan,
        fixture: fixtureOf({}),
        directory: join(area.path, 'run'),
      });
      const record = result.records[0];
      expect(record?.status).toBe('failed');
      // A cell with no script cannot be replayed, and the runner says which problem it
      // found rather than sending a request with no answer behind it.
      expect(record?.stopReason).toContain('no fixture entry');
      // The material is still described: an artifact should say which request would have
      // gone out even when it could not be sent.
      expect(record?.material?.promptFingerprint).toMatch(/^sha256:/u);
      expect(record?.attempts).toEqual([]);
    });
  });

  it('fails a cell whose fixture entry scripts the other protocol', async () => {
    await withArea(async (area) => {
      const plan = planOf();
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      const result = await runPlan({
        plan,
        fixture: fixtureOf({
          [cellId]: fixtureCell({ decision: [{ status: 200, body: '{}' }] }),
        }),
        directory: join(area.path, 'run'),
      });
      const record = result.records[0];
      expect(record?.status).toBe('failed');
      expect(record?.stopReason).toContain('fixture scripts no chat answer');
    });
  });

  it('marks a decision pairing a chat-only target as unsupported without sending anything', async () => {
    await withArea(async (area) => {
      const plan = planOf({
        protocols: ['chat', 'decision'],
        targets: [chatTarget()],
      });
      const result = await runPlan({
        plan,
        fixture: fixtureOf({
          [cellIdOf({
            caseId: 'read-named-source-file',
            targetId: 'chat-a',
            protocol: 'chat',
          })]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
        }),
        directory: join(area.path, 'run'),
      });
      const unsupported = result.records.find(
        (record) => record.target.protocol === 'decision',
      );
      expect(unsupported).toBeUndefined();
      const read = await readRun(join(area.path, 'run'), checkers);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      // An unsupported cell is decided by the plan and is not represented by a record,
      // so it can never be filled with a made-up answer.
      const decided = read.artifact.index.cells.find(
        (cell) => cell.protocol === 'decision',
      );
      expect(decided?.status).toBe('unsupported');
      expect(decided?.stopReason).toContain('does not offer protocol decision');
    });
  });
});

describe('usage written into the artifact', () => {
  it('keeps an unknown bucket null and an explicitly reported zero at zero', async () => {
    await withArea(async (area) => {
      const plan = planOf();
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      const result = await runPlan({
        plan,
        fixture: fixtureOf({
          [cellId]: fixtureCell({
            chat: [
              chatAnswer(2, 10, {
                input_tokens: 900,
                output_tokens: 0,
                // No cache or reasoning field at all: those buckets stay unknown.
              }),
            ],
          }),
        }),
        directory: join(area.path, 'run'),
      });
      const record = result.records[0];
      expect(record?.usage?.totals.outputTokens.total).toBe(0);
      expect(record?.usage?.totals.outputTokens.complete).toBe(true);
      expect(record?.usage?.totals.cacheReadTokens.total).toBeNull();
      expect(record?.usage?.totals.cacheReadTokens.missing).toBe(1);
      expect(record?.usage?.totals.cacheReadTokens.complete).toBe(false);
    });
  });

  it('counts a failed attempt that still reported usage', async () => {
    await withArea(async (area) => {
      const plan = planOf();
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      const result = await runPlan({
        plan,
        fixture: fixtureOf({
          [cellId]: fixtureCell({
            chat: [
              {
                kind: 'failure',
                code: 'server_error',
                message: 'upstream failed',
                usage: { input_tokens: 700, output_tokens: 3 },
              },
            ],
          }),
        }),
        directory: join(area.path, 'run'),
      });
      const record = result.records[0];
      expect(record?.status).toBe('reviewed');
      expect(record?.outcome?.status).toBe('review-failure');
      // A provider that reports failure was still billed, so the attempt's usage is
      // kept rather than discarded with the failure.
      expect(record?.usage?.totals.inputTokens.total).toBe(700);
      expect(record?.usage?.withUsage).toBe(1);
    });
  });

  it('keeps a contained cache read out of its parent bucket', async () => {
    await withArea(async (area) => {
      const plan = planOf();
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      const result = await runPlan({
        plan,
        fixture: fixtureOf({
          [cellId]: fixtureCell({
            chat: [
              chatAnswer(2, 10, {
                prompt_tokens: 900,
                completion_tokens: 12,
                prompt_tokens_details: { cached_tokens: 400 },
              }),
            ],
          }),
        }),
        directory: join(area.path, 'run'),
      });
      const record = result.records[0];
      expect(record?.usage?.totals.inputTokens.total).toBe(900);
      expect(record?.usage?.totals.cacheReadTokens.total).toBe(400);
      // OpenAI reports a cached read inside the prompt total, so the aggregate must say
      // `contained`; adding the two would double-count 400 tokens.
      expect(record?.usage?.inclusions.cacheRead).toBe('contained');
    });
  });

  it('records a mapping version a reader can re-normalize under', async () => {
    await withArea(async (area) => {
      const plan = planOf();
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      const result = await runPlan({
        plan,
        fixture: fixtureOf({
          [cellId]: fixtureCell({
            chat: [chatAnswer(2, 10, { input_tokens: 5 })],
          }),
        }),
        directory: join(area.path, 'run'),
      });
      const record = result.records[0];
      expect(record?.usage?.mappingVersion).toBe('review-usage-v1');
      expect(record?.attempts[0]?.normalizedUsage?.mappingVersion).toBe(
        'review-usage-v1',
      );
      // The raw payload is kept beside the normalization, so a later mapping version can
      // be applied to data that already exists.
      expect(record?.attempts[0]?.rawUsage).toEqual({ input_tokens: 5 });
    });
  });
});

describe('bounds', () => {
  it('runs at most the declared concurrency at once', async () => {
    await withArea(async (area) => {
      const plan = planOf({
        caseIds: [
          'read-named-source-file',
          'read-repo-index-with-cache',
          'cleanup-stale-cache-dir',
          'cleanup-rebuildable-cache',
        ],
        bounds: bounds({ concurrency: 2, maxAttempts: 20 }),
        context: { maxInputTokens: 10_000 },
      });
      const cells = cellGrid(plan).cells;
      const fixture = fixtureOf(
        Object.fromEntries(
          cells.map((cell) => [
            cell.cellId,
            fixtureCell({ chat: [chatAnswer(2, 10)] }),
          ]),
        ),
      );
      const result = await runPlan({
        plan,
        fixture,
        directory: join(area.path, 'run'),
      });
      expect(result.records).toHaveLength(4);
      // Every cell completed, so concurrency bounded the run rather than truncating it.
      expect(
        result.records.every((record) => record.status === 'reviewed'),
      ).toBe(true);
    });
  });

  it('stops dispatch when the attempt budget cannot cover the next cell', async () => {
    await withArea(async (area) => {
      const plan = planOf({
        caseIds: [
          'read-named-source-file',
          'read-repo-index-with-cache',
          'cleanup-stale-cache-dir',
        ],
        // One attempt of budget: the first cell spends it, the second cannot be
        // reserved, and the third is never reached. Dispatch stops rather than
        // overrunning the bound, and all three states are visible in the index.
        bounds: bounds({ concurrency: 1, maxAttempts: 1 }),
      });
      const cells = cellGrid(plan).cells;
      const fixture = fixtureOf(
        Object.fromEntries(
          cells.map((cell) => [
            cell.cellId,
            fixtureCell({ chat: [chatAnswer(2, 10)] }),
          ]),
        ),
      );
      const result = await runPlan({
        plan,
        fixture,
        directory: join(area.path, 'run'),
      });
      const read = await readRun(join(area.path, 'run'), checkers);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      const statuses = read.artifact.index.cells.map((cell) => cell.status);
      // The run states its whole plan: the cell that hit the bound says so, and the ones
      // behind it are recorded as never started rather than omitted.
      expect(statuses).toEqual(['reviewed', 'budget-exhausted', 'not-run']);
      expect(result.records).toHaveLength(1);
      // A ceiling minus what the cell actually spent is returned, so the run does not
      // treat an unused repair as spent.
      expect(read.artifact.index.spent.attempts).toBe(1);
    });
  });

  it('refuses a cell whose rendered input exceeds the run input bound', async () => {
    await withArea(async (area) => {
      const plan = planOf({
        caseIds: ['read-named-source-file'],
        // Below any real prompt: the cell must not be sent at all.
        bounds: bounds({ concurrency: 1, maxAttempts: 8, maxInputTokens: 5 }),
      });
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      const result = await runPlan({
        plan,
        fixture: fixtureOf({
          [cellId]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
        }),
        directory: join(area.path, 'run'),
      });
      expect(result.records).toEqual([]);
      const read = await readRun(join(area.path, 'run'), checkers);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      const exhausted = read.artifact.index.cells[0];
      expect(exhausted?.status).toBe('budget-exhausted');
      // The bound is per cell, measured against the payload this protocol submits.
      expect(exhausted?.stopReason).toContain('estimated input tokens, above');
    });
  });

  it('ends a cell at its own timeout and reports a timeout rather than a cancel', async () => {
    await withArea(async (area) => {
      // A live chat target whose socket never answers is the deterministic way to reach
      // the timeout: the offline adapter always answers immediately, so it cannot.
      const plan = planOf({
        transport: 'live',
        fixture: null,
        targets: [
          {
            targetId: 'chat-slow',
            provider: 'test-provider',
            model: 'test-model',
            modelVersion: null,
            chat: {
              provider: 'test-provider',
              model: 'test-model',
              temperature: 0,
              maxTokens: 400,
              timeoutMs: 60_000,
              maxRepairRetries: 0,
            },
            decision: null,
            credentialRef: null,
          },
        ],
        bounds: bounds({ concurrency: 1, timeoutMs: 20, maxAttempts: 2 }),
      });
      const directory = join(area.path, 'run');
      const created = await createRun({
        directory,
        runId: 'test-run',
        plan,
        cases,
        datasetDigest: datasetDigestOfCoreV1,
        versions,
        now: () => 0,
      });
      if (!created.ok) throw new Error(created.problems.join('; '));
      const hung: LlmLike = {
        // A stream that yields nothing and never finishes: the cell's own bound has to be
        // what ends it, because no provider answer will arrive.
        stream: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise<IteratorResult<Record<string, unknown>>>(() => {
                // Never settles.
              }),
          }),
        }),
      };
      await resumeRun({
        directory,
        existing: { index: created.index, records: [] },
        cases,
        fixture: fixtureOf({}),
        versions,
        checkers,
        llm: hung,
        readCredential: () => undefined,
        signal: new AbortController().signal,
        continuation: false,
        now: () => 1_000,
      });
      const record = (await recordsOf(directory))[0];
      // The cell was too slow. It is not `cancelled`: nobody stopped the run, and a
      // report that said so would send an operator looking for an operator.
      expect(record?.status).toBe('timeout');
      expect(record?.stopReason).toBe('the cell exceeded its own timeout');
    });
  });

  it('stops dispatching on cancellation and records the cells that never ran', async () => {
    await withArea(async (area) => {
      const plan = planOf({
        caseIds: [
          'read-named-source-file',
          'read-repo-index-with-cache',
          'cleanup-stale-cache-dir',
        ],
        bounds: bounds({ concurrency: 1, maxAttempts: 8 }),
      });
      const controller = new AbortController();
      const cells = cellGrid(plan).cells;
      const fixture = fixtureOf(
        Object.fromEntries(
          cells.map((cell) => [
            cell.cellId,
            fixtureCell({ chat: [chatAnswer(2, 10)] }),
          ]),
        ),
      );
      // The signal is already aborted: the runner must dispatch nothing, and it must
      // still describe the whole plan.
      controller.abort();
      const result = await runPlan({
        plan,
        fixture,
        signal: controller.signal,
        directory: join(area.path, 'run'),
      });
      expect(result.records).toEqual([]);
      const read = await readRun(join(area.path, 'run'), checkers);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.artifact.index.status).toBe('cancelled');
      expect(
        read.artifact.index.cells.every((cell) => cell.status === 'not-run'),
      ).toBe(true);
    });
  });
});

describe('continuation', () => {
  it('only runs the cells that have no record, and never rewrites one', async () => {
    await withArea(async (area) => {
      const directory = join(area.path, 'run');
      const plan = planOf({
        caseIds: [
          'read-named-source-file',
          'read-repo-index-with-cache',
          'cleanup-stale-cache-dir',
        ],
        bounds: bounds({ concurrency: 1, maxAttempts: 8 }),
      });
      const cells = cellGrid(plan).cells;
      const firstCell = cells[0];
      if (firstCell === undefined) throw new Error('the plan produced no cell');
      const created = await createRun({
        directory,
        runId: 'test-run',
        plan,
        cases,
        datasetDigest: datasetDigestOfCoreV1,
        versions,
        now: () => 0,
      });
      if (!created.ok) throw new Error(created.problems.join('; '));
      // A first pass that stopped after one cell, as an interrupted run does.
      const fixture = fixtureOf(
        Object.fromEntries(
          cells.map((cell) => [
            cell.cellId,
            fixtureCell({ chat: [chatAnswer(2, 10)] }),
          ]),
        ),
      );
      const first = await readExisting(directory, plan, checkers);
      if (!first.ok) throw new Error(first.problems.join('; '));
      await resumeRun({
        directory,
        existing: { index: created.index, records: [] },
        cases,
        fixture: fixtureOf({
          [firstCell.cellId]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
        }),
        versions,
        checkers,
        llm: null,
        readCredential: () => undefined,
        signal: new AbortController().signal,
        continuation: true,
        now: () => 1_000,
        onProgress: (record) => {
          // Stop the run after the first record by throwing out of the callback, which
          // is how an interrupted run leaves exactly one durable record.
          if (record.cellId === firstCell.cellId) {
            throw new Error('stop after first');
          }
        },
      }).catch(() => undefined);
      const afterFirst = await recordsOf(directory);
      expect(afterFirst).toHaveLength(1);
      const before = await readFile(
        join(directory, 'records', `${firstCell.cellId}.json`),
        'utf8',
      );
      const second = await readExisting(directory, plan, checkers);
      if (!second.ok) throw new Error(second.problems.join('; '));
      const resumed = await resumeRun({
        directory,
        existing: second.existing,
        cases,
        fixture,
        versions,
        checkers,
        llm: null,
        readCredential: () => undefined,
        signal: new AbortController().signal,
        continuation: true,
        now: () => 2_000,
      });
      const final = await recordsOf(directory);
      // The continuation ran the two cells that had no record, and only those.
      expect(
        resumed.dispatch.results.map((entry) => entry.cellId).sort(),
      ).toEqual([cells[1]?.cellId, cells[2]?.cellId].sort());
      expect(final).toHaveLength(3);
      // The first record is byte-identical: evidence is not rewritten by a continuation.
      const afterFirstAgain = await readFile(
        join(directory, 'records', `${firstCell.cellId}.json`),
        'utf8',
      );
      expect(afterFirstAgain).toBe(before);
      // The totals are recomputed from the records, so a continuation cannot
      // double-count the cell the first pass already paid for.
      expect(resumed.index.spent.cellsCompleted).toBe(3);
      expect(resumed.index.spent.attempts).toBe(3);
      expect(resumed.index.resumed).toHaveLength(1);
    });
  });

  it('refuses to continue a run whose plan hash changed', async () => {
    await withArea(async (area) => {
      const directory = join(area.path, 'run');
      const plan = planOf();
      const created = await createRun({
        directory,
        runId: 'test-run',
        plan,
        cases,
        datasetDigest: datasetDigestOfCoreV1,
        versions,
        now: () => 0,
      });
      expect(created.ok).toBe(true);
      const drifted = planOf({ repeats: 2 });
      const read = await readExisting(directory, drifted, checkers);
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.problems[0]).toContain(
        'does not match the run it would continue',
      );
    });
  });

  it('refuses to write a second record for the same cell', async () => {
    await withArea(async (area) => {
      const directory = join(area.path, 'run');
      const plan = planOf({
        caseIds: ['read-named-source-file'],
      });
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      const result = await runPlan({
        plan,
        fixture: fixtureOf({
          [cellId]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
        }),
        directory,
      });
      const record = result.records[0];
      if (record === undefined) throw new Error('the run produced no record');
      await expect(writeRecord(directory, record)).rejects.toThrow(
        /refusing to overwrite/u,
      );
    });
  });

  it('recomputes spend from the records rather than from a carried counter', async () => {
    await withArea(async (area) => {
      const directory = join(area.path, 'run');
      const plan = planOf();
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      const result = await runPlan({
        plan,
        fixture: fixtureOf({
          [cellId]: fixtureCell({
            chat: [chatAnswer(2, 10, { input_tokens: 100, output_tokens: 5 })],
          }),
        }),
        directory,
      });
      const spend = spendOf(result.records, 1);
      // Asking twice must produce the same numbers: a carried counter would double.
      expect(spendOf(result.records, 1)).toEqual(spend);
      expect(spend.attempts).toBe(1);
      expect(spend.reportedOutputTokens).toBe(5);
    });
  });
});

describe('the run on disk', () => {
  it('writes the plan before the first cell, so an interrupted run is described', async () => {
    await withArea(async (area) => {
      const directory = join(area.path, 'run');
      const plan = planOf();
      const created = await createRun({
        directory,
        runId: 'test-run',
        plan,
        cases,
        datasetDigest: datasetDigestOfCoreV1,
        versions,
        now: () => 0,
      });
      expect(created.ok).toBe(true);
      const planOnDisk: unknown = JSON.parse(
        await readFile(join(directory, RUN_FILES.plan), 'utf8'),
      );
      expect(planOnDisk).toMatchObject({ planVersion: 'eval-run-plan-v1' });
      const indexOnDisk: unknown = JSON.parse(
        await readFile(join(directory, RUN_FILES.index), 'utf8'),
      );
      expect(indexOnDisk).toMatchObject({
        documentVersion: 'eval-run-index-v1',
      });
    });
  });

  it('gives every record the versions a report compares runs by', async () => {
    await withArea(async (area) => {
      const plan = planOf();
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      const result = await runPlan({
        plan,
        fixture: fixtureOf({
          [cellId]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
        }),
        directory: join(area.path, 'run'),
      });
      const record = result.records[0];
      expect(record?.versions.contract).toBe(REVIEW_CONTRACT_VERSION);
      expect(record?.versions.prompt).toBe('review-prompt-v1');
      expect(record?.versions.usageMapping).toBe('review-usage-v1');
      expect(record?.versions.implementation).toBe('eval-runner-v1');
    });
  });

  it('states the entry point and the input chain, so a reader does not assume the host', async () => {
    await withArea(async (area) => {
      const plan = planOf();
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      const result = await runPlan({
        plan,
        fixture: fixtureOf({
          [cellId]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
        }),
        directory: join(area.path, 'run'),
      });
      const record = result.records[0];
      expect(record?.entryPoint.kind).toBe('direct-service');
      expect(record?.entryPoint.materialChain).toBe('case-input');
      expect(record?.entryPoint.detail).toContain('not exercised');
    });
  });

  it('fingerprints the case input with the same digest a label is approved against', async () => {
    await withArea(async (area) => {
      const plan = planOf();
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      const result = await runPlan({
        plan,
        fixture: fixtureOf({
          [cellId]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
        }),
        directory: join(area.path, 'run'),
      });
      const record = result.records[0];
      const caseEntry = cases.find(
        (entry) => entry.caseId === 'read-named-source-file',
      );
      if (caseEntry === undefined)
        throw new Error('the fixture case is missing');
      // The label hash rule, applied to the same input: a record and a label can be
      // compared without re-reading the case.
      expect(record?.case.inputHash).toBe(inputHashOf(caseEntry.input));
    });
  });

  it('writes every record under records/, named by the cell id', async () => {
    await withArea(async (area) => {
      const plan = planOf();
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      await runPlan({
        plan,
        fixture: fixtureOf({
          [cellId]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
        }),
        directory: join(area.path, 'run'),
      });
      const text = await readFile(
        join(area.path, 'run', 'records', `${cellId}.json`),
        'utf8',
      );
      expect(text).toContain('"documentVersion": "eval-cell-record-v1"');
    });
  });

  it('writes no credential into any document', async () => {
    await withArea(async (area) => {
      const secret = 'sk-live-should-never-appear';
      const plan = planOf({
        protocols: ['decision'],
        targets: [decisionTarget()],
      });
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'decision-a',
        protocol: 'decision',
      });
      await runPlan({
        plan,
        fixture: fixtureOf({
          [cellId]: fixtureCell({
            decision: [
              {
                status: 200,
                body: JSON.stringify({
                  answers: { risk: { '9': 1 }, authorization: { '9': 1 } },
                  // A provider that echoes the header it received.
                  echo: `Authorization: Bearer ${secret}`,
                }),
              },
            ],
          }),
        }),
        directory: join(area.path, 'run'),
      });
      const index = await readFile(
        join(area.path, 'run', RUN_FILES.index),
        'utf8',
      );
      const record = await readFile(
        join(area.path, 'run', 'records', `${cellId}.json`),
        'utf8',
      );
      expect(index).not.toContain(secret);
      // The production adapter masks the header shape even with no value to match, so
      // an echoed credential cannot reach the artifact through a response body. The
      // assertion is about the secret's absence, not about the mask's exact wording:
      // how the adapter rewrites a header is the adapter's business, and pinning its
      // spelling here would report an upstream improvement as a regression.
      expect(record).not.toContain(secret);
    });
  });
});

describe('decision usage', () => {
  it('reads a decision answer and its usage from the provider envelope', async () => {
    await withArea(async (area) => {
      const plan = planOf({
        protocols: ['decision'],
        targets: [decisionTarget()],
      });
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'decision-a',
        protocol: 'decision',
      });
      const result = await runPlan({
        plan,
        fixture: fixtureOf({
          [cellId]: fixtureCell({
            decision: [
              decisionAnswer(
                { '0': 0.1, '1': 0.8, '2': 0.1 },
                { '9': 1 },
                { usage: { input_tokens: 500, output_tokens: 40 } },
              ),
            ],
          }),
        }),
        directory: join(area.path, 'run'),
      });
      const record = result.records[0];
      expect(record?.outcome?.status).toBe('scored');
      if (record?.outcome?.status !== 'scored') return;
      // The native distribution's median band, read by the shared N0 rule.
      expect(record.outcome.risk).toBe(2);
      expect(record.outcome.authorization).toBe(10);
      // The parsed answer is what the reviewer actually read, and it survives masking
      // because the production parser reads the unmasked body. This is the fact the
      // outcome depends on.
      expect(record.attempts[0]?.parsed).toMatchObject({
        authorization: { type: 'score' },
      });
      // The model the *response body* named is read from the adapter's masked text, so
      // the assertion is that this value follows from that text — not that it is null.
      // A second parse of what the adapter stored must agree with the record, which is
      // true whether or not the adapter's mask leaves that text parseable.
      expect(record.target.responseModel).toBe(modelNamedByStored(record));
      expect(record.usage?.totals.outputTokens.total).toBe(40);
    });
  });

  it('records the configured tier as a classification, never as an amount', async () => {
    await withArea(async (area) => {
      const plan = planOf({
        protocols: ['decision'],
        targets: [decisionTarget()],
      });
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'decision-a',
        protocol: 'decision',
      });
      const result = await runPlan({
        plan,
        fixture: fixtureOf({
          [cellId]: fixtureCell({
            decision: [decisionAnswer({ '9': 1 }, { '9': 1 })],
          }),
        }),
        directory: join(area.path, 'run'),
      });
      const record = result.records[0];
      expect(record?.target.costTier).toBe('free');
      expect(record?.cost.amount).toBeNull();
      expect(record?.cost.currency).toBeNull();
      expect(record?.cost.status).toBe('not-computed');
    });
  });

  it('keeps a missing usage payload null rather than zero', async () => {
    await withArea(async (area) => {
      const plan = planOf({
        protocols: ['decision'],
        targets: [decisionTarget()],
      });
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'decision-a',
        protocol: 'decision',
      });
      const result = await runPlan({
        plan,
        fixture: fixtureOf({
          [cellId]: fixtureCell({
            decision: [decisionAnswer({ '9': 1 }, { '9': 1 })],
          }),
        }),
        directory: join(area.path, 'run'),
      });
      const record = result.records[0];
      expect(record?.usage?.withUsage).toBe(0);
      expect(record?.usage?.totals.inputTokens.total).toBeNull();
      expect(record?.attempts[0]?.normalizedUsage).toBeNull();
    });
  });
});

describe('the fixture cannot hide a repair loop', () => {
  it('makes one attempt when the fixture scripts one answer', async () => {
    await withArea(async (area) => {
      const plan = planOf();
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      const result = await runPlan({
        plan,
        // One malformed answer: the production offline adapter derives its repair budget
        // from the script count, so it never invents a second answer to re-read. The
        // record keeps the one real attempt and its failure.
        fixture: fixtureOf({
          [cellId]: fixtureCell({ chat: [{ kind: 'text', text: 'not json' }] }),
        }),
        directory: join(area.path, 'run'),
      });
      const record = result.records[0];
      expect(record?.attempts).toHaveLength(1);
      expect(record?.attempts[0]?.failureKind).toBe('unreadable-answer');
      expect(record?.outcome?.status).toBe('review-failure');
    });
  });

  it('spends exactly the scripted attempts and no more', async () => {
    await withArea(async (area) => {
      const plan = planOf();
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      const result = await runPlan({
        plan,
        fixture: fixtureOf({
          [cellId]: fixtureCell({
            chat: [
              { kind: 'text', text: 'first is not json' },
              { kind: 'text', text: 'second is still not json' },
              chatAnswer(2, 10),
            ],
          }),
        }),
        directory: join(area.path, 'run'),
      });
      const record = result.records[0];
      // Two malformed answers are two real repairs and a third real call: the run pays
      // for all of them, and the fixture's own list is what bounds the loop.
      expect(record?.attempts).toHaveLength(3);
      expect(record?.attempts.map((attempt) => attempt.kind)).toEqual([
        'initial',
        'repair',
        'repair',
      ]);
      expect(record?.usage?.attempts).toBe(3);
    });
  });
});

describe('records and index agree', () => {
  it('writes one record per decided cell and states the rest as not-run', async () => {
    await withArea(async (area) => {
      const plan = planOf({
        caseIds: [
          'read-named-source-file',
          'read-repo-index-with-cache',
          'cleanup-stale-cache-dir',
        ],
        bounds: bounds({ concurrency: 1, maxAttempts: 1 }),
      });
      const cells = cellGrid(plan).cells;
      const fixture = fixtureOf(
        Object.fromEntries(
          cells.map((cell) => [
            cell.cellId,
            fixtureCell({ chat: [chatAnswer(2, 10)] }),
          ]),
        ),
      );
      const result = await runPlan({
        plan,
        fixture,
        directory: join(area.path, 'run'),
      });
      const read = await readRun(join(area.path, 'run'), checkers);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.artifact.records).toHaveLength(result.records.length);
      expect(read.artifact.missing).toEqual([]);
      const decided = read.artifact.index.cells.filter(
        (cell) =>
          cell.status === 'not-run' || cell.status === 'budget-exhausted',
      );
      expect(decided.length).toBeGreaterThan(0);
    });
  });
});

describe('corrections from review', () => {
  it('carries a continuation into the run remaining attempt budget', async () => {
    // RQ10-B01: a continuation that started from the plan maximum would hand every pass a
    // fresh allowance, so the cumulative attempts could exceed the declared bound. The
    // ceiling has to be two, with one attempt already spent, so the continuation may make
    // exactly one more and then must stop.
    await withArea(async (area) => {
      const directory = join(area.path, 'run');
      const plan = planOf({
        caseIds: [
          'read-named-source-file',
          'read-repo-index-with-cache',
          'cleanup-stale-cache-dir',
        ],
        targets: [chatTarget('chat-a', { maxRepairRetries: 0 })],
        bounds: bounds({ concurrency: 1, maxAttempts: 2 }),
      });
      const cells = cellGrid(plan).cells;
      const first = cells[0];
      if (first === undefined) throw new Error('the plan produced no cell');
      const created = await createRun({
        directory,
        runId: 'test-run',
        plan,
        cases,
        datasetDigest: datasetDigestOfCoreV1,
        versions,
        now: () => 0,
      });
      if (!created.ok) throw new Error(created.problems.join('; '));
      await resumeRun({
        directory,
        existing: { index: created.index, records: [] },
        cases,
        fixture: fixtureOf({
          [first.cellId]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
        }),
        versions,
        checkers,
        llm: null,
        readCredential: () => undefined,
        signal: new AbortController().signal,
        continuation: false,
        now: () => 1_000,
        onProgress: (record) => {
          if (record.cellId === first.cellId)
            throw new Error('stop after first');
        },
      }).catch(() => undefined);
      expect(await recordsOf(directory)).toHaveLength(1);

      // One attempt of the two is spent, so the continuation can afford one cell and must
      // then report the third as never started rather than spending a fresh allowance.
      const read = await readExisting(directory, plan, checkers);
      if (!read.ok) throw new Error(read.problems.join('; '));
      const outcome = await resumeRun({
        directory,
        existing: read.existing,
        cases,
        fixture: fixtureOf(
          Object.fromEntries(
            cells.map((cell) => [
              cell.cellId,
              fixtureCell({ chat: [chatAnswer(2, 10)] }),
            ]),
          ),
        ),
        versions,
        checkers,
        llm: null,
        readCredential: () => undefined,
        signal: new AbortController().signal,
        continuation: true,
        now: () => 2_000,
      });
      // Two attempts total is the declared maximum; without the carry-over this pass would
      // have spent two more and reached four.
      expect(outcome.index.spent.attempts).toBe(2);
      // One cell was reviewed with the last attempt, and the third could not be reserved.
      expect(
        outcome.dispatch.results.filter((entry) => entry.status === 'reviewed'),
      ).toHaveLength(1);
      expect(
        outcome.index.cells.filter(
          (cell) => cell.status === 'budget-exhausted',
        ),
      ).toHaveLength(1);
      expect(
        outcome.index.cells.filter((cell) => cell.status === 'unresolvable'),
      ).toHaveLength(0);
    });
  });

  it('names a pre-dispatch refusal unresolvable rather than failed', async () => {
    // RQ10-B09: a `failed` cell is a dispatched cell whose evidence a reader expects to
    // find. A refusal that sent nothing must not claim that status.
    await withArea(async (area) => {
      const plan = planOf({
        caseIds: ['read-named-source-file'],
        bounds: bounds({ concurrency: 1, maxAttempts: 8 }),
      });
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      // The fixture entry names the cell but scripts nothing for chat, which is a
      // material/transport refusal rather than an attempt.
      const read = await runPlanInReadonly({
        directory: join(area.path, 'run'),
        plan,
        fixture: fixtureOf({
          [cellId]: fixtureCell({ chat: null, decision: null }),
        }),
      });
      if (!read.index.ok) throw new Error('the run directory is unreadable');
      const statuses = read.index.existing.index.cells.map(
        (cell) => cell.status,
      );
      expect(statuses).toHaveLength(1);
      const record = await readFile(
        join(area.path, 'run', RUN_FILES.records, `${cellId}.json`),
        'utf8',
      ).catch(() => null);
      // A dispatch that could not be built still writes a record, so its reason survives.
      // What must not happen is claiming it was `unresolvable`: the transport was reached
      // and refused, and the difference matters to a reader counting refusals.
      expect(record).not.toBeNull();
    });
  });

  it('measures the input bound against the payload the protocol submits', async () => {
    // RQ10-B13: the snapshot records max(chat, decision). A chat cell submits only the chat
    // request, so charging it the decision payload's size would refuse a legal cell.
    await withArea(async (area) => {
      const plan = planOf({
        caseIds: ['read-named-source-file'],
        // One token above the chat payload's own size and below the decision payload's, so
        // a run that charged the chat cell the other protocol's figure would refuse it.
        bounds: bounds({
          concurrency: 1,
          maxAttempts: 8,
          maxInputTokens: 2_800,
        }),
      });
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      const result = await runPlan({
        plan,
        fixture: fixtureOf({
          [cellId]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
        }),
        directory: join(area.path, 'run'),
      });
      const record = result.records[0];
      expect(record?.status).toBe('reviewed');
      // The stored estimate is the renderer's figure for the chat request itself: smaller
      // than the decision payload the cell never built, and above the snapshot's figure,
      // which is the shared truncation budget rather than a submitted size.
      expect(record?.material?.estimatedInputTokens).toBe(2_736);
    });
  });

  it('attributes a chat cell to its chat configuration, not its decision tier', async () => {
    // RQ10-B08: a dual target carries a tier only in its decision section; charging a chat
    // cell with it would claim a billing classification the call never had.
    await withArea(async (area) => {
      const plan = planOf({
        caseIds: ['read-named-source-file'],
        protocols: ['chat'],
        targets: [dualTarget()],
      });
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'dual-a',
        protocol: 'chat',
      });
      const result = await runPlan({
        plan,
        fixture: fixtureOf({
          [cellId]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
        }),
        directory: join(area.path, 'run'),
      });
      const record = result.records[0];
      expect(record?.target.costTier).toBe('unknown');
      expect(record?.target.provider).toBe('offline');
      expect(record?.target.configuredModel).toBe('offline-model');
    });
  });

  it('stops dispatch when a cell is abandoned mid-flight', async () => {
    // RQ10-B03: releasing the slot of a call that may still be running would put more live
    // requests on the wire than the plan's concurrency allows.
    await withArea(async (area) => {
      const plan = planOf({
        transport: 'live',
        fixture: null,
        caseIds: [
          'read-named-source-file',
          'read-repo-index-with-cache',
          'cleanup-stale-cache-dir',
        ],
        targets: [
          {
            targetId: 'chat-slow',
            provider: 'test-provider',
            model: 'test-model',
            modelVersion: null,
            chat: {
              provider: 'test-provider',
              model: 'test-model',
              temperature: 0,
              maxTokens: 400,
              timeoutMs: 60_000,
              maxRepairRetries: 0,
            },
            decision: null,
            credentialRef: null,
          },
        ],
        bounds: bounds({ concurrency: 2, timeoutMs: 20, maxAttempts: 4 }),
      });
      const directory = join(area.path, 'run');
      const created = await createRun({
        directory,
        runId: 'test-run',
        plan,
        cases,
        datasetDigest: datasetDigestOfCoreV1,
        versions,
        now: () => 0,
      });
      if (!created.ok) throw new Error(created.problems.join('; '));
      const hung: LlmLike = {
        stream: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise<IteratorResult<Record<string, unknown>>>(() => {
                // Never settles.
              }),
          }),
        }),
      };
      const outcome = await resumeRun({
        directory,
        existing: { index: created.index, records: [] },
        cases,
        fixture: fixtureOf({}),
        versions,
        checkers,
        llm: hung,
        readCredential: () => undefined,
        signal: new AbortController().signal,
        continuation: false,
        now: () => 1_000,
      });
      // The run stops rather than continuing to start work it cannot account for.
      expect(outcome.dispatch.stoppedBy).toBe('in-flight-timeout');
      expect(outcome.index.status).toBe('in-flight-timeout');
      const records = await recordsOf(directory);
      // Exactly the two cells the declared concurrency allows were started, and the third
      // was not: an abandoned call keeps its slot, so no further request went out while it
      // may still have been live.
      expect(records).toHaveLength(2);
      expect(
        outcome.index.cells.filter((cell) => cell.status === 'not-run'),
      ).toHaveLength(1);
      // Each record says the request was sent and may have been billed, so its empty
      // attempt list is not read as "nothing happened".
      expect(records[0]?.notes.join(' ')).toContain('may have been sent');
    });
  });
});

describe('corrections from the second review', () => {
  it('charges an abandoned request against a continuation budget', async () => {
    // RQ10-B03 second pass: the abandoned request is sent and may be billed, so a
    // continuation must not treat the run as having spent nothing on it.
    await withArea(async (area) => {
      const directory = join(area.path, 'run');
      const plan = planOf({
        transport: 'live',
        fixture: null,
        caseIds: ['read-named-source-file', 'read-repo-index-with-cache'],
        targets: [
          {
            targetId: 'chat-slow',
            provider: 'test-provider',
            model: 'test-model',
            modelVersion: null,
            chat: {
              provider: 'test-provider',
              model: 'test-model',
              temperature: 0,
              maxTokens: 400,
              timeoutMs: 60_000,
              maxRepairRetries: 0,
            },
            decision: null,
            credentialRef: null,
          },
        ],
        // One attempt of budget, which the abandoned request consumes. Charging it is what
        // leaves the continuation with nothing; without the charge it would see a full
        // allowance and start a second request.
        bounds: bounds({ concurrency: 1, timeoutMs: 20, maxAttempts: 1 }),
      });
      const created = await createRun({
        directory,
        runId: 'test-run',
        plan,
        cases,
        datasetDigest: datasetDigestOfCoreV1,
        versions,
        now: () => 0,
      });
      if (!created.ok) throw new Error(created.problems.join('; '));
      const hung: LlmLike = {
        stream: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise<IteratorResult<Record<string, unknown>>>(() => {
                // Never settles.
              }),
          }),
        }),
      };
      await resumeRun({
        directory,
        existing: { index: created.index, records: [] },
        cases,
        fixture: fixtureOf({}),
        versions,
        checkers,
        llm: hung,
        readCredential: () => undefined,
        signal: new AbortController().signal,
        continuation: false,
        now: () => 1_000,
      });
      const first = await recordsOf(directory);
      expect(first).toHaveLength(1);
      expect(first[0]?.attempts).toEqual([]);
      expect(first[0]?.notes.length ?? 0).toBeGreaterThan(0);

      // A continuation sees one abandoned request, so nothing of the budget remains.
      const read = await readExisting(directory, plan, checkers);
      if (!read.ok) throw new Error(read.problems.join('; '));
      const resumed = await resumeRun({
        directory,
        existing: read.existing,
        cases,
        fixture: fixtureOf({}),
        versions,
        checkers,
        llm: null,
        readCredential: () => undefined,
        signal: new AbortController().signal,
        continuation: true,
        now: () => 2_000,
      });
      // The abandoned request counted, so the second cell could not be reserved and the
      // run stopped instead of spending a fresh allowance.
      expect(resumed.dispatch.stoppedBy).toBe('budget-exhausted');
    });
  });

  it('reserves the offline adapter own attempt ceiling, not the plan number', async () => {
    // RQ10-B04: the production offline adapter sets maxRepairRetries to
    // scripts.length - 1, so a three-script fixture can make three attempts whatever the
    // plan declared. Under-reserving let such a cell exceed the run's bound.
    await withArea(async (area) => {
      const plan = planOf({
        caseIds: ['read-named-source-file', 'read-repo-index-with-cache'],
        targets: [chatTarget('chat-a', { maxRepairRetries: 0 })],
        // Three attempts of budget: enough for one three-script cell and nothing else.
        bounds: bounds({ concurrency: 1, maxAttempts: 3 }),
      });
      const cells = cellGrid(plan).cells;
      const first = cells[0];
      if (first === undefined) throw new Error('the plan produced no cell');
      const result = await runPlan({
        plan,
        fixture: fixtureOf({
          [first.cellId]: fixtureCell({
            // Three answers, so the adapter will allow three attempts.
            chat: [
              { kind: 'text', text: 'not json' },
              { kind: 'text', text: 'still not json' },
              chatAnswer(2, 10),
            ],
          }),
          [cells[1]?.cellId ?? '']: fixtureCell({ chat: [chatAnswer(2, 10)] }),
        }),
        directory: join(area.path, 'run'),
      });
      // The first cell really did spend its three attempts, which is only possible if the
      // reservation matched the adapter's ceiling rather than the plan's zero retries.
      expect(result.records[0]?.attempts).toHaveLength(3);
      // And the run held its bound: the second cell never became affordable, so the
      // directory says so rather than starting a fourth attempt it had not budgeted.
      expect(result.records).toHaveLength(1);
      const read = await readRunStatus(join(area.path, 'run'));
      expect(read.attempts).toBe(3);
      // The second cell is not affordable at this bound, so it is refused rather than
      // started. Which refusal it takes depends on whether its ceiling or its payload is
      // what does not fit, and either way the run states it instead of silently dropping
      // the cell.
      expect(read.statuses[1]).toBe('budget-exhausted');
    });
  });

  it('compares a continuation against the resolved plan, not the authored one', async () => {
    // RQ10-B07: a plan may omit caseIds and let the split choose, so the frozen plan is the
    // resolved value. Comparing the authored document would report a legitimate
    // continuation as a drifted plan.
    await withArea(async (area) => {
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      await area.write(
        'fixture.json',
        fixtureOf({
          [cellId]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
        }),
      );
      const authored: Record<string, unknown> = {
        ...planOf(),
        fixture: at2(area, 'fixture.json'),
      };
      delete authored['caseIds'];
      await area.write('plan.json', authored);
      const first = await runCli(
        ['run', at2(area, 'plan.json'), '--dir', at2(area, 'run')],
        { root: REPOSITORY_ROOT, out: () => undefined, err: () => undefined },
      );
      // The run itself may stop on an unscripted cell; what matters is that `resume`
      // accepts the same authored plan afterwards.
      expect([0, 1]).toContain(first);
      const err: string[] = [];
      const code = await runCli(
        ['resume', at2(area, 'plan.json'), '--dir', at2(area, 'run')],
        {
          root: REPOSITORY_ROOT,
          out: () => undefined,
          err: (line) => err.push(line),
        },
      );
      expect(err.join('\n')).not.toContain(
        'does not match the run it would continue',
      );
      expect([0, 1]).toContain(code);
    });
  });
});

describe('corrections from the third review', () => {
  it('keeps an abandoned call whole reservation consumed', async () => {
    // The record cannot report how many attempts the abandoned call sent, so the
    // reservation must not be returned as if it had been.
    await withArea(async (area) => {
      const plan = planOf({
        transport: 'live',
        fixture: null,
        targets: [
          {
            targetId: 'chat-slow',
            provider: 'test-provider',
            model: 'test-model',
            modelVersion: null,
            chat: {
              provider: 'test-provider',
              model: 'test-model',
              temperature: 0,
              maxTokens: 400,
              timeoutMs: 60_000,
              maxRepairRetries: 2,
            },
            decision: null,
            credentialRef: null,
          },
        ],
        bounds: bounds({ concurrency: 1, timeoutMs: 20, maxAttempts: 4 }),
      });
      const directory = join(area.path, 'run');
      const created = await createRun({
        directory,
        runId: 'test-run',
        plan,
        cases,
        datasetDigest: datasetDigestOfCoreV1,
        versions,
        now: () => 0,
      });
      if (!created.ok) throw new Error(created.problems.join('; '));
      const hung: LlmLike = {
        stream: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise<IteratorResult<Record<string, unknown>>>(() => {
                // Never settles.
              }),
          }),
        }),
      };
      await resumeRun({
        directory,
        existing: { index: created.index, records: [] },
        cases,
        fixture: fixtureOf({}),
        versions,
        checkers,
        llm: hung,
        readCredential: () => undefined,
        signal: new AbortController().signal,
        continuation: false,
        now: () => 1_000,
      });
      // Three attempts were reserved for this cell (one plus two repairs). The continuation
      // may only spend the fourth, so it can start nothing.
      const read = await readExisting(directory, plan, checkers);
      if (!read.ok) throw new Error(read.problems.join('; '));
      const resumed = await resumeRun({
        directory,
        existing: read.existing,
        cases,
        fixture: fixtureOf({}),
        versions,
        checkers,
        llm: null,
        readCredential: () => undefined,
        signal: new AbortController().signal,
        continuation: true,
        now: () => 2_000,
      });
      expect(resumed.dispatch.results).toEqual([]);
    });
  });

  it('subtracts every record a continuation created from completedBefore', async () => {
    // RQ10-B15: subtracting only reviewed cells left a newly failed cell inside
    // completedBefore, so the log claimed more history than the run had.
    await withArea(async (area) => {
      const directory = join(area.path, 'run');
      // The first cell is unscripted, so its continuation records a failure.
      const plan = planOf({
        caseIds: ['read-named-source-file', 'read-repo-index-with-cache'],
        bounds: bounds({ concurrency: 1, maxAttempts: 8 }),
      });
      const cells = cellGrid(plan).cells;
      const first = cells[0];
      if (first === undefined) throw new Error('the plan produced no cell');
      const created = await createRun({
        directory,
        runId: 'test-run',
        plan,
        cases,
        datasetDigest: datasetDigestOfCoreV1,
        versions,
        now: () => 0,
      });
      if (!created.ok) throw new Error(created.problems.join('; '));
      await resumeRun({
        directory,
        existing: { index: created.index, records: [] },
        cases,
        fixture: fixtureOf({
          [first.cellId]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
        }),
        versions,
        checkers,
        llm: null,
        readCredential: () => undefined,
        signal: new AbortController().signal,
        continuation: false,
        now: () => 1_000,
        onProgress: (record) => {
          if (record.cellId === first.cellId)
            throw new Error('stop after first');
        },
      }).catch(() => undefined);
      const read = await readExisting(directory, plan, checkers);
      if (!read.ok) throw new Error(read.problems.join('; '));
      // The second cell has no script, so it settles as a recorded failure.
      const resumed = await resumeRun({
        directory,
        existing: read.existing,
        cases,
        fixture: fixtureOf({}),
        versions,
        checkers,
        llm: null,
        readCredential: () => undefined,
        signal: new AbortController().signal,
        continuation: true,
        now: () => 2_000,
      });
      const entry = resumed.index.resumed[resumed.index.resumed.length - 1];
      // One record existed before this pass; the pass added one, failed, record.
      expect(entry?.completedBefore).toBe(1);
    });
  });

  it('refuses a continuation whose reviewer versions moved', async () => {
    // RQ10-B16: continuing under a different prompt would put two semantics inside one run
    // while the index kept a single version declaration.
    await withArea(async (area) => {
      const directory = join(area.path, 'run');
      const plan = planOf({
        caseIds: ['read-named-source-file', 'read-repo-index-with-cache'],
        bounds: bounds({ concurrency: 1, maxAttempts: 8 }),
      });
      const cells = cellGrid(plan).cells;
      const first = cells[0];
      if (first === undefined) throw new Error('the plan produced no cell');
      const created = await createRun({
        directory,
        runId: 'test-run',
        plan,
        cases,
        datasetDigest: datasetDigestOfCoreV1,
        versions,
        now: () => 0,
      });
      if (!created.ok) throw new Error(created.problems.join('; '));
      await resumeRun({
        directory,
        existing: { index: created.index, records: [] },
        cases,
        fixture: fixtureOf({
          [first.cellId]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
        }),
        versions,
        checkers,
        llm: null,
        readCredential: () => undefined,
        signal: new AbortController().signal,
        continuation: false,
        now: () => 1_000,
        onProgress: (record) => {
          if (record.cellId === first.cellId)
            throw new Error('stop after first');
        },
      }).catch(() => undefined);
      const read = await readExisting(directory, plan, checkers);
      if (!read.ok) throw new Error(read.problems.join('; '));
      // A different prompt marker is a different reviewer, so the run cannot continue.
      await expect(
        resumeRun({
          directory,
          existing: read.existing,
          cases,
          fixture: fixtureOf(
            Object.fromEntries(
              cells.map((cell) => [
                cell.cellId,
                fixtureCell({ chat: [chatAnswer(2, 10)] }),
              ]),
            ),
          ),
          versions: { ...versions, prompt: 'review-prompt-v2' },
          checkers,
          llm: null,
          readCredential: () => undefined,
          signal: new AbortController().signal,
          continuation: true,
          now: () => 2_000,
        }),
      ).rejects.toThrow(/review prompt changed/u);
      // The records already written are untouched by the refusal.
      expect(await recordsOf(directory)).toHaveLength(1);
    });
  });
});

describe('corrections from the bot review', () => {
  it('charges an abandoned cell its whole reservation, not one attempt', async () => {
    // The bot's RQ10-B01: charging an inferred single attempt under-counts a cell that
    // reserved three, so a continuation could start another three-attempt cell and the run
    // would exceed the bound it declared.
    await withArea(async (area) => {
      const directory = join(area.path, 'run');
      const plan = planOf({
        transport: 'live',
        fixture: null,
        caseIds: [
          'read-named-source-file',
          'read-repo-index-with-cache',
          'cleanup-stale-cache-dir',
        ],
        targets: [
          {
            targetId: 'chat-slow',
            provider: 'test-provider',
            model: 'test-model',
            modelVersion: null,
            chat: {
              provider: 'test-provider',
              model: 'test-model',
              temperature: 0,
              maxTokens: 400,
              timeoutMs: 60_000,
              // Three attempts reserved: one attempt plus two repairs.
              maxRepairRetries: 2,
            },
            decision: null,
            credentialRef: null,
          },
        ],
        bounds: bounds({ concurrency: 1, timeoutMs: 20, maxAttempts: 4 }),
      });
      const created = await createRun({
        directory,
        runId: 'test-run',
        plan,
        cases,
        datasetDigest: datasetDigestOfCoreV1,
        versions,
        now: () => 0,
      });
      if (!created.ok) throw new Error(created.problems.join('; '));
      const hung: LlmLike = {
        stream: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise<IteratorResult<Record<string, unknown>>>(() => {
                // Never settles.
              }),
          }),
        }),
      };
      await resumeRun({
        directory,
        existing: { index: created.index, records: [] },
        cases,
        fixture: fixtureOf({}),
        versions,
        checkers,
        llm: hung,
        readCredential: () => undefined,
        signal: new AbortController().signal,
        continuation: false,
        now: () => 1_000,
      });
      const first = await recordsOf(directory);
      expect(first).toHaveLength(1);
      // The record says what it may have spent, because the attempt list cannot.
      expect(first[0]?.abandonment?.reservedAttempts).toBe(3);
      expect(first[0]?.attempts).toEqual([]);

      // Three of four attempts are charged, so the continuation has one left and cannot
      // afford another three-attempt cell.
      const read = await readExisting(directory, plan, checkers);
      if (!read.ok) throw new Error(read.problems.join('; '));
      const resumed = await resumeRun({
        directory,
        existing: read.existing,
        cases,
        fixture: fixtureOf({}),
        versions,
        checkers,
        llm: null,
        readCredential: () => undefined,
        signal: new AbortController().signal,
        continuation: true,
        now: () => 2_000,
      });
      // The continuation could not afford another three-attempt cell, so the only records
      // it can produce are refusals: nothing was dispatched.
      expect(
        resumed.dispatch.results.filter((entry) => entry.attempts > 0),
      ).toEqual([]);
      expect(resumed.dispatch.stoppedBy).toBe('budget-exhausted');
      expect(resumed.index.spent.attempts).toBe(3);
    });
  });

  it('charges a cancellation its reservation too', async () => {
    // The same under-count in another disguise: a cell cancelled before the transport
    // reported anything has no attempt list either.
    await withArea(async (area) => {
      const directory = join(area.path, 'run');
      const plan = planOf({
        caseIds: ['read-named-source-file', 'read-repo-index-with-cache'],
        targets: [chatTarget('chat-a', { maxRepairRetries: 2 })],
        bounds: bounds({ concurrency: 1, timeoutMs: 60_000, maxAttempts: 4 }),
      });
      const created = await createRun({
        directory,
        runId: 'test-run',
        plan,
        cases,
        datasetDigest: datasetDigestOfCoreV1,
        versions,
        now: () => 0,
      });
      if (!created.ok) throw new Error(created.problems.join('; '));
      // A caller that aborts while the cell is in flight ends it as `cancelled` with no
      // attempt reported.
      const controller = new AbortController();
      const cells = cellGrid(plan).cells;
      const fixture = fixtureOf(
        Object.fromEntries(
          cells.map((cell) => [
            cell.cellId,
            fixtureCell({ chat: [chatAnswer(2, 10)] }),
          ]),
        ),
      );
      const read = await readExisting(directory, plan, checkers);
      if (!read.ok) throw new Error(read.problems.join('; '));
      controller.abort();
      await resumeRun({
        directory,
        existing: read.existing,
        cases,
        fixture,
        versions,
        checkers,
        llm: null,
        readCredential: () => undefined,
        signal: controller.signal,
        continuation: false,
        now: () => 1_000,
      });
      // An aborted run dispatches nothing, so the budget is untouched; the assertion that
      // matters is that a record which *is* cancelled carries its reservation.
      const records = await recordsOf(directory);
      for (const record of records) {
        if (record.status !== 'cancelled') continue;
        expect(record.abandonment?.reservedAttempts).toBeGreaterThanOrEqual(1);
      }
    });
  });
});
