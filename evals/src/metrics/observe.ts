/**
 * Turning one saved run directory into the observations a report is built from.
 *
 * This module is the report's only reader of the run artifact and the dataset, and
 * it deliberately imports neither the executor nor the scheduler nor the fixture
 * reader: `readRun` and `compileRunCheckers` are the published consumer surface, so
 * a report built through them cannot dispatch anything even by accident. Nothing
 * here reads a clock, opens a socket or calls a model.
 *
 * The dataset is a separate input and is optional. A run records its cases'
 * fingerprints but not their text, so the report needs the dataset to name a case's
 * family, split, provenance and mechanism. It needs it for the *labels* too, and a
 * dataset that has been edited since the run is a different and more serious
 * situation: the input hash on each label is what decides whether a decision still
 * applies, so a mismatch is reported as an exclusion rather than repaired.
 *
 * The join is by case id and, for a label, by input hash. A label that no longer
 * matches its case is kept and reported with its reason; it is never discarded
 * silently and never counted as an answer.
 */

import { join } from 'node:path';

import { REVIEW_CONTRACT_VERSION } from '../../../src/review-contract/index.js';
import { USAGE_MAPPING_VERSION } from '../../../src/reviewer/usage.js';

import { inputHashOf } from '../data/eligibility.js';
import type { LabelAssessment } from '../data/eligibility.js';
import { inspectDataset } from '../data/inspect.js';
import type { DatasetInspection } from '../data/inspect.js';
import { readDataset } from '../data/read.js';
import type { Sourced } from '../data/read.js';
import { compileCheckers } from '../data/schemas.js';
import type {
  CaseReviews,
  DatasetManifest,
  ReviewCase,
  ReviewLabel,
} from '../data/types.js';
import { readRun } from '../run/artifact.js';
import type { RunArtifact } from '../run/artifact.js';
import { compileRunCheckers } from '../run/schemas.js';
import type { CellRecord, CellState, RunProtocol } from '../run/types.js';
import type { DatasetSource } from './types.js';

/** One case's static identity, from the dataset rather than from the run. */
export interface CaseFacts {
  readonly caseId: string;
  readonly familyId: string;
  readonly split: string;
  readonly provenance: string;
  /** Dataset-relative path of the case document. */
  readonly path: string;
  /** The mechanisms the input uses, in a fixed order; empty for an ordinary case. */
  readonly challenge: readonly string[];
}

/** One label's standing, with the path it was read from. */
export interface LabelFacts {
  readonly caseId: string;
  readonly path: string;
  readonly gold: boolean;
  readonly reasons: readonly string[];
  readonly label: ReviewLabel;
}

/** Everything the dataset contributed, or why it contributed nothing. */
export interface DatasetFacts {
  readonly status: 'joined' | 'absent' | 'unreadable';
  readonly datasetId: string | null;
  readonly manifest: DatasetManifest | null;
  readonly cases: ReadonlyMap<string, CaseFacts>;
  readonly labels: ReadonlyMap<string, LabelFacts>;
  /** The inspection, kept for the label coverage table and for findings. */
  readonly inspection: DatasetInspection | null;
  readonly reviews: readonly Sourced<CaseReviews>[];
  readonly problems: readonly string[];
  readonly findings: readonly string[];
}

/** What one run directory and its dataset amounted to. */
export interface Observation {
  readonly artifact: RunArtifact;
  readonly dataset: DatasetFacts;
  /** Records whose cell id is not one the index planned, which is an integrity failure. */
  readonly strays: readonly string[];
  /**
   * The records keyed by cell id.
   *
   * A record whose id the index does not plan is still kept here so the report can
   * say it exists; the `strays` list is what makes it a problem rather than data.
   */
  readonly records: ReadonlyMap<string, CellRecord>;
  readonly missing: readonly CellState[];
  readonly problems: readonly string[];
}

/** A read that failed before a report could be built. */
export interface ObservationFailure {
  readonly ok: false;
  readonly problems: readonly string[];
}

