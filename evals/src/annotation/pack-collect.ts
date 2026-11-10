import { dirname, join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { ReturnedResponse } from './workflow-types.js';
import { readTaskReceipt } from './pack-receipt.js';
import { absent, immutableJson, readRegular } from './pack-files.js';
import { validatedPackBatch } from './pack-material.js';
import { independentQuestion } from './workflow-view.js';
import { canonicalJson } from '../data/hash.js';
import { importWorkflowOpinions } from './workflow-service.js';
import { validateAdoption } from './pack-origin.js';

export async function collectPackTask(options: {
  readonly dataset: string;
  readonly batch: string;
  readonly receipt: string;
  readonly write: boolean;
  readonly error?: string;
  readonly missing?: boolean;
}) {
  const dataset = await realpath(options.dataset),
    batch = await validatedPackBatch(dataset, options.batch);
  const receipt = await readTaskReceipt(options.receipt);
  const expectedReceipt = join(
    dirname(await realpath(options.batch)),
    'attempts',
    `${receipt.responseId}.json`,
  );
  if (
    resolve(options.receipt) !== expectedReceipt ||
    receipt.batchId !== batch.batchId
  )
    throw new Error('receipt belongs to another batch/path');
  if (resolve(receipt.directory) !== receipt.directory)
    throw new Error('task directory must be absolute');
  const point = batch.points.find((p) => p.questionId === receipt.questionId);
  if (point === undefined) throw new Error('unknown receipt question');
  if (
    (batch.purpose === 'prepared') !== (receipt.modelKey === null) ||
    batch.purpose === 'human'
  )
    throw new Error('invalid receipt participant state');
  if (
    receipt.modelKey !== null &&
    !point.registrations.some((p) => p.modelKey === receipt.modelKey)
  )
    throw new Error('unregistered receipt model');
  const actualQuestion = JSON.parse(
    await readRegular(join(receipt.directory, 'question.json')),
  ) as unknown;
  if (
    canonicalJson(actualQuestion) !==
    canonicalJson(independentQuestion(point.questionId, point.request))
  )
    throw new Error('handed-off question was altered');
  if (options.error !== undefined && options.missing === true)
    throw new Error('failure and missing are mutually exclusive');
  const resultPath = join(receipt.directory, 'answer.txt');
  const explicitFailure =
    options.error !== undefined || options.missing === true;
  let rawResponse: string | null = null;
  if (explicitFailure) await absent(resultPath);
  else rawResponse = await readRegular(resultPath);
  const error = options.error ?? null;
  if (receipt.origin !== undefined)
    await validateAdoption(receipt, point, rawResponse, error);
  const metadata = {
    attempt: receipt.attempt,
    channel: receipt.channel,
    createdAt: receipt.createdAt,
    ...(options.missing === true
      ? { note: 'operator recorded no return at collection cutoff' }
      : {}),
    ...(receipt.origin === undefined
      ? {}
      : {
          origin: {
            responseId: receipt.origin.responseId,
            attempt: receipt.origin.attempt,
            channel: receipt.origin.channel,
          },
        }),
    state:
      options.missing === true
        ? 'missing'
        : error !== null
          ? 'reported-failure'
          : 'returned',
  };
  const archive = {
    batchId: receipt.batchId,
    responseId: receipt.responseId,
    questionId: receipt.questionId,
    modelKey: receipt.modelKey,
    rawResponse,
    error,
    metadata,
  };
  await immutableJson(
    join(dirname(expectedReceipt), `${receipt.responseId}.return.json`),
    archive,
  );
  if (receipt.modelKey === null) {
    if (options.write)
      throw new Error(
        'neutral raw retained; actual participant registration required before opinion import',
      );
    return {
      archived: true,
      registered: false,
      responseId: receipt.responseId,
    };
  }
  const response: ReturnedResponse = {
    responseId: receipt.responseId,
    questionId: receipt.questionId,
    modelKey: receipt.modelKey,
    rawResponse,
    error,
    metadata,
  };
  const args = {
    dataset,
    baseline: options.batch,
    returned: { batchId: batch.batchId, responses: [response] },
  };
  const preview = await importWorkflowOpinions({ ...args, write: false });
  if (options.write) return importWorkflowOpinions({ ...args, write: true });
  return { archived: true, registered: true, preview };
}
