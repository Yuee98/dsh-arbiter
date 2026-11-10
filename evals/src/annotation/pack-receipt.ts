import { checked, idSchema } from './workflow-validation.js';
import { readRegular } from './pack-files.js';
export interface TaskReceipt {
  readonly batchId: string;
  readonly questionId: string;
  readonly modelKey: string | null;
  readonly responseId: string;
  readonly attempt: string;
  readonly createdAt: string;
  readonly directory: string;
  readonly channel: 'file' | 'web';
  readonly origin?: {
    readonly responseId: string;
    readonly attempt: string;
    readonly channel: 'file' | 'web';
  };
}
export async function readTaskReceipt(path: string): Promise<TaskReceipt> {
  return checked<TaskReceipt>(
    {
      type: 'object',
      additionalProperties: false,
      required: [
        'batchId',
        'questionId',
        'modelKey',
        'responseId',
        'attempt',
        'createdAt',
        'directory',
        'channel',
      ],
      properties: {
        batchId: idSchema,
        questionId: idSchema,
        modelKey: { anyOf: [idSchema, { type: 'null' }] },
        responseId: idSchema,
        attempt: idSchema,
        createdAt: { type: 'string' },
        directory: { type: 'string' },
        channel: { enum: ['file', 'web'] },
        origin: {
          type: 'object',
          additionalProperties: false,
          required: ['responseId', 'attempt', 'channel'],
          properties: {
            responseId: idSchema,
            attempt: idSchema,
            channel: { enum: ['file', 'web'] },
          },
        },
      },
    },
    JSON.parse(await readRegular(path)) as unknown,
  );
}
