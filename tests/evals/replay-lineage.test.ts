/**
 * The reference labels a replay must not touch, and the lineage it must publish.
 *
 * Two separate guarantees, and both are about what a reader is allowed to conclude:
 *
 *   1. **labels do not move.** A replay produces "what would have happened under
 *      another rule", not a new adjudication. So the derived report is measured
 *      against the *same* human reference as the original, `labels/` is byte-identical
 *      afterwards, and a threshold change that moves the engine's band moves it under
 *      the label rather than the label under it.
 *   2. **the derivation is traceable.** A derived run names its source run, the source
 *      documents by digest, the axis values and the contract that re-derived them. A
 *      reader who has the lineage can tell which rule produced which number, and can
 *      check that the source has not changed since.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { inputHashOf } from '../../evals/src/data/eligibility.js';
import type { ReviewLabel } from '../../evals/src/data/types.js';
import {
  defaultSettings,
  reportForRun,
} from '../../evals/src/metrics/index.js';
import type { EvaluationReport } from '../../evals/src/metrics/types.js';
import { REPLAY_FILES } from '../../evals/src/replay/write.js';

import { readDocument, schemas } from './helpers/documents.js';
import { REPOSITORY_ROOT, withArea } from './helpers/report-run.js';
import type { Area } from './helpers/report-run.js';
import {
  decisionCellOf,
  decisionForCase,
  decisionRun,
  digestOf,
  inventory,
  at,
  listTextAt,
  objectAt,
  objectsAt,
  readJson,
  replay,
  textAt,
} from './helpers/replay.js';
import { runPlan } from './helpers/report-run.js';
import { fixtureCell, fixtureOf, planOf } from './helpers/run.js';
import { decisionTarget } from './helpers/run.js';

/** The case the labelled tests use. */
const CASE = 'read-named-source-file';

/** The cell id one decision case produces. */
const CELL = decisionCellOf(CASE);

/** The label versions the committed manifest declares. */
const LABEL_VERSIONS = {
  contract: 'review-contract-v1',
  rubric: 'review-rubric-v1',
  policy: 'arbiter-policy-v2',
} as const;

/** One public score, from a test's own number. */
function scoreOf(value: number): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 {
  const allowed = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new RangeError(`${String(value)} is not a score`);
  }
  return found;
}

/**
 * A labelled copy of the committed dataset, with one approved label.
 *
 * Built by copying the case and manifest rather than by editing the committed
 * dataset: a test that wrote into `evals/datasets/` would be modifying evidence that
 * other tests read, and the "labels did not move" assertion below needs a copy that
 * belongs to this test.
 */
async function labelledDataset(
  created: Area,
  label: ReviewLabel,
): Promise<string> {
  await created.write(
    'dataset/manifest.json',
    JSON.parse(
      await readFile(
        join(REPOSITORY_ROOT, 'evals/datasets/core-v1/manifest.json'),
        'utf8',
      ),
    ) as unknown,
  );
  await created.write(
    `dataset/cases/${CASE}.json`,
    JSON.parse(
      await readFile(
        join(REPOSITORY_ROOT, `evals/datasets/core-v1/cases/${CASE}.json`),
        'utf8',
      ),
    ) as unknown,
  );
  await created.write(`dataset/labels/${label.caseId}.json`, label);
  return join(created.path, 'dataset');
}

/** An approved label pinning one pair, bound to the case's current input hash. */
async function approvedLabel(
  risk: number,
  authorization: number,
  behaviourReference: ReviewLabel['target']['behaviourReference'],
): Promise<ReviewLabel> {
  // Read through the case checker, so the input hash is taken from the document the real
  // loader accepts rather than from a shape a test assumed.
  const entry = await readDocument(
    join(REPOSITORY_ROOT, `evals/datasets/core-v1/cases/${CASE}.json`),
    schemas.case,
  );
  return {
    caseId: CASE,
    inputHash: inputHashOf(entry.input),
    versions: LABEL_VERSIONS,
    target: {
      status: 'approved',
      allowed: {
        risk: [scoreOf(risk)],
        authorization: [scoreOf(authorization)],
      },
      behaviourReference,
      rationale: `测试裁决：risk ${String(risk)} / authorization ${String(authorization)}`,
      decidedBy: 'test',
      decidedAt: '2026-10-30',
    },
  };
}

