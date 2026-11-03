import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRun } from '../../evals/src/run/artifact.js';
import { cellGrid } from '../../evals/src/run/grid.js';
import { compileRunCheckers } from '../../evals/src/run/schemas.js';
import type { RunPlan } from '../../evals/src/run/types.js';
import { collectionOf } from '../evals/fixtures/workflow.js';
import { withWorkflowArea } from '../evals/helpers/workflow-run.js';
import {
  compared,
  savedRun,
  syntheticReferences,
} from '../evals/helpers/version-comparison.js';
import {
  decisionAnswer,
  fixtureCell,
  fixtureOf,
} from '../evals/helpers/run.js';

describe('comparison denominators and coverage', { timeout: 60_000 }, () => {
  it.each(['group', 'lineage', 'split'] as const)(
    'keeps different %s identities separate despite equal point IDs and input',
    async (axis) => {
      await withWorkflowArea(async (area) => {
        if (area.plan.workflow === undefined)
          throw new Error('workflow required');
        const baseline = await savedRun(area, 'baseline');
        const oldRefs = await syntheticReferences(area, 'old', area.plan);
        const dataset = join(area.directory, 'other-source');
        await cp(area.datasetPath, dataset, { recursive: true });
        const split = axis === 'split' ? 'calibration' : 'dev';
        const group = axis === 'group' ? 'f02' : 'f01';
        await mkdir(join(dataset, split, group), { recursive: true });
        await writeFile(
          join(dataset, split, group, 'workflows.json'),
          JSON.stringify(
            collectionOf({
              ...area.source,
              ...(axis === 'lineage'
                ? { lineageId: 'different-independent-lineage' }
                : {}),
            }),
          ),
        );
        const plan: RunPlan = {
          ...area.plan,
          datasetPath: dataset,
          split,
          workflow: {
            ...area.plan.workflow,
            points: area.plan.workflow.points.map((point) => ({
              ...point,
              group,
            })),
          },
        };
        const current = await savedRun(area, 'current', plan);
        const refs = await syntheticReferences(area, 'new', plan);
        const result = await compared(
          area,
          baseline,
          current,
          axis === 'lineage' ? refs : [...oldRefs, ...refs],
          oldRefs,
        );
        expect(result.section).toMatchObject({
          unionConditions: 4,
          pairedConditions: 0,
        });
        expect(
          result.section.rows.filter((row) =>
            row.reasons.includes('baseline-only'),
          ),
        ).toHaveLength(2);
        expect(
          result.section.rows.filter((row) =>
            row.reasons.includes('current-only'),
          ),
        ).toHaveLength(2);
      });
    },
  );
  it('shows unequal populations and same-sized populations with different members', async () => {
    await withWorkflowArea(async (area) => {
      if (area.plan.workflow === undefined)
        throw new Error('workflow required');
      const points = area.plan.workflow.points;
      const first = {
        ...area.plan,
        workflow: { ...area.plan.workflow, points: points.slice(0, 1) },
      };
      const second = {
        ...area.plan,
        workflow: { ...area.plan.workflow, points: points.slice(1, 2) },
      };
      const baseline = await savedRun(area, 'baseline', first);
      const disjoint = await savedRun(area, 'disjoint', second);
      const current = await savedRun(area, 'current');
      const refs = await syntheticReferences(area, 'refs', area.plan);
      const unequal = await compared(area, baseline, current, refs);
      expect(unequal.section).toMatchObject({
        unionConditions: 2,
        pairedConditions: 1,
        baseline: { cellsPlanned: 1 },
        current: { cellsPlanned: 2 },
        behaviour: { paired: 1 },
      });
      expect(unequal.section.rows.map((row) => row.reasons)).toContainEqual([
        'current-only',
      ]);
      const equalSize = await compared(area, baseline, disjoint, refs);
      expect(equalSize.section).toMatchObject({
        unionConditions: 2,
        pairedConditions: 0,
        behaviour: { paired: 0, baselineRate: null, currentRate: null },
      });
      expect(equalSize.section.rows.map((row) => row.reasons).sort()).toEqual([
        ['baseline-only'],
        ['current-only'],
      ]);
      expect(equalSize.formats[1]).toContain('n/a');
    });
  });
  it('retains a baseline-only missing record, fails self-check, and never substitutes a later repeat', async () => {
    await withWorkflowArea(async (area) => {
      const plan = { ...area.plan, repeats: 2 };
      const baseline = await savedRun(area, 'baseline', plan);
      const current = await savedRun(area, 'current', plan);
      const refs = await syntheticReferences(area, 'refs', plan);
      const read = await readRun(baseline, await compileRunCheckers(), {
        allowWorkflow: true,
      });
      if (!read.ok)
        throw new Error(
          read.problems.map((problem) => problem.message).join('; '),
        );
      const first = read.artifact.index.cells.find((cell) => cell.repeat === 1);
      if (first === undefined) throw new Error('planned first repeat missing');
      await rm(join(baseline, first.record));
      const result = await compared(area, baseline, current, refs);
      expect(result.exit).toBe(1);
      expect(result.errors.join('\n')).toContain('baseline:');
      expect(result.section.baseline).toMatchObject({
        cellsPlanned: 4,
        conditionsPlanned: 2,
      });
      expect(
        result.section.baseline.cells.find(
          (cell) => cell.cellId === first.cellId,
        ),
      ).toMatchObject({ standing: 'missing-record' });
      expect(
        result.section.rows.find((row) => row.baselineCellId === first.cellId)
          ?.reasons,
      ).toContain('baseline-evidence-unverified');
      expect(result.section.behaviour.paired).toBe(0);
    });
  });
  it('keeps a technical first response outside the denominator despite successful later repeats', async () => {
    await withWorkflowArea(async (area) => {
      const plan: RunPlan = { ...area.plan, repeats: 2 };
      const fixture = fixtureOf(
        Object.fromEntries(
          cellGrid(plan).cells.map((cell) => [
            cell.cellId,
            fixtureCell({
              decision: [
                cell.repeat === 1
                  ? { status: 500, body: 'synthetic transport failure' }
                  : decisionAnswer({ '1': 1 }, { '9': 1 }),
              ],
            }),
          ]),
        ),
      );
      const baseline = await savedRun(area, 'baseline', plan, fixture);
      const current = await savedRun(area, 'current', plan);
      const refs = await syntheticReferences(area, 'refs', plan);
      const result = await compared(area, baseline, current, refs);
      expect(
        result.section.baseline.cells
          .filter((cell) => cell.repeat === 2)
          .every((cell) => cell.common.classification === 'matched'),
      ).toBe(true);
      expect(result.section.behaviour).toMatchObject({
        paired: 0,
        improved: 0,
        regressed: 0,
      });
      expect(
        result.section.rows.every((row) =>
          row.reasons.includes('behaviour-unavailable'),
        ),
      ).toBe(true);
    });
  });
  it('uses separately bound common references for prompt candidates and displays actual model differences', async () => {
    await withWorkflowArea(async (area) => {
      const alternative: RunPlan = {
        ...area.plan,
        candidate: {
          candidateId: 'synthetic-compact',
          prompt: 'no-probe',
          structure: 'compact',
          history: 'current-turn',
          scale: 'complete',
        },
        targets: area.plan.targets.map((target) => ({
          ...target,
          model: 'different-configured-model',
          decision:
            target.decision === null
              ? null
              : { ...target.decision, model: 'different-configured-model' },
        })),
      };
      const baseline = await savedRun(area, 'baseline');
      const current = await savedRun(area, 'current', alternative);
      const oldRefs = await syntheticReferences(
        area,
        'baseline-refs',
        area.plan,
      );
      const newRefs = await syntheticReferences(
        area,
        'current-refs',
        alternative,
      );
      const incomplete = await compared(
        area,
        baseline,
        current,
        newRefs,
        oldRefs,
      );
      expect(incomplete.section.pairedConditions).toBe(0);
      expect(
        incomplete.section.rows.every((row) =>
          row.reasons.includes('common-reference-unavailable'),
        ),
      ).toBe(true);
      const applicable = await compared(
        area,
        baseline,
        current,
        [...oldRefs, ...newRefs],
        oldRefs,
      );
      expect(applicable.section.behaviour).toMatchObject({
        paired: 2,
        unchanged: 2,
      });
      expect(
        applicable.section.rows.every(
          (row) =>
            row.conditionChanges.includes('candidate') &&
            row.conditionChanges.includes('actual-model'),
        ),
      ).toBe(true);
      expect(
        applicable.section.current.cells.every(
          (cell) => cell.model?.configured === 'different-configured-model',
        ),
      ).toBe(true);
    });
  });
  it('does not read or add holdout cells when unrelated holdout material is damaged', async () => {
    await withWorkflowArea(async (area) => {
      await mkdir(join(area.datasetPath, 'holdout/f01'), { recursive: true });
      await writeFile(
        join(area.datasetPath, 'holdout/f01/workflows.json'),
        'not valid JSON; must remain unread',
      );
      const baseline = await savedRun(area, 'baseline');
      const current = await savedRun(area, 'current');
      const refs = await syntheticReferences(area, 'refs', area.plan);
      const before = await readFile(
        join(area.datasetPath, 'holdout/f01/workflows.json'),
      );
      const result = await compared(area, baseline, current, refs);
      expect(result.section).toMatchObject({
        pairedConditions: 2,
        unionConditions: 2,
      });
      expect(
        result.section.current.cells.every(
          (cell) =>
            cell.source.kind === 'workflow' && cell.source.split === 'dev',
        ),
      ).toBe(true);
      expect(
        await readFile(join(area.datasetPath, 'holdout/f01/workflows.json')),
      ).toEqual(before);
    });
  });
});
