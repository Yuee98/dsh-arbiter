/**
 * Loading an experiment definition and the cases it selects.
 *
 * Kept apart from the commands so the record writer and the dry run load through exactly
 * one path: two loaders would be two ideas of which problems block an experiment.
 *
 * Only problems that make the *cases* unusable block a load: a stale label is a problem
 * with the annotation side, and an experiment reads cases and never labels — the same
 * rule the run commands apply, for the same reason.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { REVIEW_CONTRACT_VERSION } from '../../../src/review-contract/index.js';

import { findingOrigin, inspectDataset } from '../data/inspect.js';
import type { DatasetInspection } from '../data/inspect.js';
import { readDataset } from '../data/read.js';
import { compileCheckers } from '../data/schemas.js';
import type { ReviewCase } from '../data/types.js';

import { definitionProblems } from './inspect.js';
import { compileExperimentCheckers } from './schemas.js';
import type { ExperimentDefinition } from './types.js';

/** Where the loaders read. */
export interface LoadIo {
  readonly root: string;
  readonly err: (line: string) => void;
}

/** A loaded definition, or why it cannot be used. */
export type LoadedDefinition =
  | {
      readonly ok: true;
      readonly definition: ExperimentDefinition;
      readonly path: string;
    }
  | { readonly ok: false; readonly problems: readonly string[] };

/** The cases one definition selects, or why none can be read. */
export type LoadedCases =
  | { readonly ok: true; readonly cases: readonly ReviewCase[] }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Check one unvalidated document against the schema and the definition's own rules.
 *
 * The one place "this JSON is an experiment" is decided, so a caller that already has a
 * parsed document (a test, a future reader) checks it without asserting a type first.
 * Every problem is prefixed with the document's name, so a report points at a file.
 */
export async function inspectDefinition(
  raw: unknown,
  name: string,
): Promise<LoadedDefinition> {
  const checkers = await compileExperimentCheckers();
  const checked = checkers.experiment(raw);
  if (!checked.ok) {
    return {
      ok: false,
      problems: checked.problems.map((problem) => `${name}: ${problem}`),
    };
  }
  const problems = definitionProblems(checked.document);
  if (problems.length > 0) {
    return {
      ok: false,
      problems: problems.map((problem) => `${name}: ${problem}`),
    };
  }
  return { ok: true, definition: checked.document, path: name };
}

/** Read one definition and check it against its schema and its own declarations. */
export async function loadDefinition(path: string): Promise<LoadedDefinition> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      problems: [
        error instanceof Error && 'code' in error && error.code === 'ENOENT'
          ? `${path} does not exist`
          : `${path} is not readable JSON`,
      ],
    };
  }
  return inspectDefinition(raw, path);
}

/**
 * Read the committed rubric snapshot's version.
 *
 * A run reads the same document the annotation tools do, so an experiment cannot declare
 * a semantics the repository does not publish.
 */
async function rubricVersion(root: string): Promise<string> {
  const parsed: unknown = JSON.parse(
    await readFile(resolve(root, 'evals/rubrics/rubric-v1.json'), 'utf8'),
  );
  if (parsed === null || typeof parsed !== 'object') {
    throw new TypeError('evals/rubrics/rubric-v1.json must be a JSON object');
  }
  if (!('rubricVersion' in parsed)) {
    throw new TypeError(
      'evals/rubrics/rubric-v1.json declares no rubricVersion',
    );
  }
  const version = parsed.rubricVersion;
  if (typeof version !== 'string') {
    throw new TypeError(
      'evals/rubrics/rubric-v1.json declares no rubricVersion',
    );
  }
  return version;
}

/** Read one dataset through the same contract the run commands read it with. */
async function inspect(
  io: LoadIo,
  datasetPath: string,
): Promise<
  | { readonly ok: true; readonly inspection: DatasetInspection }
  | { readonly ok: false; readonly problems: readonly string[] }
> {
  const checkers = await compileCheckers();
  const raw = await readDataset(resolve(io.root, datasetPath));
  const inspection = inspectDataset(raw, checkers, {
    contract: REVIEW_CONTRACT_VERSION,
    rubric: await rubricVersion(io.root),
  });
  // A stale label is not this chain's problem: an experiment reads cases and never
  // labels, so rejecting the load for one would block a matrix on annotation work that
  // plays no part in what it measures.
  const blocking = inspection.problems.filter(
    (problem) => findingOrigin(problem) !== 'label',
  );
  if (blocking.length > 0) {
    return {
      ok: false,
      problems: blocking.map(
        (problem) => `${problem.path}: ${problem.message}`,
      ),
    };
  }
  return { ok: true, inspection };
}

/** Read the dataset a definition names and narrow it to its selected cases. */
export async function loadCases(
  io: LoadIo,
  definition: ExperimentDefinition,
): Promise<LoadedCases> {
  const result = await inspect(io, definition.dataset.datasetPath);
  if (!result.ok) return result;
  const manifestId = result.inspection.manifest?.datasetId ?? '';
  if (manifestId !== definition.dataset.datasetId) {
    return {
      ok: false,
      problems: [
        `the experiment names dataset ${definition.dataset.datasetId} but ${definition.dataset.datasetPath} declares itself ${manifestId}`,
      ],
    };
  }
  const all = result.inspection.cases.map((entry) => entry.document);
  // A named id this dataset does not publish is reported before the selection is
  // resolved: a dry run that quietly measured fewer cases would understate the
  // experiment, and "the selection is empty" would hide which id was wrong.
  const unknown = unknownCaseIds(definition, all);
  if (unknown.length > 0) {
    return {
      ok: false,
      problems: [
        `the experiment names ${String(unknown.length)} case(s) its dataset does not publish: ${unknown.join(', ')}`,
      ],
    };
  }
  const selected = selectCases(definition, all);
  if (selected.length === 0) {
    return {
      ok: false,
      problems: [
        `the experiment selects no case from ${definition.dataset.datasetPath}`,
      ],
    };
  }
  return { ok: true, cases: selected };
}

/**
 * The cases a definition selects.
 *
 * An explicit list is resolved in its own order, because the order decides which cells a
 * bounded run reaches first; a split selects the cases assigned to it. A named id the
 * dataset does not publish is reported by the caller rather than dropped: a dry run that
 * quietly measured fewer cases would understate the experiment.
 */
function selectCases(
  definition: ExperimentDefinition,
  cases: readonly ReviewCase[],
): readonly ReviewCase[] {
  const named = definition.dataset.caseIds ?? [];
  if (named.length > 0) {
    const byId = new Map(cases.map((entry) => [entry.caseId, entry] as const));
    return named.flatMap((caseId) => {
      const entry = byId.get(caseId);
      return entry === undefined ? [] : [entry];
    });
  }
  if (definition.dataset.split === 'all') return cases;
  return cases.filter((entry) => entry.split === definition.dataset.split);
}

/** The case ids a definition names that its dataset does not publish. */
export function unknownCaseIds(
  definition: ExperimentDefinition,
  cases: readonly ReviewCase[],
): readonly string[] {
  const named = definition.dataset.caseIds ?? [];
  const published = new Set(cases.map((entry) => entry.caseId));
  return named.filter((caseId) => !published.has(caseId));
}
