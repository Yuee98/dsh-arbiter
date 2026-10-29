/**
 * The defects the first external review found, one test per finding.
 *
 * Each of these is a case where the report would have produced a plausible number that was
 * not true of the artifact. That is the failure mode this whole task is about, so they are
 * kept as a named set rather than folded into the general tests: a future change that
 * reintroduces one should read as a regression of a known defect, not as a new opinion.
 *
 * The IDs match the review's ledger so a reader can move between the two.
 */

import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { inputHashOf } from '../../evals/src/data/eligibility.js';
import { compileCheckers } from '../../evals/src/data/schemas.js';
import { buildReport, defaultSettings } from '../../evals/src/metrics/index.js';
import { observeRun } from '../../evals/src/metrics/observe.js';
import type { EvaluationReport } from '../../evals/src/metrics/types.js';
import { compileRunCheckers } from '../../evals/src/run/schemas.js';
import { reportRun } from '../../evals/src/report/command.js';
import { renderHtml } from '../../evals/src/report/html.js';
import { renderMarkdown } from '../../evals/src/report/markdown.js';
import { reportPathsOf } from '../../evals/src/report/write.js';
import type { ReviewCase, ReviewLabel } from '../../evals/src/data/types.js';
import type { RunTarget } from '../../evals/src/run/types.js';
import {
  cellIdOf,
  chatAnswer,
  chatTarget,
  fixtureCell,
  fixtureOf,
  planOf,
} from './helpers/run.js';
import {
  CORE_DATASET,
  REPOSITORY_ROOT,
  runPlan,
  withArea,
} from './helpers/report-run.js';
import type { Area } from './helpers/report-run.js';

/** The label versions the committed manifest declares. */
const LABEL_VERSIONS = {
  contract: 'review-contract-v1',
  rubric: 'review-rubric-v1',
  policy: 'arbiter-policy-v2',
} as const;

/** One public score from a test's own number, refusing a value off the scale. */
function scoreOf(value: number): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 {
  const allowed = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined)
    throw new RangeError(`${String(value)} is not a score`);
  return found;
}

/**
 * A chat-only target with a chosen model name, so two targets can be two models.
 *
 * Written out rather than spread from `chatTarget`, because the chat section's model is what
 * the record reports and a spread that changed only the outer member would leave both
 * targets naming the same model — which would silently make the test assert nothing.
 */
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

/** One case from the committed dataset, narrowed by its own schema checker. */
async function committedCase(caseId: string): Promise<ReviewCase> {
  const { readDataset } = await import('../../evals/src/data/read.js');
  const checkers = await compileCheckers();
  const raw = await readDataset(
    join(REPOSITORY_ROOT, 'evals/datasets/core-v1'),
  );
  for (const entry of raw.cases) {
    const checked = checkers.case(entry.document);
    if (checked.ok && checked.document.caseId === caseId) {
      return checked.document;
    }
  }
  throw new Error(`core-v1 has no case ${caseId}`);
}

/** The hash of one case's input, as a label would record it. */
function hashOf(entry: ReviewCase): string {
  return inputHashOf(entry.input);
}

/** An approved label pinning one pair. */
function label(
  caseId: string,
  inputHash: string,
  risk: number,
  authorization: number,
  overrides: Partial<ReviewLabel> = {},
): ReviewLabel {
  return {
    caseId,
    inputHash,
    versions: LABEL_VERSIONS,
    target: {
      status: 'approved',
      allowed: {
        risk: [scoreOf(risk)],
        authorization: [scoreOf(authorization)],
      },
      behaviourReference: authorization === 1 ? 'deny' : 'allow',
      rationale: `测试裁决 ${String(risk)}/${String(authorization)}`,
      decidedBy: 'test',
      decidedAt: '2026-10-29',
    },
    ...overrides,
  };
}

/** A temporary dataset directory with the given cases and labels. */
async function datasetOf(
  created: Area,
  parts: {
    readonly cases: readonly string[];
    readonly labels: readonly ReviewLabel[];
    readonly name?: string;
  },
): Promise<string> {
  const name = parts.name ?? 'dataset';
  await created.write(
    `${name}/manifest.json`,
    JSON.parse(
      await readFile(
        join(REPOSITORY_ROOT, 'evals/datasets/core-v1/manifest.json'),
        'utf8',
      ),
    ) as unknown,
  );
  for (const caseId of parts.cases) {
    await created.write(
      `${name}/cases/${caseId}.json`,
      JSON.parse(
        await readFile(
          join(REPOSITORY_ROOT, `evals/datasets/core-v1/cases/${caseId}.json`),
          'utf8',
        ),
      ) as unknown,
    );
  }
  for (const entry of parts.labels) {
    await created.write(`${name}/labels/${entry.caseId}.json`, entry);
  }
  return join(created.path, name);
}

/** Build a report against one dataset. */
async function buildFor(
  directory: string,
  dataset: string,
): Promise<EvaluationReport> {
  const read = await observeRun({
    directory,
    root: REPOSITORY_ROOT,
    dataset: { kind: 'path', path: dataset },
  });
  if (!read.ok) throw new Error(read.problems.join('; '));
  return buildReport({
    observation: read.observation,
    settings: {
      ...defaultSettings(REPOSITORY_ROOT),
      dataset: { kind: 'path', path: dataset },
    },
  });
}

/** Run one case through chat with one answer and one usage payload. */
async function runOne(
  created: Area,
  caseId: string,
  risk: number,
  authorization: number,
  name = 'run',
): Promise<string> {
  const directory = join(created.path, name);
  await runPlan({
    directory,
    plan: planOf({
      caseIds: [caseId],
      protocols: ['chat'],
      targets: [chatTarget()],
    }),
    fixture: fixtureOf({
      [cellIdOf({ caseId, targetId: 'chat-a', protocol: 'chat' })]: fixtureCell(
        {
          chat: [
            chatAnswer(risk, authorization, {
              input_tokens: 900,
              output_tokens: 12,
            }),
          ],
        },
      ),
    }),
  });
  return directory;
}

describe('RQ11-B01: a label must judge the input the run submitted', () => {
  it('refuses a gold label approved for an input the run never submitted', async () => {
    await withArea(async (created) => {
      // The failure sequence the review named: run the case at one input, then edit the
      // case's input and approve a label for the new one. Dataset validation passes,
      // because the label agrees with the *current* dataset — but the saved answer was
      // produced from material that no longer exists.
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const original = await committedCase('read-named-source-file');
      const edited: ReviewCase = {
        ...original,
        input: {
          ...original.input,
          action: { ...original.input.action, name: 'read-edited' },
        },
      };
      const dataset = await datasetOf(created, {
        cases: [],
        labels: [],
        name: 'edited',
      });
      await created.write('edited/cases/read-named-source-file.json', edited);
      // The label is approved against the edited input, so it is gold by dataset rules.
      const checkers = await compileCheckers();
      const checked = checkers.case(edited);
      if (!checked.ok) throw new Error(checked.problems.join('; '));
      await created.write(
        'edited/labels/read-named-source-file.json',
        label(
          'read-named-source-file',
          inputHashOf(checked.document.input),
          1,
          10,
        ),
      );

      const report = await buildFor(directory, dataset);
      // The dataset says gold; this run's answer has no reference, because the label judges
      // material the answer never saw.
      expect(report.diagnostics.labels.gold).toBe(0);
      expect(report.diagnostics.labels.inputMismatch).toBe(1);
      expect(report.behaviour.overall.judged).toBe(1);
      expect(report.behaviour.overall.referenceKnown).toBe(0);
      expect(report.behaviour.overall.compared).toBe(0);
      expect(report.behaviour.overall.uncompared).toBe(1);
      expect(report.examples[0]?.labelStatus).toBe('input-mismatch');
    });
  });

  it('counts the label when the fingerprints agree', async () => {
    await withArea(async (created) => {
      const entry = await committedCase('read-named-source-file');
      const dataset = await datasetOf(created, {
        cases: ['read-named-source-file'],
        labels: [label('read-named-source-file', hashOf(entry), 1, 10)],
      });
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const report = await buildFor(directory, dataset);
      expect(report.diagnostics.labels.gold).toBe(1);
      expect(report.diagnostics.labels.inputMismatch).toBe(0);
      expect(report.behaviour.overall.compared).toBe(1);
      expect(report.behaviour.overall.matched).toBe(1);
    });
  });
});

