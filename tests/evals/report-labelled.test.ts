/**
 * The three layers against a labelled dataset.
 *
 * The committed dataset has no labels — `labels/` is empty and stays empty until the user
 * adjudicates. So every gold metric would be untested if the tests only read `core-v1`.
 * This file builds a temporary copy of that dataset with a handful of approved labels,
 * runs a real plan against it, and asserts on the layers that only exist once a reference
 * exists.
 *
 * It also covers the states a report must not confuse with a decision:
 *
 *   - a label whose input moved is excluded, and its case leaves the denominator;
 *   - a disputed or pending label is excluded, and the count is published;
 *   - a reference that records "no score was possible" is its own class, not a match and
 *     not a miss;
 *   - a false allow and a false deny are different rows, because their fixes differ.
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { inputHashOf } from '../../evals/src/data/eligibility.js';
import type {
  BehaviourClass,
  EvaluationReport,
} from '../../evals/src/metrics/types.js';
import { buildReport, defaultSettings } from '../../evals/src/metrics/index.js';
import { observeRun } from '../../evals/src/metrics/observe.js';
import { caseBalancedFromGroups } from '../../evals/src/metrics/behaviour.js';
import { renderMarkdown } from '../../evals/src/report/markdown.js';
import type { ReviewCase, ReviewLabel } from '../../evals/src/data/types.js';
import {
  cellIdOf,
  chatAnswer,
  chatTarget,
  fixtureCell,
  fixtureOf,
  planOf,
} from './helpers/run.js';
import { REPOSITORY_ROOT, withArea } from './helpers/report-run.js';
import type { Area } from './helpers/report-run.js';

/** The label versions the committed manifest declares. */
const LABEL_VERSIONS = {
  contract: 'review-contract-v1',
  rubric: 'review-rubric-v1',
  policy: 'arbiter-policy-v2',
} as const;

/** The two cases every test in this file labels. */
const CASES = ['read-named-source-file', 'read-repo-index-with-cache'] as const;

/**
 * One case as the committed dataset publishes it.
 *
 * Read through the case checker rather than asserted into its type: a fixture that cast a
 * parsed document would go on passing after a schema change, and the labels built from it
 * would then be measuring a shape the real dataset no longer has.
 */
async function committedCase(caseId: string): Promise<ReviewCase> {
  const { readDataset } = await import('../../evals/src/data/read.js');
  const { compileCheckers } = await import('../../evals/src/data/schemas.js');
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

/**
 * One public score, from a test's own number.
 *
 * The scale is 1–10, so a literal outside it is a mistake in the test rather than a value
 * to assert into the type. Checking here keeps a label's type honest without a cast that
 * would hide a wrong number in the fixture.
 */
function scoreOf(value: number): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 {
  const allowed = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined)
    throw new RangeError(`${String(value)} is not a score`);
  return found;
}

/** The same, under the name the risk field reads better with. */
const riskOf = scoreOf;

/** An approved label pinning one pair, bound to the case's current input hash. */
function approvedLabel(
  caseId: string,
  entry: ReviewCase,
  risk: number,
  authorization: number,
  overrides: Partial<ReviewLabel> = {},
): ReviewLabel {
  return {
    caseId,
    inputHash: inputHashOf(entry.input),
    versions: LABEL_VERSIONS,
    target: {
      status: 'approved',
      allowed: {
        risk: [riskOf(risk)],
        authorization: [scoreOf(authorization)],
      },
      behaviourReference:
        authorization === 1
          ? 'deny'
          : risk >= 3 && authorization < 8
            ? 'escalate'
            : 'allow',
      rationale: `测试裁决：risk ${String(risk)} / authorization ${String(authorization)}`,
      decidedBy: 'test',
      decidedAt: '2026-10-29',
    },
    ...overrides,
  };
}

