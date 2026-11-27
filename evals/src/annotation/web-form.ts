import type {
  HumanState,
  IndependentAnswer,
} from '../data/annotation-types.js';
import type { LabelTarget } from '../data/types.js';
import type { WebForm } from './web-types.js';
import { isPublicScore } from '../../../src/review-contract/rubrics.js';
import { verdictFor } from '../../../src/review-contract/matrix.js';
import type { ReviewVerdict } from '../../../src/types.js';
import { materialLines } from './web-material.js';

export function sameWebForm(left: WebForm, right: WebForm): boolean {
  const fields = (value: WebForm) => [
    value.noScores === true,
    value.pairs,
    value.behaviour,
    value.rationale,
    value.evidence,
    value.author,
    value.state,
  ];
  return JSON.stringify(fields(left)) === JSON.stringify(fields(right));
}

function scorePairs(text: string): number[][] {
  return text.trim() === ''
    ? []
    : text
        .trim()
        .split(/\n+/u)
        .map((line) =>
          line
            .trim()
            .split(/[,，\s]+/u)
            .map(Number),
        );
}

/** A matrix preview for each valid pair. Null means the supplied set is invalid. */
export function matrixPreview(text: string): readonly ReviewVerdict[] | null {
  const pairs = scorePairs(text);
  const outcomes: ReviewVerdict[] = [];
  const seen = new Set<string>();
  let prohibited = 0;
  for (const pair of pairs) {
    const [risk, authorization] = pair;
    const key = pair.join(',');
    if (
      pair.length !== 2 ||
      !isPublicScore(risk) ||
      !isPublicScore(authorization) ||
      seen.has(key)
    )
      return null;
    seen.add(key);
    if (authorization === 1) prohibited += 1;
    outcomes.push(verdictFor(risk, authorization));
  }
  return prohibited > 0 && prohibited !== pairs.length ? null : outcomes;
}

/** Parsing never expands independent score sets into a Cartesian product. */
export function formAnswer(form: WebForm): unknown {
  return {
    pairs:
      form.noScores === true || form.pairs.trim() === ''
        ? null
        : scorePairs(form.pairs),
    behaviourReference: form.behaviour === '' ? null : form.behaviour,
    rationale: form.rationale,
    evidence: form.evidence.split('\n').filter((line) => line.trim() !== ''),
    conflicts: [],
  };
}
export function humanTarget(
  answer: IndependentAnswer,
  author: string,
  state: HumanState,
  date: string,
): LabelTarget {
  return {
    status: state === 'confirmed' ? 'approved' : 'pending',
    allowed: {
      risk:
        answer.pairs === null
          ? null
          : [...new Set(answer.pairs.map((p) => p[0]))],
      authorization:
        answer.pairs === null
          ? null
          : [...new Set(answer.pairs.map((p) => p[1]))],
    },
    ...(answer.pairs === null ? {} : { allowedPairs: answer.pairs }),
    behaviourReference: answer.behaviourReference,
    rationale: answer.rationale,
    evidence: answer.evidence.map((ref) => ({ kind: 'material-quote', ref })),
    decidedBy: author,
    decidedAt: date,
  };
}
export function changedMaterial(
  current: unknown,
  previous: unknown,
): readonly number[] {
  const positions = new Map<string, number[]>();
  materialLines(previous).forEach((line, index) => {
    const indexes = positions.get(line) ?? [];
    indexes.push(index);
    positions.set(line, indexes);
  });
  let cursor = -1;
  return materialLines(current).flatMap((line, index) => {
    const candidates = positions.get(line) ?? [];
    let low = 0,
      high = candidates.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((candidates[middle] ?? -1) <= cursor) low = middle + 1;
      else high = middle;
    }
    const match = candidates[low];
    if (match === undefined) return [index];
    cursor = match;
    return [];
  });
}