describe('RQ11-B02: a protocol comparison requires one model identity', () => {
  it('reports a system combination when the two protocol sections name different models', async () => {
    await withArea(async (created) => {
      const directory = join(created.path, 'run');
      await runPlan({
        directory,
        plan: planOf({
          caseIds: ['read-named-source-file'],
          protocols: ['chat', 'decision'],
          targets: [
            {
              targetId: 'mixed',
              provider: 'offline',
              model: 'outer-model',
              modelVersion: null,
              chat: {
                provider: 'offline',
                model: 'chat-model',
                temperature: 0,
                maxTokens: 400,
                timeoutMs: 5_000,
                maxRepairRetries: 1,
              },
              decision: {
                url: 'https://offline.test/v1/systemone',
                model: 'decision-model',
                apiKeyRef: 'OFFLINE_KEY',
                timeoutMs: 5_000,
                costTier: 'free',
              },
              credentialRef: null,
            },
          ],
        }),
        fixture: fixtureOf({
          [cellIdOf({
            caseId: 'read-named-source-file',
            targetId: 'mixed',
            protocol: 'chat',
          })]: fixtureCell({ chat: [chatAnswer(1, 10)] }),
          [cellIdOf({
            caseId: 'read-named-source-file',
            targetId: 'mixed',
            protocol: 'decision',
          })]: fixtureCell({
            decision: [
              {
                status: 200,
                body: JSON.stringify({
                  model: 'decision-model',
                  answers: {
                    risk: {
                      type: 'score',
                      probabilities: {
                        '0': 0.1,
                        '1': 0.1,
                        '2': 0.1,
                        '3': 0.1,
                        '4': 0.1,
                        '5': 0.1,
                        '6': 0.1,
                        '7': 0.1,
                        '8': 0.1,
                        '9': 0.1,
                      },
                    },
                    authorization: {
                      type: 'score',
                      probabilities: {
                        '0': 0.1,
                        '1': 0.1,
                        '2': 0.1,
                        '3': 0.1,
                        '4': 0.1,
                        '5': 0.1,
                        '6': 0.1,
                        '7': 0.1,
                        '8': 0.1,
                        '9': 0.1,
                      },
                    },
                  },
                }),
              },
            ],
          }),
        }),
      });
      const report = await buildFrom(directory);
      // One target id, two model identities: the pair is confounded, so no protocol
      // comparison is constructed and the reason says why.
      expect(report.comparison.protocolComparisons).toHaveLength(0);
      expect(report.comparison.systems).toHaveLength(1);
      expect(report.comparison.systems[0]?.reason).toContain(
        '不能归因于单一协议',
      );
      expect(report.comparison.systems[0]?.model).toContain('chat-model');
      expect(report.comparison.systems[0]?.model).toContain('decision-model');
    });
  });
});

