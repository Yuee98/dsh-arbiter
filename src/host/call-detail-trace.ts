/**
 * What a stored record proves about whether a model request was actually made.
 *
 * The stored chain mixes facts of different strength, and treating them alike is
 * how a detail starts making claims it cannot support:
 *
 *   - `review(default)` and `force-review` are rule-stage *routing*. They prove
 *     the review pipeline was entered, not that a request was sent.
 *   - `error-escalate` can be written before any request exists — an open circuit
 *     breaker, a snapshot that could not be built, an input budget that cannot be
 *     assembled, a Reviewer adapter that failed before calling out. It is also
 *     written after a request failed.
 *   - `review-allow` / `review-deny` / `review-escalate` are the policy's answer
 *     to a response, and a stored model attempt is the record of a request that
 *     was actually issued. Those are the only positive evidence this module
 *     trusts.
 *
 * Because an unrecognized escalation reason proves nothing either way, it is
 * classified `unknown` rather than being guessed into `reviewed` or `none`. The
 * three states exist precisely so the page can avoid both mistakes.
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
 * Each is the gate's own pre-request exit. Any other reason may have come back
 * from an attempt, and without a recorded attempt it cannot be attributed.
 */
const PRE_REQUEST_REASONS: ReadonlySet<string> = new Set([
  'circuit_open',
  'input_budget_exceeded',
]);

/** Whether a reason names a failure that is provably before the model call. */
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

/** A stage result that enters the review pipeline without proving a request. */
function routingResult(result: string): boolean {
  return result.startsWith('review') || result === 'force-review';
}

/**
 * Classify an escalation.
 *
 * A source that stored no stage reasons cannot say whether the failure came from
 * an attempt, so it is `unknown`. With reasons available, only a provably
 * pre-request failure means no request was made; anything else is unattributable.
 */
function escalationState(
  stages: readonly TraceStageFacts[] | null,
): CallDetailReviewState {
  if (stages === null) return 'unknown';
  const escalations = stages.filter(
    (stage) => stage.result === 'error-escalate',
  );
  if (escalations.some((stage) => !preRequestFailure(stage.reason)))
    return 'unknown';
  return escalations.length > 0 ? 'none' : 'unknown';
}

/**
 * Classify one call from its stored chain and its stored attempt records.
 *
 * `stages` is the structured chain when the source stored one; `attemptCount` is
 * how many model attempts the source actually recorded. A session record keeps
 * neither, so both arrive empty there and the answer stays conservative.
 */
export function reviewStateOf(
  trace: readonly string[],
  stages: readonly TraceStageFacts[] | null,
  attemptCount: number,
): CallDetailReviewState {
  // Positive evidence first, even when the trace is empty: a stored attempt is
  // the record of a request that was issued, and no chain needs to corroborate
  // it. An old row can carry attempts while its result list was never written.
  if (attemptCount > 0) return 'reviewed';
  if (trace.length === 0) return 'unknown';
  if (trace.some(definitiveReview)) return 'reviewed';
  if (trace.includes('error-escalate')) return escalationState(stages);
  // No review answer and no escalation. Routing alone cannot be attributed.
  if (trace.some(routingResult)) return 'unknown';
  // A rule, human or fallback ending with no review stage at all: no request was
  // made, whatever supplied the final verdict.
  return 'none';
}
