import type {
  CallResult,
  ModelAttemptRecord,
  ReviewScores,
  ReviewSnapshot,
  ReviewStageRecord,
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
  /**
   * The scored pair this review reached, or null when it produced no score.
   *
   * `null` is a real state — a material gap or a reviewer failure reached its own
   * stage without a number — and it is stored as `NULL` rather than as a default
   * band, so a reader can tell "no score" from "a score of the lowest band".
   */
  readonly scores: ReviewScores | null;
  /** The stage the review reached, whether or not it settled as that stage. */
  readonly reviewStage: ReviewStageRecord | null;
  /** The review's usage summary over its actual attempts, or null when it ran none. */
  readonly usage: unknown;
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
 * `recordFormatVersion` says how the row was written, or is `null` when the row
 * declares none. A row whose format this build cannot interpret is reported with
 * `unreadable: true` and its original fields untouched rather than being coerced
 * into the current shape.
 */
export interface StoredCall {
  readonly recordFormatVersion: number | null;
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

/** One position in the newest-first order. */
export interface CallAnchor {
  readonly ts: number;
  readonly callId: string;
}

/**
 * One page of list rows, read with a keyset cursor.
 *
 * `after`/`before` bound the window by the reader's own position in the order,
 * not by a count of skipped rows. That is what makes the traversal stable: a
 * call inserted anywhere — above the window, below it, or inside a timestamp
 * that ties with the cursor — cannot shift which rows come next, because the
 * window is "everything after this exact row", not "skip N rows".
 *
 * `total` is the size of the whole filtered set, for the pager and the total
 * label. `newer` counts the matching rows above the traversal head, which is
 * what "N new records" means: a total delta cannot answer it, because cleanup
 * can delete as many rows as arrive.
 */
export interface CallPage {
  readonly rows: readonly CallSummary[];
  readonly total: number;
  readonly limit: number;
  /** The continuation cursor: pass it back as `after` for the next page. */
  readonly nextCursor: CallAnchor | null;
  /** The cursor that would return this page again: pass it as `before`. */
  readonly prevCursor: CallAnchor | null;
  /** The traversal head, echoed so the arrival count stays comparable. */
  readonly anchor: CallAnchor | null;
  readonly newer: number;
  /**
   * How many matching rows follow this page inside the traversal.
   *
   * Counted against the traversal head, not derived from `total`: a call arriving
   * inside the already-read region raises the total without adding a page after
   * the reader, and deriving pages from the total would advertise pages that do
   * not exist. Zero means the traversal ends here.
   */
  readonly remaining: number;
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
   * The continuation cursor: the last row of the previous page.
   *
   * The window is then every row strictly after that position in the
   * newest-first order, which stays correct no matter what is inserted.
   */
  readonly after?: CallAnchor;
  /** Read the page immediately before this position (used for "previous"). */
  readonly before?: CallAnchor;
  /**
   * Read the oldest page instead of a cursor-relative one.
   *
   * The end of a traversal is the only page a reader cannot reach by following a
   * cursor after the rows they were on were deleted; this names it directly
   * instead of asking for a row count that no longer exists.
   */
  readonly tail?: boolean;
  /**
   * The traversal head, used only to count records that arrived above it.
   *
   * A request without one starts a traversal at the newest matching record and
   * receives the head it was given, so the arrival count stays comparable
   * across pages.
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
  /** The rule's name at decision time, or null when the row recorded none. */
  readonly ruleName: string | null;
  readonly recordFormatVersion: number | null;
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
