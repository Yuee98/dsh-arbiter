import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { reviewCase } from './fixtures/documents.js';
import { collectionOf, workflow } from './fixtures/workflow.js';
import { withDataset } from './helpers/dataset.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
beforeEach(() => {
  vi.resetModules();
  vi.mocked(fs.readFile).mockClear();
});

test('concurrent default callers share one published compilation and still accept and reject real documents', async () => {
  const { compileCheckers } = await import('../../evals/src/data/schemas.js');
  const first = compileCheckers();
  const concurrent = compileCheckers();
  expect(concurrent).toBe(first);
  const checkers = await first;
  const reads = vi.mocked(fs.readFile).mock.calls.length;
  expect(reads).toBeGreaterThan(0);
  expect(await concurrent).toBe(checkers);
  expect(await compileCheckers()).toBe(checkers);
  expect(vi.mocked(fs.readFile).mock.calls).toHaveLength(reads);
  expect(checkers.workflows(collectionOf(workflow())).ok).toBe(true);
  expect(
    checkers.workflows(collectionOf({ ...workflow(), expectedRisk: 9 })).ok,
  ).toBe(false);
});

test('a failed shared compilation is cleared so a later caller can read the schemas and recover', async () => {
  const { compileCheckers } = await import('../../evals/src/data/schemas.js');
  vi.mocked(fs.readFile).mockRejectedValueOnce(
    new Error('temporary schema read failure'),
  );
  const first = compileCheckers();
  expect(compileCheckers()).toBe(first);
  await expect(first).rejects.toThrow('temporary schema read failure');
  const recovered = compileCheckers();
  expect(recovered).not.toBe(first);
  const checkers = await recovered;
  expect(checkers.workflows(collectionOf(workflow())).ok).toBe(true);
  expect(
    checkers.workflows(collectionOf({ ...workflow(), expectedRisk: 9 })).ok,
  ).toBe(false);
});

test('explicit custom schemas are recompiled after edits without poisoning the published cache', async () => {
  await withDataset(async (f) => {
    const { compileCheckers, SCHEMA_DIRECTORY } =
      await import('../../evals/src/data/schemas.js');
    const published = await compileCheckers();
    const directory = join(f.path, 'schemas');
    await fs.cp(SCHEMA_DIRECTORY, directory, { recursive: true });
    const first = await compileCheckers(directory);
    expect(first.case(reviewCase()).ok).toBe(true);
    const file = join(directory, 'case.schema.json');
    const document: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (document === null || typeof document !== 'object')
      throw new Error('schema fixture');
    await fs.writeFile(file, JSON.stringify({ ...document, not: {} }));
    const edited = await compileCheckers(directory);
    expect(edited.case(reviewCase()).ok).toBe(false);
    expect(published.case(reviewCase()).ok).toBe(true);
    expect(await compileCheckers()).toBe(published);
    expect(await compileCheckers(SCHEMA_DIRECTORY)).not.toBe(published);
  });
});
