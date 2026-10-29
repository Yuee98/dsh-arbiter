/**
 * Running one cell: one review, through the production service.
 *
 * This module exists to be the *only* place a cell turns into an attempt. It takes
 * the material the scheduler already built, asks the production `review()` for an
 * outcome through a production backend, and maps the result into a record. It
 * decides nothing about scores, verdicts or usage: the outcome is the shared
 * contract's, the attempts are the production adapter's, and the usage summary is
 * `aggregateUsage` over exactly those attempts.
 *
 * Three rules keep a record honest:
 *
 *   - every attempt is kept, including a failed one and the transport's own repair.
 *     An attempt that was billed but discarded would make the usage summary a partial
 *     account presented as a whole.
 *   - the outcome is stored as returned. A `review-failure` stays a failure and a
 *     partial trail stays diagnostic; nothing here turns a failed read into a score.
 *   - the status is decided by what actually ended the cell, not only by the outcome.
 *     A cell the run cancelled is `cancelled` even though the reviewer also reported a
 *     failure, because "the run was stopped" and "the reviewer broke" are different
 *     facts a report must not conflate.
 *
 * Cost is recorded as `not-computed`. This runner does not know a provider's rate
 * card, and writing `0` would read as a free call.
 */

import { review } from '../../../src/reviewer/service.js';
import type { ReviewAttempt } from '../../../src/reviewer/attempt.js';
import { aggregateUsage } from '../../../src/reviewer/usage.js';

import { inputHashOf } from '../data/eligibility.js';
import type { ReviewCase } from '../data/types.js';

import { backendFor } from './backends.js';
import type { BackendContext } from './backends.js';
import type { CaseMaterial } from './material.js';
import { CELL_RECORD_VERSION } from './types.js';
import type {
  CellAbandonment,
  CellCost,
  CellRecord,
  CellStatus,
  CellTargetRecord,
  FixtureCell,
  RunAttempt,
  RunProtocol,
  RunTarget,
  RunTransportName,
  RunVersions,
} from './types.js';

/**
 * How this chain produced the review, stated once so no consumer guesses.
 *
 * `direct-service` is the production reviewer called with material assembled from a
 * case input. It is *not* the host chain: the session-log collector, the host
 * configuration and the approval channel are not exercised, so a result measured here
 * is a reviewer result rather than a host-behaviour result.
 */
const ENTRY_POINT = {
  kind: 'direct-service',
  materialChain: 'case-input',
  detail:
    'the production reviewer service called with material assembled from the case input; the host session-log collector, host configuration and approval channel are not exercised',
} as const;

/** What one cell needs in order to run. */
export interface CellDeps {
  readonly runId: string;
  readonly caseEntry: ReviewCase;
  readonly target: RunTarget;
  readonly protocol: RunProtocol;
  readonly repeat: number;
  readonly transport: RunTransportName;
  readonly fixture: FixtureCell | null;
  readonly versions: RunVersions;
  readonly llm: BackendContext['llm'];
  readonly readCredential: BackendContext['readCredential'];
  /** The caller's lifetime and the cell's own bound, already composed. */
  readonly signal: AbortSignal;
  /** Whether this cell's own `timeoutMs` bound fired, rather than the caller's cancel. */
  readonly timedOut: () => boolean;
  /** Wall clock, injected so a test never depends on the real one. */
  readonly now: () => number;
}

/**
 * Why an attempt is a first attempt or a repair.
 *
 * The production transport numbers attempts from one, so the first is the plan's own
 * request and anything after it is the transport re-asking after an unreadable
 * answer. Nothing else can produce a second attempt within one call, which is what
 * makes this classification total rather than a guess.
 */
function attemptKind(attempt: number): RunAttempt['kind'] {
  return attempt === 1 ? 'initial' : 'repair';
}

/** One production attempt, tagged with how it came to exist. */
function tagged(attempt: ReviewAttempt): RunAttempt {
  return { ...attempt, kind: attemptKind(attempt.attempt) };
}

