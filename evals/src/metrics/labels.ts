/**
 * Which labels could count, and what stopped the rest.
 *
 * `labels/` is empty in this repository today, and that is a correct state rather than
 * a defect: the user owns adjudication and has not started it. What the report must
 * not do is pretend otherwise. So every headline figure that depends on a human
 * reference is reported with the number of cases it could actually be computed over,
 * and a gold layer with no labels reports zero comparable cases rather than a passing
 * rate.
 *
 * The exclusion reasons are the dataset contract's own, carried through unchanged.
 * They are not reinterpreted here: a label the dataset check calls stale is stale for
 * this report too, and inventing a second rule would let the two tools disagree about
 * whether a decision exists.
 */

import type { CellFacts } from './cell.js';
import type { DatasetFacts } from './observe.js';
import { compareText } from './support.js';
import type { LabelCoverage, LabelRow, ReferenceWord } from './types.js';
import type { LabelVersions } from '../data/types.js';

/** The reason strings the dataset contract can produce, in print order. */
const REASONS = [
  'case-missing',
  'input-changed',
  'version-drift',
  'not-approved',
  'no-score',
  'indeterminate',
] as const;

/** The references the label schema publishes, as a lookup the compiler can check. */
const REFERENCES: Readonly<Record<string, ReferenceWord>> = {
  allow: 'allow',
  deny: 'deny',
  escalate: 'escalate',
  'insufficient-material': 'insufficient-material',
  'review-failure': 'review-failure',
};

/**
 * The reference a label records, or null when it records none this report knows.
 *
 * Read through the table rather than asserted from the schema's enum: the label is a
 * committed document a person edits, and a value outside the published set must read as
 * "no reference" instead of becoming one by a type cast.
 */
function referenceOfLabel(reference: string | null): ReferenceWord | null {
  if (reference === null) return null;
  return REFERENCES[reference] ?? null;
}

/** One label row. */
function rowOf(parts: {
  readonly caseId: string;
  readonly facts: DatasetFacts;
}): LabelRow {
  const label = parts.facts.labels.get(parts.caseId) ?? null;
  const known = parts.facts.cases.has(parts.caseId);
  const contested = parts.facts.contestedCases.has(parts.caseId);
  if (label === null) {
    return {
      caseId: parts.caseId,
      outcome: known ? 'missing' : 'case-absent',
      reasons: [],
      status: null,
      reference: null,
      pairs: 0,
      versions: null,
      rationale: null,
      decidedBy: null,
      decidedAt: null,
    };
  }
  const target = label.label.target;
  // A contested case is reported before gold, because a conflict means no decision can be
  // read from the files at all.
  const outcome = !known
    ? 'case-absent'
    : contested
      ? 'authority-conflict'
      : label.gold
        ? 'gold'
        : 'excluded';
  return {
    caseId: parts.caseId,
    outcome,
    reasons: [...label.reasons],
    status: target.status,
    reference: referenceOfLabel(target.behaviourReference),
    pairs: target.allowedPairs?.length ?? 0,
    versions: label.label.versions,
    rationale: target.rationale,
    decidedBy: target.decidedBy,
    decidedAt: target.decidedAt,
  };
}

/** How many distinct cases carry one label status. */
function casesWithStatus(
  cells: readonly CellFacts[],
  status: CellFacts['labelStatus'],
): number {
  return new Set(
    cells
      .filter((cell) => cell.labelStatus === status)
      .map((cell) => cell.caseId),
  ).size;
}

/**
 * The same figure, named for the case where it is about absence.
 *
 * `gold` and the two exclusion counts are the same measurement of different statuses; only
 * the reading differs, so the alias exists to keep each call site honest rather than to
 * duplicate the function.
 */
const casesWithoutReference = casesWithStatus;

