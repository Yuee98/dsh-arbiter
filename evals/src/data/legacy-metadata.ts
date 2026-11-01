/** The retained historical manifest is the existing legacy identity/split authority. */
import { readFile } from 'node:fs/promises';
import { hasDatasetManifest } from './dataset-layout.js';
import { compileCheckers } from './schemas.js';
import type { DatasetManifest } from './types.js';
export async function legacyMetadata(): Promise<DatasetManifest> {
  const value: unknown = JSON.parse(
    await readFile(
      new URL('../../datasets/core-v1/manifest.json', import.meta.url),
      'utf8',
    ),
  );
  const checked = (await compileCheckers()).manifest(value);
  if (!checked.ok)
    throw new Error(
      `historical legacy metadata: ${checked.problems.join('; ')}`,
    );
  return checked.document;
}

/** Mixed-layout collections are format previews; their single-document source
 * is checked separately. Only manifest-free legacy groups are the migration. */
export async function groupedLegacyAuthority(
  dataset: string,
): Promise<DatasetManifest | undefined> {
  return (await hasDatasetManifest(dataset)) ? undefined : legacyMetadata();
}
