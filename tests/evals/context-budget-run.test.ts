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
import { caseFacts, caseMaterial } from '../../evals/src/run/material.js';
import { variantPackage } from '../../src/reviewer/package.js';
import {
  defineVariant,
  PRODUCTION_VARIANT,
} from '../../src/reviewer/variant.js';
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

test('unsafe material preparation refuses only that cell before reservation or provider dispatch', async () => {
  await withArea(async (area) => {
    const guarded: ReviewCase = {
      ...sample,
      caseId: 'guarded-material',
      input: {
        ...sample.input,
        action: {
          name: 'unknown-tool',
          arguments: { entries: Array.from({ length: 100001 }, () => 0) },
        },
      },
    };
    const provider = scriptedLlm(['{"risk":2,"authorization":10}']);
    const plan = planOf({
      caseIds: [guarded.caseId, sample.caseId],
      transport: 'live',
      fixture: null,
      targets: [chatTarget('chat-a', { maxRepairRetries: 0 })],
      context: { targetInputTokens: 6000, maxInputTokens: 10000 },
      bounds: bounds({
        concurrency: 1,
        maxAttempts: 1,
        maxInputTokens: 100000,
      }),
    });
    const result = await execute(
      join(area.path, 'run'),
      plan,
      [guarded, sample],
      null,
      provider.llm,
    );
    expect(result.index.cells.map((cell) => cell.status)).toEqual([
      'unresolvable',
      'reviewed',
    ]);
    expect(result.index.cells.map((cell) => cell.attempts)).toEqual([0, 1]);
    expect(provider.sent).toHaveLength(1);
    expect(result.index.spent.attempts).toBe(1);
    expect(result.records.map((record) => record.case.caseId)).toEqual([
      sample.caseId,
    ]);
    expect(JSON.stringify(result.index.cells[0])).toContain(
      'material_preparation_failed',
    );
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

describe('PR1 source and degradation regressions through the actual legacy adapter', () => {
  test('protects the latest actual local and parent originals instead of earlier tool facts and approvals', () => {
    const entry: ReviewCase = {
      ...sample,
      input: {
        ...sample.input,
        evidence: [
          { kind: 'material-quote', ref: 'TOOL_FACT', note: '工具结果原文' },
          {
            kind: 'material-quote',
            ref: 'OLD_LOCAL_ALLOW',
            note: '本会话人类原文',
          },
          {
            kind: 'material-quote',
            ref: 'OLD_PARENT_ALLOW',
            note: '直接父会话人类原文',
          },
          {
            kind: 'material-quote',
            ref: 'LATEST_LOCAL_WITHDRAW',
            note: '本会话人类原文',
          },
          {
            kind: 'material-quote',
            ref: 'LATEST_PARENT_WITHDRAW',
            note: '直接父会话人类原文',
          },
        ],
      },
    };
    const material = caseMaterial(entry, 'chat', {
      targetInputTokens: 1,
      maxInputTokens: 10000,
    });
    expect(material.snapshot.budget.targetExceededReason).toBe('base-input');
    expect(material.snapshot.evidence.map((item) => item.text)).toEqual([
      'LATEST_LOCAL_WITHDRAW',
      'LATEST_PARENT_WITHDRAW',
    ]);
    expect(
      material.snapshot.evidence.every((item) => item.evidence === 'explicit'),
    ).toBe(true);
  });

  test('considers earlier originals newest first while retaining their original display positions', () => {
    const newest = {
      kind: 'material-quote' as const,
      ref: 'LATEST_WITHDRAWAL',
      note: '本会话人类原文',
    };
    const reference: ReviewCase = {
      ...sample,
      input: { ...sample.input, evidence: [newest] },
    };
    const base = caseMaterial(reference, 'chat', {
      targetInputTokens: 1,
      maxInputTokens: 20000,
    });
    const target = base.snapshot.budget.estimatedInputTokens + 2300;
    const entry: ReviewCase = {
      ...reference,
      input: {
        ...reference.input,
        evidence: [
          {
            kind: 'material-quote',
            ref: 'EARLIER_APPROVAL ' + 'old '.repeat(2000),
            note: '本会话人类原文',
          },
          {
            kind: 'material-quote',
            ref: 'RECENT_AMENDMENT ' + 'middle '.repeat(2000),
            note: '本会话人类原文',
          },
          newest,
        ],
      },
    };
    const material = caseMaterial(entry, 'chat', {
      targetInputTokens: target,
      maxInputTokens: target,
    });
    expect(
      material.snapshot.evidence.map((item) => item.text.split(' ')[0]),
    ).toEqual(['RECENT_AMENDMENT', 'LATEST_WITHDRAWAL']);
  });

  test.each(['full', 'compact', 'compact-no-audit'] as const)(
    'reports parsed facts omitted by budget truthfully in %s',
    (structure) => {
      const entry: ReviewCase = {
        ...sample,
        input: {
          ...sample.input,
          action: {
            name: 'bash',
            arguments: { command: 'echo actual-parsed-action' },
          },
          evidence: [],
        },
      };
      expect(caseFacts(entry)).not.toBeNull();
      const pkg = variantPackage(
        defineVariant({ ...PRODUCTION_VARIANT, structure }),
      );
      const material = caseMaterial(entry, 'chat', {
        targetInputTokens: 1,
        maxInputTokens: 10000,
        pkg,
      });
      expect(material.snapshot.facts).toBeNull();
      expect(material.snapshot.budget.truncatedSegments).toContain(
        'DERIVED_FACTS',
      );
      expect(JSON.stringify(material.request)).toContain(
        'facts omitted by the input budget',
      );
      expect(JSON.stringify(material.request)).not.toContain(
        'the program could not be parsed',
      );
      const unknown: ReviewCase = {
        ...entry,
        input: {
          ...entry.input,
          action: { name: 'unknown-tool', arguments: {} },
        },
      };
      expect(caseFacts(unknown)).toBeNull();
      expect(
        JSON.stringify(
          caseMaterial(unknown, 'chat', {
            targetInputTokens: 1,
            maxInputTokens: 10000,
            pkg,
          }).request,
        ),
      ).toContain('the program could not be parsed');
    },
  );

  test('degrades large action siblings when the preferred command field alone cannot fit H', () => {
    const args = {
      command: 'echo ok',
      payload: 'PAYLOAD_HEAD ' + 'payload '.repeat(20000) + ' PAYLOAD_TAIL',
    };
    const entry: ReviewCase = {
      ...sample,
      input: {
        ...sample.input,
        action: { name: 'bash', arguments: args },
        evidence: [],
      },
    };
    const material = caseMaterial(entry, 'chat', {
      targetInputTokens: 3000,
      maxInputTokens: 4500,
    });
    expect(material.snapshot.budget.truncatedSegments).not.toContain(
      'OVER_BUDGET',
    );
    expect(material.snapshot.budget.estimatedInputTokens).toBeLessThanOrEqual(
      4500,
    );
    expect(material.snapshot.action.arguments).toMatchObject({
      format: 'json-fragment',
    });
    expect(material.snapshot.action.truncated?.field).toBeNull();
    expect(JSON.stringify(material.snapshot.action.arguments)).toContain(
      'PAYLOAD_TAIL',
    );
    expect(args.payload).toHaveLength(
      'PAYLOAD_HEAD '.length +
        'payload '.repeat(20000).length +
        ' PAYLOAD_TAIL'.length,
    );
  });

  test('never replaces an independent programText with a different argument field', () => {
    const programText = 'INDEPENDENT actual program';
    const entry: ReviewCase = {
      ...sample,
      input: {
        ...sample.input,
        action: {
          name: 'run_code',
          arguments: {
            code: 'CODE_HEAD ' + 'actual '.repeat(20000) + ' CODE_TAIL',
          },
          programText,
        },
        evidence: [],
      },
    };
    const material = caseMaterial(entry, 'chat', {
      targetInputTokens: 3000,
      maxInputTokens: 4500,
    });
    expect(material.snapshot.action.programText).toBe(programText);
    expect(material.snapshot.budget.truncatedSegments).not.toContain(
      'OVER_BUDGET',
    );
    expect(material.snapshot.budget.estimatedInputTokens).toBeLessThanOrEqual(
      4500,
    );
  });

  test('whole-action fallback includes an independent program without inventing a duplicate', () => {
    const args = {
      command: 'echo ok',
      payload: 'actual payload '.repeat(10000),
    };
    const programText =
      'PROGRAM_HEAD ' + 'independent '.repeat(10000) + ' PROGRAM_TAIL';
    const entry: ReviewCase = {
      ...sample,
      input: {
        ...sample.input,
        action: { name: 'run_code', arguments: args, programText },
        evidence: [],
      },
    };
    const material = caseMaterial(entry, 'chat', {
      targetInputTokens: 3000,
      maxInputTokens: 4500,
    });
    expect(material.snapshot.budget.truncatedSegments).not.toContain(
      'OVER_BUDGET',
    );
    expect(material.snapshot.budget.estimatedInputTokens).toBeLessThanOrEqual(
      4500,
    );
    expect(material.snapshot.action.programText).toBeUndefined();
    expect(material.snapshot.action.arguments).toMatchObject({
      format: 'json-fragment',
    });
    expect(JSON.stringify(material.snapshot.action.arguments)).toContain(
      'PROGRAM_TAIL',
    );
    expect(material.snapshot.action.truncated?.originalChars).toBe(
      JSON.stringify({ arguments: args, programText }).length,
    );
    expect(material.snapshot.action.truncated?.field).toBeNull();
    expect(entry.input.action.programText).toBe(programText);
    expect(entry.input.action.arguments).toEqual(args);
  });

  test('distinguishes available guidance fully omitted by budget from originally absent guidance', () => {
    const input = {
      ...sample.input,
      action: {
        name: 'bash',
        arguments: { command: 'echo ' + 'large-action '.repeat(10000) },
      },
      evidence: [],
    };
    const entry: ReviewCase = {
      ...sample,
      input: {
        ...input,
        policy: {
          ...input.policy,
          customRules: 'global '.repeat(10000),
          projectRules: 'project '.repeat(10000),
        },
      },
    };
    const material = caseMaterial(entry, 'chat', {
      targetInputTokens: 3000,
      maxInputTokens: 4500,
    });
    expect(material.snapshot.customRules).toBe('');
    expect(material.snapshot.projectRules).toBeNull();
    for (const source of material.snapshot.materials)
      expect(source).toMatchObject({
        enabled: true,
        present: false,
        chars: 0,
        truncated: true,
      });
    const absent: ReviewCase = {
      ...entry,
      input: {
        ...entry.input,
        policy: { ...entry.input.policy, customRules: '', projectRules: null },
      },
    };
    for (const source of caseMaterial(absent, 'chat', {
      targetInputTokens: 3000,
      maxInputTokens: 4500,
    }).snapshot.materials)
      expect(source).toMatchObject({
        present: false,
        chars: 0,
        truncated: false,
      });
  });
});
