import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { REVIEW_CONTRACT } from '../../src/reviewer/contract.js';
import { POLICY_NOTE } from '../../src/reviewer/material.js';
import { exportWorkflowBatch } from '../../evals/src/annotation/workflow-export.js';
import {
  importWorkflowOpinions,
  workflowReferences,
} from '../../evals/src/annotation/workflow-service.js';
import {
  DEFAULT_ANNOTATION_CONTEXT,
  materialStrings,
} from '../../evals/src/annotation/workflow-view.js';
import {
  workflowRecords,
  workflowState,
} from '../../evals/src/annotation/workflow-store.js';
import { withDataset } from '../evals/helpers/dataset.js';
import {
  models,
  returns,
  withWorkflowAnnotation,
} from '../evals/helpers/workflow-annotation.js';
import { collectionOf, workflow } from '../evals/fixtures/workflow.js';

const contractQuote = REVIEW_CONTRACT.split('\n').find(
  (line) => line.trim().length > 20,
);
if (contractQuote === undefined) throw new Error('fixture contract quote');

describe('independent evidence must identify visible case material', () => {
  test.each(
    (['chat', 'decision'] as const).flatMap((protocol) =>
      [
        { name: 'space', quote: ' ' },
        { name: 'newline', quote: '\n' },
        { name: 'scoring contract', quote: contractQuote },
        { name: 'material instruction', quote: POLICY_NOTE },
      ].map((value) => ({ protocol, ...value })),
    ),
  )(
    '$protocol rejects $name and preserves the invalid replies',
    async ({ protocol, quote }) => {
      await withDataset(async (temp) => {
        const dataset = join(temp.path, 'data');
        await temp.write(
          'data/dev/f01/workflows.json',
          collectionOf(workflow()),
        );
        const context = { ...DEFAULT_ANNOTATION_CONTEXT, protocol };
        const f = await exportWorkflowBatch({
          root: temp.path,
          dataset,
          split: 'dev',
          group: 'f01',
          models: models(3),
          context,
          out: join(temp.path, 'pack'),
        });
        {
          const returned = returns(f.batch, { evidence: [quote] });
          await importWorkflowOpinions({
            dataset,
            baseline: f.baseline,
            returned,
            write: true,
          });
          const current = (
            await workflowReferences({
              dataset,
              split: 'dev',
              group: 'f01',
              context,
            })
          ).entries[0];
          expect(current?.source).toBe('unresolved');
          expect(current?.consensus?.n).toBe(3);
          expect(current?.consensus?.valid).toBe(0);
          const state = workflowRecords(
            await workflowState(dataset, 'dev', 'f01'),
          );
          for (const response of returned.responses) {
            const saved = state.opinions.find(
              (value) => value.opinion.reviewId === response.responseId,
            );
            expect(saved?.annotation?.rawResponse).toBe(response.rawResponse);
            expect(saved?.annotation?.parsed).toEqual(
              JSON.parse(response.rawResponse ?? 'null'),
            );
            expect(saved?.annotation?.complete).toBe(false);
          }
        }
        // The first complete case-fact answers can repair earlier invalid attempts.
        const material = materialStrings(f.batch.points[0]?.request).find(
          (text) => text.includes('PENDING_ACTION\n'),
        );
        if (material === undefined) throw new Error('fixture action material');
        const start = material.indexOf('PENDING_ACTION\n');
        const end = material.indexOf('\n\nACTION_FACTS', start);
        if (end < start) throw new Error('fixture action block');
        await importWorkflowOpinions({
          dataset,
          baseline: f.baseline,
          returned: returns(f.batch, {
            evidence: [material.slice(start, end)],
          }),
          write: true,
        });
        const current = (
          await workflowReferences({
            dataset,
            split: 'dev',
            group: 'f01',
            context,
          })
        ).entries[0];
        expect(current?.source).toBe('model-consensus');
        expect(current?.consensus?.valid).toBe(3);
        const state = workflowRecords(
          await workflowState(dataset, 'dev', 'f01'),
        );
        expect(
          state.opinions.filter(
            (value) => value.annotation?.rawResponse !== null,
          ),
        ).toHaveLength(6);
      });
    },
    30_000,
  );

  test('reloading complete=true opinions rechecks evidence and rationale before dynamic adoption', async () => {
    await withWorkflowAnnotation(async (f) => {
      await importWorkflowOpinions({
        ...f,
        returned: returns(f.batch),
        write: true,
      });
      const file = join(f.dataset, 'dev/f01/opinions.json');
      const initial = await readFile(file, 'utf8');
      const state = workflowRecords(
        await workflowState(f.dataset, 'dev', 'f01'),
      );
      for (const evidence of [
        [],
        [{ kind: 'material-quote' as const, ref: ' ' }],
        [{ kind: 'material-quote' as const, ref: contractQuote }],
      ]) {
        await writeFile(
          file,
          JSON.stringify(
            collectionOf(
              ...state.opinions.map((value) =>
                value.annotation?.complete ? { ...value, evidence } : value,
              ),
            ),
          ),
        );
        const current = (
          await workflowReferences({
            dataset: f.dataset,
            split: 'dev',
            group: 'f01',
            context: DEFAULT_ANNOTATION_CONTEXT,
          })
        ).entries[0];
        expect(current?.source).toBe('unresolved');
        expect(current?.consensus?.n).toBe(3);
        expect(current?.consensus?.valid).toBe(0);
      }
      await writeFile(
        file,
        JSON.stringify(
          collectionOf(
            ...state.opinions.map((value) =>
              value.annotation?.complete
                ? { ...value, rationale: ' \n ' }
                : value,
            ),
          ),
        ),
      );
      expect(
        (
          await workflowReferences({
            dataset: f.dataset,
            split: 'dev',
            group: 'f01',
            context: DEFAULT_ANNOTATION_CONTEXT,
          })
        ).entries[0]?.source,
      ).toBe('unresolved');
      await writeFile(file, initial);
      expect(
        (
          await workflowReferences({
            dataset: f.dataset,
            split: 'dev',
            group: 'f01',
            context: DEFAULT_ANNOTATION_CONTEXT,
          })
        ).entries[0]?.source,
      ).toBe('model-consensus');
    });
  }, 30_000);
});
