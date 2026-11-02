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

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
describe('workflow role publication interruption', () => {
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
