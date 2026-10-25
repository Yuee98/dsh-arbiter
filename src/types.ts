/**
 * Shared, host-independent types for dsh-arbiter.
 *
 * The host half and the browser half both compile these definitions. Keep this
 * module free of Node.js and DSH imports.
 */

import type { ShellParse } from './shell/parse.js';

export type ApprovalMode = 'normal' | 'strict' | 'progress';
export type SubagentMode = 'strict' | 'progress';
export type SessionKind = 'main' | 'subagent';

export type RuleVerdict = 'allow' | 'deny' | 'force-ask' | 'force-review';
export type RuleKind = 'exact' | 'regex' | 'glob';
export type RuleNode =
  'command' | 'file_redirect' | 'variable_assignment' | 'tool';

export interface RuleMatchSpec {
  readonly node: RuleNode;
  readonly kind: RuleKind;
  readonly pattern: string;
  /** Required for `node: "tool"`; an explicit tool name or namespace glob. */
  readonly tool?: string;
  /** Argument selector for tool rules, e.g. `path`, `command`, `arguments.url`. */
  readonly selector?: string;
  /** `main`, `subagent`, or `preset:<name>`; absent means any known identity. */
  readonly agents?: readonly string[];
}

export interface CommandRule {
  readonly id: string;
  readonly comment?: string;
  readonly enabled?: boolean;
  readonly match: RuleMatchSpec;
  readonly verdict: RuleVerdict;
  readonly hint?: string;
}

export interface PolicyThresholds {
  /** Minimum probability that authorization is at least explicit. */
  readonly tauAuth: number;
  /** Minimum probability used for the regular risk gate. */
  readonly tauRisk: number;
  /** Minimum probability of critical risk that triggers a hard deny. */
  readonly tauCritical: number;
  /** Minimum probability of low risk for the low-risk fast path. */
  readonly tauLow: number;
  /** chat risk point at or below which the call is low risk. */
  readonly chatLowRiskMax: number;
  /** chat risk point at or below which a plain medium call may be allowed. */
  readonly chatMediumRiskMax: number;
  /** decision risk ceiling used for the regular medium-risk allow row. */
  readonly mediumRiskCeiling: number;
  /** Lowest risk class that requires explicit authorization. */
  readonly explicitFromRisk: number;
  /** Whether a bulk + egress operation may be delegated to the model. */
  readonly allowBulkEgress: boolean;
}

export type ProbeMode = 'assist' | 'override';
export type ReviewerType = 'chat' | 'decision';
export type CostTier = 'free' | 'paid';
export type BreakerPreset = 'strict' | 'balanced' | 'lenient';

export interface ChatReviewerConfig {
  readonly provider: string;
  readonly model: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly timeoutMs: number;
  readonly maxRepairRetries: number;
}

export interface DecisionReviewerConfig {
  readonly url: string;
  readonly model: string;
  readonly apiKeyRef: string;
  readonly timeoutMs: number;
  readonly costTier: CostTier;
}

export interface ReviewerConfig {
  readonly type: ReviewerType;
  readonly chat: ChatReviewerConfig;
  readonly decision: DecisionReviewerConfig;
}

export interface PolicyConfig {
  readonly version: string;
  readonly normal: PolicyThresholds;
  readonly progress: PolicyThresholds;
  readonly probeMode: ProbeMode;
}

export interface ContextConfig {
  readonly maxInputTokens: number;
  readonly evidenceMaxItems: number;
  readonly parentHumanItems: number;
  readonly parentEvidenceFloor: number;
  readonly historyMaxItems: number;
  readonly checkpointMaxItems: number;
  readonly toolCallArgumentMaxChars: number;
  readonly customRules: string;
  readonly projectRules: {
    readonly enabled: boolean;
    readonly files: readonly string[];
  };
}

export interface AuditConfig {
  readonly enabled: boolean;
  readonly retentionDays: number;
  readonly retentionBytes: number;
  readonly maxQueue: number;
}

export interface BreakerConfig {
  readonly mode: 'off' | 'preset' | 'custom';
  readonly preset: BreakerPreset;
  readonly consecutiveDenials: number;
  readonly windowDenials: number;
  readonly windowSize: number;
}

export interface ArbiterConfig {
  readonly enabled: boolean;
  readonly modes: {
    readonly main: ApprovalMode;
    readonly subagent: SubagentMode;
  };
  readonly rules: readonly CommandRule[];
  readonly reviewer: ReviewerConfig;
  readonly policy: PolicyConfig;
  readonly context: ContextConfig;
  readonly audit: AuditConfig;
  readonly breaker: BreakerConfig;
  readonly reviewBudget: number | null;
}