/** Count each exclusion reason once per label. */
function exclusionsOf(
  rows: readonly LabelRow[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const reason of REASONS) counts[reason] = 0;
  for (const row of rows) {
    // A label can fail for several reasons, and each is counted: reporting only the
    // first would hide that a label is both stale and unapproved.
    for (const reason of row.reasons) {
      counts[reason] = (counts[reason] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * The label coverage of one run.
 *
 * The rows are keyed by the cases the *run observed*, not by the labels the dataset
 * happens to hold. A label for a case this run never asked about says nothing about
 * this run, and including it would inflate the denominator with decisions that were
 * never compared with anything.
 */
export function labelCoverageOf(parts: {
  readonly cells: readonly CellFacts[];
  readonly dataset: DatasetFacts;
  readonly executionDigest: string | null;
}): LabelCoverage {
  const caseIds = [...new Set(parts.cells.map((cell) => cell.caseId))].sort(
    compareText,
  );
  const rows = caseIds.map((caseId) => rowOf({ caseId, facts: parts.dataset }));
  const versions: LabelVersions | null =
    parts.dataset.manifest?.versions ?? null;
  return {
    source: parts.dataset.status,
    datasetId: parts.dataset.datasetId,
    datasetPath: null,
    executionDigest: parts.executionDigest,
    versions,
    cases: caseIds.length,
    // `gold` is the number of cases this report could actually compare against, not the
    // number the dataset marks approved. The difference is the whole point: a label approved
    // for an input the run never submitted is gold to the dataset and useless here, and a
    // table that reported it as gold would put a reference behind a number it never
    // influenced. The rows below keep the dataset's own view, so both facts are visible.
    gold: casesWithStatus(parts.cells, 'gold'),
    excluded: rows.filter((row) => row.outcome === 'excluded').length,
    missing: rows.filter((row) => row.outcome === 'missing').length,
    // Counted separately from `excluded`, and derived from the *cells* rather than from
    // the label rows: whether a label judges this run's material is a fact about the run's
    // fingerprint, and the dataset cannot know it. These are the cases whose reference was
    // withheld for that reason, so the number is also the size of the gap it creates.
    inputMismatch: casesWithoutReference(parts.cells, 'input-mismatch'),
    authorityConflict: casesWithoutReference(parts.cells, 'authority-conflict'),
    pending: rows.filter((row) => row.status === 'pending').length,
    disputed: rows.filter((row) => row.status === 'disputed').length,
    excludedByReason: exclusionsOf(rows),
    rows,
  };
}

/**
 * Whether the report can compute a gold metric at all.
 *
 * Stated as one predicate rather than as a scattered `length > 0` because every
 * layer needs to agree: a report that computed a rate in one section and left it
 * null in another would read as two different states of the same dataset.
 */
export function hasGold(coverage: LabelCoverage): boolean {
  return coverage.gold > 0;
}

/**
 * The sentence a report prints when nothing could be compared.
 *
 * It names the reason rather than saying "no data": an empty `labels/` and a dataset
 * that could not be read are different problems with different fixes, and a reader
 * has to know which one they are looking at.
 */
export function emptyGoldNote(coverage: LabelCoverage): string {
  if (coverage.source === 'unreadable') {
    return '数据集不可读，因此没有任何人类参考可比；这并不是 0% 通过率。';
  }
  if (coverage.source === 'absent') {
    return '没有提供数据集，因此没有人类参考可比；这并不是 0% 通过率。';
  }
  if (coverage.gold === 0 && coverage.excluded === 0) {
    return `数据集 ${String(coverage.datasetId)} 中 ${String(coverage.cases)} 条被观察的案例都没有已批准标签，因此金标指标没有分母；这是等待用户裁决的正常中间状态，不是缺陷。`;
  }
  if (coverage.gold === 0) {
    return `数据集 ${String(coverage.datasetId)} 有 ${String(coverage.excluded)} 条标签，但没有一条能计入金标；原因见排除计数。`;
  }
  return '';
}