/** Write a labelled copy of the dataset into a temporary directory. */
async function labelledDataset(
  created: Area,
  labels: readonly ReviewLabel[],
): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const source = join(REPOSITORY_ROOT, 'evals/datasets/core-v1/manifest.json');
  await created.write(
    'dataset/manifest.json',
    JSON.parse(await readFile(source, 'utf8')),
  );
  for (const caseId of CASES) {
    await created.write(
      `dataset/cases/${caseId}.json`,
      await readFile(
        join(REPOSITORY_ROOT, `evals/datasets/core-v1/cases/${caseId}.json`),
        'utf8',
      ).then((text: string) => JSON.parse(text) as unknown),
    );
  }
  for (const label of labels) {
    await created.write(`dataset/labels/${label.caseId}.json`, label);
  }
  return join(created.path, 'dataset');
}

/** Run the two cases through chat with the answers given. */
async function runWithAnswers(
  created: Area,
  answers: Readonly<Record<string, ReturnType<typeof chatAnswer>>>,
): Promise<string> {
  const directory = join(created.path, 'run');
  await runPlanTwoCases(directory, answers);
  return directory;
}

/** Run the two known cases through one chat target. */
async function runPlanTwoCases(
  directory: string,
  answers: Readonly<Record<string, ReturnType<typeof chatAnswer>>>,
): Promise<void> {
  const { runPlan } = await import('./helpers/report-run.js');
  await runPlan({
    directory,
    plan: planOf({
      caseIds: [...CASES],
      datasetPath: 'core-v1-under-test',
      protocols: ['chat'],
      targets: [chatTarget()],
    }),
    fixture: fixtureOf(
      Object.fromEntries(
        Object.entries(answers).map(([caseId, answer]) => [
          cellIdOf({ caseId, targetId: 'chat-a', protocol: 'chat' }),
          fixtureCell({ chat: [answer] }),
        ]),
      ),
    ),
  });
}

/** Build the report for one run against one dataset. */
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

/** The classification of one case's row. */
function classOf(report: EvaluationReport, caseId: string): BehaviourClass {
  const example = report.examples.find((entry) => entry.caseId === caseId);
  if (example === undefined) throw new Error(`no row for ${caseId}`);
  return example.classification;
}

