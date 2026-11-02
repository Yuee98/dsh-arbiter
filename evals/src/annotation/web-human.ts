import { randomUUID } from 'node:crypto';
import type { AnnotationContext } from '../data/annotation-types.js';
import type { Split } from '../data/types.js';
import type { WorkflowBatch } from './workflow-types.js';
import type { DraftPoint } from './web-draft-store.js';
import { sameAnnotationView } from '../data/annotation-binding.js';
import { buildAnnotationView } from './workflow-view.js';
import type { GroupedDataset } from '../data/group-types.js';
import { workflowRecords, workflowState } from './workflow-store.js';
import { canonicalJson } from '../data/hash.js';

export async function createHumanBatch(
  dataset: string,
  split: Split,
  point: DraftPoint,
  context: AnnotationContext,
): Promise<WorkflowBatch> {
  const source = await workflowState(dataset, split, point.group, true);
  const view = await buildAnnotationView(
    source,
    point.rootId,
    point.pointId,
    context,
  );
  const records = workflowRecords(source);
  const previous = records.labels.find(
    (label) =>
      label.source === 'human' &&
      label.pointId === point.pointId &&
      label.viewId === point.viewId &&
      label.annotation?.humanState !== 'draft' &&
      label.annotation !== undefined &&
      sameAnnotationView(label.annotation.binding, view.binding),
  );
  return {
    batchVersion: 'workflow-annotation-v1',
    purpose: 'human',
    batchId: randomUUID(),
    dataset,
    split,
    group: point.group,
    createdAt: new Date().toISOString().slice(0, 10),
    sourceCommit: null,
    sourceDirty: null,
    context,
    models: [],
    opinions: [],
    labels: records.labels,
    points: [
      {
        questionId: point.token,
        rootId: point.rootId,
        pointId: point.pointId,
        viewId: point.viewId,
        modelReferenceId: randomUUID(),
        humanReferenceId: previous?.referenceId ?? randomUUID(),
        ...view,
        error: null,
        registrations: [],
      },
    ],
  };
}
export async function checkHumanView(
  batch: WorkflowBatch,
  source?: GroupedDataset,
): Promise<void> {
  const point = batch.points[0];
  if (point?.binding === undefined || point.binding === null)
    throw new Error('material preparation failed');
  const current =
    source ??
    (await workflowState(batch.dataset, batch.split, batch.group, true));
  const actual = await buildAnnotationView(
    current,
    point.rootId,
    point.pointId,
    batch.context,
  );
  if (!sameAnnotationView(point.binding, actual.binding))
    throw new Error('conflict: current material changed; reopen and review');
}
export async function checkHumanDraftBaseline(
  batch: WorkflowBatch,
): Promise<void> {
  const source = await workflowState(
    batch.dataset,
    batch.split,
    batch.group,
    true,
  );
  await checkHumanView(batch, source);
  const current = workflowRecords(source);
  const point = batch.points[0];
  if (point === undefined) throw new Error('missing human point');
  const relevant = (labels: WorkflowBatch['labels']) =>
    labels
      .filter(
        (label) =>
          label.pointId === point.pointId &&
          label.viewId === point.viewId &&
          ['human', 'human-inherited'].includes(label.source) &&
          label.annotation?.humanState !== 'draft' &&
          label.annotation !== undefined &&
          point.binding !== null &&
          sameAnnotationView(label.annotation.binding, point.binding),
      )
      .sort((a, b) => a.referenceId.localeCompare(b.referenceId));
  if (
    canonicalJson(relevant(batch.labels)) !==
    canonicalJson(relevant(current.labels))
  )
    throw new Error(
      'conflict: related human decision changed; reopen and review',
    );
}
