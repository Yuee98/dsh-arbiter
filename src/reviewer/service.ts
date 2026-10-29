/**
 * The reviewer service: one review, from snapshot to a shared outcome.
 *
 * This is the callable capability the task delivers. It takes material a caller
 * assembled (production builds it from the host; the evals tooling builds it from
 * a case) and returns the shared contract's outcome plus the attempts that
 * produced it and their usage. It is deliberately independent of the host:
 * nothing here reads configuration, a session, a clock or the audit store, so a
 * production review and an eval review of the same material are the same call.
 *
 * What it does *not* do, on purpose:
 *
 *   - it does not decide. The outcome is scored / insufficient-material /
 *     review-failure from `review-contract`; applying the matrix and settling a
 *     verdict belongs to the caller that owns approval channels.
 *   - it does not fall back to a mean, a threshold or a default score. A failed
 *     read is a failure, and a missing source is an insufficient review.
 *   - it does not require the legacy effect probes. They are gone from the
 *     request, so nothing here reads them.
 *
 * A production entry point still points at the previous reviewer until RQ-04
 * switches it; this module is what that switch will call.
 */

import type {
  ProtocolScores,
  ReviewOutcome,
  ScoreTrail,
} from '../review-contract/types.js';
import { evaluateReview } from '../review-contract/evaluate.js';
import type { ReviewSnapshot } from '../types.js';
import { maskAttempt, type ReviewAttempt } from './attempt.js';
import { runChatTransport, type ChatTransportContext } from './chat.js';
import {
  runDecisionTransport,
  type DecisionTransportContext,
} from './decision.js';
import {
  renderChatRequest,
  renderChatUser,
  renderDecisionRequest,
} from './prompt.js';
import { redact, redactAuthHeaders } from './redact.js';
import { aggregateUsage, type UsageAggregate } from './usage.js';

/** What a caller must supply to run one review. */
export interface ReviewRequest {
  readonly snapshot: ReviewSnapshot;
  readonly callId: string;
  /** The caller's lifetime. An abort is reported as such, never as a timeout. */
  readonly signal: AbortSignal;
  /**
   * Which backend to ask.
   *
   * The two variants carry only what that transport needs, so a chat review
   * cannot accidentally require a decision credential and vice versa.
   */
  readonly backend: ChatBackend | DecisionBackend;
}

export interface ChatBackend {
  readonly kind: 'chat';
  readonly transport: ChatTransportContext;
}

export interface DecisionBackend {
  readonly kind: 'decision';
  readonly transport: DecisionTransportContext;
}

/**
 * One review's result.
 *
 * The outcome is the contract's own; `attempts` and `usage` are how it was
 * produced. Keeping both means a caller that only wants the verdict reads one
 * field, and a caller that must show or bill the cost reads the other.
 */
export interface ReviewResult {
  readonly outcome: ReviewOutcome;
  readonly protocol: 'chat' | 'decision';
  readonly attempts: readonly ReviewAttempt[];
  /** The review's usage over its actual attempts, mapped by the shared contract. */
  readonly usage: UsageAggregate;
}

/**
 * Whether the material can support a score at all.
 *
 * M0 owns this; the reviewer only reads its status. A `complete` report — the
 * connection probe's synthetic input — counts as available, because a probe makes
 * no observation and must not be reported as a gap it never saw.
 */
function completenessOf(
  snapshot: ReviewSnapshot,
): ReviewSnapshot['completeness'] {
  return snapshot.completeness;
}

/** The outcome for a protocol answer that read, with the material noted. */
function outcomeOf(
  snapshot: ReviewSnapshot,
  scores: ProtocolScores,
): ReviewOutcome {
  const completeness = completenessOf(snapshot);
  return evaluateReview({
    scores,
    material:
      completeness.status === 'insufficient'
        ? { status: 'insufficient', gaps: completeness.gaps }
        : { status: 'available' },
  });
}

/**
 * Run one review.
 *
 * A transport failure and a malformed answer both end as `review-failure`, but
 * they are not conflated: the reason names which happened, because the difference
 * decides whether a person is asked about a broken reviewer or a confused one.
 */
