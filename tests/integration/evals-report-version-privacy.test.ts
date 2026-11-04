import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reportRun } from '../../evals/src/report/command.js';
import { readRun } from '../../evals/src/run/artifact.js';
import { compileRunCheckers } from '../../evals/src/run/schemas.js';
import type { RunPlan } from '../../evals/src/run/types.js';
import { withWorkflowArea } from '../evals/helpers/workflow-run.js';
import {
  compared,
  savedRun,
  syntheticReferences,
} from '../evals/helpers/version-comparison.js';

describe('two-sided comparison publication', { timeout: 60_000 }, () => {
  it('uses baseline credentials to protect current-side identities while omitting ordinary private guidance', async () => {
    await withWorkflowArea(async (area) => {
      if (area.plan.workflow === undefined)
        throw new Error('workflow required');
      const secret = 'synthetic_baseline_bearer_133';
      const privateText = 'PRIVATE_ORDINARY_BASELINE_GUIDANCE_133';
      const baselinePlan: RunPlan = {
        ...area.plan,
        workflow: {
          ...area.plan.workflow,
          input: {
            ...area.plan.workflow.input,
            customRules: `Authorization: Bearer ${secret}\n${privateText}`,
          },
        },
      };
      const currentPlan: RunPlan = {
        ...area.plan,
        targets: area.plan.targets.map((target) => ({
          ...target,
          model: secret,
          decision:
            target.decision === null
              ? null
              : { ...target.decision, model: secret },
        })),
      };
      const baseline = await savedRun(area, 'baseline', baselinePlan);
      const oldRefs = await syntheticReferences(area, 'old', baselinePlan);
      const current = await savedRun(area, 'current', currentPlan);
      const newRefs = await syntheticReferences(area, 'new', currentPlan);
      const result = await compared(
        area,
        baseline,
        current,
        [...oldRefs, ...newRefs],
        oldRefs,
      );
      expect(result.section.pairedConditions).toBe(2);
      for (const format of result.formats) {
        expect(format).not.toContain(secret);
        expect(format).not.toContain(privateText);
      }
      expect(JSON.parse(result.formats[0] ?? '') as unknown).toMatchObject({
        versionComparison: {
          pairedConditions: 2,
          behaviour: { paired: 2, unchanged: 2 },
          current: { cellsPlanned: 2 },
        },
      });
      const errors: string[] = [];
      expect(
        await reportRun(
          { root: area.root, out: () => {}, err: (line) => errors.push(line) },
          {
            ...result.command,
            output: join(area.directory, secret),
          },
        ),
      ).toBe(1);
      expect(errors.join('\n')).not.toContain(secret);
    });
  });
  it('escapes baseline-owned hostile model text in both human formats without executable markup', async () => {
    await withWorkflowArea(async (area) => {
      const hostile =
        '<img src="https://example.invalid/comparison-leak" onerror="globalThis.comparisonAttack=true">';
      const plan = {
        ...area.plan,
        targets: area.plan.targets.map((target) => ({
          ...target,
          model: hostile,
          decision:
            target.decision === null
              ? null
              : { ...target.decision, model: hostile },
        })),
      };
      const baseline = await savedRun(area, 'baseline', plan);
      const current = await savedRun(area, 'current');
      const refs = await syntheticReferences(area, 'refs', area.plan);
      const result = await compared(area, baseline, current, refs);
      expect(result.section.baseline.cells[0]?.model?.configured).toBe(hostile);
      expect(result.formats[1]).toContain('&lt;img');
      expect(result.formats[2]).toContain('&lt;img');
      expect(result.formats[2]).not.toContain(hostile);
    });
  });
  it('refuses retained request/model identity drift instead of trusting a stable target ID', async () => {
    await withWorkflowArea(async (area) => {
      const baseline = await savedRun(area, 'baseline');
      const current = await savedRun(area, 'current');
      const refs = await syntheticReferences(area, 'refs', area.plan);
      const read = await readRun(baseline, await compileRunCheckers(), {
        allowWorkflow: true,
      });
      if (!read.ok) throw new Error('baseline unreadable');
      const record = read.artifact.records[0];
      const state = read.artifact.index.cells.find(
        (cell) => cell.cellId === record?.cellId,
      );
      if (record === undefined || state === undefined)
        throw new Error('fixture record missing');
      await writeFile(
        join(baseline, state.record),
        JSON.stringify({
          ...record,
          target: { ...record.target, configuredModel: 'invented-model' },
        }),
      );
      const result = await compared(area, baseline, current, refs);
      expect(
        result.section.rows.find((row) => row.baselineCellId === record.cellId)
          ?.reasons,
      ).toContain('baseline-evidence-unverified');
      expect(result.section.behaviour.paired).toBe(1);
      expect(await readFile(join(baseline, state.record), 'utf8')).toContain(
        'invented-model',
      );
    });
  });
});
