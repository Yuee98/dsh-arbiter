import { publishNewDirectory } from './pack-files.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { TaskReceipt } from './pack-receipt.js';
import { readTaskReceipt } from './pack-receipt.js';
import { canonicalJson } from '../data/hash.js';
import { readRegular } from './pack-files.js';
import { validatedPackBatch } from './pack-material.js';
import { independentQuestion } from './workflow-view.js';
import { artifactPath, exclusiveJson } from './pack-files.js';
import { taskInstructions } from './pack-instructions.js';
import { newPackDestination } from './pack-prepare.js';
import {
  adoptionPath,
  collectedNeutralOrigin,
  existingAdoption,
  validateAdoption,
} from './pack-origin.js';

export async function createPackTask(options: {
  readonly origin?: string;
  readonly root: string;
  readonly dataset: string;
  readonly batch: string;
  readonly question: string;
  readonly model?: string;
  readonly attempt: string;
  readonly out: string;
  readonly channel: 'file' | 'web';
}) {
  const dataset = await realpath(options.dataset),
    batch = await validatedPackBatch(dataset, options.batch);
  if (batch.purpose === 'human')
    throw new Error('human batch cannot create model tasks');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(options.attempt))
    throw new Error('invalid attempt');
  const point = batch.points.find((p) => p.questionId === options.question);
  if (point === undefined) throw new Error('unknown task question');
  const model = batch.models.find(
    (m) =>
      m.modelKey === options.model ||
      (options.model !== undefined && m.aliases.includes(options.model)),
  );
  if (
    (batch.purpose === 'prepared' && options.model !== undefined) ||
    (batch.purpose === undefined && model === undefined)
  )
    throw new Error('task model must be actually registered');
  let origin: TaskReceipt['origin'];
  let originalRaw: string | undefined;
  let claimPath: string | undefined;
  if (options.origin !== undefined) {
    if (model === undefined)
      throw new Error('origin adoption requires an actual registered model');
    const saved = await collectedNeutralOrigin(options.origin, point);
    const old = saved.receipt;
    originalRaw = saved.rawResponse;
    origin = {
      receipt: resolve(options.origin),
      responseId: old.responseId,
      attempt: old.attempt,
      channel: old.channel,
    };
    claimPath = adoptionPath(options.origin, old.responseId);
    const existing = await existingAdoption(claimPath);
    if (existing !== null) {
      const directory = await artifactPath(options.root, options.out);
      if (
        existing.batchId !== batch.batchId ||
        existing.modelKey !== model.modelKey ||
        existing.questionId !== point.questionId ||
        existing.attempt !== options.attempt ||
        existing.channel !== options.channel ||
        existing.directory !== directory ||
        canonicalJson(existing.origin) !== canonicalJson(origin)
      )
        throw new Error('neutral origin already adopted by another task');
      const receipt = join(
        dirname(await realpath(options.batch)),
        'attempts',
        `${existing.responseId}.json`,
      );
      if (
        canonicalJson(await readTaskReceipt(receipt)) !==
        canonicalJson(existing)
      )
        throw new Error('retained adoption receipt differs');
      await validateAdoption(
        existing,
        point,
        await readRegular(join(directory, 'answer.txt')),
        null,
      );
      return {
        directory,
        receipt,
        result: join(directory, 'answer.txt'),
        modelKey: existing.modelKey,
        responseId: existing.responseId,
      };
    }
  }
  const directory = await newPackDestination(
    options.root,
    dataset,
    options.out,
  );
  const responseId = randomUUID();
  const receipt: TaskReceipt = {
    batchId: batch.batchId,
    questionId: point.questionId,
    modelKey: model?.modelKey ?? null,
    responseId,
    attempt: options.attempt,
    directory,
    channel: options.channel,
    createdAt: new Date().toISOString(),
    ...(origin === undefined ? {} : { origin }),
  };
  const privateReceipt = join(
    dirname(await realpath(options.batch)),
    'attempts',
    `${responseId}.json`,
  );
  // A failed publication retains the claim; it must never create a second vote.
  if (claimPath !== undefined) await exclusiveJson(claimPath, receipt);
  const stage = await mkdtemp(join(dirname(directory), '.task-'));
  await writeFile(
    join(stage, 'question.json'),
    JSON.stringify(
      independentQuestion(point.questionId, point.request),
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  await writeFile(join(stage, 'TASK.txt'), taskInstructions(directory), {
    flag: 'wx',
  });
  if (originalRaw !== undefined)
    await writeFile(join(stage, 'answer.txt'), originalRaw, { flag: 'wx' });
  await exclusiveJson(privateReceipt, receipt);
  await publishNewDirectory(stage, directory);
  return {
    directory,
    receipt: privateReceipt,
    result: join(directory, 'answer.txt'),
    modelKey: receipt.modelKey,
    responseId,
  };
}
