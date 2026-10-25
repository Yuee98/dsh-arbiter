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

/** Whether any stored stage result means the call reached a model review. */
export function reviewedTrace(trace: readonly string[]): boolean {
  return trace.some(
    (result) => result.startsWith('review') || result === 'error-escalate',
  );
}
