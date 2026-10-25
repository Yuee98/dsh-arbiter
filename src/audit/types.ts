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
  readonly approvalMode: string;
  readonly decisionRules: readonly string[];
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