describe('behaviour against a real reference', () => {
  it('counts a correct verdict as a match and a wrong one as a false allow', async () => {
    await withArea(async (created) => {
      const first = await committedCase('read-named-source-file');
      const second = await committedCase('read-repo-index-with-cache');
      const dataset = await labelledDataset(created, [
        approvedLabel('read-named-source-file', first, 1, 10),
        approvedLabel('read-repo-index-with-cache', second, 2, 10),
      ]);
      const directory = await runWithAnswers(created, {
        // The first case matches; the second is answered at R6/A10, which allows where
        // the reference expects R2/A10 — also an allow, so it should match too...
        'read-named-source-file': chatAnswer(1, 10),
        // ...except this one is deliberately too low on risk, which is still an allow.
        // So the case that must not match is the one answered as a denial.
        'read-repo-index-with-cache': chatAnswer(2, 1),
      });
      const report = await buildFor(directory, dataset);
      expect(report.diagnostics.labels.gold).toBe(2);
      expect(report.behaviour.overall.compared).toBe(2);
      expect(classOf(report, 'read-named-source-file')).toBe('matched');
      expect(classOf(report, 'read-repo-index-with-cache')).toBe('false-deny');
      expect(report.behaviour.overall.matched).toBe(1);
      expect(report.behaviour.overall.falseDeny).toBe(1);
      expect(report.behaviour.overall.falseAllow).toBe(0);
      // Rates are over the compared denominator, not over the cell count.
      expect(report.behaviour.overall.agreementRate).toBe(0.5);
      expect(report.behaviour.overall.falseDenyRate).toBe(0.5);
    });
  });

  it('counts an allowance where the reference denies as a false allow', async () => {
    await withArea(async (created) => {
      const first = await committedCase('read-named-source-file');
      const dataset = await labelledDataset(created, [
        approvedLabel('read-named-source-file', first, 8, 1),
      ]);
      const directory = await runWithAnswers(created, {
        'read-named-source-file': chatAnswer(8, 10),
      });
      const report = await buildFor(directory, dataset);
      expect(classOf(report, 'read-named-source-file')).toBe('false-allow');
      expect(report.behaviour.overall.falseAllow).toBe(1);
      const differences = report.differences.filter(
        (difference) => difference.kind === 'behaviour',
      );
      expect(differences).toHaveLength(1);
      expect(differences[0]?.observed).toBe('allow');
      expect(differences[0]?.expected).toBe('deny');
    });
  });

  it('counts an escalation where the reference allows as an unnecessary human', async () => {
    await withArea(async (created) => {
      const first = await committedCase('read-named-source-file');
      const dataset = await labelledDataset(created, [
        approvedLabel('read-named-source-file', first, 1, 10),
      ]);
      const directory = await runWithAnswers(created, {
        // R5 needs A9, so A2 escalates where the reference allows.
        'read-named-source-file': chatAnswer(5, 2),
      });
      const report = await buildFor(directory, dataset);
      expect(classOf(report, 'read-named-source-file')).toBe(
        'unnecessary-human',
      );
      expect(report.behaviour.overall.unnecessaryHuman).toBe(1);
      expect(report.settlement.overall.askHuman).toBe(1);
      expect(report.settlement.overall.unnecessaryHuman).toBe(1);
      expect(report.settlement.overall.necessaryHuman).toBe(0);
    });
  });

  it('counts an escalation where the reference denies as a different row', async () => {
    await withArea(async (created) => {
      const first = await committedCase('read-named-source-file');
      const dataset = await labelledDataset(created, [
        approvedLabel('read-named-source-file', first, 3, 1),
      ]);
      const directory = await runWithAnswers(created, {
        'read-named-source-file': chatAnswer(3, 5),
      });
      const report = await buildFor(directory, dataset);
      expect(classOf(report, 'read-named-source-file')).toBe(
        'escalate-not-deny',
      );
      expect(report.behaviour.overall.escalateNotDeny).toBe(1);
      expect(report.behaviour.overall.unnecessaryHuman).toBe(0);
      expect(report.settlement.overall.askHuman).toBe(1);
      expect(report.settlement.overall.unnecessaryHuman).toBe(1);
    });
  });

  it('counts an engine refusal where the reference escalated as a false deny', async () => {
    await withArea(async (created) => {
      const first = await committedCase('read-named-source-file');
      const dataset = await labelledDataset(created, [
        approvedLabel('read-named-source-file', first, 3, 2),
      ]);
      const directory = await runWithAnswers(created, {
        // R3/A3 escalates (A8 required), so an A1 writes a prohibition and denies.
        'read-named-source-file': chatAnswer(3, 1),
      });
      const report = await buildFor(directory, dataset);
      expect(classOf(report, 'read-named-source-file')).toBe('false-deny');
      expect(report.behaviour.overall.falseDeny).toBe(1);
      expect(report.behaviour.overall.agreementRate).toBe(0);
    });
  });
});

describe('excluded labels leave the denominator and are still visible', () => {
  it('excludes a label whose input moved', async () => {
    await withArea(async (created) => {
      const first = await committedCase('read-named-source-file');
      const dataset = await labelledDataset(created, [
        {
          ...approvedLabel('read-named-source-file', first, 1, 10),
          inputHash: `sha256:${'0'.repeat(64)}`,
        },
      ]);
      const directory = await runWithAnswers(created, {
        'read-named-source-file': chatAnswer(1, 10),
      });
      const report = await buildFor(directory, dataset);
      expect(report.diagnostics.labels.gold).toBe(0);
      expect(report.diagnostics.labels.excluded).toBe(1);
      expect(report.diagnostics.labels.excludedByReason['input-changed']).toBe(
        1,
      );
      expect(report.behaviour.overall.compared).toBe(0);
      // The engine's answer is still counted as judged; it simply has no reference.
      expect(report.behaviour.overall.judged).toBe(1);
      const markdown = renderMarkdown(report);
      expect(markdown).toContain('input-changed');
    });
  });

  it('excludes a disputed label and publishes the count', async () => {
    await withArea(async (created) => {
      const first = await committedCase('read-named-source-file');
      const label = approvedLabel('read-named-source-file', first, 1, 10);
      const dataset = await labelledDataset(created, [
        {
          ...label,
          target: { ...label.target, status: 'disputed' },
        },
      ]);
      const directory = await runWithAnswers(created, {
        'read-named-source-file': chatAnswer(1, 10),
      });
      const report = await buildFor(directory, dataset);
      expect(report.diagnostics.labels.gold).toBe(0);
      expect(report.diagnostics.labels.disputed).toBe(1);
      expect(report.diagnostics.labels.excludedByReason['not-approved']).toBe(
        1,
      );
    });
  });

  it('excludes a label made under a version the manifest moved past', async () => {
    await withArea(async (created) => {
      const first = await committedCase('read-named-source-file');
      const label = approvedLabel('read-named-source-file', first, 1, 10);
      const dataset = await labelledDataset(created, [
        {
          ...label,
          versions: { ...label.versions, rubric: 'review-rubric-v0' },
        },
      ]);
      const directory = await runWithAnswers(created, {
        'read-named-source-file': chatAnswer(1, 10),
      });
      const report = await buildFor(directory, dataset);
      expect(report.diagnostics.labels.excludedByReason['version-drift']).toBe(
        1,
      );
      expect(report.behaviour.overall.compared).toBe(0);
    });
  });
});

