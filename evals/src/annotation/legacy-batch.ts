import { REVIEW_CONTRACT_VERSION } from '../../../src/review-contract/index.js';
/** One-split legacy annotation batches; hidden local baselines never travel with blind packs. */
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readLegacyDataset } from '../data/legacy-read.js';
import { legacyMetadata } from '../data/legacy-metadata.js';
import { compileCheckers } from '../data/schemas.js';
import { findingOrigin, inspectDataset } from '../data/inspect.js';
import { canonicalJson } from '../data/hash.js';
import { buildAnnotationPack, auditPack } from './export.js';
import { importFill } from './import.js';
import { assertAnnotationOutput } from './output.js';
import {
  assertLegacyDirectories,
  labelRecords,
  mergeLegacyLabels,
} from './legacy-labels.js';
import type { LabelBaseline } from './legacy-labels.js';
import type { AnnotationDocument, Split } from '../data/types.js';

const BATCH_VERSION = 'legacy-annotation-batch-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
interface Batch {
  readonly batchVersion: typeof BATCH_VERSION;
  readonly batchId: string;
  readonly pack: AnnotationDocument;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
async function batchOf(value: unknown): Promise<Batch> {
  if (
    !record(value) ||
    value['batchVersion'] !== BATCH_VERSION ||
    typeof value['batchId'] !== 'string' ||
    !UUID.test(value['batchId']) ||
    Object.keys(value).some(
      (key) => !['batchVersion', 'batchId', 'pack'].includes(key),
    )
  )
    throw new Error(
      'expected a versioned legacy annotation batch; re-export historical packs before writing',
    );
  const pack = (await compileCheckers()).annotation(value['pack']);
  if (!pack.ok) throw new Error(pack.problems.join('; '));
  return {
    batchVersion: BATCH_VERSION,
    batchId: value['batchId'],
    pack: pack.document,
  };
}
function baselinePath(root: string, id: string): string {
  return resolve(root, '.local/evals/annotation-batches', `${id}.json`);
}
async function source(root: string, dataset: string, split: Split) {
  const path = resolve(root, dataset);
  await assertLegacyDirectories(path, split);
  const metadata = await legacyMetadata();
  const checkers = await compileCheckers();
  const inspection = inspectDataset(
    await readLegacyDataset(path, { split }),
    checkers,
    { contract: REVIEW_CONTRACT_VERSION, rubric: metadata.versions.rubric },
  );
  const problems = inspection.problems.filter(
    (p) => findingOrigin(p) === 'case' || findingOrigin(p) === 'manifest',
  );
  if (problems.length > 0 || inspection.manifest === null)
    throw new Error(problems.map((p) => `${p.path}: ${p.message}`).join('; '));
  const rubric = checkers.rubric(
    JSON.parse(
      await readFile(
        new URL('../../rubrics/rubric-v1.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  if (!rubric.ok) throw new Error(rubric.problems.join('; '));
  return {
    inspection,
    manifest: inspection.manifest,
    rubric: rubric.document,
    path,
  };
}
export async function exportLegacyBatch(
  root: string,
  dataset: string,
  split: Split,
  out: string,
): Promise<number> {
  const destination = resolve(root, out);
  assertAnnotationOutput(root, dataset, destination);
  const loaded = await source(root, dataset, split);
  const pack = buildAnnotationPack({
    manifest: loaded.manifest,
    cases: loaded.inspection.cases,
    rubric: loaded.rubric,
    exportedAt: new Date().toISOString().slice(0, 10),
  });
  if (auditPack(pack).length > 0)
    throw new Error('annotation pack is not blind');
  const current = await labelRecords(
    join(loaded.path, split, 'legacy-v1/labels.json'),
  );
  const byId = new Map(current.map((e) => [e.caseId, e.label]));
  const labels = pack.entries.map((e) => ({
    caseId: e.caseId,
    label: byId.get(e.caseId) ?? null,
  }));
  const batch: Batch = {
    batchVersion: BATCH_VERSION,
    batchId: randomUUID(),
    pack,
  };
  let sourceCommit: string | null;
  try {
    sourceCommit = (
      await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: root })
    ).stdout.trim();
  } catch {
    sourceCommit = null;
  }
  let sourceDirty: boolean | null;
  try {
    sourceDirty =
      (
        await promisify(execFile)(
          'git',
          ['status', '--porcelain', '--', relative(root, loaded.path)],
          { cwd: root },
        )
      ).stdout.length > 0;
  } catch {
    sourceDirty = null;
  }
  const baseline = {
    sourceDirty,
    ...batch,
    dataset: relative(root, loaded.path),
    split,
    labels,
    sourceCommit,
  };
  const file = baselinePath(root, batch.batchId);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(baseline, null, 2) + '\n', {
    flag: 'wx',
  });
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(batch, null, 2) + '\n', {
      flag: 'wx',
    });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return pack.entries.length;
}
export async function importLegacyBatch(
  root: string,
  dataset: string,
  file: string,
  write: boolean,
  requestedSplit: Split,
): Promise<number> {
  const fill = await batchOf(
    JSON.parse(await readFile(resolve(root, file), 'utf8')),
  );
  const raw: unknown = JSON.parse(
    await readFile(baselinePath(root, fill.batchId), 'utf8'),
  );
  if (
    !record(raw) ||
    typeof raw['dataset'] !== 'string' ||
    resolve(root, raw['dataset']) !== resolve(root, dataset) ||
    !['dev', 'calibration', 'holdout'].includes(String(raw['split'])) ||
    !Array.isArray(raw['labels'])
  )
    throw new Error('batch baseline does not bind this dataset/split');
  const original = await batchOf(rawBatch(raw));
  if (original.batchId !== fill.batchId)
    throw new Error('baseline batch identity mismatch');
  const split = raw['split'];
  if (split !== 'dev' && split !== 'calibration' && split !== 'holdout')
    throw new Error('invalid baseline split');
  if (split !== requestedSplit)
    throw new Error('annotation batch split differs from selected split');
  const labels: LabelBaseline[] = [];
  for (const value of raw['labels'] as readonly unknown[]) {
    if (
      !record(value) ||
      typeof value['caseId'] !== 'string' ||
      !('label' in value)
    )
      throw new Error('invalid label baseline');
    labels.push({ caseId: value['caseId'], label: value['label'] });
  }
  if (
    new Set(labels.map((e) => e.caseId)).size !== labels.length ||
    labels.length !== original.pack.entries.length ||
    labels.some(
      (e) => !original.pack.entries.some((p) => p.caseId === e.caseId),
    )
  )
    throw new Error('baseline membership mismatch');
  const nonTarget = (pack: AnnotationDocument) => ({
    ...pack,
    annotatedBy: undefined,
    entries: pack.entries
      .map((e) => ({ ...e, target: undefined }))
      .sort((a, b) => a.caseId.localeCompare(b.caseId)),
  });
  if (
    canonicalJson(nonTarget(fill.pack)) !==
    canonicalJson(nonTarget(original.pack))
  )
    throw new Error(
      'annotation batch membership/input/family/split changed; re-export',
    );
  const validate = async () => {
    const loaded = await source(root, dataset, split);
    const result = importFill({
      pack: fill.pack,
      manifest: loaded.manifest,
      rubric: loaded.rubric,
      cases: loaded.inspection.cases,
    });
    if (result.problems.length > 0)
      throw new Error(
        result.problems
          .map((p) => `${p.caseId ?? ''}: ${p.message}`)
          .join('; '),
      );
    return result;
  };
  const imported = await validate();
  if (write)
    await mergeLegacyLabels(
      resolve(root, dataset),
      split,
      labels,
      imported.labels,
      async () => {
        await validate();
      },
    );
  return imported.labels.length;
}
function rawBatch(value: Record<string, unknown>): unknown {
  return {
    batchVersion: value['batchVersion'],
    batchId: value['batchId'],
    pack: value['pack'],
  };
}
