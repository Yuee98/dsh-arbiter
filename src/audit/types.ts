import type {
  CallResult,
  ModelAttemptRecord,
  ReviewSignals,
  ReviewSnapshot,
  TraceStage,
} from '../types.js';
export interface CallRecord {
  readonly callId: string;
  readonly ts: number;
  readonly sessionId: string;
  readonly sessionKind: 'main' | 'subagent';
  readonly parentSession: string | null;
  readonly profile: string | null;
  readonly workspace: string | null;
  readonly tool: string;
  readonly arguments: unknown;
  /**
   * The tool's declared input schema at call time, or null when the host
   * exposed none. It is evidence a later reader needs to interpret the
   * arguments; it is not re-read from the live tool registry.
   */
  readonly argumentsSchema?: unknown;
  readonly cwd: string;
  readonly fingerprint: string;
  readonly configRevision: string;
  readonly configSnapshotId: string;
  readonly approvalMode: string;
  readonly executionMode: string;
  readonly result: CallResult;
  readonly reason: string;
  readonly trace: readonly TraceStage[];
  readonly effect: unknown;
  readonly sessionRecordState: string;
  readonly snapshot: ReviewSnapshot | null;
  readonly modelAttempts: readonly ModelAttemptRecord[];
  readonly signals: ReviewSignals | null;
  readonly policyStrategy: string | null;
  readonly decisionRules: readonly string[];
  readonly executionStatus: string;
  /** When execution began, or null when it never began. */
  readonly executionStartedAt?: number | null;
  /** When execution finished, or null when it has no observed end. */
  readonly executionFinishedAt?: number | null;
}

/**
 * One stored call as the read adapter returns it.
 *
 * `recordFormatVersion` says how the row was written. A row whose format this
 * build cannot interpret is reported with `unreadable: true` and its original
 * fields untouched rather than being coerced into the current shape.
 */
export interface StoredCall {
  readonly recordFormatVersion: number;
  readonly unreadable: boolean;
  readonly unreadableReason: string | null;
  readonly [key: string]: unknown;
}

export interface AuditHealth {
  readonly state: 'ok' | 'degraded' | 'unavailable' | 'disabled';
  readonly lastError: string | null;
  readonly dropped: number;
  readonly pending: number;
}

/**
 * The verdicts that denied a call, for the list's "denied" shortcut.
 *
 * `fallback-deny` and `human-abort` are included because both end in the call
 * not running; a list that only showed `deny` would hide those two outcomes.
 */
export const DENIED_RESULTS: readonly string[] = [
  'deny',
  'review-deny',
  'human-deny',
  'fallback-deny',
  'human-abort',
];

/** The newest record a traversal is anchored at. */
export interface CallAnchor {
  readonly ts: number;
  readonly callId: string;
}

/**
 * One page of list rows.
 *
 * `anchor` says which records this traversal is allowed to see: rows newer than
 * the anchor are outside it, so inserting a call cannot shift a page window and
 * make the reader see one row twice. `newer` counts the matching rows outside
 * the anchor, which is what "N new records" means — a count that cleanup cannot
 * fake the way a `total` delta could.
 */
export interface CallPage {
  readonly rows: readonly CallSummary[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly anchor: CallAnchor | null;
  readonly newer: number;
}

export interface CallFilter {
  readonly limit?: number;
  readonly offset?: number;
  readonly result?: string;
  readonly tool?: string;
  readonly sessionId?: string;
  /**
   * The rule that decided the call.
   *
   * A rule short-circuit records the hit rule only in the `rule` trace stage,
   * while a reviewed call records the reviewer's decision rules in
   * `decision_rules`; both are the same question to the operator ("which rule
   * decided this"), so the filter matches either source.
   */
  readonly ruleId?: string;
  /** Only verdicts that stopped the call. */
  readonly deniedOnly?: boolean;
  /** Only calls whose review stage failed (`error-escalate`). */
  readonly reviewFailureOnly?: boolean;
  /** `main` or `subagent`; separates subtask calls from the main session. */
  readonly sessionKind?: string;
  /**
   * The traversal's upper bound.
   *
   * A request without one starts a traversal at the newest matching record and
   * receives the anchor it was given. Every later page repeats it, so a call
   * that arrives in between stays outside the window instead of shifting it.
   */
  readonly anchor?: CallAnchor;
  readonly query?: string;
  readonly from?: number;
  readonly to?: number;
}

/**
 * One list row: the identity, the verdict, and a one-line summary.
 *
 * The list answers "where is the call I am looking for"; everything needed to
 * explain the decision (reason, stage chain, arguments, model traffic) belongs
 * to the detail read. Narrowing the row keeps a page from carrying each call's
 * full prompt and response.
 */
export interface CallSummary {
  readonly callId: string;
  readonly ts: number;
  readonly sessionId: string;
  readonly sessionKind: string;
  readonly tool: string;
  /**
   * A single-line operation summary derived from the stored arguments.
   *
   * The name is historical; it is the command, the code, or a bounded JSON
   * excerpt, never the whole argument object.
   */
  readonly command: string;
  readonly result: string;
  readonly ruleId: string | null;
  /** The rule's name at decision time, or null when the row predates it. */
  readonly ruleName: string | null;
  readonly recordFormatVersion: number;
  readonly unreadable: boolean;
  readonly unreadableReason: string | null;
}

export interface CandidateRecord {
  readonly candidateId: string;
  readonly createdAt: number;
  readonly status: 'pending' | 'accepted' | 'rejected';
  readonly rule: unknown;
  readonly stats: unknown;
  readonly evidence: unknown;
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly note: string | null;
}