/** A non-array object, for narrowing a parsed body without asserting its type. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The model a response body named, when it named one.
 *
 * Read from the last attempt that carried a body, because that is the answer the
 * review actually settled on. `null` means no body named a model, which is unknown
 * rather than equal to the configured one.
 */
function responseModelOf(attempts: readonly ReviewAttempt[]): string | null {
  for (const attempt of [...attempts].reverse()) {
    if (attempt.responseText === null) continue;
    let parsed: unknown;
    try {
      // `JSON.parse` is typed as returning `any`; going through `unknown` keeps the
      // value unchecked until the guard below narrows it.
      parsed = JSON.parse(attempt.responseText) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const named = parsed['model'];
    if (typeof named === 'string' && named.length > 0) return named;
  }
  return null;
}

/**
 * The wire protocol the attempt recorded, or null when no attempt ran.
 *
 * Null is not filled with the plan's expectation: a report must be able to tell "this
 * ran under that protocol" from "this was meant to".
 */
function protocolNameOf(attempts: readonly ReviewAttempt[]): string | null {
  return attempts[0]?.protocol ?? null;
}

/** The cost stub a record carries. No number is invented for it. */
function costOf(status: CellStatus): CellCost {
  return status === 'unsupported' || status === 'budget-exhausted'
    ? {
        status: 'not-applicable',
        amount: null,
        currency: null,
        reason: 'no model call was made for this cell',
      }
    : {
        status: 'not-computed',
        amount: null,
        currency: null,
        reason:
          'this runner does not price tokens; a report that needs money derives it from the recorded usage and the provider rate card',
      };
}

function caseOf(caseEntry: ReviewCase): CellRecord['case'] {
  return {
    caseId: caseEntry.caseId,
    familyId: caseEntry.familyId,
    split: caseEntry.split,
    provenanceSource: caseEntry.provenance.source,
    // The same digest a label is approved against, so a record and a label can be
    // compared without re-reading the case.
    inputHash: inputHashOf(caseEntry.input),
  };
}

function executionOf(
  repeat: number,
  transport: RunTransportName,
): CellRecord['execution'] {
  return { origin: repeat === 1 ? 'original' : 'repeat', repeat, transport };
}

/**
 * The target a cell actually used, in its own protocol's terms.
 *
 * The plan's `target` is one model offered through one or more protocols, and each
 * protocol carries its own configuration: a chat section names a provider and a model, a
 * decision section names an endpoint and a tier. Reading `target.model` and the decision
 * tier for a chat cell (or the reverse) would attribute a request to semantics the call
 * never used, so the record takes the section matching the protocol that ran.
 */
function targetRecordOf(
  target: RunTarget,
  protocol: RunProtocol,
  attempts: readonly ReviewAttempt[],
  costTier: CellTargetRecord['costTier'],
): CellTargetRecord {
  const configured =
    protocol === 'chat'
      ? { provider: target.chat?.provider, model: target.chat?.model }
      : { provider: target.provider, model: target.decision?.model };
  return {
    targetId: target.targetId,
    provider: configured.provider ?? target.provider,
    configuredModel: configured.model ?? target.model,
    modelVersion: target.modelVersion,
    protocol,
    protocolName: protocolNameOf(attempts),
    responseModel: responseModelOf(attempts),
    costTier,
  };
}

/** The cost tier the protocol that ran actually has. */
function tierOf(
  target: RunTarget,
  protocol: RunProtocol,
): CellTargetRecord['costTier'] {
  // Only a decision endpoint has a tier at all; a chat call is billed by the host's own
  // route, so its tier is unknown rather than borrowed from a decision section that this
  // cell never touched.
  return protocol === 'decision'
    ? (target.decision?.costTier ?? 'unknown')
    : 'unknown';
}

/**
 * The status a dispatched cell settles at.
 *
 * The two ends are checked before the outcome, because a cell that was cut short still
 * has an outcome: the production reviewer reports an aborted request as a failure, and
 * copying that alone would tell a reader the reviewer broke when the run was stopped.
 */
function statusOf(parts: {
  readonly cancelled: boolean;
  readonly timedOut: boolean;
}): CellStatus {
  if (parts.cancelled) return 'cancelled';
  if (parts.timedOut) return 'timeout';
  return 'reviewed';
}

/** The stop reason a cell carries, or null when it simply ran. */
function stopReasonOf(parts: {
  readonly status: CellStatus;
  readonly outcomeReason: string | null;
}): string | null {
  if (parts.status === 'cancelled') {
    return 'the run was cancelled while this cell was in flight';
  }
  if (parts.status === 'timeout') {
    return 'the cell exceeded its own timeout';
  }
  return parts.outcomeReason;
}

/**
 * Run one cell through the production reviewer.
 *
 * The material arrives already built: the scheduler built it to compare the input
 * bound against a real number, so rebuilding it here would be the same work twice with
 * a chance of disagreeing. The signal is supplied by the scheduler too, composed from
 * the run's lifetime and this cell's own timeout.
 */
export async function runCell(parts: {
  readonly cellId: string;
  readonly material: CaseMaterial;
  readonly deps: CellDeps;
}): Promise<{ readonly record: CellRecord }> {
  const { deps } = parts;
  const startedAt = deps.now();
  const cancelled = (): boolean => deps.signal.aborted && !deps.timedOut();
  const build = backendFor(deps.target, deps.protocol, {
    transport: deps.transport,
    fixture: deps.fixture,
    signal: deps.signal,
    llm: deps.llm,
    readCredential: deps.readCredential,
  });
  if (!build.ok) {
    return {
      record: recordOf({
        cellId: parts.cellId,
        deps,
        material: parts.material,
        startedAt,
        status: cancelled() ? 'cancelled' : 'failed',
        stopReason: build.message,
        outcome: null,
        attempts: [],
      }),
    };
  }
  let result: Awaited<ReturnType<typeof review>>;
  try {
    result = await review({
      snapshot: parts.material.snapshot,
      callId: parts.cellId,
      signal: deps.signal,
      backend: build.backend,
    });
  } catch (error) {
    // `review` reports transport failures as outcomes rather than throwing, so a
    // throw here is a defect in this chain, not a provider fault. It is recorded once
    // and is not retried.
    return {
      record: recordOf({
        cellId: parts.cellId,
        deps,
        material: parts.material,
        startedAt,
        status: cancelled() ? 'cancelled' : 'failed',
        stopReason: error instanceof Error ? error.message : String(error),
        outcome: null,
        attempts: [],
      }),
    };
  }
  const status = statusOf({
    cancelled: cancelled(),
    timedOut: deps.timedOut(),
  });
  const attempts = result.attempts.map(tagged);
  return {
    record: recordOf({
      cellId: parts.cellId,
      deps,
      material: parts.material,
      startedAt,
      status,
      stopReason: stopReasonOf({
        status,
        outcomeReason:
          result.outcome.status === 'review-failure'
            ? result.outcome.reason
            : null,
      }),
      // Stored as the service returned it. A cancelled cell keeps the reviewer's own
      // failure description beside the cancellation, so both facts survive; the
      // status, not the outcome, is what says the run stopped it.
      outcome: result.outcome,
      attempts,
    }),
  };
}

/** Assemble one record from what the attempt produced. */
function recordOf(parts: {
  readonly cellId: string;
  readonly deps: CellDeps;
  readonly material: CaseMaterial;
  readonly startedAt: number;
  readonly status: CellStatus;
  readonly stopReason: string | null;
  readonly outcome: CellRecord['outcome'];
  readonly attempts: readonly RunAttempt[];
  /** Set only by an abandonment, which is the one case with a reservation to record. */
  readonly abandonment?: CellAbandonment;
}): CellRecord {
  const { deps } = parts;
  return {
    documentVersion: CELL_RECORD_VERSION,
    runId: deps.runId,
    cellId: parts.cellId,
    createdAt: new Date(deps.now()).toISOString(),
    case: caseOf(deps.caseEntry),
    execution: executionOf(deps.repeat, deps.transport),
    entryPoint: ENTRY_POINT,
    abandonment: parts.abandonment ?? null,
    target: targetRecordOf(
      deps.target,
      deps.protocol,
      parts.attempts,
      tierOf(deps.target, deps.protocol),
    ),
    material: parts.material.material,
    status: parts.status,
    stopReason: parts.stopReason,
    outcome: parts.outcome,
    attempts: parts.attempts,
    usage:
      parts.attempts.length === 0
        ? null
        : aggregateUsage(
            parts.attempts.map((attempt) => ({
              attemptId: attempt.attemptId,
              usage: attempt.normalizedUsage,
            })),
          ),
    cost: costOf(parts.status),
    timing: {
      startedAt: parts.startedAt,
      durationMs: Math.max(0, deps.now() - parts.startedAt),
    },
    versions: deps.versions,
    notes: [],
  };
}

/**
 * The record for a cell the run's own outer bound ended.
 *
 * A transport that ignores its abort signal would otherwise keep the run waiting: the
 * production transports pass the caller's signal down, but whether it is honoured is the
 * socket's behaviour, not something this runner can assume. So the run's ceiling is
 * enforced from outside the call, and this record states exactly what happened.
 *
 * The attempts are empty and that is a fact, not an omission: the transport never
 * reported one, because it never returned. `notes` says so, so a reader does not mistake
 * a lost report for a request that was never sent.
 */
export function timedOutRecord(parts: {
  readonly cellId: string;
  readonly deps: CellDeps;
  readonly material: CaseMaterial;
  readonly startedAt: number;
  readonly reason: string;
  readonly status: 'timeout' | 'cancelled';
  /** The attempts the run reserved, which the abandoned call may have spent. */
  readonly reservedAttempts: number;
}): CellRecord {
  return {
    ...recordOf({
      cellId: parts.cellId,
      deps: parts.deps,
      material: parts.material,
      startedAt: parts.startedAt,
      status: parts.status,
      stopReason: parts.reason,
      outcome: null,
      attempts: [],
      abandonment: {
        reservedAttempts: Math.max(1, parts.reservedAttempts),
        reason: parts.reason,
      },
    }),
    notes: [
      "the transport did not return before the run's own bound, so no attempt was reported; the request may have been sent and may have been billed",
    ],
  };
}

/**
 * The record for a cell the plan itself says cannot be sent.
 *
 * Kept beside the runner so an unsupported cell has the same shape as any other: a
 * report walking records sees a decided cell with a stated reason rather than a gap it
 * has to special-case.
 */
export function unsupportedRecord(parts: {
  readonly runId: string;
  readonly cellId: string;
  readonly caseEntry: ReviewCase;
  readonly target: RunTarget;
  readonly protocol: RunProtocol;
  readonly repeat: number;
  readonly transport: RunTransportName;
  readonly reason: string;
  readonly versions: RunVersions;
  readonly createdAt: string;
}): CellRecord {
  return {
    documentVersion: CELL_RECORD_VERSION,
    runId: parts.runId,
    cellId: parts.cellId,
    createdAt: parts.createdAt,
    case: caseOf(parts.caseEntry),
    execution: executionOf(parts.repeat, parts.transport),
    entryPoint: ENTRY_POINT,
    abandonment: null,
    target: targetRecordOf(parts.target, parts.protocol, [], 'unknown'),
    material: null,
    status: 'unsupported',
    stopReason: parts.reason,
    outcome: null,
    attempts: [],
    usage: null,
    cost: costOf('unsupported'),
    timing: { startedAt: 0, durationMs: 0 },
    versions: parts.versions,
    notes: [],
  };
}
