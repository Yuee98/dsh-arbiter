/**
 * One model attempt, as the reviewer service reports it.
 *
 * The shape keeps the audit's fields (an attempt id, the request, the raw answer,
 * the error) and adds the two things the evals tooling needs to account for cost:
 * the provider's usage payload already masked by this adapter, and its
 * normalization under the shared mapping. Both are present because a reader must
 * be able to re-normalize a stored payload after the mapping version changes.
 */

import type { UsageNormalized } from './usage.js';
import { normalizeUsage } from './usage.js';
import { redact, redactAuthHeaders, redactValue } from './redact.js';

/** The two backends one review can run on. */
export type ReviewerBackend = 'chat' | 'decision';

/**
 * Why an attempt produced no answer.
 *
 * The three are different facts and a reader must not infer them from the error
 * text: a provider that declared its own failure is not the same as an answer that
 * arrived and could not be read, and neither is a connection that never carried
 * one. The connection test classifies the stage from this field, so guessing from
 * wording would report a provider outage as a malformed answer.
 */
export type AttemptFailureKind =
  /** The provider reported the failure itself: a non-2xx, `success:false`, or a provider finish reason. */
  | 'provider-refusal'
  /** An answer arrived and the contract could not read it. */
  | 'unreadable-answer'
  /** No answer arrived at all: transport, timeout, dropped stream. */
  | 'transport';

/** What one attempt produced, successful or not. */
export interface ReviewAttempt {
  /**
   * The identity of this actual model attempt.
   *
   * Unique per call and attempt number, which is what lets a usage summary dedupe
   * a record read twice without collapsing two genuinely separate attempts.
   */
  readonly attemptId: string;
  readonly callId: string;
  readonly attempt: number;
  readonly backend: ReviewerBackend;
  /** The wire protocol this attempt was rendered and parsed under. */
  readonly protocol: string;
  readonly request: unknown;
  /** The complete body, already free of every credential this adapter knows. */
  readonly responseText: string | null;
  /** The parsed answer, or null when nothing usable was parsed. */
  readonly parsed: unknown;
  readonly error: string | null;
  /** Why this attempt failed, or null when it succeeded. */
  readonly failureKind: AttemptFailureKind | null;
  readonly startedAt: number;
  readonly durationMs: number;
  /** This adapter's own estimate of the input it sent. */
  readonly estimatedInputTokens: number;
  /**
   * The provider's usage payload after credential masking, exactly as received.
   *
   * Null means the provider reported nothing at all — which is not the same as a
   * payload full of zeros, and the difference survives into the normalization.
   */
  readonly rawUsage: unknown;
  /** The same payload under the shared mapping, or null when nothing arrived. */
  readonly normalizedUsage: UsageNormalized | null;
}

/** Attempt id for one call's attempt number. */
export function attemptIdOf(callId: string, attempt: number): string {
  return `${callId}:model:${String(attempt)}`;
}

/**
 * Mask one attempt record before it leaves this module.
 *
 * The masking boundary has to be here rather than in a consumer: RQ-04's audit
 * writer and RQ-10's run artifacts both receive these records, and a rule that
 * lived in each of them would be two rules that can disagree. `secrets` is what
 * this adapter knows it sent — the decision credential — and the structural pass
 * beside it covers a header echo when there is no value to match, which is the
 * chat case where the host owns the credential.
 *
 * Numbers survive: the score distributions, token counts and timestamps are
 * values this contract must keep exactly. Only text is masked.
 */
export function maskAttempt(
  attempt: ReviewAttempt,
  secrets: readonly string[],
): ReviewAttempt {
  const maskedRaw = redactValue(attempt.rawUsage, secrets);
  return {
    ...attempt,
    failureKind: attempt.failureKind,
    request: redactValue(attempt.request, secrets),
    parsed: redactValue(attempt.parsed, secrets),
    responseText:
      attempt.responseText === null
        ? null
        : redact(redactAuthHeaders(attempt.responseText), secrets),
    error:
      attempt.error === null
        ? null
        : redact(redactAuthHeaders(attempt.error), secrets),
    rawUsage: maskedRaw,
    // Re-normalized from the masked payload rather than masked field by field:
    // the mapping is the production one, so a masked record cannot disagree with
    // an unmasked one about what a count means. Numbers are unaffected by masking.
    normalizedUsage:
      attempt.normalizedUsage === null
        ? null
        : normalizeUsage(attempt.normalizedUsage.source, maskedRaw),
  };
}

/**
 * The stored-record shape one attempt contributes to a call record.
 *
 * The service reports `attemptId`/`rawUsage`; the audit writes `requestId`/`usage`.
 * Converting in one place means a consumer storing an attempt cannot disagree with
 * the writer about which field holds what, and the normalized value always travels
 * beside the raw one it was derived from.
 */
export function storedAttemptOf(attempt: ReviewAttempt): {
  readonly requestId: string;
  readonly callId: string;
  readonly attempt: number;
  readonly backend: ReviewerBackend;
  readonly protocol: string;
  readonly request: unknown;
  readonly responseText: string | null;
  readonly parsed: unknown;
  readonly error: string | null;
  readonly failureKind: AttemptFailureKind | null;
  readonly usage: unknown;
  readonly normalizedUsage: UsageNormalized | null;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly estimatedInputTokens: number;
} {
  return {
    requestId: attempt.attemptId,
    callId: attempt.callId,
    attempt: attempt.attempt,
    backend: attempt.backend,
    protocol: attempt.protocol,
    request: attempt.request,
    responseText: attempt.responseText,
    parsed: attempt.parsed,
    error: attempt.error,
    failureKind: attempt.failureKind,
    usage: attempt.rawUsage,
    normalizedUsage: attempt.normalizedUsage,
    startedAt: attempt.startedAt,
    durationMs: attempt.durationMs,
    estimatedInputTokens: attempt.estimatedInputTokens,
  };
}
