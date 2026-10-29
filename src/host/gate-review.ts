/**
 * Running one review through the shared service.
 *
 * This module owns everything between "the gate decided to review" and "an
 * outcome exists to settle": the circuit breaker, material preparation, the input
 * budget, the material-completeness gate, and the one call into `review()`.
 *
 * It is separate from the gate for a reason that is not line count. The gate owns
 * *decisions* — admission, rules, settlement, approval channels — and this module
 * owns *the review run*. Keeping them apart is what makes "production calls the
 * same `review()` the evals tooling calls" checkable: this file is the only place
 * that calls it, and it knows nothing about config modes or human approval.
 */

import {
  aggregateUsage,
  review,
  storedAttemptOf,
  type LlmLike,
} from '../reviewer.js';
import type { UsageAggregate } from '../reviewer/usage.js';
import type { ReviewOutcome } from '../review-contract/types.js';
import type { BuiltSnapshot } from '../snapshot.js';
import type { ModelAttemptRecord } from '../types.js';
import type { AuditExtras, CallContext, HostEnvironment } from './types.js';

/** What one completed review produced, before it is settled. */
export interface Reviewed {
  readonly outcome: ReviewOutcome;
  /** The service's own attempt records, which the audit writer stores. */
  readonly attempts: readonly ModelAttemptRecord[];
  readonly usage: UsageAggregate;
  readonly snapshot: BuiltSnapshot['snapshot'] | null;
}

/** The stage a review reached, as the trace and the record both name it. */
export type ReviewRunStage = 'review-escalate' | 'error-escalate';

/** One review that ended before a model was asked. */
export interface EarlyOutcome {
  readonly stage: ReviewRunStage;
  /** The machine-readable reason the audit and the detail reader already use. */
  readonly code: string;
  readonly outcome: ReviewOutcome;
  readonly snapshot: BuiltSnapshot['snapshot'] | null;
}

/** A usage summary for a review that made no attempt. */
function emptyUsage(): UsageAggregate {
  return aggregateUsage([]);
}

/** The outcome for a run that failed before any model request. */
function failedOutcome(reason: string): ReviewOutcome {
  return { status: 'review-failure', failures: [], reason, diagnostic: null };
}

/**
 * The pre-request exit for this call, when there is one.
 *
 * Four things stop a review before the model is asked, and they are genuinely
 * different: an open breaker is a runtime protection, an unbuildable snapshot is a
 * host fault, an over-budget request is a preparation failure, and insufficient
 * material means no score could stand. Each carries its own stage code so the
 * chain says which happened instead of collapsing them into "review failed".
 *
 * `null` means the review may proceed.
 *
 * Taking the breaker/capability/material decisions in one function keeps the
 * caller linear: it either has a usable review to run or it has a final outcome,
 * and it never re-checks a condition this function already answered.
 */
export function preRequestExit(
  host: HostEnvironment,
  options: {
    readonly breakerOpen: boolean;
    readonly bundle: BuiltSnapshot | null;
    readonly prepareError: string | null;
  },
): EarlyOutcome | null {
  if (options.breakerOpen) {
    return {
      stage: 'error-escalate',
      code: 'circuit_open',
      outcome: failedOutcome(
        'the review circuit breaker is open for this session',
      ),
      snapshot: null,
    };
  }
  if (options.bundle === null) {
    const message = options.prepareError ?? 'the review could not be prepared';
    return {
      stage: 'error-escalate',
      code: `snapshot_error: ${message}`,
      outcome: failedOutcome(`the review could not be prepared: ${message}`),
      snapshot: null,
    };
  }
  const snapshot = options.bundle.snapshot;
  if (snapshot.budget.truncatedSegments.includes('OVER_BUDGET')) {
    // A legal truncation is a normal review; a request that cannot be assembled
    // within the declared budget is a request-preparation failure, not a
    // decision. Recording it as error-escalate keeps the chain honest.
    return {
      stage: 'error-escalate',
      code: 'input_budget_exceeded',
      outcome: failedOutcome(
        'the review request cannot be assembled within the configured input budget',
      ),
      snapshot,
    };
  }
  // Material the host could not supply makes any score unusable, so it is settled
  // before the model is asked: spending the call would only produce a number that
  // has to be discarded.
  if (snapshot.completeness.status === 'insufficient') {
    return {
      stage: 'review-escalate',
      code: `insufficient_material: ${snapshot.completeness.gaps
        .map((gap) => gap.source)
        .join(', ')}`,
      outcome: {
        status: 'insufficient-material',
        gaps: snapshot.completeness.gaps,
        reason:
          snapshot.completeness.note ??
          'required review material could not be assembled from this session',
        diagnostic: null,
      },
      snapshot,
    };
  }
  // The host is consulted for its own services only when the call proceeds; a
  // missing LLM service here is a host fault, reported like a snapshot failure.
  if (host.services.llm === undefined) {
    const message = 'llm service is unavailable';
    return {
      stage: 'error-escalate',
      code: `snapshot_error: ${message}`,
      outcome: failedOutcome(`the review could not be prepared: ${message}`),
      snapshot,
    };
  }
  return null;
}

