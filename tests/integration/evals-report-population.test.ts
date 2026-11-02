import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { withWorkflowArea } from '../evals/helpers/workflow-run.js';
import {
  dualProtocolPlan,
  frozenWorkflowReferences,
  workflowReport,
} from '../evals/helpers/report-workflow.js';
import type { RunPlan } from '../../evals/src/run/types.js';

describe('workflow planned report populations', { timeout: 30_000 }, () => {
  it('keeps actual unsupported and budget-blocked cells in planned identity and allow-burden denominators', async () => {
    await withWorkflowArea(async (area) => {
      const plan = {
        ...dualProtocolPlan(area.plan),
        targets: area.plan.targets,
        bounds: { ...area.plan.bounds, maxAttempts: 1 },
        resource: {
          ...area.plan.resource,
          runDirectory: area.runDirectory,
          maxAttempts: 1,
          maxEstimatedInputTokens: 80000,
        },
      };
      await area.write(plan);
      const references = await frozenWorkflowReferences(
        area.directory,
        plan,
        'allow',
      );
      expect(await area.cli(['run', area.planPath])).toBe(1);
      const report = await workflowReport(
        area.root,
        area.runDirectory,
        references,
      );
      expect(report.coverage.cellsPlanned).toBe(8);
      expect(report.coverage.statuses).toEqual({
        unsupported: 4,
        reviewed: 1,
        'budget-exhausted': 1,
        'not-run': 2,
      });
      expect(report.quality?.references.cellsBySource).toEqual({ human: 8 });
      expect(report.quality?.overall.cellBurden).toMatchObject({
        plannedAllow: 8,
        supportedAllow: 4,
        unsupported: 4,
        preDispatchBlocked: 1,
        unknown: 2,
        knownBurdenLowerBound: { numerator: 1, denominator: 8 },
        supportedBurdenLowerBound: { numerator: 1, denominator: 4 },
      });
      expect(report.quality?.overall.burden).toMatchObject({
        plannedAllow: 4,
        supportedAllow: 2,
        preDispatchBlocked: 0,
        unknown: 1,
        knownBurdenLowerBound: { numerator: 0, denominator: 4 },
      });
      expect(report.examples).toHaveLength(8);
      expect(
        report.examples.every((cell) => cell.source?.kind === 'workflow'),
      ).toBe(true);
    });
  });
  it('measures a complete selected trajectory and refuses stale reference bindings for actual config/package changes', async () => {
    await withWorkflowArea(async (area) => {
      const base = dualProtocolPlan(area.plan);
      if (base.workflow === undefined) throw new Error('workflow required');
      const plan = {
        ...base,
        repeats: 1,
        workflow: {
          ...base.workflow,
          points: area.source.points.map((point) => ({
            group: 'f01',
            rootId: area.source.rootId,
            pointId: point.pointId,
            viewId: point.primaryViewId,
          })),
        },
      };
      await area.write(plan);
      const references = await frozenWorkflowReferences(area.directory, plan);
      expect(await area.cli(['run', area.planPath])).toBe(0);
      expect(
        (await workflowReport(area.root, area.runDirectory, references))
          .trajectories,
      ).toMatchObject({
        selected: 2,
        completeScope: 2,
        assessable: 2,
        violated: 2,
        partialScope: 0,
      });
      const alternatives: readonly Partial<RunPlan>[] = [
        {
          workflow: {
            ...plan.workflow,
            input: {
              ...plan.workflow.input,
              customRules: 'Changed visible custom guidance.',
            },
          },
        },
        {
          candidate: {
            candidateId: 'synthetic-compact',
            prompt: 'no-probe',
            structure: 'compact',
            history: 'current-turn',
            scale: 'complete',
          },
        },
      ];
      for (const [index, patch] of alternatives.entries()) {
        const run = join(area.directory, `changed-${String(index)}`);
        const changed: RunPlan = {
          ...plan,
          ...patch,
          resource: {
            ...plan.resource,
            runDirectory: run,
            maxAttempts: 8,
            maxEstimatedInputTokens: 80000,
          },
        };
        await area.write(changed);
        expect(await area.cli(['run', area.planPath])).toBe(0);
        const report = await workflowReport(area.root, run, references);
        expect(report.quality?.references.cellsBySource).toEqual({
          unresolved: 6,
        });
        expect(
          report.examples.every((cell) =>
            cell.evaluationReference?.reasons.includes(
              'input-view-version-drift',
            ),
          ),
        ).toBe(true);
        expect(report.notes).not.toContain('workflow-config-unverified');
      }
    });
  });
});
