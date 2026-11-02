import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  withWorkflowAnnotation,
  returns,
} from '../evals/helpers/workflow-annotation.js';
import { importWorkflowOpinions } from '../../evals/src/annotation/workflow-service.js';
import {
  workflowRecords,
  workflowState,
} from '../../evals/src/annotation/workflow-store.js';
import { collectionOf } from '../evals/fixtures/workflow.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
describe('workflow role publication interruption', () => {
  test('a human edit between role publications is preserved while received opinions remain recoverable', async () => {
    await withWorkflowAnnotation(async (f) => {
      const point = f.batch.points[0];
      if (point?.binding === undefined || point.binding === null)
        throw new Error('fixture');
      const human = {
        referenceId: 'external-human',
        rootId: point.rootId,
        pointId: point.pointId,
        viewId: point.viewId,
        batchId: f.batch.batchId,
        versions: point.binding.versions,
        source: 'human',
        humanConfirmed: true,
        scoringEligible: true,
        supportingOpinionIds: [],
        annotation: { binding: point.binding, humanState: 'confirmed' },
        target: {
          status: 'approved',
          allowed: { risk: [3], authorization: [10] },
          allowedPairs: [[3, 10]],
          behaviourReference: 'deny',
          rationale: 'synthetic intervening human decision',
          decidedBy: 'synthetic-human',
          decidedAt: '2026-11-02',
        },
      };
      const actual = await vi.importActual<typeof fs>('node:fs/promises');
      vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
        await actual.rename(from, to);
        await fs.writeFile(
          join(f.dataset, 'dev/f01/labels.json'),
          JSON.stringify(collectionOf(human)),
        );
      });
      const returned = returns(f.batch);
      await expect(
        importWorkflowOpinions({ ...f, returned, write: true }),
      ).rejects.toThrow(/opinions retained; labels were not updated/u);
      const state = workflowRecords(
        await workflowState(f.dataset, 'dev', 'f01'),
      );
      expect(
        state.opinions.filter((value) => !value.annotation?.registration),
      ).toHaveLength(3);
      expect(state.labels).toEqual([human]);
      await importWorkflowOpinions({ ...f, returned, write: true });
      expect(
        workflowRecords(
          await workflowState(f.dataset, 'dev', 'f01'),
        ).labels.find((value) => value.referenceId === 'external-human'),
      ).toEqual(human);
    });
  }, 30_000);
  test('retains raw opinions after a label rename failure and retries without duplicate attempts/votes', async () => {
    await withWorkflowAnnotation(async (f) => {
      const returned = returns(f.batch);
      const actual = await vi.importActual<typeof fs>('node:fs/promises');
      vi.mocked(fs.rename)
        .mockImplementationOnce(actual.rename)
        .mockRejectedValueOnce(new Error('injected label rename failure'));
      await expect(
        importWorkflowOpinions({ ...f, returned, write: true }),
      ).rejects.toThrow(/opinions retained; labels were not updated/u);
      const retained = workflowRecords(
        await workflowState(f.dataset, 'dev', 'f01'),
      );
      expect(retained.labels).toEqual([]);
      expect(
        retained.opinions.filter((value) => !value.annotation?.registration),
      ).toHaveLength(3);
      const before = await fs.readFile(
        join(f.dataset, 'dev/f01/opinions.json'),
        'utf8',
      );
      expect(
        (await fs.readdir(join(f.dataset, 'dev/f01'))).filter((name) =>
          name.startsWith('.'),
        ),
      ).toEqual([]);
      await importWorkflowOpinions({ ...f, returned, write: true });
      expect(
        await fs.readFile(join(f.dataset, 'dev/f01/opinions.json'), 'utf8'),
      ).toBe(before);
      const restored = workflowRecords(
        await workflowState(f.dataset, 'dev', 'f01'),
      );
      expect(restored.labels[0]?.source).toBe('model-consensus');
      expect(restored.labels[0]?.humanConfirmed).toBe(false);
    });
  }, 30_000);
});