/** A read that produced observations. */
export interface ObservationSuccess {
  readonly ok: true;
  readonly observation: Observation;
}

/** Either the observations or why the run could not be read. */
export type ObservationRead = ObservationSuccess | ObservationFailure;

/**
 * The mechanisms that make a case a *targeted* probe rather than an ordinary one.
 *
 * These are read from the input itself rather than from a family name or a note, so the
 * grouping follows what the material contains. A case can use several at once; one that
 * uses none is the ordinary baseline.
 *
 * What is deliberately *not* here matters as much as what is. An evidence item that quotes
 * the material is how a case documents its own provenance, and it appears in almost every
 * case including the plainest read — using it would classify the whole dataset as
 * "targeted" and make the group meaningless. The mechanisms below are the ones that make a
 * review harder than reading a direct action: a hint asserting attention, history that must
 * be distinguished from current permission, a session without the caller's authority, or a
 * policy whose status is the question.
 *
 * The list is closed and ordered: adding a mechanism is a report-format change, and an
 * unstable order would make two rebuilds of one artifact disagree.
 */
export function challengeMechanismsOf(entry: ReviewCase): readonly string[] {
  const input = entry.input;
  const found: string[] = [];
  if (typeof input.hint === 'string' && input.hint.trim().length > 0) {
    found.push('hint');
  }
  // Earlier turns of any kind, because either the review must decide whether an older
  // statement still permits this action or must not treat the older call as material.
  if ((input.context ?? []).length > 0) found.push('earlier-turns');
  if (input.session.kind === 'subagent') found.push('subagent-session');
  if (input.session.parentAuthorizationPresent === true) {
    found.push('parent-authorization');
  }
  if (input.policy.customRules.trim().length > 0) found.push('custom-rules');
  if (input.policy.projectRules === null) found.push('no-project-rules');
  return found;
}

/**
 * The three-way reading of a case's challenge class.
 *
 * `targeted` means the input uses at least one mechanism beyond a plain direct
 * action; `ordinary` means it uses none; `unclassified` means the dataset did not
 * resolve the case, so nothing is claimed about it. The third value exists so a run
 * reported without its dataset cannot be described as "all ordinary".
 */
export function challengeClassOf(
  challenge: readonly string[] | null,
): 'ordinary' | 'targeted' | 'unclassified' {
  if (challenge === null) return 'unclassified';
  return challenge.length === 0 ? 'ordinary' : 'targeted';
}

/** The family-and-case facts a dataset contributes, keyed by case id. */
function casesOf(
  inspection: DatasetInspection,
): ReadonlyMap<string, CaseFacts> {
  const facts = new Map<string, CaseFacts>();
  for (const entry of inspection.cases) {
    const document = entry.document;
    facts.set(document.caseId, {
      caseId: document.caseId,
      familyId: document.familyId,
      split: document.split,
      provenance: document.provenance.source,
      path: entry.path,
      challenge: challengeMechanismsOf(document),
    });
  }
  return facts;
}

/** Every label's standing, keyed by case id, with gold and excluded both kept. */
function labelsOf(
  inspection: DatasetInspection,
): ReadonlyMap<string, LabelFacts> {
  const facts = new Map<string, LabelFacts>();
  const all: readonly {
    readonly assessment: LabelAssessment;
    readonly gold: boolean;
  }[] = [
    ...inspection.labels.gold.map((assessment) => ({
      assessment,
      gold: true,
    })),
    ...inspection.labels.excluded.map((assessment) => ({
      assessment,
      gold: false,
    })),
  ];
  for (const { assessment, gold } of all) {
    facts.set(assessment.label.caseId, {
      caseId: assessment.label.caseId,
      path: assessment.path,
      gold,
      reasons: assessment.reasons,
      label: assessment.label,
    });
  }
  return facts;
}

