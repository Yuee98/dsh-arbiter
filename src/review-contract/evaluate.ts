/**
 * One review, from protocol answer to an auditable outcome.
 *
 * Three outcomes are possible and they are genuinely different states, not three
 * names for "not allowed":
 *
 *   scored                — the reviewer answered and the matrix decided
 *   insufficient-material — the answer is fine but the material behind it is not
 *   review-failure        — the answer, its transport or its shape failed
 *
 * They take different escalation paths, so collapsing any two of them would lose
 * information a person needs. No outcome ever fabricates a score: a failed read
 * reports what failed, and an incomplete material reports the gap.
 */

import type {
  InsufficientMaterialReview,
  MaterialAvailability,
  MaterialGap,
  PublicScore,
  ReviewEvaluation,
  ReviewFailureOutcome,
  ReviewOutcome,
  ScoreFailure,
} from './types.js';
import { readProtocolScores } from './normalize.js';
import { scoreReview } from './matrix.js';

/**
 * Evaluate one reviewer answer that is *not* already known to be a transport or
 * call failure. A call-level failure is the caller's `review-failure`, which this
 * function cannot observe and must not invent.
 */
export function evaluateReview(evaluation: ReviewEvaluation): ReviewOutcome {
  const read = readProtocolScores(evaluation.scores);
  if (!read.ok) {
    return {
      status: 'review-failure',
      failures: read.failures,
      reason: summarizeFailures(read.failures),
      // A partial read is evidence, never a verdict: the valid half is kept so a
      // person can tell a confused reviewer from a broken transport.
      diagnostic: read.diagnostic,
    };
  }
  const material = evaluation.material ?? { status: 'available' };
  if (material.status === 'insufficient') {
    return insufficientMaterial(material.gaps, read.risk, read.authorization);
  }
  return scoreReview(read.risk, read.authorization, {
    source: evaluation.scores.source,
    audit: read.audit,
  });
}

/**
 * The outcome for a review whose material could not be assembled.
 *
 * The partial scores are kept as diagnostics because they may still help a person
 * understand what the reviewer saw, but they never become a verdict: the material
 * that would justify one is the part that is missing.
 */
function insufficientMaterial(
  gaps: readonly MaterialGap[],
  risk: PublicScore,
  authorization: PublicScore,
): InsufficientMaterialReview {
  return {
    status: 'insufficient-material',
    gaps,
    reason:
      gaps.length === 0
        ? 'required review material was unavailable'
        : `required review material was unavailable: ${gaps
            .map((gap) => `${gap.source} (${gap.reason})`)
            .join(', ')}`,
    diagnostic: { risk, authorization },
  };
}

/** The failure outcome for a call the reviewer never completed. */
export function reviewFailure(error: string): ReviewFailureOutcome {
  return {
    status: 'review-failure',
    failures: [],
    reason: error,
    // A call-level failure produced no answer at all, so there is nothing partial
    // to keep.
    diagnostic: null,
  };
}

/**
 * One sentence naming what failed, for a human handoff.
 *
 * It names the field and the reason class only — never the reviewer's raw output,
 * which may quote the material being reviewed.
 */
export function summarizeFailures(failures: readonly ScoreFailure[]): string {
  if (failures.length === 0) return 'the review produced no usable score';
  return failures
    .map((failure) => `${failure.field} (${failure.reason}: ${failure.detail})`)
    .join('; ');
}

/** Where a review's material came from, for the material-availability input. */
export function materialAvailability(
  gaps: readonly MaterialGap[],
): MaterialAvailability {
  return gaps.length === 0
    ? { status: 'available' }
    : { status: 'insufficient', gaps };
}

/** Which outcome this evaluation produced, for a caller that only needs the kind. */
export function outcomeStatus(outcome: ReviewOutcome): ReviewOutcome['status'] {
  return outcome.status;
}
