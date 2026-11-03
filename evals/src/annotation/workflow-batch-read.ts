import { compileCheckers } from '../data/schemas.js';
import type { WorkflowBatch } from './workflow-types.js';
import { annotationContext } from './workflow-view.js';
import { checked, idSchema, registeredModels } from './workflow-validation.js';
import { readJson } from './workflow-store.js';

export async function readWorkflowBatch(path: string): Promise<WorkflowBatch> {
  const binding = {
    type: ['object', 'null'],
    required: ['inputHash', 'promptFingerprint', 'credentials', 'versions'],
    properties: {
      inputHash: { type: 'string' },
      promptFingerprint: { type: 'string' },
      credentials: { type: 'boolean' },
      versions: {
        type: 'object',
        required: ['contract', 'rubric', 'policy'],
        properties: {
          contract: { type: 'string' },
          rubric: { type: 'string' },
          policy: { type: 'string' },
        },
      },
    },
  };
  const batch = checked<WorkflowBatch>(
    {
      type: 'object',
      additionalProperties: false,
      required: [
        'batchVersion',
        'batchId',
        'dataset',
        'split',
        'group',
        'createdAt',
        'sourceCommit',
        'sourceDirty',
        'context',
        'models',
        'points',
        'labels',
        'opinions',
      ],
      properties: {
        batchVersion: { const: 'workflow-annotation-v1' },
        purpose: { const: 'human' },
        batchId: idSchema,
        dataset: { type: 'string' },
        split: { enum: ['dev', 'calibration', 'holdout'] },
        group: idSchema,
        createdAt: { type: 'string' },
        sourceCommit: { type: ['string', 'null'] },
        sourceDirty: { type: ['boolean', 'null'] },
        retryKey: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        context: { type: 'object' },
        models: { type: 'array' },
        labels: { type: 'array' },
        opinions: { type: 'array' },
        points: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'questionId',
              'rootId',
              'pointId',
              'viewId',
              'modelReferenceId',
              'humanReferenceId',
              'binding',
              'request',
              'error',
              'registrations',
            ],
            properties: {
              questionId: idSchema,
              rootId: idSchema,
              pointId: idSchema,
              viewId: idSchema,
              modelReferenceId: idSchema,
              humanReferenceId: idSchema,
              binding,
              request: {},
              error: { type: ['string', 'null'] },
              registrations: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['modelKey', 'reviewId'],
                  properties: { modelKey: idSchema, reviewId: idSchema },
                },
              },
            },
          },
        },
      },
    },
    await readJson(path),
  );
  annotationContext(batch.context);
  if (batch.purpose === 'human') {
    if (
      batch.models.length !== 0 ||
      batch.opinions.length !== 0 ||
      batch.retryKey !== undefined ||
      batch.points.some((point) => point.registrations.length !== 0)
    )
      throw new Error(
        'human batch must not register models or retain opinions/keys',
      );
  } else registeredModels(batch.models);
  const checkers = await compileCheckers();
  for (const result of [
    checkers.groupedLabels({
      schemaVersion: 'grouped-v1',
      records: batch.labels,
    }),
    checkers.groupedOpinions({
      schemaVersion: 'grouped-v1',
      records: batch.opinions,
    }),
  ])
    if (!result.ok) throw new Error(result.problems.join('; '));
  for (const property of ['questionId', 'pointId'] as const)
    if (
      new Set(batch.points.map((p) => p[property])).size !== batch.points.length
    )
      throw new Error(`duplicate batch ${property}`);
  return batch;
}
