/**
 * The one call-detail contract the host and the browser share.
 *
 * A detail is assembled from whatever sources actually hold this call, so every
 * field is either real stored evidence or an explicit absence. Nothing is
 * defaulted into a claim: a missing snapshot stays `null` with a `missing` code,
 * a historical rule name is only ever taken from the stored stage row, and the
 * final permission verdict is kept apart from the execution result.
 */

import type { RuleConjunctionEvidence } from '../types.js';

/**
 * Why part of a detail could not be shown.
 *
 * These are stable codes rather than sentences: the browser localizes them, and
 * an unrecognized code renders a generic sentence instead of a bare key.
 */
export type CallDetailMissingCode =
  | 'audit-disabled'
  | 'audit-unavailable'
  | 'audit-record-cleared'
  | 'audit-unreadable'
  | 'record-format-newer'
  | 'snapshot-missing'
  | 'snapshot-unreadable'
  | 'config-missing'
  | 'config-unreadable'
  | 'model-attempts-missing'
  | 'template-missing'
  | 'template-unreadable'
  | 'stages-missing'
  | 'stage-details-missing'
  | 'rule-name-missing'
  | 'arguments-missing'
  | 'execution-not-observed';

/** Where the shown final verdict came from. */
export type CallDetailSource = 'audit' | 'session';

export interface CallDetailExecution {
  /** The host's observed execution status; never the permission verdict. */
  readonly status: string | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

export interface CallDetailOverview {
  readonly tool: string;
  readonly ts: number;
  readonly sessionId: string | null;
  readonly sessionKind: string | null;
  readonly parentSession: string | null;
  readonly workspace: string | null;
  readonly cwd: string | null;
  readonly profile: string | null;
  readonly approvalMode: string | null;
  readonly executionMode: string | null;
  /** The final permission verdict, or null when no source could state one. */
  readonly verdict: string | null;
  /** The reason the runtime composed for that verdict. */
  readonly verdictReason: string | null;
  readonly configRevision: string | null;
  readonly fingerprint: string | null;
  readonly execution: CallDetailExecution;
  /** True when a human approval ended without an answer. */
  readonly cancelled: boolean;
}

/** One disagreement two sources recorded for the same call. */
export interface CallDetailConflict {
  /** The call-level field name, or `stages[i].<field>` for a stage field. */
  readonly field: string;
  /** Both observed values, in the order the sources reported them. */
  readonly observed: readonly string[];
}

export interface CallDetailStage {
  readonly seq: number;
  readonly stage: string;
  readonly result: string;
  /** The runtime-composed reason for this stage; model output is not merged in. */
  readonly reason: string | null;
  readonly ruleId: string | null;
  /** The rule's name at decision time; never a live lookup. */
  readonly ruleName: string | null;
  readonly decisionRules: readonly string[];
  readonly configRevision: string | null;
  readonly configSnapshotId: string | null;
  /**
   * The conjunction witness recorded when this stage ruled.
   *
   * `null` means the record carries none — an `any` rule, or a record written
   * before the connective existed. It never means "recompute from the current
   * rule": a deleted or edited rule must not change what history says happened.
   */
  readonly conjunction: RuleConjunctionEvidence | null;
  readonly ts: number | null;
}

/** What the stored record proves about whether a model review ran. */
export type CallDetailReviewState = 'none' | 'reviewed' | 'unknown';

export interface CallDetailBasis {
  /** The rule that decided this call, with the name recorded at the time. */
  readonly rule: {
    readonly ruleId: string;
    readonly ruleName: string | null;
  } | null;
  readonly decisionRules: readonly string[];
  /**
   * Disagreements between sources for this same call.
   *
   * #16 already preserves both readings instead of resolving them. The detail
   * carries them so the visible verdict is not presented as uncontested when
   * another stored observation contradicts it.
   */
  readonly conflicts: readonly CallDetailConflict[];
  /** True when more disagreement was observed than an entry can represent. */
  readonly conflictsTruncated: boolean;
  readonly policyStrategy: string | null;
  /** Structured stages when the source stored them; otherwise null. */
  readonly chain: readonly CallDetailStage[] | null;
  /**
   * Whether the record proves this call reached a model review.
   *
   * Three states, because they mean different things and the page must not
   * collapse them:
   *
   *   - `none`: the stored chain shows a rule short-circuit; no review happened,
   *     so absent review material is not a gap;
   *   - `reviewed`: the chain shows a review stage; absent material is a real
   *     gap and is reported as missing;
   *   - `unknown`: nothing proves either way (an old row with no stage rows), so
   *     the page says the fact cannot be established instead of guessing.
   */
  readonly reviewState: CallDetailReviewState;
  /** The stored result sequence every source carries. */
  readonly trace: readonly string[];
  /**
   * The scored pair this review reached, or null when it produced no score.
   *
   * `null` is a real state — a material gap or a reviewer failure reached its own
   * stage without a number — so it never means "a score of the lowest band".
   */
  readonly scores: unknown;
  /** The usage summary over this review's actual attempts, or null. */
  readonly usage: unknown;
  /** Authorisation evidence and material provenance the review actually saw. */
  readonly evidence: readonly unknown[];
  readonly materials: readonly unknown[];
  readonly evidenceTruncated: boolean;
  /** Input facts the snapshot reported as missing. */
  readonly snapshotMissing: readonly string[];
  readonly historyStatus: unknown;
  readonly effect: unknown;
}

export interface CallDetailModelAttempt {
  readonly requestId: string;
  readonly attempt: number;
  readonly backend: string;
  readonly protocol: string;
  readonly templateId: string | null;
  /** Submitted request material, already free of authentication headers. */
  readonly request: unknown;
  /** The model's own answer text; never replaced by a runtime reason. */
  readonly responseText: string | null;
  readonly parsed: unknown;
  readonly error: string | null;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly estimatedInputTokens: number;
  /** The provider's usage payload after masking, exactly as received, or null. */
  readonly usage: unknown;
  /** The same payload under the shared usage mapping, or null when nothing arrived. */
  readonly normalizedUsage: unknown;
}

export interface CallDetailRaw {
  readonly arguments: unknown;
  readonly argumentsSchema: unknown;
  readonly snapshot: unknown;
  readonly config: unknown;
  readonly configFormatVersion: number | null;
  readonly snapshotFormatVersion: number | null;
  readonly modelAttempts: readonly CallDetailModelAttempt[];
  readonly templates: readonly unknown[];
  /** What the runtime recorded about the session-log write itself. */
  readonly sessionRecordState: string | null;
}

export interface CallDetail {
  readonly callId: string;
  readonly source: CallDetailSource;
  readonly recordFormatVersion: number | null;
  readonly unreadable: boolean;
  /** A stored diagnostic; kept original because it describes the data itself. */
  readonly unreadableReason: string | null;
  readonly overview: CallDetailOverview;
  readonly basis: CallDetailBasis;
  readonly raw: CallDetailRaw;
  readonly missing: readonly CallDetailMissingCode[];
}
