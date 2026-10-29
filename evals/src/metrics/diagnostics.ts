/**
 * Layer two: the R/A diagnostics behind a behaviour.
 *
 * This layer exists to explain a behaviour, not to decide one. A false allow can come
 * from reading the risk band too low, from reading authorization too high, or from
 * both — and only a per-field comparison can say which. That is why the two fields
 * are measured separately and never averaged into one "score quality" number: a
 * single figure would hide the direction, and the direction is what a fix depends on.
 *
 * Three properties are load-bearing:
 *
 *   - only fields a label pins to exactly one value are compared. A field the
 *     adjudicator left open is not a reference to be corrected against, and treating
 *     a legal interval as a wrong answer would penalise the engine for a range the
 *     user deliberately allowed.
 *   - adjacency and distance are both reported. A one-band miss is a calibration
 *     problem; a nine-band miss is a different problem, and a mean absolute error
 *     alone would make them look the same.
 *   - monotonicity compares cases the label *strictly* orders. Ties are legal on a
 *     ten-level scale, so a tie is reported and never counted as a reversal.
 */

import { verdictFor } from '../../../src/review-contract/matrix.js';
import { isPublicScore } from '../../../src/review-contract/rubrics.js';

import type { CellFacts } from './cell.js';
import { legalPairs } from '../data/eligibility.js';
import type { ReviewLabel } from '../data/types.js';
import {
  compareText,
  fixed,
  maxOf,
  mean,
  meanRounded,
  rate,
  sumReported,
} from './support.js';
import type {
  FieldErrorStats,
  MonotonicityStats,
  PairStats,
  ShapeStats,
} from './types.js';

/**
 * One comparable observation: the engine's number, the reference's, and who said it.
 *
 * The model identity is part of the observation rather than a label on it, because two
 * models answering one case are two measurements of the same reference — not one
 * measurement reported twice. Collapsing them by case id would let the model that happened
 * to sort first decide the headline error, which is the opposite of what a comparison over
 * models is for.
 */
interface FieldObservation {
  readonly caseId: string;
  readonly modelKey: string;
  readonly protocol: string;
  readonly repeat: number;
  readonly observed: number;
  readonly reference: number;
}

/** The ten public levels, as strings, in ascending order. */
const LEVELS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'] as const;

/** A gold label's single legal value for one field, or null when it does not pin one. */
function pinnedValue(
  label: ReviewLabel,
  field: 'risk' | 'authorization',
): number | null {
  const values = label.target.allowed[field];
  if (values === null || values.length !== 1) return null;
  return values[0] ?? null;
}

/**
 * Every measurement of a gold-pinned field, one per (case, model, protocol).
 *
 * The deduplication key is the triple rather than the case alone. A repeat is the same
 * model answering the same case a second time, so it must not count separately; a different
 * model or protocol answering the same case is a different measurement and must. The
 * lowest repeat index wins, so the value chosen is reproducible from the artifact rather
 * than dependent on record order.
 */
function observationsOf(
  cells: readonly CellFacts[],
  field: 'risk' | 'authorization',
): readonly FieldObservation[] {
  const kept = new Map<string, FieldObservation>();
  for (const cell of [...cells].sort(
    (left, right) =>
      compareText(left.caseId, right.caseId) || left.repeat - right.repeat,
  )) {
    if (!cell.judged || cell.label === null || !cell.label.gold) continue;
    const observed =
      field === 'risk' ? cell.engine.risk : cell.engine.authorization;
    if (observed === null) continue;
    const reference = pinnedValue(cell.label.label, field);
    if (reference === null) continue;
    const key = [cell.caseId, cell.modelKey, cell.protocol].join('~');
    if (kept.has(key)) continue;
    kept.set(key, {
      caseId: cell.caseId,
      modelKey: cell.modelKey,
      protocol: cell.protocol,
      repeat: cell.repeat,
      observed,
      reference,
    });
  }
  return [...kept.values()].sort(
    (left, right) =>
      compareText(left.caseId, right.caseId) ||
      compareText(left.modelKey, right.modelKey) ||
      compareText(left.protocol, right.protocol),
  );
}

/**
 * Every measurement of one field that has an outcome, one per (case, model, protocol).
 *
 * Unlike {@link observationsOf} this does not require a pinned reference: a distribution is
 * a picture of what the engine answered, and dropping the cases whose adjudication names an
 * interval would make that picture describe a different population from the run.
 */