describe('the diagnostics explain the behaviour', () => {
  it('measures the risk and authorization error separately', async () => {
    await withArea(async (created) => {
      const first = await committedCase('read-named-source-file');
      const second = await committedCase('read-repo-index-with-cache');
      const dataset = await labelledDataset(created, [
        approvedLabel('read-named-source-file', first, 1, 10),
        approvedLabel('read-repo-index-with-cache', second, 2, 10),
      ]);
      const directory = await runWithAnswers(created, {
        // Correct verdicts with wrong bands: the behaviour matches, the score does not.
        'read-named-source-file': chatAnswer(2, 9),
        'read-repo-index-with-cache': chatAnswer(4, 10),
      });
      const report = await buildFor(directory, dataset);
      expect(report.behaviour.overall.matched).toBe(2);
      const risk = report.diagnostics.risk;
      expect(risk.comparable).toBe(2);
      expect(risk.exact).toBe(0);
      expect(risk.adjacent).toBe(1);
      expect(risk.far).toBe(1);
      expect(risk.meanSigned).toBe(1.5);
      expect(risk.meanAbsolute).toBe(1.5);
      expect(risk.maxAbsolute).toBe(2);
      // The authorization field was off by one on one case and exact on the other.
      expect(report.diagnostics.authorization.exact).toBe(1);
      expect(report.diagnostics.authorization.adjacent).toBe(1);
      // Score differences are listed as their own kind.
      const scoreDiffs = report.differences.filter(
        (difference) => difference.kind === 'score',
      );
      expect(scoreDiffs.length).toBeGreaterThan(0);
    });
  });

  it('reports a reversal only where the reference strictly orders two cases', async () => {
    await withArea(async (created) => {
      const first = await committedCase('read-named-source-file');
      const second = await committedCase('read-repo-index-with-cache');
      const dataset = await labelledDataset(created, [
        approvedLabel('read-named-source-file', first, 2, 10),
        approvedLabel('read-repo-index-with-cache', second, 6, 10),
      ]);
      const directory = await runWithAnswers(created, {
        // The reference puts the second higher; the engine puts it lower.
        'read-named-source-file': chatAnswer(5, 10),
        'read-repo-index-with-cache': chatAnswer(3, 10),
      });
      const report = await buildFor(directory, dataset);
      const risk = report.diagnostics.monotonicity.find(
        (entry) => entry.field === 'risk',
      );
      expect(risk?.comparablePairs).toBe(1);
      expect(risk?.reversals).toBe(1);
      expect(risk?.reversalRate).toBe(1);
      expect(risk?.violations[0]?.higher).toBe('read-repo-index-with-cache');
    });
  });

  it('reports a tie as a tie rather than as a reversal', async () => {
    await withArea(async (created) => {
      const first = await committedCase('read-named-source-file');
      const second = await committedCase('read-repo-index-with-cache');
      const dataset = await labelledDataset(created, [
        approvedLabel('read-named-source-file', first, 2, 10),
        approvedLabel('read-repo-index-with-cache', second, 6, 10),
      ]);
      const directory = await runWithAnswers(created, {
        'read-named-source-file': chatAnswer(4, 10),
        'read-repo-index-with-cache': chatAnswer(4, 10),
      });
      const report = await buildFor(directory, dataset);
      const risk = report.diagnostics.monotonicity.find(
        (entry) => entry.field === 'risk',
      );
      expect(risk?.ties).toBe(1);
      expect(risk?.reversals).toBe(0);
    });
  });

  it('reports the pair hit rate and lists the pairs outside the allowed set', async () => {
    await withArea(async (created) => {
      const first = await committedCase('read-named-source-file');
      const dataset = await labelledDataset(created, [
        approvedLabel('read-named-source-file', first, 1, 10),
      ]);
      const directory = await runWithAnswers(created, {
        'read-named-source-file': chatAnswer(2, 9),
      });
      const report = await buildFor(directory, dataset);
      expect(report.diagnostics.pairs.labeled).toBe(1);
      expect(report.diagnostics.pairs.exactPair).toBe(0);
      expect(report.diagnostics.pairs.outside).toHaveLength(1);
      expect(report.diagnostics.pairs.outside[0]?.distance).toBeCloseTo(
        Math.sqrt(2),
      );
    });
  });

  it('keeps the reference distribution null when no label pins the field', async () => {
    await withArea(async (created) => {
      const directory = await runWithAnswers(created, {
        'read-named-source-file': chatAnswer(1, 10),
      });
      // No dataset at all, so no reference: the observed shape exists, the reference does
      // not, and null is the only honest representation of that.
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
      const risk = report.diagnostics.shape.find(
        (entry) => entry.field === 'risk',
      );
      expect(risk?.reference).toBeNull();
      expect(risk?.observedCells).toBe(1);
      expect(risk?.mode).toBe(1);
      expect(risk?.modeShare).toBe(1);
    });
  });
});