export interface ConfigError {
  readonly path: string;
  readonly message: string;
}

export interface ConfigWarning {
  readonly path: string;
  readonly message: string;
}

export interface ConfigParseResult {
  readonly config: ArbiterConfig;
  readonly errors: readonly ConfigError[];
  readonly warnings: readonly ConfigWarning[];
}

/**
 * DSH reports tool decisions as this closed union. `ask` hands the call to the
 * host approval seam; the plugin settles its own human requests directly so it
 * can distinguish human-allow, human-deny and human-abort.
 */
export type PreToolDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string; readonly info?: unknown }
  | {
      readonly kind: 'ask';
      readonly reason: string;
      readonly displayReason?: { readonly en: string; readonly zh: string };
    }
  | { readonly kind: 'cancel' };

export type ReviewVerdict = 'review-allow' | 'review-deny' | 'review-escalate';
export type DecisionStage = 'rule' | 'review' | 'human' | 'fallback';
export type CallResult =
  | RuleVerdict
  | ReviewVerdict
  | 'human-allow'
  | 'human-deny'
  | 'human-abort'
  | 'fallback-deny';

export interface TraceStage {
  readonly stage: DecisionStage;
  readonly result: string;
  readonly reason?: string;
  readonly ruleId?: string;
  readonly decisionRules?: readonly string[];
  readonly configRevision?: string;
  readonly at: number;
}

export interface DerivedFacts {
  readonly version: 1;
  readonly parse: {
    readonly status: 'ok' | 'error';
    readonly statements: number;
  };
  readonly observed: {
    readonly writes: readonly string[];
    readonly networkCommands: readonly string[];
    readonly credentialPaths: readonly string[];
    readonly pipelineExec: readonly (readonly string[])[];
    readonly substitutions: number;
    readonly subshells: number;
  };
  readonly opaque: boolean;
  readonly opaqueReason: string | null;
  readonly unresolvedExpansions: readonly string[];
  readonly expansionRisk: string | null;
  readonly completeness: 'complete' | 'partial' | 'none';
  readonly parentAuthorizationPresent: boolean | null;
  readonly overlapsDeniedEffect: boolean;
  readonly historyTruncated: boolean;
  readonly truncated?: boolean;
}

export type EvidenceKind = 'session-human' | 'parent-human' | 'parent-relay';
export type EvidenceRole =
  'human-instruction' | 'direct-parent-instruction' | 'checkpoint' | 'fact';

export interface EvidenceItem {
  readonly ts: number;
  readonly source: { readonly kind: EvidenceKind; readonly sessionId: string };
  readonly role: EvidenceRole;
  readonly evidence: 'explicit' | 'implied' | null;
  /** Conflict priority of the source layer; lower wins. Display order still uses ts. */
  readonly sourcePriority?: 1 | 2 | 5;
  readonly text: string;
  /** The question or operation a short answer answered, when it came from ask. */
  readonly question?: string;
  /** The ask call this human answer belongs to. */
  readonly askCallId?: string;
  /** The message was longer than the per-item evidence cap. */
  readonly truncated?: boolean;
  readonly originalLength?: number;
}

/**
 * One configured guidance source as actually submitted. `present` says whether
 * its text was available; `enabled` distinguishes "switched off" from "on but
 * missing". Absence is an input fact, never an authorization finding.
 */
export interface SnapshotMaterial {
  readonly id: 'project-rules' | 'custom-rules';
  readonly enabled: boolean;
  readonly present: boolean;
  readonly chars: number;
  readonly limit: number;
  readonly truncated: boolean;
  /** Candidate file that supplied the text, or the first candidate tried. */
  readonly path?: string;
}

/** Pending-action material trimmed to fit the input budget. */
export interface ActionTruncation {
  readonly originalChars: number;
  readonly retainedChars: number;
  /** Field that was trimmed, or `null` when the whole serialized action was cut. */
  readonly field: string | null;
  /** Inclusive character range omitted from the submitted text. */
  readonly omittedFrom: number;
  readonly omittedTo: number;
}

export interface ContextToolCall {
  readonly ts: number;
  readonly tool: string;
  readonly arguments: string;
  readonly argumentsTruncated?: boolean;
}

export interface ContextCheckpoint {
  readonly ts: number;
  readonly text: string;
}

export interface PriorVerdictItem {
  readonly ts: number;
  readonly callId: string;
  readonly configRevision: string;
  readonly tool: string;
  readonly fingerprint: string;
  readonly trace: readonly string[];
  readonly result: CallResult;
  readonly reason?: string;
  readonly ruleId?: string;
  readonly decisionRules?: readonly string[];
  readonly effect?: { readonly writes?: readonly string[] };
}

