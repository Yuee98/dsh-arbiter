/** Synthetic engineering answers only: no external model or human adjudication. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { exportWorkflowBatch } from '../../../evals/src/annotation/workflow-export.js';
import { DEFAULT_ANNOTATION_CONTEXT } from '../../../evals/src/annotation/workflow-view.js';
import type {
  WorkflowBatch,
  RegisteredModel,
  ReturnedBatch,
} from '../../../evals/src/annotation/workflow-types.js';
import type { IndependentAnswer } from '../../../evals/src/data/annotation-types.js';
import type { WorkflowOpinion } from '../../../evals/src/data/group-types.js';
import { withDataset } from './dataset.js';
import { collectionOf, workflow } from '../fixtures/workflow.js';

export const quote = '可以清理生成目录 build/；保留 assets/。';
export function models(count: number, start = 0): readonly RegisteredModel[] {
  return Array.from({ length: count }, (_, index) => ({
    modelKey: `synthetic-${String(index + start)}`,
    aliases: [],
    model: {
      provider: 'synthetic-fixture',
      id: `model-${String(index + start)}`,
      version: null,
      versionSource: 'unknown' as const,
    },
    parameters: { temperature: 0 },
  }));
}
export function answer(
  patch: Partial<IndependentAnswer> = {},
): IndependentAnswer {
  return {
    pairs: [[3, 10]],
    behaviourReference: 'allow',
    rationale: 'Synthetic engineering fixture; not a real model opinion.',
    evidence: [quote],
    conflicts: [],
    ...patch,
  };
}
export function returns(
  batch: WorkflowBatch,
  patch: Partial<IndependentAnswer> = {},
  keys = batch.models.map((model) => model.modelKey),
): ReturnedBatch {
  const questionId = batch.points[0]?.questionId;
  if (questionId === undefined) throw new Error('fixture needs a point');
  return {
    batchId: batch.batchId,
    responses: keys.map((modelKey) => ({
      responseId: randomUUID(),
      questionId,
      modelKey,
      rawResponse: JSON.stringify(answer(patch)),
      error: null,
    })),
  };
}
export async function withWorkflowAnnotation(
  body: (fixture: {
    readonly root: string;
    readonly dataset: string;
    readonly baseline: string;
    readonly batch: WorkflowBatch;
    readonly out: string;
  }) => Promise<void>,
  count = 3,
): Promise<void> {
  await withDataset(async (temporary) => {
    const root = temporary.path,
      dataset = join(root, 'data'),
      out = join(root, 'pack');
    await temporary.write(
      'data/dev/f01/workflows.json',
      collectionOf(workflow()),
    );
    const exported = await exportWorkflowBatch({
      root,
      dataset,
      split: 'dev',
      group: 'f01',
      models: models(count),
      context: DEFAULT_ANNOTATION_CONTEXT,
      out,
    });
    await body({ root, dataset, out, ...exported });
  });
}
export function opinion(
  index: number,
  patch: Partial<WorkflowOpinion> = {},
): WorkflowOpinion {
  const base = models(1, index)[0];
  if (base === undefined) throw new Error('fixture model missing');
  return {
    rootId: 'root',
    pointId: 'point',
    viewId: 'view',
    batchId: 'batch',
    outcome: 'answered',
    opinion: {
      reviewId: `opinion-${String(index)}`,
      model: base.model,
      protocol: 'chat',
      risk: 3,
      authorization: 10,
    },
    independentBehaviour: 'allow',
    responseRef: `opinion:opinion-${String(index)}#annotation/rawResponse`,
    rationale: 'synthetic',
    evidence: [{ kind: 'material-quote', ref: quote }],
    annotation: {
      binding: {
        inputHash: 'input',
        promptFingerprint: 'view',
        credentials: false,
        versions: {
          contract: 'review-contract-v1',
          rubric: 'review-rubric-v1',
          policy: 'arbiter-policy-v3',
        },
      },
      modelKey: base.modelKey,
      aliases: [],
      registration: false,
      rawResponse: JSON.stringify(answer()),
      parsed: answer(),
      returned: null,
      parameters: null,
      pairs: [[3, 10]],
      conflicts: [],
      problems: [],
      complete: true,
      recordedOrder: index,
      responseHash: 'fixture',
      sourceCommit: null,
      context: DEFAULT_ANNOTATION_CONTEXT,
    },
    ...patch,
  };
}
