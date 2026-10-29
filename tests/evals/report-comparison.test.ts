/**
 * Comparability: what the report may attribute, and what it must report whole.
 *
 * The milestone restricts one comparison — two protocols of the *same* model — and forbids
 * one conclusion: that a difference between two models run on two different protocols is a
 * protocol effect. That rule is easy to state and easy to violate by accident, because a
 * table with a protocol column looks like a comparison whatever the report says. So it is
 * tested here as behaviour rather than as prose:
 *
 *   - one target with both protocols yields a paired comparison over the cases both
 *     answered;
 *   - two targets with different models and different protocols yield a system
 *     combination and *no* paired comparison;
 *   - a pairing the plan declared but the target cannot support is reported as
 *     unsupported rather than compared against nothing.
 *
 * The same file covers the sample-count rules, because they are the other half of "do not
 * pretend to have more evidence than you do": a repeat is a second observation of one
 * case, a repair is not an observation at all, and a related variant shares a seed.
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildReport, defaultSettings } from '../../evals/src/metrics/index.js';
import { observeRun } from '../../evals/src/metrics/observe.js';
import type { EvaluationReport } from '../../evals/src/metrics/types.js';
import { renderMarkdown } from '../../evals/src/report/markdown.js';
import {
  cellIdOf,
  chatAnswer,
  chatTarget,
  decisionAnswer,
  decisionTarget,
  fixtureCell,
  fixtureOf,
  planOf,
} from './helpers/run.js';
import type { RunTarget } from '../../evals/src/run/types.js';

/**
 * One model offered through both protocols.
 *
 * The shared helper `dualTarget` names a different model in each protocol block, which is
 * a legitimate plan but not a single model: it would make the two protocols differ in two
 * things at once, and this file's whole subject is the difference between that and a real
 * same-model comparison. So the dual target here pins one model name on both sides.
 */
function sameModelDual(
  targetId = 'dual-a',
  model = 'offline-model',
): RunTarget {
  return {
    targetId,
    provider: 'offline',
    model,
    modelVersion: '2026-10-01',
    chat: {
      provider: 'offline',
      model,
      temperature: 0,
      maxTokens: 400,
      timeoutMs: 5_000,
      maxRepairRetries: 1,
    },
    decision: {
      url: 'https://offline.test/v1/systemone',
      model,
      apiKeyRef: 'OFFLINE_KEY',
      timeoutMs: 5_000,
      costTier: 'free',
    },
    credentialRef: null,
  };
}

/** A chat-only target with a chosen model name, so two targets can be two models. */
function chatModel(targetId: string, model: string): RunTarget {
  return {
    targetId,
    provider: 'offline',
    model,
    modelVersion: null,
    chat: {
      provider: 'offline',
      model,
      temperature: 0,
      maxTokens: 400,
      timeoutMs: 5_000,
      maxRepairRetries: 1,
    },
    decision: null,
    credentialRef: null,
  };
}
import {
  CORE_DATASET,
  REPOSITORY_ROOT,
  runPlan,
  withArea,
} from './helpers/report-run.js';

/** Build a report for one run directory, with the committed dataset joined. */
async function build(directory: string): Promise<EvaluationReport> {
  const read = await observeRun({
    directory,
    root: REPOSITORY_ROOT,
    dataset: { kind: 'path', path: CORE_DATASET },
  });
  if (!read.ok) throw new Error(read.problems.join('; '));
  return buildReport({
    observation: read.observation,
    settings: {
      ...defaultSettings(REPOSITORY_ROOT),
      dataset: { kind: 'path', path: CORE_DATASET },
    },
  });
}

/** The two cases the comparison tests use. */
const CASES = ['read-named-source-file', 'read-repo-index-with-cache'] as const;

/** A fixture entry for one cell, answering chat or decision. */
function cellChat(
  caseId: string,
  targetId: string,
  risk: number,
  authorization: number,
) {
  return [
    cellIdOf({ caseId, targetId, protocol: 'chat' }),
    fixtureCell({ chat: [chatAnswer(risk, authorization)] }),
  ] as const;
}

/** A fixture entry for a decision cell, answering with both distributions. */
function cellDecision(
  caseId: string,
  targetId: string,
  risk: number,
  authorization: number,
) {
  return [
    cellIdOf({ caseId, targetId, protocol: 'decision' }),
    fixtureCell({
      decision: [
        decisionAnswer(
          { [String(risk - 1)]: 0.95 },
          { [String(authorization - 1)]: 0.95 },
        ),
      ],
    }),
  ] as const;
}