export interface ReviewSnapshot {
  readonly version: 1;
  readonly createdAt: number;
  readonly callId: string;
  readonly sessionId: string;
  readonly sessionKind: SessionKind;
  readonly parentSessionId?: string;
  readonly tool: string;
  readonly cwd: string;
  readonly action: {
    readonly name: string;
    readonly arguments: unknown;
    readonly programText?: string;
    /** Set when the input budget trimmed this action's own material. */
    readonly truncated?: ActionTruncation;
  };
  readonly facts: DerivedFacts | null;
  readonly hint?: string;
  readonly projectRules: string | null;
  readonly customRules: string;
  readonly materials: readonly SnapshotMaterial[];
  readonly evidence: readonly EvidenceItem[];
  readonly evidenceTruncated: boolean;
  readonly parentAuthorizationPresent: boolean | null;
  readonly context: readonly ContextToolCall[];
  readonly checkpoints: readonly ContextCheckpoint[];
  readonly contextTruncated: boolean;
  readonly priorVerdicts: readonly PriorVerdictItem[];
  readonly historyTruncated: boolean;
  readonly missing: readonly string[];
  readonly budget: {
    readonly maxInputTokens: number;
    readonly estimatedInputTokens: number;
    readonly truncatedSegments: readonly string[];
  };
}

export interface ReviewSignals {
  readonly riskDist: Readonly<Record<string, number>> | null;
  readonly riskPoint: number | null;
  readonly riskScore: number | null;
  readonly riskClass: 'low' | 'medium' | 'high';
  readonly authDist: Readonly<Record<string, number>> | null;
  readonly authPoint: number | null;
  readonly authClass: 'none' | 'implied' | 'explicit';
  readonly secrets: boolean;
  readonly destructive: boolean;
  readonly egress: boolean;
  readonly bulk: boolean;
  readonly source: 'decision' | 'chat';
  readonly repairs: number;
}

export interface PolicyDecision {
  readonly verdict: ReviewVerdict;
  readonly decisionRules: readonly string[];
  readonly reason: string;
  readonly strategy: string;
  readonly details: {
    readonly riskClass: 'low' | 'medium' | 'high';
    readonly authClass: 'none' | 'implied' | 'explicit';
    readonly thresholds: PolicyThresholds;
  };
}

export interface ModelAttemptRecord {
  readonly requestId: string;
  readonly callId: string;
  readonly attempt: number;
  readonly backend: 'chat' | 'decision';
  readonly protocol: string;
  readonly request: unknown;
  readonly responseText: string | null;
  readonly parsed: unknown;
  readonly error: string | null;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly estimatedInputTokens: number;
  readonly usage: unknown;
}

export type ModelResult =
  | {
      readonly ok: true;
      readonly signals: ReviewSignals;
      readonly attempts: readonly ModelAttemptRecord[];
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly attempts: readonly ModelAttemptRecord[];
      readonly kind: 'review-failure';
    };

export interface RuleMatchDetail {
  readonly index: number;
  readonly id: string;
  readonly verdict: RuleVerdict;
  readonly effective: boolean;
  readonly node: RuleNode;
  readonly nodeIndex: number;
  readonly matchedText: string;
  readonly hint?: string;
}

export type RulePath =
  | {
      readonly kind: 'rule';
      readonly verdict: RuleVerdict;
      readonly ruleId: string;
      readonly hint?: string;
    }
  | {
      readonly kind: 'review-default';
      readonly reason: 'no-match' | 'incomplete' | 'partial-allow';
    };

export interface RuleTestResult {
  readonly input: string;
  readonly tool: string;
  readonly path: RuleMatchDetail['verdict'] | 'review(default)';
  readonly rule: RuleMatchDetail | null;
  readonly matches: readonly RuleMatchDetail[];
  readonly parse: {
    readonly status: 'ok' | 'error';
    readonly statements: number;
    readonly nodes: readonly string[];
    readonly completeness: 'complete' | 'partial' | 'none';
    readonly opaque: boolean;
    readonly unresolved: readonly string[];
  };
  readonly argv: readonly string[];
  readonly shadowed: readonly string[];
  readonly error?: string;
}

export interface RuleEvaluation {
  readonly path: RulePath;
  readonly matches: readonly RuleMatchDetail[];
  readonly parse: ShellParse;
  readonly argv: readonly string[];
  readonly facts: DerivedFacts | null;
  readonly shadowed: readonly string[];
}
