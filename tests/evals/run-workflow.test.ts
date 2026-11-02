import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRun } from '../../evals/src/run/artifact.js';
import { compileRunCheckers } from '../../evals/src/run/schemas.js';
import { withWorkflowArea } from './helpers/workflow-run.js';
import { collectionOf } from './fixtures/workflow.js';

const checkers = await compileRunCheckers();

describe('workflow CLI uses the production material and immutable run', () => {
  it('dry-runs actual identities and estimates, then records requests without legacy gold interpretation', async () => {
    await withWorkflowArea(async (area) => {
      await area.write();
      expect(await area.cli(['plan', area.planPath])).toBe(0);
      expect(area.log.join('\n')).toContain(
        'independent-lineage/format-clean/format-clean-main',
      );
      expect(area.log.join('\n')).toContain('workflow estimated initial input');
      expect(area.log.join('\n')).toContain(
        'workflow planned attempt ceiling 2; resource attempt cap 8; conservative request ceiling 2',
      );
      expect(await area.cli(['run', area.planPath])).toBe(0);
      const read = await readRun(area.runDirectory, checkers, {
        allowWorkflow: true,
      });
      expect(read.ok).toBe(true);
      if (!read.ok) throw new Error('workflow artifact could not be read');
      expect(read.artifact.records).toHaveLength(2);
      expect(read.artifact.index.spent.attempts).toBe(2);
      const first = read.artifact.records[0];
      if (first === undefined) throw new Error('first record missing');
      expect(first.workflow).toMatchObject({
        rootId: 'format-build',
        lineageId: 'independent-lineage',
        pointId: 'format-clean',
        viewId: 'format-clean-main',
        group: 'f01',
      });
      expect(first.case.familyId).toBe('independent-lineage');
      expect(first.entryPoint.materialChain).toBe('workflow-point');
      const request = JSON.stringify(first.attempts[0]?.request);
      expect(request).toContain('build/');
      expect(request).not.toContain('FUTURE_FAILURE_SENTINEL');
      expect(request).not.toContain('AUTHOR_SENTINEL');
      expect(first.outcome).toMatchObject({
        status: 'scored',
        risk: 2,
        authorization: 10,
      });
      expect(read.artifact.index.workflowExecution?.config).toMatchObject({
        context: { projectRules: { enabled: false } },
      });
      expect(read.artifact.index.workflowExecution?.codeGit.revision).toMatch(
        /^[a-f0-9]{40}$/u,
      );
      expect(
        read.artifact.index.workflowExecution?.sourceGit.revision,
      ).toBeNull();
      expect((await readRun(area.runDirectory, checkers)).ok).toBe(false);
      const before = await readFile(
        join(area.runDirectory, 'records', `${first.cellId}.json`),
        'utf8',
      );
      expect(await area.cli(['run', area.planPath, '--resume'])).toBe(0);
      expect(
        await readFile(
          join(area.runDirectory, 'records', `${first.cellId}.json`),
          'utf8',
        ),
      ).toBe(before);
      expect(await area.cli(['show', area.runDirectory])).toBe(0);
    });
  });

  it('rejects unknown views, duplicate points, implicit all and a missing target before creating a run', async () => {
    await withWorkflowArea(async (area) => {
      const selected = area.plan.workflow;
      if (selected === undefined) throw new Error('fixture has no workflow');
      for (const plan of [
        { ...area.plan, targets: [] },
        { ...area.plan, split: 'all' as const },
        {
          ...area.plan,
          workflow: {
            ...selected,
            points: [...selected.points, ...selected.points],
          },
        },
        {
          ...area.plan,
          workflow: {
            ...selected,
            points: selected.points.map((p) => ({
              ...p,
              viewId: 'unknown-view',
            })),
          },
        },
      ]) {
        await area.write(plan);
        expect(await area.cli(['plan', area.planPath])).toBe(1);
      }
    });
  });

  it('refuses source drift, alternate resource directories, and a changed effective input declaration', async () => {
    await withWorkflowArea(async (area) => {
      await area.write();
      expect(await area.cli(['run', area.planPath])).toBe(0);
      expect(
        await area.cli([
          'run',
          area.planPath,
          '--dir',
          join(area.directory, 'other'),
        ]),
      ).toBe(1);
      await writeFile(
        area.sourcePath,
        JSON.stringify(
          collectionOf({ ...area.source, task: 'changed authoring source' }),
        ),
      );
      expect(await area.cli(['run', area.planPath, '--resume'])).toBe(1);
      expect(area.log.join('\n')).toContain('dataset revision moved');
    });
  });
});
