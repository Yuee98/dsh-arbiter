import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { compileRunCheckers } from '../../evals/src/run/schemas.js';
import { planProblems } from '../../evals/src/run/plan.js';
import {
  createRun,
  readExisting,
  resumeRun,
} from '../../evals/src/run/lifecycle.js';
import { digestOf } from '../../evals/src/data/hash.js';
import { caseMaterial } from '../../evals/src/run/material.js';
import type { ReviewCase } from '../../evals/src/data/types.js';
import type { RunFixture, RunPlan } from '../../evals/src/run/types.js';
import type { LlmLike } from '../../src/reviewer/llm.js';
import { estimateChatInput } from '../../src/reviewer/prompt.js';
import { coreCases, VERSIONS } from './helpers/report-run.js';
import {
  bounds,
  cellIdOf,
  chatAnswer,
  chatTarget,
  fixtureCell,
  fixtureOf,
  planOf,
  withArea,
} from './helpers/run.js';

const checkers = await compileRunCheckers();
const loaded = await coreCases();
const entry = loaded.cases.find(
  (value) => value.caseId === 'read-named-source-file',
);
if (entry === undefined) throw new Error('missing committed fixture');
const sample = entry;
const longCase: ReviewCase = {
  ...sample,
  input: {
    ...sample.input,
    context: Array.from({ length: 70 }, (_, index) => ({
      tool: 'bash',
      arguments: `echo step-${String(index)} ${'observed '.repeat(80)}`,
    })),
  },
};

async function execute(
  directory: string,
  plan: RunPlan,
  entries: readonly ReviewCase[],
  fixture: RunFixture | null,
  llm: LlmLike | null = null,
) {
  const created = await createRun({
    directory,
    runId: 'context-budget',
    plan,
    cases: entries,
    datasetDigest: digestOf(entries),
    versions: VERSIONS,
    fixture: fixture ?? fixtureOf({}),
    now: () => 0,
  });
  if (!created.ok) throw new Error(created.problems.join('; '));
  const existing = await readExisting(directory, plan, checkers);
  if (!existing.ok) throw new Error(existing.problems.join('; '));
  await resumeRun({
    directory,
    existing: existing.existing,
    cases: entries,
    fixture: fixture ?? fixtureOf({}),
    versions: VERSIONS,
    checkers,
    llm,
    readCredential: () => undefined,
    signal: new AbortController().signal,
    continuation: false,
    now: () => 1000,
  });
  const result = await readExisting(directory, plan, checkers);
  if (!result.ok) throw new Error(result.problems.join('; '));
  return result.existing;
}

