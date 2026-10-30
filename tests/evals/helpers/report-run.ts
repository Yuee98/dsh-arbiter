/**
 * Running a real plan in a temporary directory, for a test that reads the report.
 *
 * Every helper here writes real files and runs the real runner, because the claim under
 * test is that a report is rebuilt from what the runner wrote. A test that handed the
 * report builder an in-memory object would exercise a path no person uses.
 *
 * The helpers are deliberately separate from `helpers/run.ts`: that one builds a plan and
 * a fixture for the runner's own tests, and reusing it would couple this suite to the
 * runner's fixtures. What is shared is the runner itself.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRun, resumeRun } from '../../../evals/src/run/lifecycle.js';
import { compileRunCheckers } from '../../../evals/src/run/schemas.js';
import type {
  RunFixture,
  RunPlan,
  RunVersions,
} from '../../../evals/src/run/types.js';
import { readExisting } from '../../../evals/src/run/lifecycle.js';
import { readDataset } from '../../../evals/src/data/read.js';
import type { ReviewCase } from '../../../evals/src/data/types.js';
import { inspectDataset } from '../../../evals/src/data/inspect.js';
import { compileCheckers } from '../../../evals/src/data/schemas.js';
import { datasetDigest } from '../../../evals/src/annotation/summary.js';
import { REVIEW_CONTRACT_VERSION } from '../../../src/review-contract/index.js';

import { objectsAt, readJson, textAt } from './replay.js';

/** The repository root. */
export const REPOSITORY_ROOT = fileURLToPath(
  new URL('../../../', import.meta.url),
);

/** The committed dataset path, relative to the repository root. */
export const CORE_DATASET = 'evals/datasets/core-v1';

/** One temporary area, removed when the test is done. */
export interface Area {
  readonly path: string;
  write(relative: string, document: unknown): Promise<void>;
  dir(relative: string): Promise<string>;
  remove(): Promise<void>;
}

/** A fresh temporary directory. */
export async function area(): Promise<Area> {
  const path = await mkdtemp(join(tmpdir(), 'arbiter-report-'));
  return {
    path,
    async write(relative: string, document: unknown): Promise<void> {
      const file = join(path, relative);
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    },
    async dir(relative: string): Promise<string> {
      const directory = join(path, relative);
      await mkdir(directory, { recursive: true });
      return directory;
    },
    async remove(): Promise<void> {
      await rm(path, { recursive: true, force: true });
    },
  };
}

/** Run one body against a temporary area that is always cleaned up. */
export async function withArea(
  body: (created: Area) => Promise<void>,
): Promise<void> {
  const created = await area();
  try {
    await body(created);
  } finally {
    await created.remove();
  }
}

/** The versions a test run records. */
export const VERSIONS: RunVersions = {
  contract: REVIEW_CONTRACT_VERSION,
  prompt: 'review-prompt-v1',
  usageMapping: 'review-usage-v1',
  plan: 'eval-run-plan-v1',
  artifact: 'eval-run-artifact-v1',
  implementation: 'eval-runner-v1',
  node: '24.21.0',
};

/**
 * The committed dataset, read the way the runner reads it.
 *
 * `path` defaults to the committed dataset. A test that asserts on an *unlabelled*
 * dataset passes a copy without `labels/`, so it no longer depends on whether the
 * committed one has been adjudicated yet.
 */
export async function coreCases(
  path: string = join(REPOSITORY_ROOT, CORE_DATASET),
): Promise<{
  readonly cases: readonly ReviewCase[];
  readonly digest: string;
}> {
  const checkers = await compileCheckers();
  const raw = await readDataset(path);
  const inspection = inspectDataset(raw, checkers, {
    contract: REVIEW_CONTRACT_VERSION,
    rubric: 'review-rubric-v1',
  });
  return {
    cases: inspection.cases.map((entry) => entry.document),
    digest: datasetDigest(inspection),
  };
}

/**
 * A copy of the committed dataset carrying no labels.
 *
 * The committed `core-v1` is the user's adjudicated dataset, so once labels exist a
 * test that asserts "no reference is known" over it is asserting something about the
 * repository state rather than about the report. Copying the manifest and cases into
 * a temporary directory gives those tests a dataset whose contents they own.
 */
export async function unlabelledCoreDataset(created: Area): Promise<string> {
  const source = join(REPOSITORY_ROOT, CORE_DATASET);
  // Read through the same narrowing accessor the other helpers use, rather than
  // asserting a shape onto a parsed value.
  const manifest = await readJson(join(source, 'manifest.json'));
  await created.write('dataset/manifest.json', manifest);
  for (const entry of objectsAt(manifest, 'cases')) {
    const caseId = textAt(entry, 'caseId');
    await created.write(
      `dataset/cases/${caseId}.json`,
      await readJson(join(source, 'cases', `${caseId}.json`)),
    );
  }
  return join(created.path, 'dataset');
}

/** Run one plan to completion inside a directory, and hand back the directory. */
export async function runPlan(parts: {
  readonly directory: string;
  readonly plan: RunPlan;
  readonly fixture: RunFixture;
  /** A caller that wants the run to stop early, so a cell is left unwritten. */
  readonly signal?: AbortSignal;
  /** The dataset to freeze this run against; the committed one by default. */
  readonly datasetPath?: string;
}): Promise<string> {
  const checkers = await compileRunCheckers();
  const loaded = await coreCases(parts.datasetPath);
  const created = await createRun({
    directory: parts.directory,
    runId: 'report-run',
    plan: parts.plan,
    cases: loaded.cases,
    datasetDigest: loaded.digest,
    versions: VERSIONS,
    fixture: parts.fixture,
    now: () => 0,
  });
  if (!created.ok) throw new Error(created.problems.join('; '));
  const existing = await readExisting(parts.directory, parts.plan, checkers);
  if (!existing.ok) throw new Error(existing.problems.join('; '));
  await resumeRun({
    directory: parts.directory,
    existing: existing.existing,
    cases: loaded.cases,
    fixture: parts.fixture,
    versions: VERSIONS,
    checkers,
    llm: null,
    readCredential: () => undefined,
    signal: parts.signal ?? new AbortController().signal,
    continuation: false,
    now: () => 1_000,
  });
  return parts.directory;
}