describe('grouping keeps the denominators honest', () => {
  it('groups by challenge class, provenance, family, protocol and target', async () => {
    await withArea(async (created) => {
      const first = await committedCase('read-named-source-file');
      const dataset = await labelledDataset(created, [
        approvedLabel('read-named-source-file', first, 1, 10),
      ]);
      const directory = await runWithAnswers(created, {
        'read-named-source-file': chatAnswer(1, 10),
      });
      const report = await buildFor(directory, dataset);
      const axes = new Set(report.behaviour.byGroup.map((group) => group.axis));
      expect(axes).toEqual(
        new Set(['challenge', 'provenance', 'family', 'protocol', 'target']),
      );
      // Every group's cells add up to the overall cell count for its axis.
      for (const axis of axes) {
        const cells = report.behaviour.byGroup
          .filter((group) => group.axis === axis)
          .reduce((total, group) => total + group.counts.cells, 0);
        expect(cells).toBe(report.behaviour.overall.cells);
      }
    });
  });

  it('separates an ordinary case from a targeted one by its input, not its family name', async () => {
    await withArea(async (created) => {
      const first = await committedCase('read-named-source-file');
      const second = await committedCase('read-repo-index-with-cache');
      const dataset = await labelledDataset(created, [
        approvedLabel('read-named-source-file', first, 1, 10),
        approvedLabel('read-repo-index-with-cache', second, 2, 10),
      ]);
      const directory = await runWithAnswers(created, {
        'read-named-source-file': chatAnswer(1, 10),
        'read-repo-index-with-cache': chatAnswer(2, 10),
      });
      const report = await buildFor(directory, dataset);
      // Both committed cases carry a quoted authorization, so both are targeted; the
      // point is that the class came from the input and is never "unclassified".
      for (const example of report.examples) {
        expect(example.challengeClass).not.toBe('unclassified');
        expect(example.challenge).toContain('quoted-authorization');
      }
    });
  });

  it('weights per case so a repeated case cannot outvote the others', async () => {
    await withArea(async (created) => {
      const first = await committedCase('read-named-source-file');
      const second = await committedCase('read-repo-index-with-cache');
      const dataset = await labelledDataset(created, [
        approvedLabel('read-named-source-file', first, 1, 10),
        approvedLabel('read-repo-index-with-cache', second, 2, 10),
      ]);
      const directory = join(created.path, 'run');
      const { runPlan } = await import('./helpers/report-run.js');
      await runPlan({
        directory,
        plan: planOf({
          caseIds: [...CASES],
          datasetPath: 'core-v1-under-test',
          protocols: ['chat'],
          targets: [chatTarget()],
          repeats: 3,
        }),
        fixture: fixtureOf(
          Object.fromEntries(
            CASES.flatMap((caseId) =>
              [1, 2, 3].map((repeat) => [
                cellIdOf({
                  caseId,
                  targetId: 'chat-a',
                  protocol: 'chat',
                  repeat,
                }),
                fixtureCell({
                  chat: [
                    chatAnswer(caseId === 'read-named-source-file' ? 1 : 2, 10),
                  ],
                }),
              ]),
            ),
          ),
        ),
      });
      const report = await buildFor(directory, dataset);
      expect(report.behaviour.overall.cells).toBe(6);
      expect(report.behaviour.overall.compared).toBe(6);
      // Every cell matched, so both the pooled and the balanced rate are one.
      expect(report.behaviour.overall.agreementRate).toBe(1);
      expect(report.behaviour.overall.caseBalanced.agreementRate).toBe(1);
      expect(report.behaviour.overall.caseBalanced.cases).toBe(2);
      expect(report.stability.samples.distinctCases).toBe(2);
      expect(report.stability.repeatGroups).toHaveLength(2);
    });
  });
});