/** A finished review in the shape the settlement consumes. */
export function reviewedOf(
  result: Awaited<ReturnType<typeof review>>,
  snapshot: BuiltSnapshot['snapshot'],
): Reviewed {
  return {
    outcome: result.outcome,
    attempts: result.attempts.map((attempt) => storedAttemptOf(attempt)),
    usage: result.usage,
    snapshot,
  };
}

/**
 * Run one review through the shared service.
 *
 * Both backends go through the same entry point the evals tooling calls, so a
 * production review and an eval review of the same material are the same call and
 * cannot disagree about a score.
 *
 * The service itself can only throw on a caller-side fault (an aborted signal is
 * not one); that is reported as a review failure rather than escaping, because an
 * escaping exception would leave the call unsettled.
 */
export async function runReview(
  host: HostEnvironment,
  call: CallContext,
  llm: LlmLike,
  bundle: BuiltSnapshot,
): Promise<Reviewed> {
  const { lifecycle } = host;
  const reviewer = host.runtime.config.reviewer;
  const sessionId = call.session.id ?? 'unknown';
  lifecycle('review/start', { callId: call.exec.callId, sessionId });
  try {
    const result = await review(
      reviewer.type === 'chat'
        ? {
            snapshot: bundle.snapshot,
            callId: call.exec.callId,
            signal: call.exec.signal,
            backend: {
              kind: 'chat',
              transport: {
                llm,
                session: call.session,
                chat: reviewer.chat,
                signal: call.exec.signal,
              },
            },
          }
        : {
            snapshot: bundle.snapshot,
            callId: call.exec.callId,
            signal: call.exec.signal,
            backend: {
              kind: 'decision',
              transport: {
                fetch: globalThis.fetch,
                credentials: host.services.credentials,
                decision: reviewer.decision,
                signal: call.exec.signal,
              },
            },
          },
    );
    lifecycle(
      result.outcome.status === 'review-failure'
        ? 'review/failed'
        : 'review/settled',
      { callId: call.exec.callId, sessionId },
    );
    return reviewedOf(result, bundle.snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lifecycle('review/failed', { callId: call.exec.callId, sessionId });
    return {
      outcome: failedOutcome(message),
      attempts: [],
      usage: emptyUsage(),
      snapshot: bundle.snapshot,
    };
  }
}

/** A review that produced no attempt, for a pre-request exit. */
export function earlyReview(
  outcome: ReviewOutcome,
  snapshot: BuiltSnapshot['snapshot'] | null,
): Reviewed {
  return { outcome, attempts: [], usage: emptyUsage(), snapshot };
}

/** The audit fields one review contributes to the record. */
export function reviewExtras(
  extras: AuditExtras,
  reviewed: Reviewed,
): AuditExtras {
  return {
    ...extras,
    snapshot: reviewed.snapshot,
    modelAttempts: reviewed.attempts,
    usage: reviewed.usage,
    reviewReason: reasonOf(reviewed.outcome),
  };
}

/** The reason a human handoff or a denial reports for one outcome. */
export function reasonOf(outcome: ReviewOutcome): string {
  switch (outcome.status) {
    case 'scored':
      return outcome.verdict === 'review-deny'
        ? `authorization band ${String(outcome.authorization)} is an applicable prohibition`
        : `risk ${String(outcome.risk)} requires authorization ${String(
            outcome.requiredAuthorization,
          )}; the review found ${String(outcome.authorization)}`;
    case 'insufficient-material':
    case 'review-failure':
      return outcome.reason;
  }
}
