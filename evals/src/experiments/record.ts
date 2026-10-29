/**
 * The experiment record: what one matrix fixed, before anything is measured.
 *
 * The issue requires the definition and the `unknown` representation to be *fixed in
 * the experiment record*, and requires every candidate to carry a unique version and
 * diff. A record is therefore two things at once:
 *
 *   - a committed document that states the frozen definition, the versions in force, and
 *     for each candidate its id, its derived variant id and the axes it changes;
 *   - a measurement summary: how many cells it would send, how many *distinct* requests
 *     they are, and the measured input estimate per candidate.
 *
 * The record deliberately carries no scores. This task prepares the matrix; running it
 * and reporting results belongs to the evaluation task that is budgeted for it, and a
 * record that pre-filled a result would be an invented one.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { REVIEW_CONTRACT_VERSION } from '../../../src/review-contract/index.js';
import { REVIEW_PROMPT_VERSION } from '../../../src/reviewer/contract.js';
import { REVIEW_PROBE_VERSION } from '../../../src/reviewer/probe.js';
import {
  PRODUCTION_VARIANT,
  productionDiff,
  REVIEW_VARIANT_VERSION,
} from '../../../src/reviewer/variant.js';

import { digestOf } from '../data/hash.js';

import { definitionProblems, resolveCandidates } from './inspect.js';
import { RECORD_VERSION } from './commands.js';
import type { ExperimentIo } from './commands.js';
import { loadCases, loadDefinition } from './load.js';
import { expandMatrix } from './matrix.js';
import type { ExpandedMatrix } from './matrix.js';
import type {
  ExperimentDefinition,
  EXPERIMENT_VERSION as Version,
} from './types.js';

/** One candidate as the record states it. */
export interface RecordedCandidate {
  readonly candidateId: string;
  readonly label: string;
  /** The package's derived identity; two candidates can never share one. */
  readonly variantId: string;
  /** The axes this candidate changes relative to production, or none for candidate A. */
  readonly changesFromProduction: readonly string[];
  /** Whether this candidate is the production package, unchanged. */
  readonly isProduction: boolean;
  readonly cells: number;
  /** Distinct request fingerprints over the candidate's own repeats. */
  readonly distinctRequests: number;
  readonly estimatedInputTokens: number;
}

/** The committed record. */
export interface ExperimentRecord {
  readonly recordVersion: typeof RECORD_VERSION;
  readonly experimentVersion: typeof Version;
  readonly experimentId: string;
  readonly description: string;
  /** The digest of the definition this record was produced from. */
  readonly definitionDigest: string;
  readonly versions: {
    readonly contract: string;
    readonly prompt: string;
    readonly probe: string;
    readonly variant: string;
  };
  /** The frozen probe definition, verbatim: the answer vocabulary and the `unknown` rule. */
  readonly probe: ExperimentDefinition['probe'];
  readonly dataset: {
    readonly datasetId: string;
    readonly split: string;
    readonly cases: readonly string[];
  };
  readonly protocols: readonly string[];
  readonly repeats: number;
  readonly candidates: readonly RecordedCandidate[];
  readonly ladder: ExperimentDefinition['ladder'];
  readonly cache: ExperimentDefinition['cache'];
  readonly bounds: ExperimentDefinition['bounds'];
  readonly budget: ExperimentDefinition['budget'];
  /** What the matrix measured, not what a run spent. */
  readonly measured: {
    readonly cells: number;
    readonly estimatedInputTokens: number;
  };
  readonly nonGoals: readonly string[];
  /**
   * What this record is not.
   *
   * Stated in the document because a matrix is easy to mistake for a result: nothing
   * here was sent, and no candidate was chosen.
   */
  readonly status: string;
}

/** The record one definition produces, plus the matrix behind its numbers. */
export interface BuiltRecord {
  readonly record: ExperimentRecord;
  readonly matrix: ExpandedMatrix;
}

