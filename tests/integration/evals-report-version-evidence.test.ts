import { cp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as observations from '../../evals/src/metrics/observe.js';
import { reportRun } from '../../evals/src/report/command.js';
import { readRun } from '../../evals/src/run/artifact.js';
import { compileRunCheckers } from '../../evals/src/run/schemas.js';
import { withWorkflowArea } from '../evals/helpers/workflow-run.js';
import {
  compared,
  savedRun,
  syntheticReferences,
} from '../evals/helpers/version-comparison.js';
import { collectionOf } from '../evals/fixtures/workflow.js';

describe(
  'comparison source proof and evidence protection',
  { timeout: 60_000 },
  () => {
    it('refuses a baseline replaced between original and common-reference reads', async () => {
      await withWorkflowArea(async (area) => {
        const baseline = await savedRun(area, 'baseline');
        const current = await savedRun(area, 'current');
        const replacement = await savedRun(area, 'replacement');
        const read = (directory: string) =>
          observations.observeRun({
            directory,
            root: area.root,
            dataset: { kind: 'recorded' },
          });
        const currentRead = await read(current),
          firstRead = await read(baseline),
          changedRead = await read(replacement);
        const gate = vi
          .spyOn(observations, 'observeRun')
          .mockResolvedValueOnce(currentRead)
          .mockResolvedValueOnce(firstRead)
          .mockResolvedValueOnce(changedRead);
        const prefix = join(area.directory, 'unwritten');
        const errors: string[] = [];
        try {
          expect(
            await reportRun(
              {
                root: area.root,
                out: () => {},
                err: (line) => errors.push(line),
              },
              {
                directory: current,
                compare: baseline,
                output: prefix,
                dataset: null,
                mode: 'ask',
                channel: 'available',
                force: true,
              },
            ),
          ).toBe(1);
          expect(errors.join('\n')).toContain('changed during evaluation');
          await expect(readFile(`${prefix}.json`)).rejects.toMatchObject({
            code: 'ENOENT',
          });
        } finally {
          gate.mockRestore();
        }
      });
    });
    it('keeps changed input with a new response separate, and rejects relabeling an old response for changed input', async () => {
      await withWorkflowArea(async (area) => {
        const baseline = await savedRun(area, 'baseline');
        const oldRefs = await syntheticReferences(area, 'old', area.plan);
        const dataset = join(area.directory, 'changed-dataset');
        await cp(area.datasetPath, dataset, { recursive: true });
        const first = area.source.events[0];
        if (first?.kind !== 'message')
          throw new Error('fixture message missing');
        await writeFile(
          join(dataset, 'dev/f01/workflows.json'),
          JSON.stringify(
            collectionOf({
              ...area.source,
              events: [
                {
                  ...first,
                  content: `${first.content} Changed permission facts.`,
                },
                ...area.source.events.slice(1),
              ],
            }),
          ),
        );
        const plan = { ...area.plan, datasetPath: dataset };
        const current = await savedRun(area, 'current', plan);
        const refs = await syntheticReferences(area, 'new', plan);
        const result = await compared(
          area,
          baseline,
          current,
          [...oldRefs, ...refs],
          oldRefs,
        );
        expect(result.section).toMatchObject({
          pairedConditions: 0,
          baseline: { cellsPlanned: 2 },
          current: { cellsPlanned: 2 },
        });
        expect(
          result.section.rows.every((row) =>
            row.reasons.includes('input-changed'),
          ),
        ).toBe(true);
        expect(
          result.section.current.cells.every(
            (cell) => cell.standing === 'answered',
          ),
        ).toBe(true);
        const errors: string[] = [];
        await reportRun(
          { root: area.root, out: () => {}, err: (line) => errors.push(line) },
          {
            ...result.command,
            baselineDataset: dataset,
          },
        );
        const output: unknown = JSON.parse(
          await readFile(`${result.command.output ?? ''}.json`, 'utf8'),
        );
        const common: unknown = expect.objectContaining({
          source: 'unresolved',
        });
        const cells: unknown = expect.arrayContaining([
          expect.objectContaining({ common }),
        ]);
        expect(output).toMatchObject({
          versionComparison: { pairedConditions: 0, baseline: { cells } },
        });
      });
    });
    it('preserves baseline self-check failures for a contradictory index even when the current run is valid', async () => {
      await withWorkflowArea(async (area) => {
        const baseline = await savedRun(area, 'baseline');
        const current = await savedRun(area, 'current');
        const refs = await syntheticReferences(area, 'refs', area.plan);
        const read = await readRun(baseline, await compileRunCheckers(), {
          allowWorkflow: true,
        });
        if (!read.ok) throw new Error('baseline read failed');
        await writeFile(
          join(baseline, 'index.json'),
          JSON.stringify({
            ...read.artifact.index,
            cells: read.artifact.index.cells.map((cell, index) =>
              index === 0 ? { ...cell, status: 'failed' } : cell,
            ),
          }),
        );
        const result = await compared(area, baseline, current, refs);
        expect(result.exit).toBe(1);
        expect(result.section.baseline.checks).toContainEqual(
          expect.objectContaining({
            name: 'index-record-consistency',
            ok: false,
          }),
        );
        expect(result.section.current.checks.every((check) => check.ok)).toBe(
          true,
        );
        expect(result.section.pairedConditions).toBe(0);
        expect(result.errors.join('\n')).toContain(
          'baseline:index-record-consistency',
        );
      });
    });
    it('retains coverage when original source disappears instead of acquiring a reference from matching IDs', async () => {
      await withWorkflowArea(async (area) => {
        const baseline = await savedRun(area, 'baseline');
        const refs = await syntheticReferences(area, 'refs', area.plan);
        const dataset = join(area.directory, 'current-source');
        await cp(area.datasetPath, dataset, { recursive: true });
        const current = await savedRun(area, 'current', {
          ...area.plan,
          datasetPath: dataset,
        });
        await rm(area.sourcePath);
        const result = await compared(area, baseline, current, refs);
        expect(result.section.baseline.cellsPlanned).toBe(2);
        expect(result.section.pairedConditions).toBe(0);
        expect(
          result.section.rows.every((row) =>
            row.reasons.includes('baseline-evidence-unverified'),
          ),
        ).toBe(true);
      });
    });
    it('protects baseline artifacts, source and references through --force and a directory alias', async () => {
      await withWorkflowArea(async (area) => {
        const baseline = await savedRun(area, 'baseline');
        const current = await savedRun(area, 'current');
        const refs = await syntheticReferences(area, 'refs', area.plan);
        const result = await compared(area, baseline, current, refs);
        const alias = join(area.directory, 'baseline-alias');
        await symlink(baseline, alias, 'dir');
        const reference = refs[0];
        if (reference === undefined) throw new Error('reference missing');
        const targets = [
          join(baseline, 'index.json'),
          join(alias, 'index.json'),
          area.sourcePath,
          reference,
        ];
        for (const target of targets) {
          const before = await readFile(target);
          const errors: string[] = [];
          expect(
            await reportRun(
              {
                root: area.root,
                out: () => {},
                err: (line) => errors.push(line),
              },
              {
                ...result.command,
                output: target.slice(0, -5),
                force: true,
              },
            ),
          ).toBe(1);
          expect(errors.join('\n')).toContain('problem');
          expect(await readFile(target)).toEqual(before);
        }
      });
    });
    it('refuses unavailable baseline input before creating any comparison output', async () => {
      await withWorkflowArea(async (area) => {
        const current = await savedRun(area, 'current');
        const prefix = join(area.directory, 'unwritten');
        const errors: string[] = [];
        expect(
          await reportRun(
            {
              root: area.root,
              out: () => {},
              err: (line) => errors.push(line),
            },
            {
              directory: current,
              compare: join(area.directory, 'missing'),
              output: prefix,
              dataset: null,
              mode: 'ask',
              channel: 'available',
              force: true,
            },
          ),
        ).toBe(1);
        await expect(readFile(`${prefix}.json`)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(errors.join('\n')).toContain('problem');
      });
    });
  },
);