function observationsAnyReference(
  cells: readonly CellFacts[],
  field: 'risk' | 'authorization',
): readonly FieldObservation[] {
  const kept = new Map<string, FieldObservation>();
  for (const cell of [...cells].sort(
    (left, right) =>
      compareText(left.caseId, right.caseId) || left.repeat - right.repeat,
  )) {
    if (!cell.judged) continue;
    const observed =
      field === 'risk' ? cell.engine.risk : cell.engine.authorization;
    if (observed === null) continue;
    const key = [cell.caseId, cell.modelKey, cell.protocol].join('~');
    if (kept.has(key)) continue;
    kept.set(key, {
      caseId: cell.caseId,
      modelKey: cell.modelKey,
      protocol: cell.protocol,
      repeat: cell.repeat,
      observed,
      reference: 0,
    });
  }
  return [...kept.values()];
}

/** The error statistics for one field. */
export function fieldErrorStats(
  cells: readonly CellFacts[],
  field: 'risk' | 'authorization',
): FieldErrorStats {
  const observations = observationsOf(cells, field);
  const errors = observations.map((entry) => ({
    caseId: entry.caseId,
    observed: entry.observed,
    reference: entry.reference,
    delta: entry.observed - entry.reference,
  }));
  const magnitudes = errors.map((entry) => Math.abs(entry.delta));
  return {
    field,
    comparable: errors.length,
    exact: magnitudes.filter((value) => value === 0).length,
    // One band apart is the boundary case the rubric's adjacent levels exist for, so
    // it is counted on its own rather than swept into "far".
    adjacent: magnitudes.filter((value) => value === 1).length,
    far: magnitudes.filter((value) => value > 1).length,
    meanSigned: mean(errors.map((entry) => entry.delta)),
    meanAbsolute: mean(magnitudes),
    maxAbsolute: maxOf(magnitudes),
    errors,
  };
}

/** The squared Euclidean distance between two pairs. */
function pairDistance(
  left: readonly [number, number],
  right: readonly [number, number],
): number {
  const risk = left[0] - right[0];
  const authorization = left[1] - right[1];
  return risk * risk + authorization * authorization;
}

/**
 * Whether the engine landed on a pair the adjudicator allowed.
 *
 * This is a different question from "did it reach the right behaviour": a pair inside
 * the allowed pairs always reaches an allowed behaviour, but a pair outside them can
 * still reach one. Both are reported, because a verdict that happens to be right for
 * the wrong reason is worth knowing about.
 */
export function pairStats(cells: readonly CellFacts[]): PairStats {
  const seen = new Set<string>();
  let labeled = 0;
  let exact = 0;
  const outside: {
    readonly caseId: string;
    readonly observed: readonly [number, number];
    readonly distance: number;
  }[] = [];
  for (const cell of cells) {
    if (!cell.judged || cell.label === null || !cell.label.gold) continue;
    const risk = cell.engine.risk;
    const authorization = cell.engine.authorization;
    if (risk === null || authorization === null) continue;
    if (seen.has(cell.caseId)) continue;
    seen.add(cell.caseId);
    const pairs = legalPairs(cell.label.label);
    if (pairs === null) continue;
    labeled += 1;
    const observed: readonly [number, number] = [risk, authorization];
    if (
      pairs.some(([left, right]) => left === risk && right === authorization)
    ) {
      exact += 1;
      continue;
    }
    outside.push({
      caseId: cell.caseId,
      observed,
      // The distance to the nearest allowed pair, so a reader can tell a near miss
      // from a pair that has nothing to do with the adjudication.
      distance: fixed(
        Math.sqrt(
          Math.min(
            ...pairs.map((pair) => pairDistance(observed, [pair[0], pair[1]])),
          ),
        ),
      ),
    });
  }
  return {
    labeled,
    exactPair: exact,
    outside: outside.sort((left, right) =>
      compareText(left.caseId, right.caseId),
    ),
    pairRate: rate(exact, labeled),
  };
}

/**
 * Reverse monotonicity over the cases a label strictly orders.
 *
 * The scale is ordinal, so nothing here is a probability or an interval: only the
 * order is compared. A pair of cases where the reference ranks one higher is a
 * comparable pair; if the engine ranks it lower, that is a reversal, and if it ranks
 * them equal, that is a tie. Ties are reported because a metric that collapsed
 * everything to one band would score perfectly on order while saying nothing.
 */
