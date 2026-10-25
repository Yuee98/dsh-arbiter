/**
 * Reading a stored result chain without inventing stages.
 *
 * The `trace` a record carries is a list of *stage results*, not a list of stage
 * names: `review(default)` is the rule stage handing the call to the review, and
 * `review-allow` is the review stage's own answer. Both begin with `review`, so
 * "did a model review happen" is answered by the prefix, not by an exact verb.
 *
 * A human or fallback stage alone proves nothing either way: a `force-ask` rule
 * reaches a human without any model call, so only a stored `review…` result (or
 * the review-failure stage) marks a model review.
 */

import type { CallDetailReviewState } from './call-detail-types.js';

/** Whether any stored stage result means the call reached a model review. */
export function reviewedTrace(trace: readonly string[]): boolean {
  return trace.some(
    (result) => result.startsWith('review') || result === 'error-escalate',
  );
}

/**
 * What a stored chain proves about a model review.
 *
 * A chain that records a review stage proves one happened. A chain that records
 * only rule or tool stages proves a short-circuit. An empty chain proves
 * nothing: an old row may simply never have stored its stages, so the honest
 * answer is `unknown`, not "no review".
 */
export function reviewStateOf(trace: readonly string[]): CallDetailReviewState {
  if (reviewedTrace(trace)) return 'reviewed';
  return trace.length === 0 ? 'unknown' : 'none';
}