/** Build the record for one definition and its measured matrix. */
export function buildRecord(parts: {
  readonly definition: ExperimentDefinition;
  readonly definitionText: string;
  readonly cases: readonly string[];
  readonly matrix: ExpandedMatrix;
}): BuiltRecord {
  const { definition, matrix } = parts;
  const cellsByCandidate = new Map(
    matrix.candidates.map((entry) => [entry.candidate.candidateId, entry]),
  );
  const candidates: RecordedCandidate[] = resolveCandidates(definition).map(
    (candidate) => {
      const expansion = cellsByCandidate.get(candidate.candidateId);
      return {
        candidateId: candidate.candidateId,
        label: candidate.label,
        variantId: candidate.variant.variantId,
        changesFromProduction: productionDiff(candidate.variant),
        isProduction:
          candidate.variant.variantId === PRODUCTION_VARIANT.variantId,
        cells: expansion?.cells.length ?? 0,
        distinctRequests: expansion?.distinctRequests ?? 0,
        estimatedInputTokens: expansion?.estimatedInputTokens ?? 0,
      };
    },
  );
  return {
    matrix,
    record: {
      recordVersion: RECORD_VERSION,
      experimentVersion: definition.experimentVersion,
      experimentId: definition.experimentId,
      description: definition.description,
      definitionDigest: digestOf(JSON.parse(parts.definitionText) as unknown),
      versions: {
        contract: REVIEW_CONTRACT_VERSION,
        prompt: REVIEW_PROMPT_VERSION,
        probe: REVIEW_PROBE_VERSION,
        variant: REVIEW_VARIANT_VERSION,
      },
      probe: definition.probe,
      dataset: {
        datasetId: definition.dataset.datasetId,
        split: definition.dataset.split,
        cases: [...parts.cases],
      },
      protocols: [...definition.protocols],
      repeats: definition.repeats,
      candidates,
      ladder: definition.ladder,
      cache: definition.cache,
      bounds: definition.bounds,
      budget: definition.budget,
      measured: {
        cells: matrix.cells,
        estimatedInputTokens: matrix.estimatedInputTokens,
      },
      nonGoals: [...definition.nonGoals],
      status:
        'This record fixes the candidate matrix and its ceilings. Nothing in it was sent: the measured figures are rendered input estimates, no model was called, and no candidate was selected.',
    },
  };
}

/**
 * `experiments record`: measure the matrix and write the record.
 *
 * The same measurement the dry run performs, written once so the committed record and a
 * later re-run cannot disagree about what the matrix costs. Writing is the caller's
 * explicit request: `plan` never writes, so an operator can inspect before freezing.
 */
export async function recordExperiment(
  io: ExperimentIo,
  path: string,
  out: string,
): Promise<number> {
  const loaded = await loadDefinition(resolve(io.root, path));
  if (!loaded.ok) {
    for (const problem of loaded.problems) io.err(`problem ${problem}`);
    return 1;
  }
  const cases = await loadCases(io, loaded.definition);
  if (!cases.ok) {
    for (const problem of cases.problems) io.err(`problem ${problem}`);
    return 1;
  }
  const unknown = (loaded.definition.dataset.caseIds ?? []).filter(
    (caseId) => !cases.cases.some((entry) => entry.caseId === caseId),
  );
  if (unknown.length > 0) {
    io.err(
      `problem the experiment names ${String(unknown.length)} case(s) its dataset does not publish: ${unknown.join(', ')}`,
    );
    return 1;
  }
  const matrix = expandMatrix({
    candidates: resolveCandidates(loaded.definition),
    cases: cases.cases,
    protocols: loaded.definition.protocols,
    repeats: loaded.definition.repeats,
    maxInputTokens: loaded.definition.bounds.maxInputTokens,
  });
  const problems = definitionProblems(loaded.definition);
  if (problems.length > 0) {
    for (const problem of problems) io.err(`problem ${problem}`);
    return 1;
  }
  const built = buildRecord({
    definition: loaded.definition,
    definitionText: await readFile(loaded.path, 'utf8'),
    cases: cases.cases.map((entry) => entry.caseId),
    matrix,
  });
  const target = resolve(io.root, out);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(built.record, null, 2)}\n`, 'utf8');
  io.out(
    `wrote ${out}: ${String(built.record.candidates.length)} candidates, ${String(built.record.measured.cells)} cells measured, nothing sent`,
  );
  return 0;
}
