/** A collected neutral return may supply exactly one registered task. */
import { dirname, join, resolve } from 'node:path';
import type { AnnotationPoint } from './workflow-types.js';
import type { TaskReceipt } from './pack-receipt.js';
import { readTaskReceipt } from './pack-receipt.js';
import { readRegular } from './pack-files.js';
import { canonicalJson } from '../data/hash.js';
import { independentQuestion } from './workflow-view.js';

export function adoptionPath(receipt: string, responseId: string): string {
  return join(dirname(receipt), `${responseId}.adoption.json`);
}

export async function collectedNeutralOrigin(
  path: string,
  point: AnnotationPoint,
) {
  const receipt = await readTaskReceipt(path);
  if (
    receipt.modelKey !== null ||
    receipt.origin !== undefined ||
    resolve(receipt.directory) !== receipt.directory ||
    receipt.questionId !== point.questionId ||
    resolve(path) !== join(dirname(resolve(path)), `${receipt.responseId}.json`)
  )
    throw new Error('origin is not the matching neutral handoff receipt');
  const question: unknown = JSON.parse(
    await readRegular(join(receipt.directory, 'question.json')),
  );
  if (
    canonicalJson(question) !==
    canonicalJson(independentQuestion(point.questionId, point.request))
  )
    throw new Error('origin question differs');
  // No fallback to the mutable external answer: collect first, then adopt.
  const archive: unknown = JSON.parse(
    await readRegular(join(dirname(path), `${receipt.responseId}.return.json`)),
  );
  if (
    typeof archive !== 'object' ||
    archive === null ||
    !('rawResponse' in archive) ||
    typeof archive.rawResponse !== 'string' ||
    canonicalJson(archive) !==
      canonicalJson({
        batchId: receipt.batchId,
        responseId: receipt.responseId,
        questionId: receipt.questionId,
        modelKey: null,
        rawResponse: archive.rawResponse,
        error: null,
        metadata: {
          attempt: receipt.attempt,
          channel: receipt.channel,
          createdAt: receipt.createdAt,
          state: 'returned',
        },
      })
  )
    throw new Error(
      'origin archive does not match its returned neutral receipt',
    );
  return { receipt, rawResponse: archive.rawResponse };
}

export async function existingAdoption(path: string) {
  try {
    return await readTaskReceipt(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
}

export async function validateAdoption(
  receipt: TaskReceipt,
  point: AnnotationPoint,
  rawResponse: string | null,
  error: string | null,
): Promise<void> {
  const origin = receipt.origin;
  if (origin === undefined) throw new Error('missing adoption origin');
  const saved = await collectedNeutralOrigin(origin.receipt, point);
  const claim = await readTaskReceipt(
    adoptionPath(origin.receipt, origin.responseId),
  );
  if (
    origin.responseId !== saved.receipt.responseId ||
    origin.attempt !== saved.receipt.attempt ||
    origin.channel !== saved.receipt.channel ||
    canonicalJson(claim) !== canonicalJson(receipt) ||
    rawResponse !== saved.rawResponse ||
    error !== null
  )
    throw new Error('adoption differs from its exclusive origin claim/archive');
}
