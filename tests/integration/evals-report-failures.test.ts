import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { withWorkflowArea } from '../evals/helpers/workflow-run.js';
import {
  dualProtocolPlan,
  frozenWorkflowReferences,
  workflowReport,
} from '../evals/helpers/report-workflow.js';
import { fixtureCell, fixtureOf } from '../evals/helpers/run.js';
import { childWorkflow, collectionOf } from '../evals/fixtures/workflow.js';
import { cellGrid } from '../../evals/src/run/grid.js';
import type { RunPlan } from '../../evals/src/run/types.js';

describe('actual workflow engineering references', { timeout: 30_000 }, () => {
  it('keeps a real provider failure out of semantic denials while comparing its engineering reference', async () => {
    await withWorkflowArea(async (area) => {
      const plan: RunPlan = {
        ...dualProtocolPlan(area.plan),
        repeats: 1,
        protocols: ['decision'],
      };
      await area.write(plan);
      const references = await frozenWorkflowReferences(
        area.directory,
        plan,
        'review-failure',
      );
      await writeFile(
        area.fixturePath,
        JSON.stringify(
          fixtureOf(
            Object.fromEntries(
              cellGrid(plan).cells.map((cell) => [
                cell.cellId,
                fixtureCell({
                  decision: [
                    { status: 503, body: '{"error":"synthetic refusal"}' },
                  ],
                }),
              ]),
            ),
          ),
        ),
      );
      expect(await area.cli(['run', area.planPath])).toBe(0);
      const report = await workflowReport(
        area.root,
        area.runDirectory,
        references,
      );
      expect(report.quality?.overall).toMatchObject({
        conditions: { cells: 2, compared: 0, technical: 2 },
        reviewFailure: { expected: 2, observed: 2, matched: 2 },
        failureKinds: { 'provider-refusal': 2 },
        pairs: { labeled: 0 },
        technicalAvailability: { numerator: 0, denominator: 2 },
      });
      expect(
        report.examples.every(
          (cell) =>
            cell.reference === 'review-failure' &&
            cell.classification === 'technical',
        ),
      ).toBe(true);
    });
  });
  it('reports actual dispatches for an M0 reference without treating matching insufficiency as a no-dispatch proof', async () => {
    await withWorkflowArea(async (area) => {
      const original = childWorkflow();
      const document = {
        ...original,
        points: original.points.map((point) => ({
          ...point,
          parentRead: {
            sessionId: 'parent',
            cutoffEventId: null,
            status: 'unavailable' as const,
          },
        })),
      };
      await writeFile(area.sourcePath, JSON.stringify(collectionOf(document)));
      const base = dualProtocolPlan(area.plan);
      if (base.workflow === undefined) throw new Error('workflow required');
      const plan: RunPlan = {
        ...base,
        repeats: 1,
        workflow: {
          ...base.workflow,
          points: document.points.map((point) => ({
            group: 'f01',
            rootId: document.rootId,
            pointId: point.pointId,
            viewId: point.primaryViewId,
          })),
        },
      };
      await area.write(plan);
      const references = await frozenWorkflowReferences(
        area.directory,
        plan,
        'insufficient-material',
      );
      expect(await area.cli(['run', area.planPath])).toBe(0);
      const report = await workflowReport(
        area.root,
        area.runDirectory,
        references,
      );
      expect(report.quality?.overall).toMatchObject({
        conditions: { cells: 4 },
        m0: {
          expected: 4,
          observed: 4,
          matched: 4,
          knownNoDispatch: 0,
          unknownDispatch: 0,
          unexpectedDispatch: 4,
        },
        pairs: { labeled: 0 },
        technicalAvailability: { numerator: 0, denominator: 4 },
      });
      expect(report.coverage.attempts).toBe(4);
      expect(report.quality?.references.cellsBySource).toEqual({ human: 4 });
    });
  });
});
