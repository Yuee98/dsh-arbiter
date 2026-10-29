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
 * renderer *and* every request of the cache workload, and reports the measured input
 * estimate, so an operator can see the cost and each candidate's difference before
 * anything is sent. It writes nothing.
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

import type { ReviewCase } from '../data/types.js';

import { resolveCandidates } from './inspect.js';
import { loadCases, loadDefinition, unknownCaseIds } from './load.js';
import { expandCache, cacheProblems } from './cache.js';
import type { CacheExpansion } from './cache.js';
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
  /** The cache workload, expanded against the first candidate and protocol. */
  readonly cache: CacheExpansion;
}

/** Expand one definition, measuring every cell and cache request it would send. */
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
  const candidates = resolveCandidates(loaded.definition);
  const matrix = expandMatrix({
    candidates,
    cases: cases.cases,
    protocols: loaded.definition.protocols,
    repeats: loaded.definition.repeats,
    maxInputTokens: loaded.definition.bounds.maxInputTokens,
  });
  const cache = expandCacheWorkload(loaded.definition, cases.cases, matrix);
  if (cache === null) {
    return {
      ok: false,
      problems: [
        `the cache workload's base case ${loaded.definition.cache.baseCaseId} is not one this experiment selects`,
      ],
    };
  }
  return {
    ok: true,
    expanded: {
      definition: loaded.definition,
      cases: cases.cases,
      matrix,
      cache,
    },
  };
}

/**
 * Expand the cache workload against the first candidate and the first protocol.
 *
 * One candidate and one protocol is the workload as the definition describes it: a cold
 * request, a reuse and a changed action, not a second matrix. The candidate is the first
 * declared one (production, which validation requires to exist), so the measured cost is
 * the baseline's rather than a variant's.
 */
export function expandCacheWorkload(
  definition: ExperimentDefinition,
  cases: readonly ReviewCase[],
  matrix: ExpandedMatrix,
): CacheExpansion | null {
  const candidate = resolveCandidates(definition)[0];
  const protocol = definition.protocols[0];
  if (candidate === undefined || protocol === undefined) return null;
  const base = cases.find(
    (entry) => entry.caseId === definition.cache.baseCaseId,
  );
  if (base === undefined) return null;
  const matrixCells = matrix.candidates.flatMap((entry) =>
    entry.cells.map((cell) => ({
      cellId: cell.cellId,
      candidateId: cell.candidateId,
      protocol: cell.protocol,
      caseId: cell.caseId,
      promptFingerprint: cell.promptFingerprint,
    })),
  );
  return expandCache({
    candidate,
    cases,
    protocol,
    baseCaseId: definition.cache.baseCaseId,
    sequence: definition.cache.sequence,
    changedActionCaseIds: definition.cache.changedActionCaseIds,
    maxInputTokens: definition.bounds.maxInputTokens,
    matrixCells,
  });
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
  const { definition, cases, matrix, cache } = expanded.expanded;
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
  printCache(io, definition, cache);
  io.out(
    `budget maxRequests ${String(definition.budget.maxRequests)} measured ${String(requiredRequests(definition, matrix, cache))} (matrix ${String(matrix.cells)} + cache ${String(cache.requests)}); maxInputTokensTotal ${String(definition.budget.maxInputTokensTotal)} measured ${String(matrix.estimatedInputTokens + cache.estimatedInputTokens)}`,
  );
  const problems = budgetProblemsOf(definition, matrix, cache);
  for (const problem of problems) io.err(`problem ${problem}`);
  if (problems.length > 0) return 1;
  io.out('dry run only: nothing was sent and nothing was written');
  return 0;
}

