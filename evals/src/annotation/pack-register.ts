import { randomBytes, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import type { WorkflowBatch } from './workflow-types.js';
import { validatedPackBatch } from './pack-material.js';
import { registeredModels } from './workflow-validation.js';
import { importWorkflowOpinions } from './workflow-service.js';
import { exclusiveJson, artifactPath } from './pack-files.js';
import { CredentialRedactor } from '../../../src/reviewer/credential-redactor.js';
import { canonicalJson } from '../data/hash.js';

export async function registerPreparedPack(options: {
  readonly root: string;
  readonly dataset: string;
  readonly prepared: string;
  readonly models: unknown;
  readonly out: string;
  readonly write: boolean;
}) {
  const dataset = await realpath(options.dataset);
  const prepared = await validatedPackBatch(dataset, options.prepared);
  if (prepared.purpose !== 'prepared')
    throw new Error('registration requires a prepared batch');
  const models = registeredModels(options.models);
  if (
    canonicalJson(new CredentialRedactor('pack-models').value(models)) !==
    canonicalJson(models)
  )
    throw new Error('model descriptors must not contain credentials');
  const baseline = await artifactPath(options.root, options.out);
  const privateRoot = resolve(
    dirname(await realpath(options.prepared)),
    'registered',
  );
  const location = relative(privateRoot, baseline);
  if (location === '' || location.startsWith('..') || location.startsWith('/'))
    throw new Error(
      'registered baseline must stay in prepared private/registered directory',
    );
  if (!options.write)
    return {
      baseline,
      questions: prepared.points.length,
      models: models.map((m) => m.modelKey),
      write: false,
    };
  const { purpose: _purpose, ...base } = prepared;
  const batch: WorkflowBatch = {
    ...base,
    batchId: randomUUID(),
    models,
    retryKey: randomBytes(32).toString('hex'),
    points: prepared.points.map((p) => ({
      ...p,
      registrations: models.map((m) => ({
        modelKey: m.modelKey,
        reviewId: randomUUID(),
      })),
    })),
  };
  await exclusiveJson(baseline, batch);
  try {
    await importWorkflowOpinions({
      dataset,
      baseline,
      returned: { batchId: batch.batchId, responses: [] },
      write: true,
    });
  } catch (error) {
    throw new Error(
      `registration incomplete; retained ordinary baseline ${baseline}; import empty responses to resume: ${String(error)}`,
      { cause: error },
    );
  }
  return {
    baseline,
    batchId: batch.batchId,
    questions: batch.points.length,
    write: true,
  };
}
