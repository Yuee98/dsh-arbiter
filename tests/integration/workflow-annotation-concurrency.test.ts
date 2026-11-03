import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { exportWorkflowBatch } from '../../evals/src/annotation/workflow-export.js';
import {
  importWorkflowHuman,
  importWorkflowOpinions,
  workflowReferences,
} from '../../evals/src/annotation/workflow-service.js';
import {
  workflowRecords,
  workflowState,
} from '../../evals/src/annotation/workflow-store.js';
import { DEFAULT_ANNOTATION_CONTEXT } from '../../evals/src/annotation/workflow-view.js';
import { collectionOf } from '../evals/fixtures/workflow.js';
import {
  withWorkflowAnnotation,
  returns,
  models,
} from '../evals/helpers/workflow-annotation.js';

const scope = {
  split: 'dev' as const,
  group: 'f01',
  context: DEFAULT_ANNOTATION_CONTEXT,
};
const target = {
  status: 'approved' as const,
  allowed: { risk: [3] as const, authorization: [10] as const },
  allowedPairs: [[3, 10]] as const,
  behaviourReference: 'deny' as const,
  rationale: 'Synthetic independent human decision',
  decidedBy: 'synthetic-human',
  decidedAt: '2026-11-02',
};
describe(
  'cross-batch arrival and human/cache ownership',
  { timeout: 30_000 },
  () => {
    test.each([false, true])(
      'reversed batch return preserves every opinion; intervening human confirmation=%s',
      async (human) => {
        await withWorkflowAnnotation(async (f) => {
          const second = await exportWorkflowBatch({
            root: f.root,
            dataset: f.dataset,
            ...scope,
            models: models(2, 2),
            out: join(f.root, 'second'),
          });
          await importWorkflowOpinions({
            dataset: f.dataset,
            baseline: second.baseline,
            returned: returns(second.batch),
            write: true,
          });
          if (human)
            await importWorkflowHuman({
              dataset: f.dataset,
              baseline: second.baseline,
              fill: {
                batchId: second.batch.batchId,
                decisions: [
                  {
                    questionId: second.batch.points[0]?.questionId,
                    state: 'confirmed',
                    target,
                  },
                ],
              },
              write: true,
            });
          const before = workflowRecords(
            await workflowState(f.dataset, 'dev', 'f01'),
          ).labels.filter((value) => value.source === 'human');
          await importWorkflowOpinions({
            ...f,
            returned: returns(f.batch),
            write: true,
          });
          const state = workflowRecords(
            await workflowState(f.dataset, 'dev', 'f01'),
          );
          expect(
            state.opinions.filter((value) => !value.annotation?.registration),
          ).toHaveLength(4);
          expect(
            state.labels.filter((value) => value.source === 'human'),
          ).toEqual(before);
          expect(
            state.labels.filter((value) =>
              ['unresolved', 'model-consensus'].includes(value.source),
            ),
          ).toHaveLength(1);
          const current = (
            await workflowReferences({ ...scope, dataset: f.dataset })
          ).entries[0];
          expect(current?.consensus?.n).toBe(4);
          expect(current?.consensus?.k).toBe(4);
          expect(current?.source).toBe(human ? 'human' : 'model-consensus');
        }, 2);
      },
    );
    test('a blind human fill ignores cache refresh but refuses a real intervening human edit', async () => {
      await withWorkflowAnnotation(async (f) => {
        const second = await exportWorkflowBatch({
          root: f.root,
          dataset: f.dataset,
          ...scope,
          models: models(3),
          out: join(f.root, 'second'),
        });
        await importWorkflowOpinions({
          dataset: f.dataset,
          baseline: second.baseline,
          returned: returns(second.batch),
          write: true,
        });
        const fill = {
          batchId: f.batch.batchId,
          decisions: [
            {
              questionId: f.batch.points[0]?.questionId,
              state: 'confirmed',
              target,
            },
          ],
        };
        await importWorkflowHuman({ ...f, fill, write: true });
        expect(
          (await workflowReferences({ ...scope, dataset: f.dataset }))
            .entries[0]?.source,
        ).toBe('human');
        const path = join(f.dataset, 'dev/f01/labels.json'),
          before = await readFile(path, 'utf8');
        const state = workflowRecords(
          await workflowState(f.dataset, 'dev', 'f01'),
        );
        await writeFile(
          path,
          JSON.stringify(
            collectionOf(
              ...state.labels.map((value) =>
                value.source === 'human'
                  ? {
                      ...value,
                      target: {
                        ...value.target,
                        rationale: 'external human correction',
                      },
                    }
                  : value,
              ),
            ),
          ),
        );
        await expect(
          importWorkflowHuman({ ...f, fill, write: true }),
        ).rejects.toThrow(/conflict/u);
        expect(await readFile(path, 'utf8')).not.toBe(before);
        expect(
          (await workflowReferences({ ...scope, dataset: f.dataset }))
            .entries[0]?.reference?.target.rationale,
        ).toBe('external human correction');
      });
    });
    test('cross-batch modelKey changes cannot multiply a known provider/model identity', async () => {
      await withWorkflowAnnotation(async (f) => {
        await importWorkflowOpinions({
          ...f,
          returned: returns(f.batch),
          write: true,
        });
        const original = f.batch.models[0];
        if (original === undefined) throw new Error('fixture');
        const duplicate = {
          ...original,
          modelKey: 'another-key',
          model: {
            ...original.model,
            version: 'new-version',
            versionSource: 'user-stated' as const,
          },
        };
        const second = await exportWorkflowBatch({
          root: f.root,
          dataset: f.dataset,
          ...scope,
          models: [duplicate],
          out: join(f.root, 'second'),
        });
        await importWorkflowOpinions({
          dataset: f.dataset,
          baseline: second.baseline,
          returned: returns(second.batch),
          write: true,
        });
        const current = (
          await workflowReferences({ ...scope, dataset: f.dataset })
        ).entries[0];
        expect(current?.consensus?.n).toBe(1);
        expect(current?.source).toBe('unresolved');
        expect(
          workflowRecords(
            await workflowState(f.dataset, 'dev', 'f01'),
          ).opinions.filter((value) => !value.annotation?.registration),
        ).toHaveLength(2);
      }, 1);
    });
  },
);
