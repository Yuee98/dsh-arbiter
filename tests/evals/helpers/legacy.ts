import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compileCheckers } from '../../../evals/src/data/schemas.js';
import type { AnnotationDocument } from '../../../evals/src/data/types.js';
import { REPOSITORY_ROOT, temporaryDataset } from './dataset.js';
export async function withLegacy(
  body: (root: string, dataset: string) => Promise<void>,
): Promise<void> {
  const area = await temporaryDataset();
  try {
    const dataset = join(area.path, 'data');
    await cp(join(REPOSITORY_ROOT, 'evals/datasets/reviewer-v2'), dataset, {
      recursive: true,
    });
    await body(area.path, dataset);
  } finally {
    await area.remove();
  }
}
export async function readBatch(file: string): Promise<{
  batchVersion: string;
  batchId: string;
  pack: AnnotationDocument;
}> {
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (
    value === null ||
    typeof value !== 'object' ||
    !('batchVersion' in value) ||
    typeof value.batchVersion !== 'string' ||
    !('batchId' in value) ||
    typeof value.batchId !== 'string' ||
    !('pack' in value)
  )
    throw new Error('invalid test batch');
  const checked = (await compileCheckers()).annotation(value.pack);
  if (!checked.ok) throw new Error(checked.problems.join('; '));
  return {
    batchVersion: value.batchVersion,
    batchId: value.batchId,
    pack: checked.document,
  };
}
export async function fillBatch(
  file: string,
  caseId: string,
  rationale: string,
): Promise<void> {
  const batch = await readBatch(file);
  const checked = (await compileCheckers()).label(
    JSON.parse(
      await readFile(
        join(REPOSITORY_ROOT, `evals/datasets/core-v1/labels/${caseId}.json`),
        'utf8',
      ),
    ),
  );
  if (!checked.ok) throw new Error(checked.problems.join('; '));
  const target = {
    ...checked.document.target,
    rationale,
    decidedBy: 'fixture-only',
  };
  await writeFile(
    file,
    JSON.stringify({
      ...batch,
      pack: {
        ...batch.pack,
        entries: batch.pack.entries.map((e) =>
          e.caseId === caseId ? { ...e, target } : e,
        ),
      },
    }),
  );
}