/**
 * Read a dataset for a report.
 *
 * A dataset that cannot be read is not a failed report: the run's own evidence is
 * complete without it, and the gold layer simply has no denominator. So an
 * unreadable or absent dataset is recorded as such and the report says so, rather
 * than refusing to describe cells that did run.
 *
 * Problems in the dataset block the *labels*, not the run. A dataset whose labels
 * disagree with each other cannot be trusted to say what a case should reach, and a
 * report that silently used one of two contradictory decisions would present a
 * choice nobody made as a reference.
 */
async function readDatasetFacts(
  root: string,
  datasetPath: string | null,
  runCaseIds: readonly string[],
): Promise<DatasetFacts> {
  if (datasetPath === null) {
    return emptyDataset('absent', [
      'no dataset was supplied, so no label was joined and every gold metric has no denominator',
    ]);
  }
  const absolute = datasetPath.startsWith('/')
    ? datasetPath
    : join(root, datasetPath);
  let inspection: DatasetInspection;
  try {
    const checkers = await compileCheckers();
    const raw = await readDataset(absolute);
    inspection = inspectDataset(raw, checkers, {
      contract: REVIEW_CONTRACT_VERSION,
      rubric: rubricVersionOf(raw.manifest),
    });
  } catch (error) {
    return emptyDataset('unreadable', [
      `${datasetPath} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  if (inspection.manifest === null) {
    return emptyDataset('unreadable', [
      `${datasetPath} has no usable manifest, so its families and versions are unknown`,
    ]);
  }
  const missingCases = runCaseIds.filter(
    (caseId) =>
      !inspection.cases.some((entry) => entry.document.caseId === caseId),
  );
  return {
    status: 'joined',
    datasetId: inspection.manifest.datasetId,
    manifest: inspection.manifest,
    cases: casesOf(inspection),
    labels: labelsOf(inspection),
    inspection,
    reviews: inspection.reviews,
    problems: inspection.problems.map(
      (problem) => `${problem.path}: ${problem.message}`,
    ),
    findings: [
      ...inspection.findings.map(
        (finding) => `${finding.path}: ${finding.message}`,
      ),
      ...missingCases.map(
        (caseId) =>
          `case ${caseId} ran but ${datasetPath} does not publish it, so its family and label are unknown`,
      ),
    ],
  };
}

/** An empty dataset result with the reason it is empty. */
function emptyDataset(
  status: 'absent' | 'unreadable',
  notes: readonly string[],
): DatasetFacts {
  return {
    status,
    datasetId: null,
    manifest: null,
    cases: new Map(),
    labels: new Map(),
    inspection: null,
    reviews: [],
    problems: status === 'unreadable' ? notes : [],
    findings: status === 'absent' ? notes : [],
  };
}

/**
 * The rubric version a manifest declares.
 *
 * The report does not re-check the rubric against the running contract: that is the
 * dataset check's job, and a report that refused to run because a band's wording
 * moved would hide the evidence it already holds. Only the declared version is
 * needed, so the labels can be compared with the versions their manifest carries.
 */
function rubricVersionOf(manifest: Sourced | null): string {
  if (manifest === null) return '';
  const document: unknown = manifest.document;
  if (document === null || typeof document !== 'object') return '';
  const versions: unknown = Reflect.get(document, 'versions');
  if (versions === null || typeof versions !== 'object') return '';
  const rubric: unknown = Reflect.get(versions, 'rubric');
  return typeof rubric === 'string' ? rubric : '';
}

/**
 * The dataset path one observation reads, from the caller's own request.
 *
 * A run index records the path it executed, so the default is that path: a report
 * rebuilt later reads the same dataset rather than whichever one happens to be current.
 * An explicit path still wins, because a rebuild against a corrected dataset is a
 * legitimate operation the caller must be able to ask for.
 */
function datasetPathOf(
  source: DatasetSource,
  artifact: RunArtifact,
): string | null {
  switch (source.kind) {
    case 'recorded':
      return artifact.index.plan.datasetPath;
    case 'none':
      return null;
    case 'path':
      return source.path;
  }
}

/**
 * Read one run directory, and the dataset it ran against.
 *
 * The cell list comes from the index, not from the records: a cell the index planned
 * but never wrote is exactly the gap this format exists to represent, and walking
 * `records/` alone would make that gap invisible. Records are then attached to
 * planned cells by id, and a record naming a cell the index does not plan is
 * reported as a stray rather than accepted as data.
 */
export async function observeRun(parts: {
  readonly directory: string;
  readonly root: string;
  readonly dataset: DatasetSource;
}): Promise<ObservationRead> {
  const checkers = await compileRunCheckers();
  const read = await readRun(parts.directory, checkers);
  if (!read.ok) {
    return {
      ok: false,
      problems: read.problems.map(
        (problem) => `${problem.path}: ${problem.message}`,
      ),
    };
  }
  const artifact = read.artifact;
  const planned = new Set(artifact.index.cells.map((cell) => cell.cellId));
  const records = new Map<string, CellRecord>();
  const strays: string[] = [];
  for (const record of artifact.records) {
    records.set(record.cellId, record);
    if (!planned.has(record.cellId)) strays.push(record.cellId);
  }
  const caseIds = [
    ...new Set(artifact.index.cells.map((cell) => cell.caseId)),
  ].sort();
  const dataset = await readDatasetFacts(
    parts.root,
    datasetPathOf(parts.dataset, artifact),
    caseIds,
  );
  const problems: string[] = [];
  if (strays.length > 0) {
    problems.push(
      `${String(strays.length)} record(s) name a cell the index does not plan: ${strays.join(', ')}`,
    );
  }
  const mappingMismatch = mappingVersionMismatches(artifact);
  if (mappingMismatch.length > 0) problems.push(...mappingMismatch);
  return {
    ok: true,
    observation: {
      artifact,
      dataset,
      strays,
      records,
      missing: artifact.missing,
      problems,
    },
  };
}

/**
 * Where a stored usage mapping version disagrees with the one this build implements.
 *
 * The report re-derives every figure through the shared aggregate, which always
 * writes the current version. A record that was normalized under another mapping
 * would then be summed under semantics it was not produced with, so the difference
 * is reported rather than glossed over: the numbers stay, and the reader is told
 * they describe an older mapping era.
 */
function mappingVersionMismatches(artifact: RunArtifact): readonly string[] {
  const found: string[] = [];
  if (artifact.index.versions.usageMapping !== USAGE_MAPPING_VERSION) {
    found.push(
      `this run was recorded under usage mapping ${artifact.index.versions.usageMapping}, the running mapping is ${USAGE_MAPPING_VERSION}`,
    );
  }
  const seen = new Set<string>();
  for (const record of artifact.records) {
    for (const attempt of record.attempts) {
      const usage = attempt.normalizedUsage;
      if (usage === null || usage.mappingVersion === USAGE_MAPPING_VERSION)
        continue;
      if (seen.has(usage.mappingVersion)) continue;
      seen.add(usage.mappingVersion);
      found.push(
        `cell ${record.cellId} carries usage normalized under ${usage.mappingVersion}, the running mapping is ${USAGE_MAPPING_VERSION}`,
      );
    }
  }
  return found;
}

/** The protocol a record ran, from its own target block. */
export function protocolOf(record: CellRecord): RunProtocol {
  return record.target.protocol;
}

/** Whether a record produced a judgeable statement about the reviewed call. */
export function judgedOutcome(record: CellRecord): boolean {
  return record.outcome !== null;
}

/** The input hash a label must match for a case. */
export function labelHashOf(entry: ReviewCase): string {
  return inputHashOf(entry.input);
}

/** A case's input hash, from a run record rather than from the dataset. */
export function recordInputHash(record: CellRecord): string {
  return record.material?.inputHash ?? record.case.inputHash;
}
