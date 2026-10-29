/**
 * The review decision engine over the shared contract.
 *
 * The engine reads one review outcome — the shared contract's `scored`,
 * `insufficient-material` or `review-failure` — and returns the settlement a host
 * should perform. It holds no thresholds, no risk cap and no backend-specific
 * gate: the matrix in `review-contract/matrix.ts` is the whole approval policy, and
 * a mode decides only *where* an escalation is sent.
 *
 * Three things are deliberately absent, because each of them was a way for the
 * old engine to disagree with the contract:
 *
 *   - the probability thresholds (`tauAuth`, `tauRisk`, `tauCritical`, `tauLow`,
 *     the two risk ceilings and the bulk-egress switch). They existed to paper
 *     over a signal shape the contract no longer produces, and a threshold
 *     redeclares what a band means;
 *   - the four effect probes (secrets/destructive/egress/bulk) and the
 *     `probeMode` override. A consequence that matters raises the risk band and a
 *     permission that does not cover the action lowers the authorization band, so
 *     a second boolean channel could only contradict the score;
 *   - the `normal`/`strict`/`progress` strategies. `normal` and `strict` already
 *     shared one engine and differed only in whether a human is asked, which is
 *     now the ask policy; `progress` widened the contract's own matrix, which the
 *     design forbids.
 *
 * What remains is the deterministic rule precedence (`deny > force-ask >
 * force-review > allow`), which lives in the matcher and is applied by the gate,
 * plus the stage → settlement mapping below.
 */

import type {
  ApprovalChannel,
  AskPolicy,
  ReviewStage,
  SettlementInstruction,
} from './review-contract/matrix.js';
import { settle } from './review-contract/matrix.js';
import type { ReviewOutcome } from './review-contract/types.js';

/** The stage an outcome reaches before any approval channel is consulted. */
export function stageOf(outcome: ReviewOutcome): ReviewStage {
  switch (outcome.status) {
    case 'scored':
      return outcome.verdict;
    case 'insufficient-material':
      // The material a score would stand on was never read, so the reviewer is
      // not asked and no score is invented. A person can supply what the host
      // could not, which is what an escalation means.
      return 'review-escalate';
    case 'review-failure':
      // The reviewer call, its output or its shape failed. That is a technical
      // fault, not an assessment, so it keeps its own stage: a human handoff can
      // then say the reviewer broke instead of implying it judged the action.
      return 'error-escalate';
  }
}

/**
 * The reason a human handoff or a denial reports for one outcome.
 *
 * The reason belongs to the outcome, not to the settlement: whether an escalation
 * became a question or a fallback denial, the operator sees the same explanation
 * of why the call got there.
 */
export function reasonOf(outcome: ReviewOutcome): string {
  switch (outcome.status) {
    case 'scored':
      return outcome.verdict === 'review-deny'
        ? `authorization band ${String(outcome.authorization)} is an applicable prohibition`
        : `risk ${String(outcome.risk)} requires authorization ${String(
            outcome.requiredAuthorization,
          )}; the review found ${String(outcome.authorization)}`;
    case 'insufficient-material':
      return outcome.reason;
    case 'review-failure':
      return outcome.reason;
  }
}

/**
 * Turn one review outcome into what the host should do.
 *
 * `ask` and `no-ask` share this matrix; the only difference is where an escalation
 * goes. Under `no-ask`, or with no channel, an escalation settles as a denial and
 * never as a question — the model is not a substitute for a person, so nothing
 * here can convert an escalation into an allow.
 */
export function settleOutcome(
  outcome: ReviewOutcome,
  ask: AskPolicy,
  channel: ApprovalChannel,
): SettlementInstruction {
  return settle(stageOf(outcome), ask, channel, reasonOf(outcome));
}

/** One deterministic rule verdict, settled under the current mode. */
export type RuleSettlement =
  | { readonly kind: 'ask-human'; readonly reason: string }
  | { readonly kind: 'fallback-deny'; readonly reason: string }
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'review' }
  | { readonly kind: 'allow' };

/**
 * What a matched rule does under one mode.
 *
 * The precedence is fixed by the design (`deny > force-ask > force-review >
 * allow`) and the matcher already resolved which verdict won, so this maps one
 * winning verdict to one settlement:
 *
 *   - `deny` outranks everything and applies in both modes;
 *   - `force-ask` demands a real person. Under `no-ask`, or with no reachable
 *     channel, it becomes a fallback denial: a model review is not a substitute
 *     for the human this rule requires, so nothing here can turn it into a
 *     review or an allow;
 *   - `allow` covers the call completely, so the reviewer is skipped;
 *   - `force-review` and an unmatched call both go to the reviewer, whose own
 *     settlement then decides.
 */
export function settleRule(options: {
  readonly verdict: 'allow' | 'deny' | 'force-ask' | 'force-review';
  readonly ask: AskPolicy;
  readonly channel: ApprovalChannel;
}): RuleSettlement {
  switch (options.verdict) {
    case 'deny':
      return { kind: 'deny', reason: 'a deny rule matches this call' };
    case 'force-ask':
      // The two reasons are different facts and the record keeps them apart: a
      // mode that never asks is not a host that could not ask.
      return options.ask === 'ask' && options.channel.status === 'available'
        ? {
            kind: 'ask-human',
            reason: 'a force-ask rule requires a human decision for this call',
          }
        : {
            kind: 'fallback-deny',
            reason:
              options.channel.status === 'unavailable'
                ? `a force-ask rule requires a human decision, but ${options.channel.reason}`
                : 'a force-ask rule requires a human decision, but this mode does not open human approval',
          };
    case 'allow':
      return { kind: 'allow' };
    case 'force-review':
      return { kind: 'review' };
  }
}
