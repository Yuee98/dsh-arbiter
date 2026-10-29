/**
 * The experiment commands: read a frozen matrix, report it, and record what it fixed.
 *
 * Three commands, none of which can reach a provider:
 *
 *   check-all   validate every committed experiment definition and measure it
 *   plan        expand one definition into its measured cells (the dry run)
 *   record      write the experiment record: the fixed definition, candidate identities,
 *               the ladder, the cache workload and the measured budget
 *
 * `plan` is the dry run the issue asks for: it renders every cell with the production
 * renderer and reports the measured input estimate, so an operator can see the cost and
 * each candidate's difference before anything is sent. It writes nothing.
 *
 * `record` is the artifact that fixes the experiment: candidate ids, the probe
 * definition, the `unknown` representation and the ceilings. It is committed, so a later
 * run can be compared against what was fixed rather than against memory.
 */

import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { REVIEW_CONTRACT_VERSION } from '../../../src/review-contract/index.js';
import { REVIEW_PROMPT_VERSION } from '../../../src/reviewer/contract.js';
import { REVIEW_PROBE_VERSION } from '../../../src/reviewer/probe.js';
import {
  productionDiff,
  REVIEW_VARIANT_VERSION,
} from '../../../src/reviewer/variant.js';
import type { ReviewVariant } from '../../../src/reviewer/variant.js';

import { resolveCandidates } from './inspect.js';
import { loadCases, loadDefinition, unknownCaseIds } from './load.js';
import { expandMatrix } from './matrix.js';
import type { ExpandedMatrix } from './matrix.js';
import { EXPERIMENT_VERSION } from './types.js';
import type { ExperimentDefinition } from './types.js';