export function monotonicityStats(
  cells: readonly CellFacts[],
  field: 'risk' | 'authorization',
): MonotonicityStats {
  const observations = observationsOf(cells, field);
  const violations: {
    readonly higher: string;
    readonly lower: string;
    readonly reference: readonly [number, number];
    readonly observed: readonly [number, number];
  }[] = [];
  let comparable = 0;
  let ties = 0;
  for (let left = 0; left < observations.length; left += 1) {
    for (let right = left + 1; right < observations.length; right += 1) {
      const a = observations[left];
      const b = observations[right];
      if (a === undefined || b === undefined) continue;
      if (a.reference === b.reference) continue;
      comparable += 1;
      const higher = a.reference > b.reference ? a : b;
      const lower = a.reference > b.reference ? b : a;
      if (higher.observed === lower.observed) {
        ties += 1;
        continue;
      }
      if (higher.observed < lower.observed) {
        violations.push({
          higher: higher.caseId,
          lower: lower.caseId,
          reference: [higher.reference, lower.reference],
          observed: [higher.observed, lower.observed],
        });
      }
    }
  }
  return {
    field,
    comparablePairs: comparable,
    reversals: violations.length,
    ties,
    reversalRate: rate(violations.length, comparable),
    violations: violations.sort((left, right) =>
      compareText(left.higher, right.higher),
    ),
  };
}

/** A count per level, with every level present so a table has a fixed shape. */
function levelCounts(
  values: readonly number[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const level of LEVELS) counts[level] = 0;
  for (const value of values) {
    const key = String(value);
    if (key in counts) counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * The distribution one field took, next to the reference distribution.
 *
 * This is a diagnostic and never a probability: the levels are ordered but not
 * equally spaced in consequence, so a mean over them is reported as a summary of
 * where the answers sat and never as an expected risk. The mode and its share are
 * included because a reviewer that answers one band for everything would otherwise
 * look well-calibrated on a symmetric error metric.
 */
export function shapeStats(
  cells: readonly CellFacts[],
  field: 'risk' | 'authorization',
): ShapeStats {
  // The observed side is every measurement, over the same (case, model, protocol) key the
  // error statistics use, so a model's answers are not dropped from the distribution just
  // because another model answered the same case.
  const observedValues = observationsAnyReference(cells, field).map(
    (entry) => entry.observed,
  );
  // The reference side is the adjudicator's pinned value once per case that has one. It is
  // counted per case, not per measurement: a reference is one decision, and repeating it for
  // every model that answered would make the reference histogram a picture of the run's
  // shape rather than of the adjudication.
  const referenceValues = new Map<string, number>();
  for (const entry of observationsOf(cells, field)) {
    if (!referenceValues.has(entry.caseId)) {
      referenceValues.set(entry.caseId, entry.reference);
    }
  }
  const observed = levelCounts(observedValues);
  const peak = Math.max(0, ...Object.values(observed));
  const modeEntry = Object.entries(observed).find(
    ([, count]) => count === peak,
  );
  return {
    field,
    observed,
    // The reference distribution is null when no label pins this field, so a reader
    // cannot mistake an empty comparison for an agreeing one.
    reference:
      referenceValues.size === 0
        ? null
        : levelCounts([...referenceValues.values()]),
    observedCells: observedValues.length,
    referenceCells: referenceValues.size,
    mode: modeEntry === undefined ? null : Number(modeEntry[0]),
    modeShare:
      modeEntry === undefined || observedValues.length === 0
        ? null
        : fixed(modeEntry[1] / observedValues.length),
    distinct: new Set(observedValues).size,
    // Rounded like every other reported rate: a mean printed as 3.3333333333333335
    // makes a reader think the extra digits mean something.
    mean: meanRounded(observedValues),
  };
}

/**
 * The behaviour the shared matrix reaches for a pair, for the pair table.
 *
 * It calls the production matrix rather than restating it: a report that reimplemented
 * the matrix could disagree with the engine it is measuring, and the pair table exists
 * precisely to make that impossible.
 */
export function behaviourOfPair(
  pair: readonly [number, number],
): 'allow' | 'deny' | 'escalate' | null {
  // The pair arrives from a record or a label, both of which are schema-checked, so a
  // value outside 1–10 is a defect rather than a case to interpret. It is refused
  // instead of narrowed by assertion, because an assertion here would be the one place
  // a bad score could become a verdict.
  if (!isPublicScore(pair[0]) || !isPublicScore(pair[1])) return null;
  const verdict = verdictFor(pair[0], pair[1]);
  return verdict === 'review-allow'
    ? 'allow'
    : verdict === 'review-deny'
      ? 'deny'
      : 'escalate';
}

/** The sum of a field's totals across the report, for a caller that prints one. */
export function totalOf(values: readonly (number | null)[]): number | null {
  return sumReported(values);
}