describe('RQ11-B03: a contested adjudication never becomes gold', () => {
  it('treats two label files claiming one case as no decision at all', async () => {
    await withArea(async (created) => {
      const entry = await committedCase('read-named-source-file');
      const hash = hashOf(entry);
      const dataset = await datasetOf(created, {
        cases: ['read-named-source-file'],
        labels: [label('read-named-source-file', hash, 1, 10)],
      });
      // A second label file with the same declared case id: schema-valid, approved, and
      // contradicting the first. A map keyed by case id would have kept the last one read.
      await created.write(
        'dataset/labels/duplicate.json',
        label('read-named-source-file', hash, 7, 1),
      );
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const report = await buildFor(directory, dataset);
      expect(report.diagnostics.labels.gold).toBe(0);
      expect(report.diagnostics.labels.authorityConflict).toBe(1);
      expect(report.behaviour.overall.compared).toBe(0);
      expect(report.examples[0]?.labelStatus).toBe('authority-conflict');
      const markdown = renderMarkdown(report);
      expect(markdown).toContain('裁决冲突');
    });
  });

  it('reports the conflict in the self-checks rather than only in the counts', async () => {
    await withArea(async (created) => {
      const entry = await committedCase('read-named-source-file');
      const hash = hashOf(entry);
      const dataset = await datasetOf(created, {
        cases: ['read-named-source-file'],
        labels: [label('read-named-source-file', hash, 1, 10)],
      });
      await created.write(
        'dataset/labels/duplicate.json',
        label('read-named-source-file', hash, 7, 1),
      );
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const report = await buildFor(directory, dataset);
      const check = report.checks.find(
        (entry2) => entry2.name === 'labels-uncontested',
      );
      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain('没有可用参考');
      // The exit status follows the checks, so a contested dataset cannot pass silently.
      const err: string[] = [];
      const code = await reportRun(
        {
          root: REPOSITORY_ROOT,
          out: () => undefined,
          err: (line) => err.push(line),
        },
        {
          directory,
          output: null,
          dataset,
          mode: 'ask',
          channel: 'available',
          force: false,
        },
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('labels-uncontested');
    });
  });

  it('treats a label the inspector found incoherent as no decision', async () => {
    await withArea(async (created) => {
      const entry = await committedCase('read-named-source-file');
      const hash = hashOf(entry);
      const broken = label('read-named-source-file', hash, 1, 10);
      const dataset = await datasetOf(created, {
        cases: ['read-named-source-file'],
        labels: [
          {
            ...broken,
            // A widened authorization set mixing band 1 with another band: an applicable
            // prohibition beside a permission, which the inspector reports as incoherent.
            target: {
              ...broken.target,
              allowed: {
                risk: [scoreOf(1)],
                authorization: [scoreOf(1), scoreOf(9)],
              },
            },
          },
        ],
      });
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const report = await buildFor(directory, dataset);
      expect(report.diagnostics.labels.gold).toBe(0);
      expect(report.diagnostics.labels.authorityConflict).toBe(1);
      expect(report.behaviour.overall.compared).toBe(0);
    });
  });
});

describe('RQ11-B04: diagnostics keep each model and protocol', () => {
  it('reports both models scores rather than whichever sorted first', async () => {
    await withArea(async (created) => {
      const entry = await committedCase('read-named-source-file');
      const dataset = await datasetOf(created, {
        cases: ['read-named-source-file'],
        labels: [label('read-named-source-file', hashOf(entry), 1, 10)],
      });
      const directory = join(created.path, 'run');
      // Two targets, deliberately divergent: model A answers correctly, model B five bands
      // off. A per-case dedupe would have kept one and reported zero far errors.
      await runPlan({
        directory,
        plan: planOf({
          caseIds: ['read-named-source-file'],
          protocols: ['chat'],
          targets: [chatTarget('chat-a'), chatModel('chat-b', 'model-b')],
        }),
        fixture: fixtureOf({
          [cellIdOf({
            caseId: 'read-named-source-file',
            targetId: 'chat-a',
            protocol: 'chat',
          })]: fixtureCell({ chat: [chatAnswer(1, 10)] }),
          [cellIdOf({
            caseId: 'read-named-source-file',
            targetId: 'chat-b',
            protocol: 'chat',
          })]: fixtureCell({ chat: [chatAnswer(6, 10)] }),
        }),
      });
      const report = await buildFor(directory, dataset);
      // Both observations are present, so the far error is counted.
      expect(report.diagnostics.risk.comparable).toBe(2);
      expect(report.diagnostics.risk.exact).toBe(1);
      expect(report.diagnostics.risk.far).toBe(1);
      // The observed distribution has two measurements; the reference has one decision.
      const risk = report.diagnostics.shape.find(
        (shape) => shape.field === 'risk',
      );
      expect(risk?.observedCells).toBe(2);
      expect(risk?.referenceCells).toBe(1);
    });
  });

  it('keeps a repeat out of the diagnostics while keeping a second protocol in', async () => {
    await withArea(async (created) => {
      const entry = await committedCase('read-named-source-file');
      const dataset = await datasetOf(created, {
        cases: ['read-named-source-file'],
        labels: [label('read-named-source-file', hashOf(entry), 1, 10)],
      });
      const directory = join(created.path, 'run');
      await runPlan({
        directory,
        plan: planOf({
          caseIds: ['read-named-source-file'],
          protocols: ['chat'],
          targets: [chatTarget()],
          repeats: 3,
        }),
        fixture: fixtureOf({
          ...Object.fromEntries(
            [1, 2, 3].map((repeat) => [
              cellIdOf({
                caseId: 'read-named-source-file',
                targetId: 'chat-a',
                protocol: 'chat',
                repeat,
              }),
              fixtureCell({ chat: [chatAnswer(1, 10)] }),
            ]),
          ),
        }),
      });
      const report = await buildFor(directory, dataset);
      // Three repeats of one (case, model, protocol) are one measurement, not three.
      expect(report.diagnostics.risk.comparable).toBe(1);
      expect(report.behaviour.overall.compared).toBe(3);
    });
  });
});

describe('RQ11-B05: every usage scope states each bucket coverage', () => {
  it('reports per-bucket reported and missing counts for each scope', async () => {
    await withArea(async (created) => {
      const directory = join(created.path, 'run');
      // One attempt reports only input; the other reports input, output and total. A single
      // completeness flag taken from totalTokens would have presented the partial input sum
      // as whole.
      await runPlan({
        directory,
        plan: planOf({
          caseIds: ['read-named-source-file'],
          protocols: ['chat'],
          targets: [chatTarget()],
          repeats: 2,
        }),
        fixture: fixtureOf({
          [cellIdOf({
            caseId: 'read-named-source-file',
            targetId: 'chat-a',
            protocol: 'chat',
            repeat: 1,
          })]: fixtureCell({
            chat: [chatAnswer(1, 10, { input_tokens: 900 })],
          }),
          [cellIdOf({
            caseId: 'read-named-source-file',
            targetId: 'chat-a',
            protocol: 'chat',
            repeat: 2,
          })]: fixtureCell({
            chat: [
              chatAnswer(1, 10, {
                input_tokens: 950,
                output_tokens: 12,
                total_tokens: 962,
              }),
            ],
          }),
        }),
      });
      const report = await buildFrom(directory);
      const model = report.usage.byModel[0];
      const input = model?.fields.find(
        (field) => field.field === 'inputTokens',
      );
      const output = model?.fields.find(
        (field) => field.field === 'outputTokens',
      );
      const total = model?.fields.find(
        (field) => field.field === 'totalTokens',
      );
      expect(input?.reported).toBe(2);
      expect(input?.complete).toBe(true);
      // Output was reported by one of two attempts, so it is partial and says so.
      expect(output?.reported).toBe(1);
      expect(output?.missing).toBe(1);
      expect(output?.complete).toBe(false);
      expect(total?.reported).toBe(1);
      expect(total?.complete).toBe(false);
      // Every scope carries all six buckets, including the ones nobody reported.
      expect(model?.fields).toHaveLength(6);
      const markdown = renderMarkdown(report);
      expect(markdown).toContain('该桶完整');
      expect(renderHtml(report)).toContain('该桶完整');
    });
  });
});

describe('RQ11-B06: a published per-cell aggregate is the recomputation', () => {
  it('publishes the recomputed total while keeping the stored value for comparison', async () => {
    await withArea(async (created) => {
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      // Damage the stored summary without touching the attempts it summarizes. A report that
      // published the stored figure would then print a consumption number its own self-check
      // says is wrong.
      const checkers = await compileRunCheckers();
      const path = join(
        directory,
        'records',
        'read-named-source-file~chat-a~chat~r1.json',
      );
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      const checked = checkers.record(parsed);
      if (!checked.ok) throw new Error(checked.problems.join('; '));
      const usage = checked.document.usage;
      if (usage === null) throw new Error('the fixture record has no usage');
      const tampered = {
        ...checked.document,
        usage: {
          ...usage,
          totals: {
            ...usage.totals,
            inputTokens: { total: 1, reported: 1, missing: 0, complete: true },
          },
        },
      };
      const rechecked = checkers.record(tampered);
      if (!rechecked.ok) throw new Error(rechecked.problems.join('; '));
      await writeFile(path, `${JSON.stringify(rechecked.document, null, 2)}\n`);

      const report = await buildFrom(directory);
      const cell = report.usage.byCell[0];
      // The published figure is the recomputation; the stored number is kept beside it so
      // the disagreement is checkable.
      expect(cell?.aggregate?.totals.inputTokens.total).toBe(900);
      expect(cell?.storedAggregate?.totals.inputTokens.total).toBe(1);
      expect(cell?.matchesRecord).toBe(false);
      expect(
        report.checks.find(
          (check) => check.name === 'usage-reproduced-from-attempts',
        )?.ok,
      ).toBe(false);
    });
  });
});

describe('RQ11-B07: --force never overwrites the evidence', () => {
  it('refuses a prefix that lands on the run plan and leaves it unchanged', async () => {
    await withArea(async (created) => {
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const planPath = join(directory, 'plan.json');
      const before = await readFile(planPath, 'utf8');
      const err: string[] = [];
      const code = await reportRun(
        {
          root: REPOSITORY_ROOT,
          out: () => undefined,
          err: (line) => err.push(line),
        },
        {
          directory,
          // A prefix chosen so that `plan.json` would be the report's JSON document.
          output: planPath.replace(/\.json$/u, ''),
          dataset: CORE_DATASET,
          mode: 'ask',
          channel: 'available',
          force: true,
        },
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('lies inside evidence');
      expect(await readFile(planPath, 'utf8')).toBe(before);
    });
  });

  it('refuses a prefix inside the records directory', async () => {
    await withArea(async (created) => {
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const err: string[] = [];
      const code = await reportRun(
        {
          root: REPOSITORY_ROOT,
          out: () => undefined,
          err: (line) => err.push(line),
        },
        {
          directory,
          output: join(
            directory,
            'records',
            'read-named-source-file~chat-a~chat~r1',
          ),
          dataset: CORE_DATASET,
          mode: 'ask',
          channel: 'available',
          force: true,
        },
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('lies inside evidence');
    });
  });

  it('still allows the ordinary destination inside the run directory', async () => {
    await withArea(async (created) => {
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const code = await reportRun(
        {
          root: REPOSITORY_ROOT,
          out: () => undefined,
          err: () => undefined,
        },
        {
          directory,
          output: null,
          dataset: CORE_DATASET,
          mode: 'ask',
          channel: 'available',
          force: false,
        },
      );
      expect(code).toBe(0);
      for (const path of Object.values(
        reportPathsOf(join(directory, 'report')),
      )) {
        await expect(readFile(path, 'utf8')).resolves.toBeTruthy();
      }
    });
  });
});

describe('RQ11-B08: a repeat group with too few answers is unassessable', () => {
  it('does not count a group whose repeats all failed as stable', async () => {
    await withArea(async (created) => {
      const directory = join(created.path, 'run');
      await runPlan({
        directory,
        plan: planOf({
          caseIds: ['read-named-source-file'],
          protocols: ['chat'],
          targets: [chatTarget()],
          repeats: 2,
        }),
        fixture: fixtureOf({
          ...Object.fromEntries(
            [1, 2].map((repeat) => [
              cellIdOf({
                caseId: 'read-named-source-file',
                targetId: 'chat-a',
                protocol: 'chat',
                repeat,
              }),
              fixtureCell({
                chat: [
                  {
                    kind: 'failure' as const,
                    code: 'overloaded',
                    message: 'refused',
                  },
                ],
              }),
            ]),
          ),
        }),
      });
      const report = await buildFrom(directory);
      const group = report.stability.repeatGroups[0];
      expect(group?.judged).toBe(0);
      expect(group?.stable).toBeNull();
      expect(report.stability.stableGroups).toBe(0);
      expect(report.stability.unassessableGroups).toBe(1);
      const markdown = renderMarkdown(report);
      expect(markdown).toContain('无法判定');
    });
  });

  it('counts a group with one scored answer as unassessable', async () => {
    await withArea(async (created) => {
      const directory = join(created.path, 'run');
      const id1 = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
        repeat: 1,
      });
      const id2 = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
        repeat: 2,
      });
      await runPlan({
        directory,
        plan: planOf({
          caseIds: ['read-named-source-file'],
          protocols: ['chat'],
          targets: [chatTarget()],
          repeats: 2,
        }),
        fixture: fixtureOf({
          [id1]: fixtureCell({ chat: [chatAnswer(1, 10)] }),
          [id2]: fixtureCell({
            chat: [
              {
                kind: 'failure' as const,
                code: 'overloaded',
                message: 'refused',
              },
            ],
          }),
        }),
      });
      const report = await buildFrom(directory);
      const group = report.stability.repeatGroups[0];
      expect(group?.judged).toBe(1);
      expect(group?.stable).toBeNull();
      expect(report.stability.unassessableGroups).toBe(1);
      expect(report.stability.stableGroups).toBe(0);
    });
  });

  it('still classifies two agreeing answers as stable', async () => {
    await withArea(async (created) => {
      const directory = join(created.path, 'run');
      await runPlan({
        directory,
        plan: planOf({
          caseIds: ['read-named-source-file'],
          protocols: ['chat'],
          targets: [chatTarget()],
          repeats: 2,
        }),
        fixture: fixtureOf({
          ...Object.fromEntries(
            [1, 2].map((repeat) => [
              cellIdOf({
                caseId: 'read-named-source-file',
                targetId: 'chat-a',
                protocol: 'chat',
                repeat,
              }),
              fixtureCell({ chat: [chatAnswer(1, 10)] }),
            ]),
          ),
        }),
      });
      const report = await buildFrom(directory);
      expect(report.stability.repeatGroups[0]?.stable).toBe(true);
      expect(report.stability.stableGroups).toBe(1);
      expect(report.stability.unassessableGroups).toBe(0);
    });
  });
});

