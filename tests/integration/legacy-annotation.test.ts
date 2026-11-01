import { readFile, writeFile, open, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  exportLegacyBatch,
  importLegacyBatch,
} from '../../evals/src/annotation/legacy-batch.js';
import { withLegacy, readBatch, fillBatch } from '../evals/helpers/legacy.js';
import { readDataset } from '../../evals/src/data/read.js';
import { inspectDataset } from '../../evals/src/data/inspect.js';
import { compileCheckers } from '../../evals/src/data/schemas.js';

const first = 'read-named-source-file';
const second = 'read-repo-index-with-cache';
const current = { contract: 'review-contract-v1', rubric: 'review-rubric-v1' };

describe('legacy annotation baseline and atomic collection writes', () => {
  it('exports blind selected material, imports byID, preserves opinions, and is idempotent', async () => {
    await withLegacy(async (root, dataset) => {
      await writeFile(join(dataset, 'holdout/legacy-v1/cases.json'), '{broken');
      const file = join(root, 'pack.json');
      expect(await exportLegacyBatch(root, dataset, 'dev', file)).toBe(13);
      const batch = await readBatch(file);
      expect(batch.pack.entries).toHaveLength(13);
      expect(JSON.stringify(batch)).not.toContain('allowedPairs');
      expect(
        batch.pack.entries.every((e) => e.target.status === 'pending'),
      ).toBe(true);
      const opinions = await readFile(
        join(dataset, 'dev/legacy-v1/opinions.json'),
        'utf8',
      );
      await fillBatch(file, first, 'fixture edited reason');
      const filled = await readBatch(file);
      await writeFile(
        file,
        JSON.stringify({
          ...filled,
          pack: { ...filled.pack, entries: [...filled.pack.entries].reverse() },
        }),
      );
      expect(await importLegacyBatch(root, dataset, file, true, 'dev')).toBe(1);
      expect(await importLegacyBatch(root, dataset, file, true, 'dev')).toBe(1);
      const inspected = inspectDataset(
        await readDataset(dataset, { split: 'dev' }),
        await compileCheckers(),
        current,
      );
      expect(inspected.problems).toEqual([]);
      expect(
        inspected.labels.gold.find((e) => e.label.caseId === first)?.label
          .target.rationale,
      ).toBe('fixture edited reason');
      expect(
        await readFile(join(dataset, 'dev/legacy-v1/opinions.json'), 'utf8'),
      ).toBe(opinions);
    });
  }, 30_000);
  it('rejects case input drift and releases the group claim without touching labels', async () => {
    await withLegacy(async (root, dataset) => {
      const file = join(root, 'pack.json');
      await exportLegacyBatch(root, dataset, 'dev', file);
      await fillBatch(file, first, 'stale-input fixture');
      const cases = join(dataset, 'dev/legacy-v1/cases.json');
      const checked = (await compileCheckers()).groupedCases(
        JSON.parse(await readFile(cases, 'utf8')),
      );
      if (!checked.ok) throw new Error(checked.problems.join('; '));
      await writeFile(
        cases,
        JSON.stringify({
          ...checked.document,
          records: checked.document.records.map((e) =>
            e.caseId === first
              ? { ...e, input: { ...e.input, hint: 'changed input fixture' } }
              : e,
          ),
        }),
      );
      const labels = join(dataset, 'dev/legacy-v1/labels.json');
      const before = await readFile(labels, 'utf8');
      await expect(
        importLegacyBatch(root, dataset, file, true, 'dev'),
      ).rejects.toThrow('input');
      expect(await readFile(labels, 'utf8')).toBe(before);
      await expect(
        readFile(join(dataset, 'dev/legacy-v1/.labels.lock')),
      ).rejects.toThrow();
    });
  }, 30_000);
  it('refuses a stale targeted label baseline but merges independent decisions', async () => {
    await withLegacy(async (root, dataset) => {
      const a = join(root, 'a.json'),
        b = join(root, 'b.json'),
        c = join(root, 'c.json');
      for (const f of [a, b, c])
        await exportLegacyBatch(root, dataset, 'dev', f);
      await fillBatch(a, first, 'first writer');
      await fillBatch(b, first, 'stale competing writer');
      await fillBatch(c, second, 'independent writer');
      await importLegacyBatch(root, dataset, a, true, 'dev');
      const source = join(dataset, 'dev/legacy-v1/labels.json');
      const before = await readFile(source, 'utf8');
      await expect(
        importLegacyBatch(root, dataset, b, true, 'dev'),
      ).rejects.toThrow('annotation conflict');
      expect(await readFile(source, 'utf8')).toBe(before);
      await importLegacyBatch(root, dataset, c, true, 'dev');
      const data = inspectDataset(
        await readDataset(dataset, { split: 'dev' }),
        await compileCheckers(),
        current,
      );
      expect(
        data.labels.gold.find((e) => e.label.caseId === first)?.label.target
          .rationale,
      ).toBe('first writer');
      expect(
        data.labels.gold.find((e) => e.label.caseId === second)?.label.target
          .rationale,
      ).toBe('independent writer');
    });
  }, 30_000);
  it('rejects wrong split and changed family, duplicate IDs, unknown metadata, without writes', async () => {
    await withLegacy(async (root, dataset) => {
      const file = join(root, 'pack.json');
      await exportLegacyBatch(root, dataset, 'dev', file);
      await fillBatch(file, first, 'fixture');
      const original = await readBatch(file);
      const path = join(dataset, 'dev/legacy-v1/labels.json');
      const before = await readFile(path, 'utf8');
      await expect(
        importLegacyBatch(root, dataset, file, true, 'holdout'),
      ).rejects.toThrow('split differs');
      for (const pack of [
        {
          ...original.pack,
          entries: original.pack.entries.map((e, i) =>
            i === 0 ? { ...e, familyId: 'foreign' } : e,
          ),
        },
        {
          ...original.pack,
          entries: [...original.pack.entries, original.pack.entries[0]],
        },
      ]) {
        await writeFile(file, JSON.stringify({ ...original, pack }));
        await expect(
          importLegacyBatch(root, dataset, file, true, 'dev'),
        ).rejects.toThrow('membership');
      }
      await writeFile(
        file,
        JSON.stringify({ ...original, secretAnswer: 'not valid metadata' }),
      );
      await expect(
        importLegacyBatch(root, dataset, file, true, 'dev'),
      ).rejects.toThrow('versioned legacy');
      expect(await readFile(path, 'utf8')).toBe(before);
    });
  }, 30_000);
  it('handles missing labels and pending rows; busy claims and symlink sources cannot write', async () => {
    await withLegacy(async (root, dataset) => {
      const labels = join(dataset, 'dev/legacy-v1/labels.json');
      await rm(labels);
      const file = join(root, 'pack.json');
      await exportLegacyBatch(root, dataset, 'dev', file);
      expect(await importLegacyBatch(root, dataset, file, true, 'dev')).toBe(0);
      await expect(readFile(labels)).rejects.toThrow();
      await fillBatch(file, first, 'new fixture reference');
      const lockPath = join(dataset, 'dev/legacy-v1/.labels.lock');
      const lock = await open(lockPath, 'wx');
      try {
        await expect(
          importLegacyBatch(root, dataset, file, true, 'dev'),
        ).rejects.toThrow();
        await expect(readFile(labels)).rejects.toThrow();
      } finally {
        await lock.close();
        await rm(lockPath);
      }
      await importLegacyBatch(root, dataset, file, true, 'dev');
      const bytes = await readFile(labels, 'utf8');
      await rm(labels);
      const alias = join(root, 'outside.json');
      await writeFile(alias, bytes);
      await symlink(alias, labels);
      await expect(
        importLegacyBatch(root, dataset, file, true, 'dev'),
      ).rejects.toThrow('regular file');
      expect(await readFile(alias, 'utf8')).toBe(bytes);
    });
  }, 30_000);
});
