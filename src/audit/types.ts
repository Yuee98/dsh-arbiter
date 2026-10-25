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

export interface CallFilter {
  readonly limit?: number;
  readonly offset?: number;
  readonly result?: string;
  readonly tool?: string;
  readonly sessionId?: string;
  readonly query?: string;
  readonly from?: number;
  readonly to?: number;
}

export interface CallSummary {
  readonly callId: string;
  readonly ts: number;
  readonly sessionId: string;
  readonly sessionKind: string;
  readonly tool: string;
  readonly command: string;
  readonly result: string;
  readonly reason: string;
  readonly ruleId: string | null;
  /** The rule's name at decision time, or null when the row predates it. */
  readonly ruleName: string | null;
  readonly approvalMode: string;
  readonly decisionRules: readonly string[];
  readonly executionStatus: string;
  readonly executionStartedAt: number | null;
  readonly executionFinishedAt: number | null;
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
