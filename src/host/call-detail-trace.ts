/**
 * What a stored chain proves about whether a model request was actually made.
 *
 * The stored chain mixes two different things, and treating them alike is how a
 * detail starts making claims it cannot support:
 *
 *   - `review(default)` is the rule stage *routing* the call to review. It proves
 *     the review pipeline was entered, not that a request was sent.
 *   - `error-escalate` can be written before any request exists — an open circuit
 *     breaker, a snapshot that could not be built, an input budget that cannot be
 *     assembled — as well as after a request failed.
 *   - `review-allow` / `review-deny` / `review-escalate` are the policy's answer
 *     to a model response, so they do prove one was obtained.
 *
 * The three states are kept distinct because they mean different things to a
 * reader: no request was made, a request was made, or the record cannot tell.
 */

import type { CallDetailReviewState } from './call-detail-types.js';

/** One stage's result and the reason recorded with it. */
export interface TraceStageFacts {
  readonly result: string;
  readonly reason: string | null;
}

/**
 * Reasons an `error-escalate` stage is written *before* any model request.
 *
 * These are the gate's own pre-request exits; a failure with any other reason
 * came back from the model attempt itself.
 */
const PRE_REQUEST_REASONS: ReadonlySet<string> = new Set([
  'circuit_open',
  'input_budget_exceeded',
]);

/** Whether a reason names a failure that happened before the model was called. */
function preRequestFailure(reason: string | null): boolean {
  if (reason === null) return false;
  return (
    PRE_REQUEST_REASONS.has(reason) || reason.startsWith('snapshot_error:')
  );
}

/** Whether a stage result is the policy's answer to an actual model response. */
function definitiveReview(result: string): boolean {
  return (
    result === 'review-allow' ||
    result === 'review-deny' ||
    result === 'review-escalate'
  );
}

/**
 * Classify one call from its stored chain.
 *
 * `stages` is the structured chain when the source stored one. Without it, an
 * `error-escalate` cannot be attributed, so the answer is `unknown` rather than
 * a guess in either direction.
 */
export function reviewStateOf(
  trace: readonly string[],
  stages: readonly TraceStageFacts[] | null,
): CallDetailReviewState {
  if (trace.length === 0) return 'unknown';
  if (trace.some(definitiveReview)) return 'reviewed';
  const escalations = (stages ?? []).filter(
    (stage) => stage.result === 'error-escalate',
  );
  if (escalations.some((stage) => !preRequestFailure(stage.reason)))
    return 'reviewed';
  if (escalations.length > 0) {
    // Every escalation is a pre-request exit: the pipeline was entered and the
    // request never was.
    return 'none';
  }
  // No review answer and no escalation. A chain that still names a review stage
  // cannot be attributed without its reasons, so it stays unknown.
  if (trace.some((result) => result.startsWith('review'))) return 'unknown';
  // A rule, human or fallback ending with no review stage at all: no request was
  // made, whatever supplied the final verdict.
  return 'none';
}
