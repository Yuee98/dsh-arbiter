/** A reference's origin, binding and per-metric applicability travel together. */
import type { AnnotationBinding } from '../data/annotation-types.js';
import type { LabelTarget } from '../data/types.js';
import type { Consensus } from '../annotation/consensus.js';
import type { CellFacts } from './cell.js';
import type { LabelFacts } from './observe.js';

export interface MetricReference {
  readonly source:
    'human' | 'human-inherited' | 'model-consensus' | 'unresolved';
  readonly basis: 'legacy-contract' | 'independent-behaviour';
  readonly referenceId: string | null;
  readonly target: LabelTarget | null;
  readonly humanConfirmed: boolean;
  readonly behaviourEligible: boolean;
  readonly scoringEligible: boolean;
  readonly binding: AnnotationBinding | null;
  readonly reasons: readonly string[];
  readonly consensus: Pick<
    Consensus,
    | 'n'
    | 'k'
    | 'returned'
    | 'valid'
    | 'missing'
    | 'failed'
    | 'branch'
    | 'maxDeviation'
  > | null;
}

export function legacyReference(parts: {
  readonly label: LabelFacts | null;
  readonly caseKnown: boolean;
  readonly inputHash: string | null;
  readonly conflicted: boolean;
}): MetricReference {
  const label = parts.label;
  const reasons = [...(label?.reasons ?? [])].filter(
    (reason) => reason !== 'no-score',
  );
  if (!parts.caseKnown) reasons.push('case-missing');
  if (label === null) reasons.push('reference-missing');
  if (parts.conflicted) reasons.push('authority-conflict');
  if (
    label !== null &&
    parts.inputHash !== null &&
    label.label.inputHash !== parts.inputHash
  )
    reasons.push('input-mismatch');
  const eligible = reasons.length === 0;
  return {
    source: eligible ? 'human' : 'unresolved',
    basis: 'legacy-contract',
    referenceId: label?.path ?? null,
    target: label?.label.target ?? null,
    humanConfirmed: label?.label.target.status === 'approved',
    behaviourEligible:
      eligible && label?.label.target.behaviourReference !== null,
    scoringEligible: eligible,
    binding: null,
    reasons: [...new Set(reasons)],
    consensus: null,
  };
}

export function referenceOfCell(cell: CellFacts): MetricReference {
  return cell.evaluationReference;
}

/** Complete-pair and single-field diagnostics make their own further checks. */
export function scoringTargetOf(cell: CellFacts): LabelTarget | null {
  const reference = referenceOfCell(cell);
  return reference.scoringEligible ? reference.target : null;
}