describe('one model through two protocols', () => {
  it('pairs the cases both protocols answered and reports the differences', async () => {
    await withArea(async (created) => {
      const directory = join(created.path, 'run');
      await runPlan({
        directory,
        plan: planOf({
          caseIds: [...CASES],
          protocols: ['chat', 'decision'],
          targets: [sameModelDual()],
        }),
        fixture: fixtureOf({
          ...Object.fromEntries([
            cellChat('read-named-source-file', 'dual-a', 1, 10),
            cellChat('read-repo-index-with-cache', 'dual-a', 2, 10),
            // The decision side agrees on the first case and not on the second.
            cellDecision('read-named-source-file', 'dual-a', 1, 10),
            cellDecision('read-repo-index-with-cache', 'dual-a', 7, 10),
          ]),
        }),
      });
      const report = await build(directory);
      expect(report.comparison.protocolComparisons).toHaveLength(1);
      const comparison = report.comparison.protocolComparisons[0];
      expect(comparison?.targetId).toBe('dual-a');
      expect(comparison?.basis).toBe('one-target-two-protocols');
      expect(comparison?.cases).toBe(2);
      expect(comparison?.paired).toBe(2);
      // Both cases allow, so the behaviour agrees even though one pair differs.
      expect(comparison?.behaviourAgree).toBe(2);
      expect(comparison?.scoreAgree).toBe(1);
      expect(comparison?.differences).toHaveLength(1);
      expect(comparison?.differences[0]?.caseId).toBe(
        'read-repo-index-with-cache',
      );
      expect(comparison?.differences[0]?.chat).toEqual([2, 10]);
      expect(comparison?.differences[0]?.decision).toEqual([7, 10]);
      // No system combination is claimed: the two sides are one target and one model.
      expect(report.comparison.systems).toHaveLength(0);
    });
  });

  it('pairs on case id, so repeats do not multiply the comparison', async () => {
    await withArea(async (created) => {
      const directory = join(created.path, 'run');
      await runPlan({
        directory,
        plan: planOf({
          caseIds: ['read-named-source-file'],
          protocols: ['chat', 'decision'],
          targets: [sameModelDual()],
          repeats: 2,
        }),
        fixture: fixtureOf({
          ...Object.fromEntries([
            [
              cellIdOf({
                caseId: 'read-named-source-file',
                targetId: 'dual-a',
                protocol: 'chat',
                repeat: 1,
              }),
              fixtureCell({ chat: [chatAnswer(1, 10)] }),
            ],
            [
              cellIdOf({
                caseId: 'read-named-source-file',
                targetId: 'dual-a',
                protocol: 'chat',
                repeat: 2,
              }),
              fixtureCell({ chat: [chatAnswer(1, 10)] }),
            ],
            [
              cellIdOf({
                caseId: 'read-named-source-file',
                targetId: 'dual-a',
                protocol: 'decision',
                repeat: 1,
              }),
              fixtureCell({
                decision: [decisionAnswer({ '0': 0.95 }, { '9': 0.95 })],
              }),
            ],
            [
              cellIdOf({
                caseId: 'read-named-source-file',
                targetId: 'dual-a',
                protocol: 'decision',
                repeat: 2,
              }),
              fixtureCell({
                decision: [decisionAnswer({ '0': 0.95 }, { '9': 0.95 })],
              }),
            ],
          ]),
        }),
      });
      const report = await build(directory);
      const comparison = report.comparison.protocolComparisons[0];
      // Four cells answered, but they are two observations of one case: the paired count
      // is one, not four.
      expect(report.coverage.records).toBe(4);
      expect(comparison?.cases).toBe(1);
      expect(comparison?.paired).toBe(1);
      expect(comparison?.behaviourAgree).toBe(1);
    });
  });

  it('compares only the cases both protocols answered', async () => {
    await withArea(async (created) => {
      const directory = join(created.path, 'run');
      await runPlan({
        directory,
        plan: planOf({
          caseIds: [...CASES],
          protocols: ['chat', 'decision'],
          targets: [sameModelDual()],
        }),
        fixture: fixtureOf({
          ...Object.fromEntries([
            cellChat('read-named-source-file', 'dual-a', 1, 10),
            cellChat('read-repo-index-with-cache', 'dual-a', 2, 10),
            cellDecision('read-named-source-file', 'dual-a', 1, 10),
            // The decision side fails on the second case, so it has no answer to pair.
            [
              cellIdOf({
                caseId: 'read-repo-index-with-cache',
                targetId: 'dual-a',
                protocol: 'decision',
              }),
              fixtureCell({
                decision: [{ status: 500, body: '{"error":"upstream"}' }],
              }),
            ],
          ]),
        }),
      });
      const report = await build(directory);
      const comparison = report.comparison.protocolComparisons[0];
      expect(comparison?.cases).toBe(2);
      expect(comparison?.paired).toBe(1);
      expect(comparison?.behaviourAgree).toBe(1);
      // The failed cell is still counted, as a technical outcome rather than a pairing.
      expect(report.behaviour.overall.technical).toBe(1);
    });
  });
});