function scriptedLlm(answers: readonly string[]) {
  const sent: number[] = [];
  const llm: LlmLike = {
    stream: (options) => {
      const text = answers[sent.length];
      if (text === undefined) throw new Error('unexpected provider invocation');
      sent.push(estimateChatInput(options.system, options.messages));
      return (async function* () {
        await Promise.resolve();
        yield { type: 'text-delta', text };
        yield { type: 'usage', usage: { input_tokens: 99, output_tokens: 3 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
  return { llm, sent };
}

describe('formal run-plan T/H and persisted v1 material', () => {
  test('loads custom T, passes it through scheduler, and reads both new and old v1 material', async () => {
    await withArea(async (area) => {
      const id = cellIdOf({
        caseId: sample.caseId,
        targetId: 'chat-a',
        protocol: 'chat',
      });
      const fixture = fixtureOf({
        [id]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
      });
      const estimates: number[] = [];
      for (const target of [4000, 6000]) {
        const authored = planOf({
          context: { targetInputTokens: target, maxInputTokens: 10000 },
        });
        await area.write(`plan-${String(target)}.json`, authored);
        const checked = checkers.plan(
          JSON.parse(
            await readFile(
              join(area.path, `plan-${String(target)}.json`),
              'utf8',
            ),
          ),
        );
        if (!checked.ok) throw new Error(checked.problems.join('; '));
        expect(planProblems(checked.document)).toEqual([]);
        const result = await execute(
          join(area.path, `run-${String(target)}`),
          checked.document,
          [longCase],
          fixture,
        );
        const record = result.records[0];
        expect(record?.status).toBe('reviewed');
        expect(record?.material?.targetInputTokens).toBe(target);
        expect(record?.material?.estimatedInputTokens).toBeLessThanOrEqual(
          target,
        );
        expect(checkers.record(record).ok).toBe(true);
        const {
          targetInputTokens: _target,
          baseInputTokens: _base,
          targetExceededReason: _reason,
          ...oldMaterial
        } = record?.material ?? {};
        expect(checkers.record({ ...record, material: oldMaterial }).ok).toBe(
          true,
        );
        estimates.push(record?.material?.estimatedInputTokens ?? 0);
      }
      expect(estimates[1]).toBeGreaterThan(estimates[0] ?? 0);
      const legacy = planOf({ context: { maxInputTokens: 4000 } });
      expect(checkers.plan(legacy).ok).toBe(true);
      const oldRun = await execute(
        join(area.path, 'legacy'),
        legacy,
        [longCase],
        fixture,
      );
      expect(oldRun.records[0]?.material?.targetInputTokens).toBe(4000);
    });
  });
  test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects explicit illegal T %s at the actual schema',
    (value) => {
      expect(
        checkers.plan(
          planOf({
            context: { targetInputTokens: value, maxInputTokens: 10000 },
          }),
        ).ok,
      ).toBe(false);
    },
  );
  test('semantic validation rejects explicit T>H rather than clamping it', () => {
    expect(
      planProblems(
        planOf({ context: { targetInputTokens: 6001, maxInputTokens: 6000 } }),
      ),
    ).toContain(
      'context.targetInputTokens must be a positive safe integer not exceeding context.maxInputTokens',
    );
  });
  test('a protected B>H never reserves an attempt and does not prevent another valid cell', async () => {
    await withArea(async (area) => {
      const impossible: ReviewCase = {
        ...sample,
        caseId: 'too-large-original',
        input: {
          ...sample.input,
          evidence: [
            {
              kind: 'material-quote',
              ref: 'actual original restriction\n'.repeat(5000),
            },
          ],
        },
      };
      const plan = planOf({
        caseIds: [impossible.caseId, sample.caseId],
        context: { targetInputTokens: 4000, maxInputTokens: 4000 },
        bounds: bounds({
          concurrency: 1,
          maxAttempts: 1,
          maxInputTokens: 100000,
        }),
      });
      const fixture = fixtureOf({
        [cellIdOf({
          caseId: sample.caseId,
          targetId: 'chat-a',
          protocol: 'chat',
        })]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
      });
      const result = await execute(
        join(area.path, 'run'),
        plan,
        [impossible, sample],
        fixture,
      );
      expect(result.index.cells.map((cell) => cell.status)).toEqual([
        'unresolvable',
        'reviewed',
      ]);
      expect(result.index.cells.map((cell) => cell.attempts)).toEqual([0, 1]);
      expect(result.index.spent.attempts).toBe(1);
      expect(
        result.records.find((record) =>
          record.cellId.startsWith(impossible.caseId),
        ),
      ).toBeUndefined();
    });
  });
});

describe('actual repair sends and trusted presend ledger', () => {
  test.each([false, true])(
    'context H enforces repair while preserving first usage (oversized=%s)',
    async (oversized) => {
      await withArea(async (area) => {
        const initial = caseMaterial(sample, 'chat', { maxInputTokens: 10000 });
        const hard = initial.snapshot.budget.estimatedInputTokens + 600;
        const malformed = oversized
          ? JSON.stringify({
              risk: 2,
              authorization: 9,
              ['K'.repeat(40000)]: true,
            })
          : JSON.stringify({
              risk: 2,
              authorization: 9,
              ['K'.repeat(800)]: true,
            });
        const provider = scriptedLlm([
          malformed,
          '{"risk":2,"authorization":10}',
        ]);
        const plan = planOf({
          transport: 'live',
          fixture: null,
          targets: [chatTarget('chat-a', { maxRepairRetries: 1 })],
          context: { targetInputTokens: hard, maxInputTokens: hard },
          bounds: bounds({
            concurrency: 1,
            maxAttempts: 2,
            maxInputTokens: 100000,
          }),
        });
        const result = await execute(
          join(area.path, 'run'),
          plan,
          [sample],
          null,
          provider.llm,
        );
        const record = result.records[0];
        expect(record?.attempts).toHaveLength(2);
        expect(provider.sent).toHaveLength(oversized ? 1 : 2);
        expect(provider.sent.every((tokens) => tokens <= hard)).toBe(true);
        expect(record?.attempts[1]?.sent === false).toBe(oversized);
        expect(record?.attempts[1]?.estimatedInputTokens).toBeGreaterThan(
          record?.attempts[0]?.estimatedInputTokens ?? 0,
        );
        expect(record?.usage?.attempts).toBe(oversized ? 1 : 2);
        expect(result.index.spent.attempts).toBe(provider.sent.length);
        expect(record?.usage?.totals.inputTokens.total).toBe(
          99 * provider.sent.length,
        );
        expect(record?.attempts[0]?.responseText).toContain('KKKK');
      });
    },
  );
});

test('a repair exactly at context H is actually sent and recorded at that size', async () => {
  await withArea(async (area) => {
    const malformed = JSON.stringify({
      risk: 2,
      authorization: 9,
      ['K'.repeat(800)]: true,
    });
    const answers = [malformed, '{"risk":2,"authorization":10}'];
    const plan = planOf({
      transport: 'live',
      fixture: null,
      context: { targetInputTokens: 6000, maxInputTokens: 10000 },
      bounds: bounds({ maxInputTokens: 100000 }),
      targets: [chatTarget('chat-a', { maxRepairRetries: 1 })],
    });
    const calibration = scriptedLlm(answers);
    const first = await execute(
      join(area.path, 'measure'),
      plan,
      [sample],
      null,
      calibration.llm,
    );
    const hard = first.records[0]?.attempts[1]?.estimatedInputTokens;
    if (hard === undefined) throw new Error('repair was not measured');
    const provider = scriptedLlm(answers);
    const exact = await execute(
      join(area.path, 'exact'),
      { ...plan, context: { targetInputTokens: hard, maxInputTokens: hard } },
      [sample],
      null,
      provider.llm,
    );
    expect(provider.sent).toHaveLength(2);
    expect(provider.sent[1]).toBe(hard);
    expect(exact.records[0]?.attempts[1]?.estimatedInputTokens).toBe(hard);
    expect(exact.records[0]?.attempts[1]?.sent).not.toBe(false);
    expect(exact.records[0]?.status).toBe('reviewed');
    expect(exact.index.spent.attempts).toBe(2);
  });
});