describe('RQ11-B09: historical grouping follows the saved record', () => {
  it('keeps a run in the family it executed even after the dataset moves the case', async () => {
    await withArea(async (created) => {
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      // The case was executed in `dev-ordinary-read`. A later dataset claims a different
      // family and split for the same case id, with the input unchanged.
      const original = await committedCase('read-named-source-file');
      const dataset = await datasetOf(created, {
        cases: [],
        labels: [],
        name: 'moved',
      });
      await created.write('moved/cases/read-named-source-file.json', {
        ...original,
        familyId: 'hold-irreversible-loss',
        split: 'holdout',
      });
      const report = await buildFor(directory, dataset);
      const example = report.examples[0];
      // The grouping comes from the record, so the historical aggregate is unchanged...
      expect(example?.familyId).toBe('dev-ordinary-read');
      expect(example?.split).toBe('dev');
      expect(example?.caseFactsSource).toBe('record-and-dataset');
      // ...and the disagreement is visible rather than silently resolved.
      expect(example?.caseFactsConflict).toBe(true);
      const families = report.behaviour.byGroup
        .filter((group) => group.axis === 'family')
        .map((group) => group.key);
      expect(families).toContain('dev-ordinary-read');
      expect(families).not.toContain('hold-irreversible-loss');
    });
  });

  it('reports the saved metadata even with no dataset at all', async () => {
    await withArea(async (created) => {
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const read = await observeRun({
        directory,
        root: REPOSITORY_ROOT,
        dataset: { kind: 'none' },
      });
      if (!read.ok) throw new Error(read.problems.join('; '));
      const report = buildReport({
        observation: read.observation,
        settings: {
          ...defaultSettings(REPOSITORY_ROOT),
          dataset: { kind: 'none' },
        },
      });
      const example = report.examples[0];
      // The record carried the family and split, so they are not "unknown" just because no
      // dataset was supplied.
      expect(example?.familyId).toBe('dev-ordinary-read');
      expect(example?.split).toBe('dev');
      expect(example?.provenance).toBe('synthetic');
      expect(example?.caseFactsSource).toBe('record');
      // The challenge class is unknown, because the record never carried the input.
      expect(example?.challengeClass).toBe('unclassified');
    });
  });
});

/** Build a report from one run directory with no dataset joined. */
async function buildFrom(directory: string): Promise<EvaluationReport> {
  const read = await observeRun({
    directory,
    root: REPOSITORY_ROOT,
    dataset: { kind: 'none' },
  });
  if (!read.ok) throw new Error(read.problems.join('; '));
  return buildReport({
    observation: read.observation,
    settings: {
      ...defaultSettings(REPOSITORY_ROOT),
      dataset: { kind: 'none' },
    },
  });
}

/** Assert that a path does not exist, treated as a passing check. */
export async function isAbsent(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8');
    return false;
  } catch {
    return true;
  }
}

/** Remove one path, for a test that damaged a fixture on purpose. */
export async function cleanUp(path: string): Promise<void> {
  await rm(path, { force: true });
}

/** Run a shell command, for a test that needs an external tool. */
export async function run(
  command: string,
  args: readonly string[],
): Promise<void> {
  await promisify(execFile)(command, [...args]);
}

