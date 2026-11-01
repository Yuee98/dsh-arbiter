/** Annotation exports are outputs, never permission to overwrite source evidence. */
import { destinationsInside } from '../report/write.js';
import { datasetEvidence } from '../data/source-evidence.js';
export function assertAnnotationOutput(
  root: string,
  dataset: string,
  path: string,
): void {
  if (destinationsInside([path], datasetEvidence(root, dataset)).length > 0)
    throw new Error(
      `annotation output would overwrite protected source evidence: ${path}`,
    );
}
