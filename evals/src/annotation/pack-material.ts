import { resolve } from 'node:path';
import { readWorkflowBatch } from './workflow-batch-read.js';
import { buildAnnotationView, workflowSource } from './workflow-view.js';
import { comparableAnnotationRequest } from './workflow-binding.js';
import { sameAnnotationView } from '../data/annotation-binding.js';
import { assertSelected } from './pack-selection.js';

export async function validatedPackBatch(dataset: string, path: string) {
  const batch = await readWorkflowBatch(path);
  if (resolve(dataset) !== batch.dataset)
    throw new Error('batch belongs to another dataset');
  const source = await workflowSource(dataset, batch.split, batch.group);
  for (const point of batch.points) {
    assertSelected(source, { ...point, group: batch.group });
    const actual = await buildAnnotationView(
      source,
      point.rootId,
      point.pointId,
      batch.context,
    );
    if (
      point.binding === null ||
      !sameAnnotationView(point.binding, actual.binding) ||
      comparableAnnotationRequest(point.request).text !==
        comparableAnnotationRequest(actual.request).text
    )
      throw new Error('prepared production material changed or was altered');
  }
  return batch;
}