describe('RQ11-B07 (round 2): the recorded dataset is protected too', () => {
  it('refuses a prefix that would replace the run-recorded dataset case', async () => {
    await withArea(async (created) => {
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const casePath = join(
        REPOSITORY_ROOT,
        'evals/datasets/core-v1/cases/read-named-source-file.json',
      );
      const before = await readFile(casePath, 'utf8');
      const err: string[] = [];
      // No `--dataset`: the CLI takes the path the run recorded, which is the one a person
      // actually uses. Protecting only an explicit path left this case writable.
      const code = await reportRun(
        {
          root: REPOSITORY_ROOT,
          out: () => undefined,
          err: (line) => err.push(line),
        },
        {
          directory,
          output: casePath.replace(/\.json$/u, ''),
          dataset: null,
          mode: 'ask',
          channel: 'available',
          force: true,
        },
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('lies inside evidence');
      expect(await readFile(casePath, 'utf8')).toBe(before);
    });
  });

  it('refuses a prefix that would replace the dataset manifest', async () => {
    await withArea(async (created) => {
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const manifestPath = join(
        REPOSITORY_ROOT,
        'evals/datasets/core-v1/manifest.json',
      );
      const before = await readFile(manifestPath, 'utf8');
      const err: string[] = [];
      const code = await reportRun(
        {
          root: REPOSITORY_ROOT,
          out: () => undefined,
          err: (line) => err.push(line),
        },
        {
          directory,
          output: manifestPath.replace(/\.json$/u, ''),
          dataset: null,
          mode: 'ask',
          channel: 'available',
          force: true,
        },
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('lies inside evidence');
      expect(await readFile(manifestPath, 'utf8')).toBe(before);
    });
  });
});

describe('RQ11-B04 (round 2): allowed-pair counting keeps each model', () => {
  it('counts both models pairs rather than only the first case match', async () => {
    await withArea(async (created) => {
      const entry = await committedCase('read-named-source-file');
      const dataset = await datasetOf(created, {
        cases: ['read-named-source-file'],
        labels: [label('read-named-source-file', hashOf(entry), 1, 10)],
      });
      const directory = join(created.path, 'run');
      // Model A returns the allowed pair; model B returns a pair outside it but still an
      // allow. A case-only dedupe would have reported a perfect pair-hit rate.
      await runPlan({
        directory,
        plan: planOf({
          caseIds: ['read-named-source-file'],
          protocols: ['chat'],
          targets: [chatTarget('chat-a'), chatModel('chat-b', 'model-b')],
        }),
        fixture: fixtureOf({
          [cellIdOf({
            caseId: 'read-named-source-file',
            targetId: 'chat-a',
            protocol: 'chat',
          })]: fixtureCell({ chat: [chatAnswer(1, 10)] }),
          [cellIdOf({
            caseId: 'read-named-source-file',
            targetId: 'chat-b',
            protocol: 'chat',
          })]: fixtureCell({ chat: [chatAnswer(6, 10)] }),
        }),
      });
      const report = await buildFor(directory, dataset);
      expect(report.diagnostics.pairs.labeled).toBe(2);
      expect(report.diagnostics.pairs.exactPair).toBe(1);
      expect(report.diagnostics.pairs.pairRate).toBe(0.5);
      expect(report.diagnostics.pairs.outside).toHaveLength(1);
    });
  });
});

describe('RQ11-B03 (round 2): a misnamed label resolves by its declared id', () => {
  it('excludes the declared case, not the filename', async () => {
    await withArea(async (created) => {
      const entry = await committedCase('read-named-source-file');
      const dataset = await datasetOf(created, {
        cases: ['read-named-source-file'],
        labels: [],
      });
      // A schema-valid approved label whose file name disagrees with the id it declares.
      // The inspector reports the filename mismatch against the file; attributing that to
      // the *filename* would leave the label usable under the id it declares.
      await created.write(
        'dataset/labels/wrong-name.json',
        label('read-named-source-file', hashOf(entry), 1, 10),
      );
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const report = await buildFor(directory, dataset);
      expect(report.diagnostics.labels.gold).toBe(0);
      expect(report.diagnostics.labels.authorityConflict).toBe(1);
      expect(report.behaviour.overall.compared).toBe(0);
      expect(report.examples[0]?.labelStatus).toBe('authority-conflict');
    });
  });
});

describe('RQ11-B01/B03 (round 2): layer two uses the same gold predicate', () => {
  it('leaves every diagnostic denominator at zero for an input mismatch', async () => {
    await withArea(async (created) => {
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const original = await committedCase('read-named-source-file');
      const edited: ReviewCase = {
        ...original,
        input: {
          ...original.input,
          action: { ...original.input.action, name: 'read-edited' },
        },
      };
      const dataset = await datasetOf(created, {
        cases: [],
        labels: [],
        name: 'edited',
      });
      await created.write('edited/cases/read-named-source-file.json', edited);
      const checkers = await compileCheckers();
      const checked = checkers.case(edited);
      if (!checked.ok) throw new Error(checked.problems.join('; '));
      await created.write(
        'edited/labels/read-named-source-file.json',
        label(
          'read-named-source-file',
          inputHashOf(checked.document.input),
          1,
          10,
        ),
      );

      const report = await buildFor(directory, dataset);
      // Every gold-dependent number, not only the headline.
      expect(report.diagnostics.risk.comparable).toBe(0);
      expect(report.diagnostics.authorization.comparable).toBe(0);
      expect(report.diagnostics.pairs.labeled).toBe(0);
      expect(
        report.diagnostics.monotonicity.every(
          (entry) => entry.comparablePairs === 0,
        ),
      ).toBe(true);
      expect(
        report.diagnostics.shape.every((entry) => entry.reference === null),
      ).toBe(true);
      // And no score difference is published against the inapplicable label.
      expect(
        report.differences.filter((entry) => entry.kind === 'score'),
      ).toHaveLength(0);
    });
  });

  it('leaves every diagnostic denominator at zero for a contested label', async () => {
    await withArea(async (created) => {
      const entry = await committedCase('read-named-source-file');
      const hash = hashOf(entry);
      const dataset = await datasetOf(created, {
        cases: ['read-named-source-file'],
        labels: [label('read-named-source-file', hash, 1, 10)],
      });
      await created.write(
        'dataset/labels/duplicate.json',
        label('read-named-source-file', hash, 7, 1),
      );
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const report = await buildFor(directory, dataset);
      expect(report.diagnostics.risk.comparable).toBe(0);
      expect(report.diagnostics.pairs.labeled).toBe(0);
      expect(report.diagnostics.shape[0]?.reference).toBeNull();
      expect(
        report.differences.filter((row) => row.kind === 'score'),
      ).toHaveLength(0);
    });
  });
});

describe('RQ11-B06 (round 2): the example table uses the recomputation', () => {
  it('publishes recomputed example tokens and detects a metadata-only mismatch', async () => {
    await withArea(async (created) => {
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const checkers = await compileRunCheckers();
      const path = join(
        directory,
        'records',
        'read-named-source-file~chat-a~chat~r1.json',
      );
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      const checked = checkers.record(parsed);
      if (!checked.ok) throw new Error(checked.problems.join('; '));
      const usage = checked.document.usage;
      if (usage === null) throw new Error('the fixture record has no usage');
      const tampered = {
        ...checked.document,
        usage: {
          ...usage,
          // Totals untouched; only the declared inclusion and coverage change. A
          // totals-only comparison would call this reconciled.
          inclusions: { ...usage.inclusions, cacheRead: 'contained' as const },
        },
      };
      const rechecked = checkers.record(tampered);
      if (!rechecked.ok) throw new Error(rechecked.problems.join('; '));
      await writeFile(path, `${JSON.stringify(rechecked.document, null, 2)}\n`);

      const report = await buildFrom(directory);
      const cell = report.usage.byCell[0];
      expect(cell?.matchesRecord).toBe(false);
      // The example row carries the same recomputed figure as the cell aggregate.
      expect(report.examples[0]?.tokens.inputTokens).toBe(
        cell?.aggregate?.totals.inputTokens.total,
      );
      expect(report.examples[0]?.tokens.inputTokens).toBe(900);
    });
  });
});

describe('RQ11-B09 (round 2): challenge mechanisms are bound to the input', () => {
  it('withholds the classification when the case input changed after the run', async () => {
    await withArea(async (created) => {
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const original = await committedCase('read-named-source-file');
      // The same family and split, but the input gains a hint. Nothing about the executed
      // cell changed, so a classification that read the current input would move an
      // ordinary case to targeted.
      const hinted: ReviewCase = {
        ...original,
        input: { ...original.input, hint: '注意：这次操作可能已被授权' },
      };
      const dataset = await datasetOf(created, {
        cases: [],
        labels: [],
        name: 'hinted',
      });
      await created.write('hinted/cases/read-named-source-file.json', hinted);
      const report = await buildFor(directory, dataset);
      const example = report.examples[0];
      expect(example?.challengeClass).toBe('unclassified');
      expect(example?.challenge).toEqual([]);
      expect(example?.caseFactsConflict).toBe(true);
      // The grouping follows that state rather than a guess.
      const challengeGroups = report.behaviour.byGroup
        .filter((group) => group.axis === 'challenge')
        .map((group) => group.key);
      expect(challengeGroups).toEqual(['unclassified']);
    });
  });
});

describe('RQ11-B10: monotonicity compares within one system', () => {
  it('does not invent a reversal across two models at different offsets', async () => {
    await withArea(async (created) => {
      // Two gold cases ordered R2 < R8, and two models that both preserve the order while
      // sitting at different offsets. A cross-model comparison would pair model B's answer
      // for the lower case with model A's answer for the higher one and call it a reversal.
      const low = await committedCase('read-named-source-file');
      const high = await committedCase('read-repo-index-with-cache');
      const dataset = await datasetOf(created, {
        cases: ['read-named-source-file', 'read-repo-index-with-cache'],
        labels: [
          label('read-named-source-file', hashOf(low), 2, 10),
          label('read-repo-index-with-cache', hashOf(high), 8, 10),
        ],
      });
      const directory = join(created.path, 'run');
      await runPlan({
        directory,
        plan: planOf({
          caseIds: ['read-named-source-file', 'read-repo-index-with-cache'],
          protocols: ['chat'],
          targets: [chatTarget('chat-a'), chatModel('chat-b', 'model-b')],
        }),
        fixture: fixtureOf({
          ...Object.fromEntries([
            [
              cellIdOf({
                caseId: 'read-named-source-file',
                targetId: 'chat-a',
                protocol: 'chat',
              }),
              fixtureCell({ chat: [chatAnswer(1, 10)] }),
            ],
            [
              cellIdOf({
                caseId: 'read-repo-index-with-cache',
                targetId: 'chat-a',
                protocol: 'chat',
              }),
              fixtureCell({ chat: [chatAnswer(3, 10)] }),
            ],
            [
              cellIdOf({
                caseId: 'read-named-source-file',
                targetId: 'chat-b',
                protocol: 'chat',
              }),
              fixtureCell({ chat: [chatAnswer(7, 10)] }),
            ],
            [
              cellIdOf({
                caseId: 'read-repo-index-with-cache',
                targetId: 'chat-b',
                protocol: 'chat',
              }),
              fixtureCell({ chat: [chatAnswer(9, 10)] }),
            ],
          ]),
        }),
      });
      const report = await buildFor(directory, dataset);
      const risk = report.diagnostics.monotonicity.find(
        (entry) => entry.field === 'risk',
      );
      // One comparable pair per model, and neither model reverses.
      expect(risk?.comparablePairs).toBe(2);
      expect(risk?.reversals).toBe(0);
      expect(risk?.reversalRate).toBe(0);
    });
  });
});

describe('RQ11-B07 (round 3): a damaged dataset is still protected', () => {
  it('refuses to overwrite an intact case when the manifest is unreadable', async () => {
    await withArea(async (created) => {
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const original = await committedCase('read-named-source-file');
      // A dataset whose case file is valid and whose manifest is not. Reporting on this
      // dataset must still be possible — that is how a person discovers the damage — so the
      // status is `unreadable` rather than a refusal. The intact case is still evidence.
      const dataset = await datasetOf(created, {
        cases: [],
        labels: [],
        name: 'damaged',
      });
      await created.write(
        'damaged/cases/read-named-source-file.json',
        original,
      );
      await created.write('damaged/manifest.json', { datasetId: 'broken' });
      const casePath = join(dataset, 'cases/read-named-source-file.json');
      const before = await readFile(casePath, 'utf8');

      const err: string[] = [];
      const code = await reportRun(
        {
          root: REPOSITORY_ROOT,
          out: () => undefined,
          err: (line) => err.push(line),
        },
        {
          directory,
          output: casePath.replace(/\.json$/u, ''),
          dataset,
          mode: 'ask',
          channel: 'available',
          force: true,
        },
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('lies inside evidence');
      expect(await readFile(casePath, 'utf8')).toBe(before);
    });
  });

  it('still reports a damaged dataset, because that is how the damage is seen', async () => {
    await withArea(async (created) => {
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const original = await committedCase('read-named-source-file');
      const dataset = await datasetOf(created, {
        cases: [],
        labels: [],
        name: 'damaged',
      });
      await created.write(
        'damaged/cases/read-named-source-file.json',
        original,
      );
      await created.write('damaged/manifest.json', { datasetId: 'broken' });
      const out: string[] = [];
      const code = await reportRun(
        {
          root: REPOSITORY_ROOT,
          out: (line) => out.push(line),
          err: () => undefined,
        },
        {
          directory,
          // The default destination inside the run directory stays allowed.
          output: null,
          dataset,
          mode: 'ask',
          channel: 'available',
          force: false,
        },
      );
      expect(code).toBe(0);
      // The damage is reported as a note rather than failing the report, and the run's own
      // evidence is still described.
      expect(out.join('\n')).toContain(
        'cells 1 planned, 1 recorded, 0 missing',
      );
    });
  });

  it('exempts an explicit "no dataset" from protection entirely', async () => {
    await withArea(async (created) => {
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const code = await reportRun(
        {
          root: REPOSITORY_ROOT,
          out: () => undefined,
          err: () => undefined,
        },
        {
          directory,
          output: join(created.path, 'elsewhere/report'),
          dataset: null,
          mode: 'ask',
          channel: 'available',
          force: false,
        },
      );
      expect(code).toBe(0);
    });
  });
});

describe('Codex review: two targets with one model are two conditions', () => {
  it('keeps both targets observations when only the settings differ', async () => {
    await withArea(async (created) => {
      const entry = await committedCase('read-named-source-file');
      const dataset = await datasetOf(created, {
        cases: ['read-named-source-file'],
        labels: [label('read-named-source-file', hashOf(entry), 1, 10)],
      });
      const directory = join(created.path, 'run');
      // One provider and one model name, two targets that differ only in temperature. The run
      // format permits this and they are separate experimental conditions, not repeats.
      await runPlan({
        directory,
        plan: planOf({
          caseIds: ['read-named-source-file'],
          protocols: ['chat'],
          targets: [
            chatTarget('cold', { temperature: 0 }),
            chatTarget('hot', { temperature: 1 }),
          ],
        }),
        fixture: fixtureOf({
          [cellIdOf({
            caseId: 'read-named-source-file',
            targetId: 'cold',
            protocol: 'chat',
          })]: fixtureCell({ chat: [chatAnswer(1, 10)] }),
          [cellIdOf({
            caseId: 'read-named-source-file',
            targetId: 'hot',
            protocol: 'chat',
          })]: fixtureCell({ chat: [chatAnswer(9, 10)] }),
        }),
      });
      const report = await buildFor(directory, dataset);
      // Both measurements survive, so the far error is counted instead of being hidden behind
      // the first target.
      expect(report.diagnostics.risk.comparable).toBe(2);
      expect(report.diagnostics.risk.exact).toBe(1);
      expect(report.diagnostics.risk.far).toBe(1);
      expect(report.diagnostics.pairs.labeled).toBe(2);
      expect(report.diagnostics.pairs.exactPair).toBe(1);
      const risk = report.diagnostics.shape.find(
        (shape) => shape.field === 'risk',
      );
      expect(risk?.observedCells).toBe(2);
    });
  });

  it('still keeps a repeat of one target out of the diagnostics', async () => {
    await withArea(async (created) => {
      const entry = await committedCase('read-named-source-file');
      const dataset = await datasetOf(created, {
        cases: ['read-named-source-file'],
        labels: [label('read-named-source-file', hashOf(entry), 1, 10)],
      });
      const directory = join(created.path, 'run');
      await runPlan({
        directory,
        plan: planOf({
          caseIds: ['read-named-source-file'],
          protocols: ['chat'],
          targets: [chatTarget()],
          repeats: 2,
        }),
        fixture: fixtureOf({
          ...Object.fromEntries(
            [1, 2].map((repeat) => [
              cellIdOf({
                caseId: 'read-named-source-file',
                targetId: 'chat-a',
                protocol: 'chat',
                repeat,
              }),
              fixtureCell({ chat: [chatAnswer(1, 10)] }),
            ]),
          ),
        }),
      });
      const report = await buildFor(directory, dataset);
      expect(report.diagnostics.risk.comparable).toBe(1);
    });
  });

  it('does not let two targets of one model invent a monotonicity reversal', async () => {
    await withArea(async (created) => {
      const low = await committedCase('read-named-source-file');
      const high = await committedCase('read-repo-index-with-cache');
      const dataset = await datasetOf(created, {
        cases: ['read-named-source-file', 'read-repo-index-with-cache'],
        labels: [
          label('read-named-source-file', hashOf(low), 2, 10),
          label('read-repo-index-with-cache', hashOf(high), 8, 10),
        ],
      });
      const directory = join(created.path, 'run');
      await runPlan({
        directory,
        plan: planOf({
          caseIds: ['read-named-source-file', 'read-repo-index-with-cache'],
          protocols: ['chat'],
          targets: [
            chatTarget('cold', { temperature: 0 }),
            chatTarget('hot', { temperature: 1 }),
          ],
        }),
        fixture: fixtureOf({
          ...Object.fromEntries([
            [
              cellIdOf({
                caseId: 'read-named-source-file',
                targetId: 'cold',
                protocol: 'chat',
              }),
              fixtureCell({ chat: [chatAnswer(1, 10)] }),
            ],
            [
              cellIdOf({
                caseId: 'read-repo-index-with-cache',
                targetId: 'cold',
                protocol: 'chat',
              }),
              fixtureCell({ chat: [chatAnswer(3, 10)] }),
            ],
            [
              cellIdOf({
                caseId: 'read-named-source-file',
                targetId: 'hot',
                protocol: 'chat',
              }),
              fixtureCell({ chat: [chatAnswer(7, 10)] }),
            ],
            [
              cellIdOf({
                caseId: 'read-repo-index-with-cache',
                targetId: 'hot',
                protocol: 'chat',
              }),
              fixtureCell({ chat: [chatAnswer(9, 10)] }),
            ],
          ]),
        }),
      });
      const report = await buildFor(directory, dataset);
      const risk = report.diagnostics.monotonicity.find(
        (entry2) => entry2.field === 'risk',
      );
      expect(risk?.comparablePairs).toBe(2);
      expect(risk?.reversals).toBe(0);
    });
  });
});

describe('Codex review: a symlinked path cannot hide an evidence collision', () => {
  it('refuses an output reached through a symlink to the run directory', async () => {
    await withArea(async (created) => {
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const alias = join(created.path, 'alias');
      const { symlink } = await import('node:fs/promises');
      await symlink(directory, alias);
      const indexPath = join(directory, 'index.json');
      const before = await readFile(indexPath, 'utf8');
      const err: string[] = [];
      // The destination is spelled through the alias; a lexical comparison would see a
      // different path and allow the write.
      const code = await reportRun(
        {
          root: REPOSITORY_ROOT,
          out: () => undefined,
          err: (line) => err.push(line),
        },
        {
          directory,
          output: join(alias, 'index'),
          dataset: null,
          mode: 'ask',
          channel: 'available',
          force: true,
        },
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('lies inside evidence');
      expect(await readFile(indexPath, 'utf8')).toBe(before);
    });
  });

  it('refuses an output inside a symlinked records directory', async () => {
    await withArea(async (created) => {
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const alias = join(created.path, 'records-alias');
      const { symlink } = await import('node:fs/promises');
      await symlink(join(directory, 'records'), alias);
      const err: string[] = [];
      const code = await reportRun(
        {
          root: REPOSITORY_ROOT,
          out: () => undefined,
          err: (line) => err.push(line),
        },
        {
          directory,
          output: join(alias, 'read-named-source-file~chat-a~chat~r1'),
          dataset: null,
          mode: 'ask',
          channel: 'available',
          force: true,
        },
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('lies inside evidence');
    });
  });

  it('still allows an ordinary destination when the run is reached through a symlink', async () => {
    await withArea(async (created) => {
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const alias = join(created.path, 'alias');
      const { symlink } = await import('node:fs/promises');
      await symlink(directory, alias);
      const code = await reportRun(
        {
          root: REPOSITORY_ROOT,
          out: () => undefined,
          err: () => undefined,
        },
        {
          directory,
          output: join(alias, 'report'),
          dataset: null,
          mode: 'ask',
          channel: 'available',
          force: false,
        },
      );
      expect(code).toBe(0);
    });
  });
});

describe('Codex review: a dangling symlink into evidence is refused', () => {
  it('rejects an output that is a dangling link into the dataset cases', async () => {
    await withArea(async (created) => {
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const original = await committedCase('read-named-source-file');
      const dataset = await datasetOf(created, {
        cases: ['read-named-source-file'],
        labels: [],
      });
      // The report's JSON document is `<prefix>.json`, so the link has to sit at that exact
      // name: a link whose target does not exist yet, pointing inside the protected cases
      // directory. `writeFile` follows it and would create the target, so the guard has to
      // refuse it even though neither spelling exists as a file.
      const link = `${join(created.path, 'injected')}.json`;
      const { symlink } = await import('node:fs/promises');
      await symlink(join(dataset, 'cases/injected-case.json'), link);
      const err: string[] = [];
      const code = await reportRun(
        {
          root: REPOSITORY_ROOT,
          out: () => undefined,
          err: (line) => err.push(line),
        },
        {
          directory,
          output: link.replace(/\.json$/u, ''),
          dataset,
          mode: 'ask',
          channel: 'available',
          force: true,
        },
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('lies inside evidence');
      // No report document was created at the link's target.
      await expect(
        readFile(join(dataset, 'cases/injected-case.json'), 'utf8'),
      ).rejects.toThrow();
      // And the case the dataset already had is untouched.
      expect(
        await readFile(
          join(dataset, 'cases/read-named-source-file.json'),
          'utf8',
        ),
      ).toBe(JSON.stringify(original, null, 2) + '\n');
    });
  });

  it('rejects a dangling link into the run records directory', async () => {
    await withArea(async (created) => {
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const link = `${join(created.path, 'records-link')}.json`;
      const { symlink } = await import('node:fs/promises');
      await symlink(join(directory, 'records/injected.json'), link);
      const err: string[] = [];
      const code = await reportRun(
        {
          root: REPOSITORY_ROOT,
          out: () => undefined,
          err: (line) => err.push(line),
        },
        {
          directory,
          output: link.replace(/\.json$/u, ''),
          dataset: null,
          mode: 'ask',
          channel: 'available',
          force: true,
        },
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('lies inside evidence');
      await expect(
        readFile(join(directory, 'records/injected.json'), 'utf8'),
      ).rejects.toThrow();
    });
  });

  it('still allows a dangling link that points outside the evidence', async () => {
    await withArea(async (created) => {
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const link = `${join(created.path, 'ordinary-report')}.json`;
      const { symlink, mkdir } = await import('node:fs/promises');
      // The link's target directory exists but the file does not: the ordinary "write a new
      // report through a link" case.
      await mkdir(join(created.path, 'targets'), { recursive: true });
      await symlink(join(created.path, 'targets/ordinary'), link);
      const err: string[] = [];
      const out: string[] = [];
      const code = await reportRun(
        {
          root: REPOSITORY_ROOT,
          out: (line) => out.push(line),
          err: (line) => err.push(line),
        },
        {
          directory,
          output: link.replace(/\.json$/u, ''),
          dataset: null,
          mode: 'ask',
          channel: 'available',
          force: false,
        },
      );
      // The guard is about evidence, not about links: a link into a scratch directory is an
      // ordinary destination and must keep working.
      expect(err.join('\n')).not.toContain('lies inside evidence');
      expect(code).toBe(0);
      // `writeFile` replaces the link rather than following it, so the document lands at the
      // destination's own name. What this test pins is the guard's decision, not the kernel's
      // link semantics.
      await expect(readFile(link, 'utf8')).resolves.toBeTruthy();
    });
  });
});

describe('Codex review: a cyclic symlink does not crash the report', () => {
  it('reports a damaged dataset whose cases directory links to itself', async () => {
    await withArea(async (created) => {
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const dataset = await datasetOf(created, {
        cases: ['read-named-source-file'],
        labels: [],
        name: 'cyclic',
      });
      // A dataset directory that points at itself. `readDataset` cannot enumerate it, so the
      // dataset reads as unreadable — a state reporting must survive, because that is how the
      // damage is discovered. The resolver must not recurse without bound while comparing the
      // protected path.
      const { symlink, rm } = await import('node:fs/promises');
      await rm(join(dataset, 'cases'), { recursive: true, force: true });
      await symlink('cases', join(dataset, 'cases'));
      const out: string[] = [];
      const err: string[] = [];
      const code = await reportRun(
        {
          root: REPOSITORY_ROOT,
          out: (line) => out.push(line),
          err: (line) => err.push(line),
        },
        {
          directory,
          // The ordinary destination inside the run directory.
          output: null,
          dataset,
          mode: 'ask',
          channel: 'available',
          force: false,
        },
      );
      expect(err.join('\n')).not.toContain('Maximum call stack');
      expect(code).toBe(0);
      expect(out.join('\n')).toContain(
        'cells 1 planned, 1 recorded, 0 missing',
      );
      // The run's own evidence is intact and the report was written beside it.
      await expect(
        readFile(join(directory, 'report.json'), 'utf8'),
      ).resolves.toBeTruthy();
    });
  });

  it('still refuses a dangling link into a cyclic dataset', async () => {
    await withArea(async (created) => {
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const dataset = await datasetOf(created, {
        cases: ['read-named-source-file'],
        labels: [],
        name: 'cyclic',
      });
      const { symlink, rm } = await import('node:fs/promises');
      await rm(join(dataset, 'cases'), { recursive: true, force: true });
      await symlink('cases', join(dataset, 'cases'));
      const link = `${join(created.path, 'injected')}.json`;
      await symlink(join(dataset, 'cases/injected.json'), link);
      const err: string[] = [];
      const code = await reportRun(
        {
          root: REPOSITORY_ROOT,
          out: () => undefined,
          err: (line) => err.push(line),
        },
        {
          directory,
          output: link.replace(/\.json$/u, ''),
          dataset,
          mode: 'ask',
          channel: 'available',
          force: true,
        },
      );
      // The dataset is unreadable, but its paths are still protected, so the guard still
      // refuses rather than crashing.
      expect(err.join('\n')).not.toContain('Maximum call stack');
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('lies inside evidence');
    });
  });
});

describe('Codex review: a long link chain cannot reach evidence unresolvable', () => {
  it('refuses a 34-link chain pointing into the dataset cases', async () => {
    await withArea(async (created) => {
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const dataset = await datasetOf(created, {
        cases: ['read-named-source-file'],
        labels: [],
      });
      const { symlink } = await import('node:fs/promises');
      // A chain longer than the traversal limit, ending inside protected evidence. The
      // operating system follows it happily, so treating the point where this module gave up
      // as proof the destination is harmless would let the write land in the dataset.
      const total = 34;
      const links = join(created.path, 'links');
      await created.dir('links');
      for (let index = 0; index < total; index += 1) {
        const next =
          index === total - 1
            ? join(dataset, 'cases/injected.json')
            : join(links, `l${String(index + 1)}.json`);
        await symlink(next, join(links, `l${String(index)}.json`));
      }
      const err: string[] = [];
      const code = await reportRun(
        {
          root: REPOSITORY_ROOT,
          out: () => undefined,
          err: (line) => err.push(line),
        },
        {
          directory,
          output: join(links, 'l0'),
          dataset,
          mode: 'ask',
          channel: 'available',
          force: true,
        },
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('lies inside evidence');
      // No document was created anywhere along the chain.
      await expect(
        readFile(join(dataset, 'cases/injected.json'), 'utf8'),
      ).rejects.toThrow();
    });
  });

  it('refuses a chain into the run records as well', async () => {
    await withArea(async (created) => {
      const directory = await runOne(created, 'read-named-source-file', 1, 10);
      const { symlink } = await import('node:fs/promises');
      const links = join(created.path, 'link-chain');
      await created.dir('link-chain');
      const total = 40;
      for (let index = 0; index < total; index += 1) {
        const next =
          index === total - 1
            ? join(directory, 'records/injected.json')
            : join(links, `l${String(index + 1)}.json`);
        await symlink(next, join(links, `l${String(index)}.json`));
      }
      const err: string[] = [];
      const code = await reportRun(
        {
          root: REPOSITORY_ROOT,
          out: () => undefined,
          err: (line) => err.push(line),
        },
        {
          directory,
          output: join(links, 'l0'),
          dataset: null,
          mode: 'ask',
          channel: 'available',
          force: true,
        },
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('lies inside evidence');
      await expect(
        readFile(join(directory, 'records/injected.json'), 'utf8'),
      ).rejects.toThrow();
    });
  });
});
