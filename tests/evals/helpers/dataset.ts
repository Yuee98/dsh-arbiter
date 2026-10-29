/**
 * Writing a dataset directory for a test.
 *
 * The checks under test read from disk, so a test that only built objects in memory
 * would exercise a different code path from the command a person runs. Each helper
 * writes real files under a fresh temporary directory and removes it again, so a
 * test never commits a fixture and never touches the repository.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root, which the resolution and rubric checks read from. */
export const REPOSITORY_ROOT = fileURLToPath(
  new URL('../../../', import.meta.url),
);

/** One dataset written to a temporary directory. */
export interface TemporaryDataset {
  readonly path: string;
  /** Write or replace one dataset-relative document. */
  write(relative: string, document: unknown): Promise<void>;
  remove(): Promise<void>;
}

/** A fresh directory, removed when the test is done. */
export async function temporaryDataset(): Promise<TemporaryDataset> {
  const path = await mkdtemp(join(tmpdir(), 'arbiter-evals-'));
  return {
    path,
    async write(relative: string, document: unknown): Promise<void> {
      const file = join(path, relative);
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    },
    async remove(): Promise<void> {
      await rm(path, { recursive: true, force: true });
    },
  };
}

/**
 * Run one body against a temporary dataset that is always cleaned up.
 *
 * A `try/finally` in every test would be noise; the cleanup is the point of the
 * wrapper, and a leaked temporary directory would otherwise accumulate.
 */
export async function withDataset(
  body: (dataset: TemporaryDataset) => Promise<void>,
): Promise<void> {
  const dataset = await temporaryDataset();
  try {
    await body(dataset);
  } finally {
    await dataset.remove();
  }
}
