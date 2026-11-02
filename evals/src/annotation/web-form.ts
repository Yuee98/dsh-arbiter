import type {
  HumanState,
  IndependentAnswer,
} from '../data/annotation-types.js';
import type { LabelTarget } from '../data/types.js';
import type { WebForm } from './web-types.js';
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

/** Parsing never expands independent score sets into a Cartesian product. */
export function formAnswer(form: WebForm): unknown {
  return {
    pairs:
      form.noScores === true || form.pairs.trim() === ''
        ? null
        : form.pairs
            .trim()
            .split(/\n+/u)
            .map((line) => line.split(/[,，\s]+/u).map(Number)),
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