export async function review(request: ReviewRequest): Promise<ReviewResult> {
  const { snapshot, callId, signal } = request;
  const transport = await runTransport(request, snapshot, callId, signal);
  // One masking boundary, applied to every attempt before it is exposed. A
  // consumer storing or reporting these records must not have to know which field
  // can carry a credential, and two consumers implementing that rule separately is
  // how a boundary leaks.
  const attempts = transport.attempts.map((attempt) =>
    maskAttempt(attempt, transport.secrets),
  );
  return {
    protocol: transport.protocol,
    attempts,
    usage: usageOf(attempts),
    outcome:
      transport.answer === null
        ? failureOutcome(
            // The reason quotes provider text, so it crosses the same boundary as
            // the attempt's own error. Masking it here means a caller never has to
            // remember that the two fields carry the same risk.
            redact(
              redactAuthHeaders(
                transport.error ?? 'the reviewer produced no answer',
              ),
              transport.secrets,
            ),
            transport.rejection?.partial ?? NO_PARTIAL,
          )
        : outcomeOf(snapshot, transport.answer.scores),
  };
}

/** No field of a failed answer could be read. */
const NO_PARTIAL = { risk: null, authorization: null };

/** What one transport run produced, before masking and outcome mapping. */
interface TransportRun {
  readonly protocol: 'chat' | 'decision';
  readonly attempts: readonly ReviewAttempt[];
  readonly answer: {
    readonly ok: true;
    readonly scores: ProtocolScores;
  } | null;
  /**
   * The last unreadable answer's readable half, when it had one.
   *
   * It travels to the failure outcome's `diagnostic`, which is how a person tells
   * a reviewer that misgraded one field from a transport that broke.
   */
  readonly rejection: {
    readonly ok: false;
    readonly partial: {
      readonly risk: ScoreTrail | null;
      readonly authorization: ScoreTrail | null;
    };
  } | null;
  readonly error: string | null;
  /** The credential values this adapter knows it sent, for masking. */
  readonly secrets: readonly string[];
}

/** Run whichever transport this request names. */
async function runTransport(
  request: ReviewRequest,
  snapshot: ReviewSnapshot,
  callId: string,
  signal: AbortSignal,
): Promise<TransportRun> {
  if (request.backend.kind === 'chat') {
    const result = await runChatTransport(
      { ...request.backend.transport, signal },
      renderChatRequest(snapshot),
      callId,
    );
    return {
      protocol: 'chat',
      attempts: result.attempts,
      answer: result.answer,
      rejection: result.rejection,
      error: result.error,
      // The host's LLM service owns the chat credential, so there is no value this
      // adapter could match; the structural pass in `maskAttempt` covers it.
      secrets: result.secrets,
    };
  }
  const result = await runDecisionTransport(
    { ...request.backend.transport, signal },
    renderDecisionRequest(renderChatUser(snapshot)),
    callId,
  );
  return {
    protocol: 'decision',
    attempts: result.attempts,
    answer: result.answer,
    rejection: result.rejection,
    error: result.error,
    // The transport reports whichever credential it actually sent, because only
    // it knows when it resolved the reference itself. A second lookup here could
    // return a rotated value that is not the one that authenticated the request.
    secrets: result.secrets,
  };
}

/**
 * The failure outcome, keeping whatever half of the answer did read.
 *
 * The partial trails are diagnostic only: no score, verdict or threshold is
 * derived from them, and the outcome stays a failure.
 */
function failureOutcome(
  error: string,
  partial: {
    readonly risk: ScoreTrail | null;
    readonly authorization: ScoreTrail | null;
  },
): ReviewOutcome {
  const diagnostic =
    partial.risk === null && partial.authorization === null ? null : partial;
  return {
    status: 'review-failure',
    failures: [],
    reason: error,
    diagnostic,
  };
}

/** The usage summary for one review's attempts. */
function usageOf(attempts: readonly ReviewAttempt[]): UsageAggregate {
  return aggregateUsage(
    attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      usage: attempt.normalizedUsage,
    })),
  );
}
