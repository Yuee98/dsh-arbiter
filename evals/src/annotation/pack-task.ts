import { publishNewDirectory } from './pack-files.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TaskReceipt } from './pack-receipt.js';
import { readTaskReceipt } from './pack-receipt.js';
import { canonicalJson } from '../data/hash.js';
import { readRegular } from './pack-files.js';
import { validatedPackBatch } from './pack-material.js';
import { independentQuestion } from './workflow-view.js';
import { exclusiveJson } from './pack-files.js';
import { taskInstructions } from './pack-instructions.js';
import { newPackDestination } from './pack-prepare.js';

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
  if (options.origin !== undefined) {
    if (model === undefined)
      throw new Error('origin adoption requires an actual registered model');
    const old = await readTaskReceipt(options.origin);
    if (old.modelKey !== null || old.questionId !== point.questionId)
      throw new Error('origin is not the matching neutral handoff');
    const oldQuestion = JSON.parse(
      await readRegular(join(old.directory, 'question.json')),
    ) as unknown;
    if (
      canonicalJson(oldQuestion) !==
      canonicalJson(independentQuestion(point.questionId, point.request))
    )
      throw new Error('origin question differs');
    originalRaw = await readRegular(join(old.directory, 'answer.txt'));
    origin = {
      responseId: old.responseId,
      attempt: old.attempt,
      channel: old.channel,
    };
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
