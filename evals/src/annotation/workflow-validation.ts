/** The exchange boundary validates unknown JSON before handing it to typed services. */
import { Ajv } from 'ajv';
import type { JSONSchemaType } from 'ajv';
import type { IndependentAnswer } from '../data/annotation-types.js';
import { knownModelIdentity } from '../data/annotation-model.js';
import type { RegisteredModel, ReturnedBatch } from './workflow-types.js';

export function checked<T>(
  schema: object | JSONSchemaType<T>,
  value: unknown,
): T {
  const ajv = new Ajv({ allErrors: true, strict: true });
  const validate = ajv.compile<T>(schema);
  if (!validate(value)) throw new Error(ajv.errorsText(validate.errors));
  return value;
}
export const textSchema = { type: 'string', minLength: 1 };
export const idSchema = {
  type: 'string',
  pattern: '^[a-z0-9][a-z0-9._-]{0,63}$',
};
export const answerSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'pairs',
    'behaviourReference',
    'rationale',
    'evidence',
    'conflicts',
  ],
  properties: {
    pairs: {
      anyOf: [
        { type: 'null' },
        {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          uniqueItems: true,
          items: {
            type: 'array',
            minItems: 2,
            maxItems: 2,
            items: { type: 'integer', minimum: 1, maximum: 10 },
          },
        },
      ],
    },
    behaviourReference: {
      enum: [
        null,
        'allow',
        'deny',
        'escalate',
        'insufficient-material',
        'review-failure',
      ],
    },
    rationale: { type: 'string' },
    evidence: { type: 'array', items: { ...textSchema, pattern: '\\S' } },
    conflicts: { type: 'array', items: textSchema },
  },
};
export function independentAnswer(value: unknown): IndependentAnswer {
  return checked<IndependentAnswer>(answerSchema, value);
}
export function registeredModels(value: unknown): readonly RegisteredModel[] {
  const models = checked<readonly RegisteredModel[]>(
    {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['modelKey', 'aliases', 'model', 'parameters'],
        properties: {
          modelKey: idSchema,
          aliases: { type: 'array', uniqueItems: true, items: idSchema },
          parameters: {},
          model: {
            type: 'object',
            additionalProperties: false,
            required: ['provider', 'id', 'version', 'versionSource'],
            properties: {
              provider: textSchema,
              id: textSchema,
              version: { anyOf: [textSchema, { type: 'null' }] },
              versionSource: {
                enum: ['unknown', 'provider-reported', 'user-stated'],
              },
            },
          },
        },
      },
    },
    value,
  );
  const identities = new Set<string>();
  const known = new Set<string>();
  for (const model of models) {
    const identity = knownModelIdentity(model.model);
    if (identity !== null) {
      if (known.has(identity))
        throw new Error(
          'duplicate known model identity; use one modelKey with aliases',
        );
      known.add(identity);
    }
    if (
      (model.model.version === null) !==
      (model.model.versionSource === 'unknown')
    )
      throw new Error('model version/source disagree');
    for (const key of [model.modelKey, ...model.aliases]) {
      if (identities.has(key))
        throw new Error(`duplicate model identity/alias ${key}`);
      identities.add(key);
    }
  }
  return models;
}
export function returnedBatch(value: unknown): ReturnedBatch {
  return checked<ReturnedBatch>(
    {
      type: 'object',
      additionalProperties: false,
      required: ['batchId', 'responses'],
      properties: {
        batchId: idSchema,
        responses: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'responseId',
              'questionId',
              'modelKey',
              'rawResponse',
              'error',
            ],
            properties: {
              responseId: idSchema,
              questionId: idSchema,
              modelKey: idSchema,
              rawResponse: { type: ['string', 'null'] },
              error: { type: ['string', 'null'] },
              metadata: {},
            },
          },
        },
      },
    },
    value,
  );
}

/** Used for separately supplied context, which cannot silently expand into host config. */
export function contextSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'protocol',
      'targetInputTokens',
      'maxInputTokens',
      'customRules',
      'projectRules',
    ],
    properties: {
      protocol: { enum: ['chat', 'decision'] },
      targetInputTokens: {
        type: 'integer',
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      maxInputTokens: {
        type: 'integer',
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      customRules: { type: 'string' },
      projectRules: { type: ['string', 'null'] },
    },
  };
}