/** A decision run against one dataset path, with one scripted answer. */
async function runAgainst(
  directory: string,
  datasetPath: string,
  risk: Readonly<Record<string, number>>,
  authorization: Readonly<Record<string, number>>,
): Promise<string> {
  return runPlan({
    directory,
    plan: planOf({
      caseIds: [CASE],
      datasetPath,
      protocols: ['decision'],
      targets: [decisionTarget()],
    }),
    fixture: fixtureOf({
      [CELL]: fixtureCell({
        decision: [decisionForCase(risk, authorization)],
      }),
    }),
  });
}

/** A report, rebuilt from the directory it describes. */
async function reportOf(directory: string): Promise<EvaluationReport> {
  const read = await reportForRun({
    directory,
    settings: defaultSettings(REPOSITORY_ROOT),
  });
  if (!read.ok) throw new Error(read.problems.join('; '));
  return read.report;
}

describe('the reference labels are not changed by a replay', () => {
  it('leaves the dataset byte-identical and compares against the same label', async () => {
    await withArea(async (created) => {
      const label = await approvedLabel(5, 8, 'escalate');
      const dataset = await labelledDataset(created, label);
      const directory = await runAgainst(
        join(created.path, 'run'),
        dataset,
        { '3': 0.5, '4': 0.5 },
        { '7': 0.5, '8': 0.5 },
      );
      const before = await inventory(dataset);
      const result = await replay({
        directory,
        output: join(created.path, 'derived'),
        thresholdRisk: 'at-least',
      });
      expect(result.code).toBe(0);
      expect(await inventory(dataset)).toEqual(before);
      const report = await reportOf(
        join(created.path, 'derived/text-at-least-at-least-ask-available'),
      );
      // The same reference, read from the same file, and still gold.
      expect(report.diagnostics.labels.gold).toBe(1);
      expect(report.diagnostics.labels.rows[0]?.reference).toBe('escalate');
      expect(report.diagnostics.labels.rows[0]?.decidedBy).toBe('test');
      expect(report.diagnostics.labels.rows[0]?.rationale).toBe(
        label.target.rationale,
      );
    });
  });

  it('moves the engine answer under the label instead of editing the label', async () => {
    await withArea(async (created) => {
      // The reference asks for an escalation. The stored answer reaches it; the
      // replay's lower risk band allows the call, which is a false allow against the
      // *same* reference. If the replay had written a label of its own, the derived
      // report would count a match instead.
      const label = await approvedLabel(5, 8, 'escalate');
      const dataset = await labelledDataset(created, label);
      const directory = await runAgainst(
        join(created.path, 'run'),
        dataset,
        { '3': 0.5, '4': 0.5 },
        { '7': 0.5, '8': 0.5 },
      );
      await replay({
        directory,
        output: join(created.path, 'derived'),
        thresholdRisk: 'at-least',
      });
      const report = await reportOf(
        join(created.path, 'derived/text-at-least-at-least-ask-available'),
      );
      expect(report.examples[0]?.labelStatus).toBe('gold');
      expect(report.examples[0]?.classification).toBe('false-allow');
      expect(report.behaviour.overall.matched).toBe(0);
      expect(report.behaviour.overall.falseAllow).toBe(1);
      // The diff names the reference, and the reference is the user's decision.
      const behaviour = report.differences.filter(
        (difference) => difference.kind === 'behaviour',
      );
      expect(behaviour[0]?.expected).toBe('escalate');
      expect(behaviour[0]?.observed).toBe('allow');
    });
  });
});