/** Print the expanded cache workload, one line per request and one for its shape. */
function printCache(
  io: ExperimentIo,
  definition: ExperimentDefinition,
  cache: CacheExpansion,
): void {
  for (const cell of cache.cells) {
    io.out(
      `cache ${cell.role} r${String(cell.repeat)} ${cell.actionCaseId} ${cell.protocol}: ${String(cell.estimatedInputTokens)} estimated input tokens, prefix ${cell.stablePrefixFingerprint?.slice(0, 12) ?? 'none'}, action ${cell.actionFingerprint.slice(0, 12)}${cell.sameAsMatrixCell === null ? '' : ` (same request as ${cell.sameAsMatrixCell})`}`,
    );
  }
  io.out(
    `cache requests ${String(cache.requests)}, byte-identical to a matrix cell ${String(cache.byteIdenticalToMatrix)}, estimated input tokens ${String(cache.estimatedInputTokens)}, stable prefixes ${String(new Set(cache.cells.map((cell) => cell.stablePrefixFingerprint)).size)}`,
  );
  for (const slot of definition.cache.sequence) {
    io.out(`cache slot ${slot.role} x${String(slot.repeats)}`);
  }
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

/**
 * The requests the experiment must be able to make.
 *
 * Every matrix cell and every cache request is charged: whether a cache request repeats a
 * matrix cell's bytes is a fact about an execution, not a discount the plan can claim.
 * Repairs are charged per cell, because the run's retry allowance is what turns a request
 * count into a spend ceiling.
 */
export function requiredRequests(
  definition: ExperimentDefinition,
  matrix: ExpandedMatrix,
  cache: CacheExpansion,
): number {
  return (
    matrix.cells +
    cache.requests +
    definition.budget.maxRepairRetries * matrix.cells
  );
}

/**
 * Why a measured experiment does not fit its declared budget or its run bounds.
 *
 * Three separate ceilings have to agree, and each failure has its own message because
 * each needs a different correction:
 *
 *   - `budget.maxRequests` bounds every request, repairs included;
 *   - `budget.maxInputTokensTotal` bounds the measured total;
 *   - `bounds.maxAttempts` bounds the attempts of **one bounded run**, so a matrix that
 *     needs more dispatches than that has to be partitioned into runs rather than sent
 *     as one;
 *   - `bounds.maxInputTokens` bounds a single request, so a cell measured above it is one
 *     the runner would refuse rather than send.
 */
export function budgetProblemsOf(
  definition: ExperimentDefinition,
  matrix: ExpandedMatrix,
  cache: CacheExpansion,
): readonly string[] {
  const problems: string[] = [];
  const requests = requiredRequests(definition, matrix, cache);
  const tokens = matrix.estimatedInputTokens + cache.estimatedInputTokens;
  if (requests > definition.budget.maxRequests) {
    problems.push(
      `the experiment needs ${String(requests)} request(s) but maxRequests is ${String(definition.budget.maxRequests)}`,
    );
  }
  if (tokens > definition.budget.maxInputTokensTotal) {
    problems.push(
      `the experiment measures ${String(tokens)} input tokens but maxInputTokensTotal is ${String(definition.budget.maxInputTokensTotal)}; the matrix is frozen, so the ceiling has to move or the matrix has to shrink deliberately`,
    );
  }
  if (
    definition.bounds.maxInputTokens > definition.budget.maxInputTokensTotal
  ) {
    problems.push(
      `one cell may use ${String(definition.bounds.maxInputTokens)} input tokens, which exceeds the experiment's whole budget of ${String(definition.budget.maxInputTokensTotal)}`,
    );
  }
  problems.push(...boundProblems(definition, matrix, cache));
  return problems;
}

/**
 * Why the experiment cannot be executed under the bounds it declares.
 *
 * Two ceilings belong to the *run* rather than to the experiment (`RunBounds` from the
 * reused RQ-10 contract): `maxAttempts` bounds the attempts of one bounded run, reserved
 * before each dispatch, and `maxInputTokens` bounds a single request. A matrix larger than
 * the first is a plan no run could finish, and a cell measured above the second is one the
 * runner would refuse rather than send — so both are checked against what was measured
 * rather than against what the definition hoped.
 *
 * A variant render is measured too, not only production's: candidate B's extra question
 * and answer format live in the system message, so a variant can exceed a per-request
 * ceiling that production fits. The `OVER_BUDGET` flag production sets is checked as well,
 * because a cell the production budget already refused must not be counted as sendable.
 */
function boundProblems(
  definition: ExperimentDefinition,
  matrix: ExpandedMatrix,
  cache: CacheExpansion,
): readonly string[] {
  const problems: string[] = [];
  const bounds = definition.bounds;
  for (const cell of matrix.candidates.flatMap((entry) => entry.cells)) {
    if (cell.estimatedInputTokens > bounds.maxInputTokens) {
      problems.push(
        `cell ${cell.cellId} measures ${String(cell.estimatedInputTokens)} input tokens against a per-request ceiling of ${String(bounds.maxInputTokens)}; the run would refuse it rather than send it`,
      );
    }
    if (cell.overBudget) {
      problems.push(
        `cell ${cell.cellId} is marked OVER_BUDGET by the production budget, so it cannot be assembled within the per-request ceiling of ${String(bounds.maxInputTokens)} input tokens`,
      );
    }
  }
  const requests = requiredRequests(definition, matrix, cache);
  if (requests > bounds.maxAttempts) {
    problems.push(
      `the experiment needs ${String(requests)} attempt(s) across ${String(matrix.cells)} cell(s) but one run's maxAttempts is ${String(bounds.maxAttempts)}; the run bound has to cover the matrix, repairs included, or the experiment has to shrink`,
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
    const { definition, matrix, cache } = expanded.expanded;
    io.out(
      `${path}: ${definition.experimentId}, ${String(definition.candidates.length)} candidates, ${String(matrix.cells)} cells, ${String(cache.requests)} cache request(s), ${String(matrix.estimatedInputTokens + cache.estimatedInputTokens)} estimated input tokens`,
    );
    for (const problem of [
      ...cacheProblems({
        expansion: cache,
        definition: definition.cache,
        bounds: definition.bounds,
      }),
      ...budgetProblemsOf(definition, matrix, cache),
    ]) {
      failed += 1;
      io.err(`problem ${problem}`);
    }
  }
  return failed === 0 ? 0 : 1;
}
