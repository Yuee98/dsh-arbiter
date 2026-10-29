/**
 * The shared decision matrix and its settlement instruction.
 *
 * The matrix is the whole approval policy in one table: risk decides the weakest
 * authorization that may permit an action, and the single asymmetric band at the
 * bottom of the authorization scale denies outright. There is no second ceiling
 * on risk, no backend-specific gate and no mode-specific matrix — a mode only
 * changes *where* an escalation is sent, which is the settlement step below.
 *
 * The module returns an instruction rather than performing anything: the host owns
 * real approval channels, sessions and lifecycle.
 */

import type { ReviewVerdict } from '../types.js';
import type { PublicScore, ScoredReview } from './types.js';
import {
  AUTHORIZATION_DENIAL_SCORE,
  requiredAuthorizationFor,
} from './rubrics.js';

/** The verdict a score pair reaches by the matrix alone. */
export function verdictFor(
  risk: PublicScore,
  authorization: PublicScore,
): ReviewVerdict {
  // An effective prohibition is not "insufficient authorization" — it is a
  // refusal, in every mode and at every risk. The rubric states band 1 as an
  // applicable prohibition or withdrawal, so it can never be read as a low score.
  if (authorization === AUTHORIZATION_DENIAL_SCORE) return 'review-deny';
  return authorization >= requiredAuthorizationFor(risk)
    ? 'review-allow'
    : 'review-escalate';
}

/** A scored review with the matrix applied. */
export function scoreReview(
  risk: PublicScore,
  authorization: PublicScore,
  review: Omit<
    ScoredReview,
    'status' | 'risk' | 'authorization' | 'requiredAuthorization' | 'verdict'
  >,
): ScoredReview {
  return {
    status: 'scored',
    ...review,
    risk,
    authorization,
    requiredAuthorization: requiredAuthorizationFor(risk),
    verdict: verdictFor(risk, authorization),
  };
}

/** Whether this environment can actually reach a human. */
export type ApprovalChannel =
  | { readonly status: 'available' }
  | { readonly status: 'unavailable'; readonly reason: string };

/** Which ask policy applies to one call. */
export type AskPolicy = 'ask' | 'no-ask';

/** What the host should do with one reviewed call. */
export type SettlementInstruction =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }
  | {
      readonly kind: 'ask-human';
      /** The review stage this escalation came from. */
      readonly stage: 'review-escalate' | 'error-escalate';
      readonly reason: string;
    }
  | {
      readonly kind: 'fallback-deny';
      readonly stage: 'review-escalate' | 'error-escalate';
      readonly reason: string;
    };

/** The review stage a settlement follows from. */
export type ReviewStage =
  'review-allow' | 'review-deny' | 'review-escalate' | 'error-escalate';

/**
 * Turn a review stage into the settlement the host should perform.
 *
 * Escalation and human availability are two different facts, and the difference
 * matters: an `error-escalate` that reaches a person keeps its own stage in the
 * instruction, so the human handoff text can still say the reviewer failed. Without
 * a channel — or under `no-ask` — an escalation settles as a denial; it never sits
 * unresolved and is never silently allowed.
 */
export function settle(
  stage: ReviewStage,
  ask: AskPolicy,
  channel: ApprovalChannel,
  reason: string,
): SettlementInstruction {
  switch (stage) {
    case 'review-allow':
      return { kind: 'allow' };
    case 'review-deny':
      return { kind: 'deny', reason };
    case 'review-escalate':
    case 'error-escalate':
      return ask === 'ask' && channel.status === 'available'
        ? { kind: 'ask-human', stage, reason }
        : { kind: 'fallback-deny', stage, reason };
    default:
      // Unreachable for the declared union; keeping the branch total means a new
      // stage cannot silently settle as an allow.
      return { kind: 'fallback-deny', stage: 'error-escalate', reason };
  }
}