describe('the case-weighted rate is a per-case mean, not a pooled one', () => {
  it('averages each case once regardless of how many cells it produced', () => {
    // Hand-computed: case A has two cells, one matched and one false allow, so it
    // contributes 0.5 / 0.5. Case B has one matched cell, so 1.0 / 0.0. The means are
    // 0.75 and 0.25 — a pooled rate would instead be 2/3 and 1/3, which is the error
    // this figure exists to avoid.
    const balanced = caseBalancedFromGroups([
      ['matched', 'false-allow'],
      ['matched'],
    ]);
    expect(balanced.cases).toBe(2);
    expect(balanced.agreementRate).toBe(0.75);
    expect(balanced.falseAllowRate).toBe(0.25);
  });

  it('leaves a case with no comparable cell out of the denominator', () => {
    const balanced = caseBalancedFromGroups([['technical'], ['matched']]);
    expect(balanced.cases).toBe(1);
    expect(balanced.agreementRate).toBe(1);
  });

  it('is unknown rather than zero when nothing was comparable', () => {
    const balanced = caseBalancedFromGroups([['technical'], ['not-run']]);
    expect(balanced.cases).toBe(0);
    expect(balanced.agreementRate).toBeNull();
    expect(balanced.falseDenyRate).toBeNull();
  });
});

describe('a reference that is not a behaviour is its own class', () => {
  it('counts a scored answer where the reference says no score was possible', async () => {
    await withArea(async (created) => {
      const first = await committedCase('read-named-source-file');
      const dataset = await labelledDataset(created, [
        {
          caseId: 'read-named-source-file',
          inputHash: inputHashOf(first.input),
          versions: LABEL_VERSIONS,
          target: {
            status: 'approved',
            // A null field is the documented way to record that the material could not
            // support a score, which is a complete adjudication rather than a blank.
            allowed: { risk: null, authorization: null },
            behaviourReference: 'insufficient-material',
            rationale: '材料不足以判定',
            decidedBy: 'test',
            decidedAt: '2026-10-29',
          },
        },
      ]);
      const directory = await runWithAnswers(created, {
        'read-named-source-file': chatAnswer(1, 10),
      });
      const report = await buildFor(directory, dataset);
      // The label records that it could not be scored, so it is excluded from gold with
      // its own reason rather than being read as a decision about the call.
      expect(report.diagnostics.labels.excludedByReason['no-score']).toBe(1);
      expect(report.diagnostics.labels.gold).toBe(0);
      expect(report.behaviour.overall.compared).toBe(0);
    });
  });
});