describe('the derivation is traceable to its source', () => {
  it('names the source run, its documents and the axis values it used', async () => {
    await withArea(async (created) => {
      const directory = await decisionRun(join(created.path, 'run'), {
        [CELL]: decisionForCase({ '4': 0.6, '5': 0.4 }, { '7': 0.6, '8': 0.4 }),
      });
      await replay({
        directory,
        output: join(created.path, 'derived'),
        thresholdAuthorization: 'strict',
        mode: 'no-ask',
      });
      const lineage = await readJson(
        join(
          created.path,
          'derived/text-strict-strict-no-ask-available',
          REPLAY_FILES.lineage,
        ),
      );
      expect(textAt(lineage, 'documentVersion')).toBe('eval-replay-lineage-v1');
      expect(textAt(lineage, 'replay.implementation')).toBe('eval-replayer-v1');
      expect(objectAt(lineage, 'replay.thresholds')).toEqual({
        risk: 'strict',
        authorization: 'strict',
      });
      expect(objectAt(lineage, 'replay.settlement')).toEqual({
        mode: 'no-ask',
        channel: 'available',
      });
      // The matrix is a recorded fact, not an axis: a replay never varies it.
      expect(textAt(lineage, 'replay.matrix')).toBe('shared');
      expect(textAt(lineage, 'replay.contract')).toBe('review-contract-v1');
      expect(textAt(lineage, 'replay.digest')).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(textAt(lineage, 'source.runId')).toBe('report-run');
      expect(textAt(lineage, 'source.planHash')).toMatch(/^sha256:/);
      expect(textAt(lineage, 'source.dataset.datasetId')).toBe('core-v1');
      // Every document the replay read, at the digest it read it at.
      expect(
        objectsAt(lineage, 'source.files').map((file) => textAt(file, 'path')),
      ).toEqual(['index.json', 'plan.json', `records/${CELL}.json`]);
      expect(at(lineage, 'derived.report')).toEqual([
        'report.json',
        'report.md',
        'report.html',
      ]);
      const cell = objectsAt(lineage, 'cells')[0];
      if (cell === undefined) throw new Error('the lineage has no cell row');
      expect(textAt(cell, 'cellId')).toBe(CELL);
      expect(textAt(cell, 'attemptId')).toBe(`${CELL}:model:1`);
      expect(textAt(cell, 'responseDigest')).toMatch(/^sha256:/);
      expect(textAt(cell, 'record.path')).toBe(`records/${CELL}.json`);
      expect(textAt(cell, 'record.digest')).toMatch(/^sha256:/);
      // The stored and derived facts sit beside each other, so a reader can see what
      // moved without re-running anything.
      expect(objectAt(cell, 'stored')).toMatchObject({ risk: 5 });
      expect(objectAt(cell, 'derived')).toMatchObject({ risk: 5 });
      expect(at(cell, 'changed')).toBe(false);
    });
  });

  it('matches the digest of the file it names', async () => {
    await withArea(async (created) => {
      const directory = await decisionRun(join(created.path, 'run'), {
        [CELL]: decisionForCase({ '4': 0.9, '5': 0.1 }, { '8': 0.9, '9': 0.1 }),
      });
      await replay({ directory, output: join(created.path, 'derived') });
      const derived = join(
        created.path,
        'derived/text-strict-at-least-ask-available',
      );
      const lineage = await readJson(join(derived, REPLAY_FILES.lineage));
      const record = objectsAt(lineage, 'source.files').find(
        (file) => textAt(file, 'path') === `records/${CELL}.json`,
      );
      expect(record === undefined ? null : textAt(record, 'digest')).toBe(
        await digestOf(join(directory, 'records', `${CELL}.json`)),
      );
    });
  });

  it('records the contract it re-derived under, and flags a source from another era', async () => {
    await withArea(async (created) => {
      const directory = await decisionRun(join(created.path, 'run'), {
        [CELL]: decisionForCase({ '4': 0.9, '5': 0.1 }, { '8': 0.9, '9': 0.1 }),
      });
      // A source written under another contract is a legitimate input — the answers are
      // still there — but the derived numbers describe today's reading of them, which is
      // a different claim from reproducing the original.
      const index = await readJson(join(directory, 'index.json'));
      const before = await inventory(directory);
      // Written through the same round trip the tool writes with, so the edit changes
      // the contract and nothing else.
      await created.write('run/index.json', {
        ...index,
        versions: {
          ...objectAt(index, 'versions'),
          contract: 'review-contract-v0',
        },
      });
      expect(await inventory(directory)).not.toEqual(before);
      await replay({ directory, output: join(created.path, 'derived') });
      const lineage = await readJson(
        join(
          created.path,
          'derived/text-strict-at-least-ask-available',
          REPLAY_FILES.lineage,
        ),
      );
      expect(textAt(lineage, 'source.versions.contract')).toBe(
        'review-contract-v0',
      );
      expect(textAt(lineage, 'replay.contract')).toBe('review-contract-v1');
      expect(listTextAt(lineage, 'notes').join('\n')).toContain(
        'review-contract-v0',
      );
    });
  });
});