describe('a comparison that changes both things is reported whole', () => {
  it('reports a system combination and no protocol comparison across two targets', async () => {
    await withArea(async (created) => {
      const directory = join(created.path, 'run');
      await runPlan({
        directory,
        plan: planOf({
          caseIds: [...CASES],
          protocols: ['chat', 'decision'],
          targets: [chatTarget('chat-a'), decisionTarget('decision-a')],
        }),
        fixture: fixtureOf({
          ...Object.fromEntries([
            cellChat('read-named-source-file', 'chat-a', 1, 10),
            cellChat('read-repo-index-with-cache', 'chat-a', 2, 10),
            cellDecision('read-named-source-file', 'decision-a', 5, 3),
            cellDecision('read-repo-index-with-cache', 'decision-a', 5, 3),
          ]),
        }),
      });
      const report = await build(directory);
      // No same-model pairing exists, so no comparison is constructed.
      expect(report.comparison.protocolComparisons).toHaveLength(0);
      // The two target/protocol groups differ in model *and* protocol, so the pair is a
      // system combination and the reason says why.
      expect(report.comparison.systems).toHaveLength(1);
      expect(report.comparison.systems[0]?.protocols).toEqual([
        'chat',
        'decision',
      ]);
      expect(report.comparison.systems[0]?.reason).toContain(
        '不能归因于单一协议',
      );
      expect(report.comparison.notes.join('\n')).toContain('模型差异');
    });
  });

  it('does not report a system combination when only the model changes', async () => {
    await withArea(async (created) => {
      const directory = join(created.path, 'run');
      await runPlan({
        directory,
        plan: planOf({
          caseIds: ['read-named-source-file'],
          protocols: ['chat'],
          targets: [
            chatModel('chat-a', 'model-a'),
            chatModel('chat-b', 'model-b'),
          ],
        }),
        fixture: fixtureOf({
          ...Object.fromEntries([
            cellChat('read-named-source-file', 'chat-a', 1, 10),
            cellChat('read-named-source-file', 'chat-b', 2, 10),
          ]),
        }),
      });
      const report = await build(directory);
      // Same protocol, two models: that is a model comparison, and the report says so
      // rather than dressing it as a system.
      expect(report.comparison.systems).toHaveLength(0);
      expect(report.comparison.notes.join('\n')).toContain('模型差异');
      expect(report.comparison.notes.join('\n')).toContain(
        '没有同模型双协议比较',
      );
    });
  });
});

describe('a declared pairing the target cannot support', () => {
  it('reports the unsupported protocol and compares nothing against it', async () => {
    await withArea(async (created) => {
      const directory = join(created.path, 'run');
      await runPlan({
        directory,
        plan: planOf({
          caseIds: ['read-named-source-file'],
          protocols: ['chat', 'decision'],
          targets: [chatTarget()],
        }),
        fixture: fixtureOf({
          ...Object.fromEntries([
            cellChat('read-named-source-file', 'chat-a', 1, 10),
          ]),
        }),
      });
      const report = await build(directory);
      expect(report.comparison.unsupported).toHaveLength(1);
      expect(report.comparison.unsupported[0]?.targetId).toBe('chat-a');
      expect(report.comparison.unsupported[0]?.protocols).toEqual(['decision']);
      // The chat cell is compared with nothing, because there is nothing to pair it with.
      expect(report.comparison.protocolComparisons).toHaveLength(0);
      expect(report.behaviour.overall.notRun).toBe(1);
      const markdown = renderMarkdown(report);
      expect(markdown).toContain('计划声明但不支持的组合');
    });
  });
});

describe('sample weights state how much evidence exists', () => {
  it('counts cells, records, cases, families, targets and protocols separately', async () => {
    await withArea(async (created) => {
      const directory = join(created.path, 'run');
      await runPlan({
        directory,
        plan: planOf({
          caseIds: [...CASES],
          protocols: ['chat'],
          targets: [chatTarget()],
          repeats: 2,
        }),
        fixture: fixtureOf({
          ...Object.fromEntries(
            CASES.flatMap((caseId) =>
              [1, 2].map((repeat) => [
                cellIdOf({
                  caseId,
                  targetId: 'chat-a',
                  protocol: 'chat',
                  repeat,
                }),
                fixtureCell({ chat: [chatAnswer(1, 10)] }),
              ]),
            ),
          ),
        }),
      });
      const report = await build(directory);
      const samples = report.stability.samples;
      expect(samples.cells).toBe(4);
      expect(samples.records).toBe(4);
      expect(samples.distinctCases).toBe(2);
      expect(samples.distinctFamilies).toBe(1);
      expect(samples.distinctTargets).toBe(1);
      expect(samples.distinctProtocols).toBe(1);
      expect(samples.repeats).toBe(2);
      expect(samples.repairs).toBe(0);
      expect(report.stability.repeatGroups).toHaveLength(2);
      expect(report.stability.stableGroups).toBe(2);
    });
  });

  it('reports a run with no repeats as having no stability sample', async () => {
    await withArea(async (created) => {
      const directory = join(created.path, 'run');
      await runPlan({
        directory,
        plan: planOf({
          caseIds: ['read-named-source-file'],
          protocols: ['chat'],
          targets: [chatTarget()],
        }),
        fixture: fixtureOf({
          ...Object.fromEntries([
            cellChat('read-named-source-file', 'chat-a', 1, 10),
          ]),
        }),
      });
      const report = await build(directory);
      expect(report.stability.repeatGroups).toHaveLength(0);
      expect(report.stability.samples.repeats).toBe(0);
      const markdown = renderMarkdown(report);
      expect(markdown).toContain('没有稳定性样本');
    });
  });
});
