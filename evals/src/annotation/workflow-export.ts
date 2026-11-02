/** Export succeeds only after every model is durably registered, including missing replies. */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CredentialRedactor } from '../../../src/reviewer/credential-redactor.js';
import { canonicalJson } from '../data/hash.js';
import { sameAnnotationView } from '../data/annotation-binding.js';
import type { AnnotationContext } from '../data/annotation-types.js';
import type { Split } from '../data/types.js';
import type { AnnotationPoint, WorkflowBatch } from './workflow-types.js';
import { registeredModels } from './workflow-validation.js';
import {
  annotationContext,
  buildAnnotationView,
  independentQuestion,
  workflowSource,
} from './workflow-view.js';
import {
  assertWorkflowOutput,
  changeWorkflowGroup,
  mergeOpinions,
  workflowRecords,
  workflowState,
} from './workflow-store.js';
import { registrationOpinions } from './workflow-opinion.js';
import { annotationOrigin } from './workflow-origin.js';

export async function exportWorkflowBatch(options: {
  readonly root: string;
  readonly dataset: string;
  readonly split: Split;
  readonly group: string;
  readonly models: unknown;
  readonly context: AnnotationContext;
  readonly out: string;
}): Promise<{ readonly batch: WorkflowBatch; readonly baseline: string }> {
  const dataset = resolve(options.root, options.dataset),
    out = resolve(options.root, options.out);
  assertWorkflowOutput(options.root, dataset, out);
  const models = registeredModels(options.models),
    context = annotationContext(options.context);
  // Configuration descriptors are not a secret storage channel.
  const redactor = new CredentialRedactor('annotation-config');
  if (
    canonicalJson(redactor.value({ models, context })) !==
    canonicalJson({ models, context })
  )
    throw new Error(
      'annotation descriptors/context must be supplied without credential values',
    );
  const source = await workflowSource(dataset, options.split, options.group);
  const records = workflowRecords(
    await workflowState(dataset, options.split, options.group),
  );
  const points: AnnotationPoint[] = [];
  for (const entry of source.groups.flatMap((group) => group.workflows))
    for (const point of entry.document.points) {
      const identity = {
        questionId: randomUUID(),
        rootId: entry.document.rootId,
        pointId: point.pointId,
        viewId: point.primaryViewId,
        modelReferenceId: randomUUID(),
        humanReferenceId: randomUUID(),
        registrations: models.map((model) => ({
          modelKey: model.modelKey,
          reviewId: randomUUID(),
        })),
      };
      try {
        const view = await buildAnnotationView(
          source,
          entry.document.rootId,
          point.pointId,
          context,
        );
        const applicable = records.labels.filter(
          (label) =>
            label.pointId === point.pointId &&
            label.annotation !== undefined &&
            sameAnnotationView(label.annotation.binding, view.binding),
        );
        points.push({
          ...identity,
          ...view,
          modelReferenceId:
            applicable.find((label) =>
              ['model-consensus', 'unresolved'].includes(label.source),
            )?.referenceId ?? identity.modelReferenceId,
          humanReferenceId:
            applicable.find(
              (label) =>
                label.source === 'human' &&
                label.annotation?.humanState !== 'draft',
            )?.referenceId ?? identity.humanReferenceId,
          error: null,
        });
      } catch (error) {
        points.push({
          ...identity,
          binding: null,
          request: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  const batch: WorkflowBatch = {
    batchVersion: 'workflow-annotation-v1',
    batchId: randomUUID(),
    dataset,
    split: options.split,
    group: options.group,
    createdAt: new Date().toISOString().slice(0, 10),
    ...(await annotationOrigin(options.root)),
    context,
    models,
    points,
    ...records,
  };
  const baseline = resolve(
    options.root,
    '.local/evals/workflow-annotation',
    `${batch.batchId}.json`,
  );
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out);
  for (const point of points)
    if (point.binding !== null)
      await writeFile(
        join(out, `${point.questionId}.json`),
        JSON.stringify(
          independentQuestion(point.questionId, point.request),
          null,
          2,
        ) + '\n',
        { flag: 'wx' },
      );
  await writeFile(
    join(out, 'README.txt'),
    '每个题号文件必须在全新独立上下文中转交；不要把整个目录交给同一个上下文。共享说明与空答案格式已包含在每题文件。用户转交模型答案不构成人工确认。\n',
    { flag: 'wx' },
  );
  await writeFile(
    join(out, 'returns-template.json'),
    JSON.stringify({ batchId: batch.batchId, responses: [] }, null, 2) + '\n',
    { flag: 'wx' },
  );
  await mkdir(dirname(baseline), { recursive: true });
  await writeFile(baseline, JSON.stringify(batch, null, 2) + '\n', {
    flag: 'wx',
  });
  try {
    await changeWorkflowGroup(
      dataset,
      batch.split,
      batch.group,
      true,
      (current) => {
        const now = workflowRecords(current);
        // An export registers opinions, it never mutates a human or cached label.
        return {
          labels: now.labels,
          opinions: mergeOpinions(now.opinions, registrationOpinions(batch)),
          result: undefined,
        };
      },
    );
  } catch (error) {
    throw new Error(
      `export registration incomplete; retained pack and baseline ${baseline}; import an empty responses array to resume: ${String(error)}`,
      { cause: error },
    );
  }
  return { batch, baseline };
}
