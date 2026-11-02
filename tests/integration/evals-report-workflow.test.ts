import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { withWorkflowArea } from '../evals/helpers/workflow-run.js';
import {
  dualProtocolPlan,
  frozenWorkflowReferences,
  workflowReport,
} from '../evals/helpers/report-workflow.js';
import { reportRun } from '../../evals/src/report/command.js';
import { readRun } from '../../evals/src/run/artifact.js';
import { compileRunCheckers } from '../../evals/src/run/schemas.js';
import { readReferenceSnapshot } from '../../evals/src/metrics/reference-snapshot.js';
import type { RunIndex, CellRecord } from '../../evals/src/run/types.js';

async function savedIndex(path: string): Promise<RunIndex> {
  const result = (await compileRunCheckers()).index(
    JSON.parse(await readFile(path, 'utf8')) as unknown,
  );
  if (!result.ok) throw new Error(result.problems.join('; '));
  return result.document;
}
async function savedRecord(path: string): Promise<CellRecord> {
  const result = (await compileRunCheckers()).record(
    JSON.parse(await readFile(path, 'utf8')) as unknown,
  );
  if (!result.ok) throw new Error(result.problems.join('; '));
  return result.document;
}

describe('formal workflow runner to report', () => {
  it('joins frozen references through the actual saved material for both protocols and repeats', async () => {
    await withWorkflowArea(async (area) => {
      const plan = dualProtocolPlan(area.plan);
      await area.write(plan);
      const references = await frozenWorkflowReferences(area.directory, plan);
      const exit = await area.cli([
        'run',
        area.planPath,
        '--dir',
        area.runDirectory,
      ]);
      expect({ exit, errors: exit === 0 ? [] : area.log }).toEqual({
        exit: 0,
        errors: [],
      });
      const network = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('report stays offline'));
      try {
        const report = await workflowReport(
          area.root,
          area.runDirectory,
          references,
        );
        expect(report.quality?.identities).toMatchObject({
          legacyCases: 0,
          roots: 1,
          lineages: 1,
          points: 2,
          views: 2,
          repeatCells: 4,
        });
        expect(report.quality?.references.cellsBySource).toEqual({ human: 8 });
        expect(report.quality?.overall).toMatchObject({
          cells: { cells: 8, compared: 8 },
          conditions: { cells: 4, compared: 4 },
          conditional: {
            falseAllow: { numerator: 4, denominator: 4, rate: 1 },
          },
        });
        expect(report.trajectories).toMatchObject({
          selected: 4,
          partialScope: 4,
          actualContinuation: 'not-observed',
        });
        expect(
          report.examples.every(
            (cell) =>
              cell.source?.kind === 'workflow' &&
              cell.labelStatus === 'not-applicable',
          ),
        ).toBe(true);
        expect(report.diagnostics.labels.gold).toBe(0);
        expect(network).not.toHaveBeenCalled();
        const output = join(area.directory, 'report');
        const options = {
          directory: area.runDirectory,
          dataset: null,
          references,
          output,
          mode: 'ask',
          channel: 'available',
          force: true,
        } as const;
        expect(
          await reportRun(
            { root: area.root, out: () => {}, err: () => {} },
            options,
          ),
        ).toBe(0);
        const before = await Promise.all(
          ['json', 'md', 'html'].map((extension) =>
            readFile(`${output}.${extension}`, 'utf8'),
          ),
        );
        expect(before.every((text) => text.includes('format-clean-main'))).toBe(
          true,
        );
        expect(
          await reportRun(
            { root: area.root, out: () => {}, err: () => {} },
            options,
          ),
        ).toBe(0);
        expect(
          await Promise.all(
            ['json', 'md', 'html'].map((extension) =>
              readFile(`${output}.${extension}`, 'utf8'),
            ),
          ),
        ).toEqual(before);
      } finally {
        network.mockRestore();
      }
    });
  });
  it('keeps source, full-config, material and version drift out of reference metrics', async () => {
    await withWorkflowArea(async (area) => {
      const plan = dualProtocolPlan(area.plan);
      await area.write(plan);
      const references = await frozenWorkflowReferences(area.directory, plan);
      expect(await area.cli(['run', area.planPath])).toBe(0);
      const indexPath = join(area.runDirectory, 'index.json');
      const index = await savedIndex(indexPath);
      if (index.workflowExecution === undefined)
        throw new Error('missing actual config');
      const recordState = index.cells[0];
      if (recordState === undefined) throw new Error('missing actual cell');
      const path = join(area.runDirectory, recordState.record);
      const record = await savedRecord(path);
      if (record.material === null) throw new Error('missing actual material');
      await writeFile(
        path,
        JSON.stringify({
          ...record,
          material: { ...record.material, maxInputTokens: 9999 },
        }),
      );
      const moved = await workflowReport(
        area.root,
        area.runDirectory,
        references,
      );
      expect(moved.quality?.references.cellsBySource).toEqual({
        unresolved: 1,
        human: 7,
      });
      expect(
        moved.examples.find((cell) => cell.cellId === recordState.cellId)
          ?.evaluationReference?.reasons,
      ).toContain('record-material-drift');
      await writeFile(path, JSON.stringify(record));
      await writeFile(
        indexPath,
        JSON.stringify({
          ...index,
          workflowExecution: {
            ...index.workflowExecution,
            configRevision: 'changed',
          },
        }),
      );
      const config = await workflowReport(
        area.root,
        area.runDirectory,
        references,
      );
      expect(config.quality?.references.cellsBySource).toEqual({
        unresolved: 8,
      });
      expect(config.notes).toContain('workflow-config-unverified');
      await writeFile(
        indexPath,
        JSON.stringify({
          ...index,
          versions: { ...index.versions, prompt: 'old-prompt' },
        }),
      );
      expect(
        (await workflowReport(area.root, area.runDirectory, references)).notes,
      ).toContain('workflow-prompt-version-drift');
      await writeFile(indexPath, JSON.stringify(index));
      await writeFile(
        area.sourcePath,
        JSON.stringify({
          schemaVersion: 'grouped-v1',
          records: [{ ...area.source, task: 'changed source' }],
        }),
      );
      const source = await workflowReport(
        area.root,
        area.runDirectory,
        references,
      );
      expect(source.quality?.references.cellsBySource).toEqual({
        unresolved: 8,
      });
      expect(source.notes).toContain('workflow-source-digest-drift');
      expect(source.quality?.identities.roots).toBe(1);
    });
  });
  it('retains every frozen identity without source/records and refuses a mismatched saved view', async () => {
    await withWorkflowArea(async (area) => {
      const plan = dualProtocolPlan(area.plan);
      await area.write(plan);
      const references = await frozenWorkflowReferences(area.directory, plan);
      expect(await area.cli(['run', area.planPath])).toBe(0);
      const index = await savedIndex(join(area.runDirectory, 'index.json'));
      const first = index.cells[0];
      if (first === undefined) throw new Error('missing actual cell');
      const path = join(area.runDirectory, first.record);
      const record = await savedRecord(path);
      await rm(path);
      const missing = await workflowReport(
        area.root,
        area.runDirectory,
        references,
      );
      expect(missing.coverage).toMatchObject({
        cellsPlanned: 8,
        records: 7,
        missing: [{ cellId: first.cellId }],
      });
      expect(missing.quality?.references.cellsBySource).toEqual({ human: 8 });
      expect(missing.quality?.overall.conditions.missingRecord).toBe(1);
      await writeFile(
        path,
        JSON.stringify({
          ...record,
          workflow: { ...record.workflow, viewId: 'different-view' },
        }),
      );
      const rejected = await readRun(
        area.runDirectory,
        await compileRunCheckers(),
        { allowWorkflow: true },
      );
      expect(rejected.ok).toBe(false);
      if (rejected.ok) throw new Error('expected identity rejection');
      expect(
        rejected.problems.map((problem) => problem.message).join(';'),
      ).toContain('identity');
      await writeFile(path, JSON.stringify(record));
      await rm(area.sourcePath);
      const absent = await workflowReport(
        area.root,
        area.runDirectory,
        references,
      );
      expect(absent.examples).toHaveLength(8);
      expect(absent.quality?.identities).toMatchObject({
        roots: 1,
        lineages: 1,
        points: 2,
        views: 2,
      });
      expect(absent.quality?.references.cellsBySource).toEqual({
        unresolved: 8,
      });
      expect(absent.quality?.overall.cells.compared).toBe(0);
    });
  });
  it('never falls back across frozen split/group/protocol/view or configuration scope', async () => {
    await withWorkflowArea(async (area) => {
      const plan = dualProtocolPlan(area.plan);
      await area.write(plan);
      const references = await frozenWorkflowReferences(area.directory, plan);
      expect(await area.cli(['run', area.planPath])).toBe(0);
      const selected = references[0];
      if (selected === undefined) throw new Error('missing snapshot');
      const original = await readReferenceSnapshot(selected);
      for (const scope of [
        { split: 'holdout', group: 'f01' },
        { split: 'dev', group: 'other' },
      ]) {
        await writeFile(selected, JSON.stringify({ ...original, scope }));
        expect(
          (await workflowReport(area.root, area.runDirectory, references))
            .quality?.references.cellsBySource,
        ).toEqual({ unresolved: 4, human: 4 });
      }
      await writeFile(
        selected,
        JSON.stringify({
          ...original,
          entries: original.entries.map((entry) => ({
            ...entry,
            pointId: `${entry.pointId}-other`,
            viewId: `${entry.viewId}-other`,
            reference:
              entry.reference === null
                ? null
                : {
                    ...entry.reference,
                    pointId: `${entry.pointId}-other`,
                    viewId: `${entry.viewId}-other`,
                  },
          })),
        }),
      );
      expect(
        (await workflowReport(area.root, area.runDirectory, references)).quality
          ?.references.cellsBySource,
      ).toEqual({ unresolved: 4, human: 4 });
      // The other protocol's snapshot never supplies a missing chat reference.
      expect(
        (
          await workflowReport(
            area.root,
            area.runDirectory,
            references.slice(1),
          )
        ).quality?.references.cellsBySource,
      ).toEqual({ unresolved: 4, human: 4 });
      await expect(
        workflowReport(area.root, area.runDirectory, [
          ...references.slice(1),
          ...references.slice(1),
        ]),
      ).rejects.toThrow('ambiguous frozen reference');
    });
  });
});