/** Where the experiment commands write their human-readable output. */
export interface ExperimentIo {
  readonly root: string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** The committed directory holding experiment definitions and the record. */
export const EXPERIMENTS_DIRECTORY = 'evals/experiments';

/** The definition file's name inside the experiments directory. */
export const DEFINITION_FILE = 'rq14-matrix.json';

/** The record file, relative to the repository root. */
export const RECORD_FILE = 'evals/experiments/record.json';

/** The record document's version. */
export const RECORD_VERSION = 'rq14-experiment-record-v1';

/** A definition expanded and measured, or why it could not be. */
export interface ExpandedDefinition {
  readonly definition: ExperimentDefinition;
  readonly cases: readonly { readonly caseId: string }[];
  readonly matrix: ExpandedMatrix;
}

/** Expand one definition, measuring every cell it would send. */
export async function expandDefinition(
  io: ExperimentIo,
  path: string,
): Promise<
  | { readonly ok: true; readonly expanded: ExpandedDefinition }
  | { readonly ok: false; readonly problems: readonly string[] }
> {
  const loaded = await loadDefinition(resolve(io.root, path));
  if (!loaded.ok) return loaded;
  const cases = await loadCases(io, loaded.definition);
  if (!cases.ok) return cases;
  const unknown = unknownCaseIds(loaded.definition, cases.cases);
  if (unknown.length > 0) {
    return {
      ok: false,
      problems: [
        `the experiment names ${String(unknown.length)} case(s) its dataset does not publish: ${unknown.join(', ')}`,
      ],
    };
  }
  const matrix = expandMatrix({
    candidates: resolveCandidates(loaded.definition),
    cases: cases.cases,
    protocols: loaded.definition.protocols,
    repeats: loaded.definition.repeats,
    maxInputTokens: loaded.definition.bounds.maxInputTokens,
  });
  return {
    ok: true,
    expanded: { definition: loaded.definition, cases: cases.cases, matrix },
  };
}

/**
 * `experiments plan`: the dry run.
 *
 * Every number it prints is measured from a rendered request. The budget check is the one
 * refusal: a matrix whose measured total exceeds its declared ceiling is reported rather
 * than quietly trimmed, because trimming would change the experiment to fit the budget
 * instead of the budget to fit the experiment.
 */
export async function planExperiment(
  io: ExperimentIo,
  path: string,
): Promise<number> {
  const expanded = await expandDefinition(io, path);
  if (!expanded.ok) {
    for (const problem of expanded.problems) io.err(`problem ${problem}`);
    return 1;
  }
  const { definition, cases, matrix } = expanded.expanded;
  io.out(
    `experiment ${definition.experimentId} (${EXPERIMENT_VERSION}): ${String(cases.length)} cases, ${String(definition.candidates.length)} candidates, protocols ${definition.protocols.join('+')}, repeats ${String(definition.repeats)}`,
  );
  io.out(
    `versions contract ${REVIEW_CONTRACT_VERSION} prompt ${REVIEW_PROMPT_VERSION} probe ${REVIEW_PROBE_VERSION} variant ${REVIEW_VARIANT_VERSION}`,
  );
  for (const entry of matrix.candidates) {
    io.out(
      `candidate ${entry.candidate.candidateId} ${entry.candidate.variant.variantId}: ${String(entry.cells.length)} cells, ${String(entry.distinctRequests)} distinct requests, ${String(entry.estimatedInputTokens)} estimated input tokens (changes ${diffOf(entry.candidate.variant)})`,
    );
  }
  io.out(
    `cells ${String(matrix.cells)}, estimated input tokens ${String(matrix.estimatedInputTokens)}`,
  );
  for (const step of definition.ladder) {
    io.out(
      `ladder ${step.stepId}: ${step.from} -> ${variantAxesText(step.axes)} (changes ${step.changes.join('+')})`,
    );
  }
  for (const slot of definition.cache.sequence) {
    io.out(`cache ${slot.role} x${String(slot.repeats)}`);
  }
  io.out(
    `budget maxRequests ${String(definition.budget.maxRequests)} measured ${String(matrix.cells)}; maxInputTokensTotal ${String(definition.budget.maxInputTokensTotal)} measured ${String(matrix.estimatedInputTokens)}`,
  );
  const problems = budgetProblemsOf(definition, matrix);
  for (const problem of problems) io.err(`problem ${problem}`);
  if (problems.length > 0) return 1;
  io.out('dry run only: nothing was sent and nothing was written');
  return 0;
}

/** The axes a variant changes from production, or `none`. */
function diffOf(variant: ReviewVariant): string {
  const axes = productionDiff(variant);
  return axes.length === 0 ? 'none' : axes.join('+');
}

/** One ladder step's axes, in the identity's own order. */
function variantAxesText(
  axes: ExperimentDefinition['ladder'][number]['axes'],
): string {
  return `${axes.prompt}/${axes.scale}/${axes.history}/${axes.structure}`;
}

/** Why a measured matrix does not fit its declared budget. */
export function budgetProblemsOf(
  definition: ExperimentDefinition,
  matrix: ExpandedMatrix,
): readonly string[] {
  const problems: string[] = [];
  if (matrix.cells > definition.budget.maxRequests) {
    problems.push(
      `the matrix needs ${String(matrix.cells)} request(s) but maxRequests is ${String(definition.budget.maxRequests)}`,
    );
  }
  if (matrix.estimatedInputTokens > definition.budget.maxInputTokensTotal) {
    problems.push(
      `the matrix measures ${String(matrix.estimatedInputTokens)} input tokens but maxInputTokensTotal is ${String(definition.budget.maxInputTokensTotal)}; the matrix is frozen, so the ceiling has to move or the matrix has to shrink deliberately`,
    );
  }
  if (
    definition.bounds.maxInputTokens > definition.budget.maxInputTokensTotal
  ) {
    problems.push(
      `one cell may use ${String(definition.bounds.maxInputTokens)} input tokens, which exceeds the experiment's whole budget of ${String(definition.budget.maxInputTokensTotal)}`,
    );
  }
  return problems;
}

/**
 * `experiments check-all`: validate every committed definition and measure it.
 *
 * A repository with no definition is a problem, not a pass: this check exists because the
 * experiment is committed, and an empty directory would mean the check verified nothing.
 * Each definition is expanded, so one that validates but cannot be measured is reported
 * here rather than at the first run.
 */
export async function checkExperiments(io: ExperimentIo): Promise<number> {
  const directory = resolve(io.root, EXPERIMENTS_DIRECTORY);
  let names: readonly string[];
  try {
    names = (await readdir(directory))
      .filter((name) => name.endsWith('.json') && name !== 'record.json')
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      names = [];
    } else {
      throw error;
    }
  }
  if (names.length === 0) {
    io.err(
      `problem ${EXPERIMENTS_DIRECTORY}: no experiment definition is published here`,
    );
    return 1;
  }
  let failed = 0;
  for (const name of names) {
    const path = join(EXPERIMENTS_DIRECTORY, name);
    const expanded = await expandDefinition(io, path);
    if (!expanded.ok) {
      failed += 1;
      for (const problem of expanded.problems) io.err(`problem ${problem}`);
      continue;
    }
    const { definition, matrix } = expanded.expanded;
    io.out(
      `${path}: ${definition.experimentId}, ${String(definition.candidates.length)} candidates, ${String(matrix.cells)} cells, ${String(matrix.estimatedInputTokens)} estimated input tokens`,
    );
    for (const problem of budgetProblemsOf(definition, matrix)) {
      failed += 1;
      io.err(`problem ${problem}`);
    }
  }
  return failed === 0 ? 0 : 1;
}
