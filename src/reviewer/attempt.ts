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

/** The two backends one review can run on. */
export type ReviewerBackend = 'chat' | 'decision';

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
