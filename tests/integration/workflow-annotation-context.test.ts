import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { runWorkflowAnnotationCli } from '../../evals/src/annotation/workflow-command.js';
import { readWorkflowBatch } from '../../evals/src/annotation/workflow-batch-read.js';
import {
  buildAnnotationView,
  DEFAULT_ANNOTATION_CONTEXT,
  workflowSource,
} from '../../evals/src/annotation/workflow-view.js';
import {
  importWorkflowOpinions,
  workflowReferences,
} from '../../evals/src/annotation/workflow-service.js';
import { collectionOf, workflow } from '../evals/fixtures/workflow.js';
import { withDataset } from '../evals/helpers/dataset.js';
import {
  models,
  withWorkflowAnnotation,
} from '../evals/helpers/workflow-annotation.js';

const unsafe = Number.MAX_SAFE_INTEGER + 1;
const fields = ['targetInputTokens', 'maxInputTokens'] as const;

describe('annotation budget input and reload boundaries', () => {
  test('CLI rejects unsafe T/H before creating a pack, baseline or registrations', async () => {
    await withDataset(async (temp) => {
      await temp.write('data/dev/f01/workflows.json', collectionOf(workflow()));
      await temp.write('models.json', models(3));
      const contexts = [
        { targetInputTokens: unsafe, maxInputTokens: unsafe },
        { targetInputTokens: unsafe, maxInputTokens: Number.MAX_SAFE_INTEGER },
        { targetInputTokens: 1, maxInputTokens: unsafe },
      ];
      for (const [index, budget] of contexts.entries()) {
        await temp.write('context.json', {
          ...DEFAULT_ANNOTATION_CONTEXT,
          ...budget,
        });
        const out: string[] = [],
          err: string[] = [];
        const pack = `pack-${String(index)}`;
        const code = await runWorkflowAnnotationCli(
          [
            'workflow-export',
            'data',
            '--group',
            'f01',
            '--models',
            'models.json',
            '--context',
            'context.json',
            '--out',
            pack,
          ],
          {
            root: temp.path,
            out: (line) => out.push(line),
            err: (line) => err.push(line),
          },
        );
        expect(code).toBe(1);
        expect(out).toEqual([]);
        expect(err.join('\n')).toContain(String(Number.MAX_SAFE_INTEGER));
        await expect(access(join(temp.path, pack))).rejects.toThrow();
      }
      expect(await readdir(join(temp.path, 'data/dev/f01'))).toEqual([
        'workflows.json',
      ]);
      await expect(access(join(temp.path, '.local'))).rejects.toThrow();
    });
  }, 30_000);

  test('maximum safe T/H survive actual CLI export, persisted reload and reference/import services', async () => {
    await withDataset(async (temp) => {
      const context = {
        ...DEFAULT_ANNOTATION_CONTEXT,
        targetInputTokens: Number.MAX_SAFE_INTEGER,
        maxInputTokens: Number.MAX_SAFE_INTEGER,
      };
      await temp.write('data/dev/f01/workflows.json', collectionOf(workflow()));
      await temp.write('models.json', models(3));
      await temp.write('context.json', context);
      const out: string[] = [],
        err: string[] = [];
      expect(
        await runWorkflowAnnotationCli(
          [
            'workflow-export',
            'data',
            '--group',
            'f01',
            '--models',
            'models.json',
            '--context',
            'context.json',
            '--out',
            'pack',
          ],
          {
            root: temp.path,
            out: (line) => out.push(line),
            err: (line) => err.push(line),
          },
        ),
      ).toBe(0);
      expect(err).toEqual([]);
      expect(out[0]).toContain('3 independent questions');
      const baseline = /baseline (.+)$/u.exec(out[0] ?? '')?.[1];
      if (baseline === undefined) throw new Error('missing CLI baseline');
      const batch = await readWorkflowBatch(baseline);
      expect(batch.context).toEqual(context);
      expect(
        batch.points.every(
          (point) => point.error === null && point.request !== null,
        ),
      ).toBe(true);
      const dataset = join(temp.path, 'data');
      await importWorkflowOpinions({
        dataset,
        baseline,
        returned: { batchId: batch.batchId, responses: [] },
        write: true,
        context,
      });
      const snapshot = await workflowReferences({
        dataset,
        split: 'dev',
        group: 'f01',
        context,
      });
      expect(snapshot.entries).toHaveLength(3);
      expect(snapshot.entries.every((entry) => entry.request !== null)).toBe(
        true,
      );
    });
  }, 30_000);

  test('unsafe persisted batches, render contexts and direct import overrides fail without writes', async () => {
    await withWorkflowAnnotation(async (f) => {
      const initial = await readFile(f.baseline, 'utf8');
      const opinions = join(f.dataset, 'dev/f01/opinions.json');
      const before = await readFile(opinions, 'utf8');
      const source = await workflowSource(f.dataset, 'dev', 'f01');
      const first = f.batch.points[0];
      if (first === undefined) throw new Error('fixture point');
      for (const field of fields) {
        const context = { ...DEFAULT_ANNOTATION_CONTEXT, [field]: unsafe };
        await writeFile(f.baseline, JSON.stringify({ ...f.batch, context }));
        await expect(readWorkflowBatch(f.baseline)).rejects.toThrow();
        await writeFile(f.baseline, initial);
        await expect(
          buildAnnotationView(source, first.rootId, first.pointId, context),
        ).rejects.toThrow();
        await expect(
          importWorkflowOpinions({
            dataset: f.dataset,
            baseline: f.baseline,
            returned: { batchId: f.batch.batchId, responses: [] },
            write: true,
            context,
          }),
        ).rejects.toThrow();
        expect(await readFile(opinions, 'utf8')).toBe(before);
        expect(await readFile(f.baseline, 'utf8')).toBe(initial);
      }
      // Even a preparation-failed batch has no render loop in which to hide invalid overrides.
      await writeFile(
        f.baseline,
        JSON.stringify({
          ...f.batch,
          points: f.batch.points.map((point) => ({
            ...point,
            binding: null,
            request: null,
            error: 'synthetic failed preparation',
          })),
        }),
      );
      await expect(
        importWorkflowOpinions({
          dataset: f.dataset,
          baseline: f.baseline,
          returned: { batchId: f.batch.batchId, responses: [] },
          write: true,
          context: { ...DEFAULT_ANNOTATION_CONTEXT, maxInputTokens: unsafe },
        }),
      ).rejects.toThrow();
      expect(await readFile(opinions, 'utf8')).toBe(before);
    });
  }, 30_000);
});
