import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { withLegacy, fillBatch } from '../evals/helpers/legacy.js';
import {
  exportLegacyBatch,
  importLegacyBatch,
} from '../../evals/src/annotation/legacy-batch.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

describe('legacy label publication failure', () => {
  it('leaves source bytes intact and releases its own lock/temp when rename fails', async () => {
    await withLegacy(async (root, dataset) => {
      const file = join(root, 'fill.json');
      await exportLegacyBatch(root, dataset, 'dev', file);
      await fillBatch(file, 'read-named-source-file', 'publication fixture');
      const directory = join(dataset, 'dev/legacy-v1');
      const path = join(directory, 'labels.json');
      const before = await fs.readFile(path, 'utf8');
      vi.mocked(fs.rename).mockRejectedValueOnce(
        new Error('injected I/O publication failure'),
      );
      await expect(
        importLegacyBatch(root, dataset, file, true, 'dev'),
      ).rejects.toThrow('publication failure');
      expect(await fs.readFile(path, 'utf8')).toBe(before);
      expect(
        (await fs.readdir(directory)).filter((name) =>
          name.startsWith('.labels'),
        ),
      ).toEqual([]);
      await importLegacyBatch(root, dataset, file, true, 'dev');
      expect(await fs.readFile(path, 'utf8')).toContain('publication fixture');
    });
  }, 30_000);
});
