/** Known evidence paths, independent of whether the selected data can be parsed. */
import { join, resolve } from 'node:path';
import type { EvidencePath } from '../report/write.js';
export function datasetEvidence(
  root: string,
  dataset: string,
): readonly EvidencePath[] {
  const evidence: EvidencePath[] = [
    { path: resolve(root, 'evals/datasets/core-v1'), kind: 'directory' },
    {
      path: resolve(root, 'evals/annotation-pack/core-v1.pack.json'),
      kind: 'file',
    },
    {
      path: resolve(root, '.local/evals/annotation-batches'),
      kind: 'directory',
    },
  ];
  for (const base of new Set([
    resolve(root, dataset),
    resolve(root, 'evals/datasets/reviewer-v2'),
  ])) {
    evidence.push({ path: join(base, 'manifest.json'), kind: 'file' });
    for (const name of ['cases', 'labels', 'reviews'])
      evidence.push({ path: join(base, name), kind: 'directory' });
    for (const split of ['dev', 'calibration', 'holdout'])
      for (const role of ['cases', 'labels', 'opinions', 'authoring'])
        evidence.push({
          path: join(base, split, 'legacy-v1', `${role}.json`),
          kind: 'file',
        });
  }
  return evidence;
}
