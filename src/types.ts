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
/**
 * The plugin's execution boundary, chosen on the configuration page.
 *
 * It decides whether an already-enabled session keeps the host workspace file
 * sandbox after the plugin admits a call. It never enables a session.
 */
export type ExecutionBoundary = 'guarded' | 'trusted';

export type RuleVerdict = 'allow' | 'deny' | 'force-ask' | 'force-review';
export type RuleKind = 'exact' | 'regex' | 'glob';

/**
 * What one condition inspects.
 *
 * `command`, `file_redirect` and `variable_assignment` read structure the shell
 * reader produced; `tool` reads the tool name; `argument` selects values from the
 * tool-call arguments with RFC 9535 JSONPath. The argument target is not a path
 * helper: a field named `path` carries no file semantics.
 */
export type RuleTarget =
  'command' | 'file_redirect' | 'variable_assignment' | 'tool' | 'argument';

/** How multiple selected values are combined for one `argument` condition. */
export type RuleMultiMode = 'any' | 'all';

/**
 * A pattern keeps the JSON type it was written with.
 *
 * `regex` and `glob` only apply to strings; `exact` compares the actual JSON
 * type, so `1` never matches `"1"` and `null` never matches an absent field.
 */
export type RulePattern = string | number | boolean | null;

export interface RuleCondition {
  readonly target: RuleTarget;
  /**
   * RFC 9535 expression, required for `argument` and absent for every other
   * target. `$` is the tool-call arguments object.
   */
  readonly path?: string;
  readonly kind: RuleKind;
  readonly pattern: RulePattern;
  /** Matches case-insensitively when `false`; absent means case-sensitive. */
  readonly caseSensitive?: boolean;
  /** `argument` only: `any` (default) or `all`. */
  readonly multi?: RuleMultiMode;
}

/**
 * What a rule applies to before its conditions are checked.
 *
 * A tool entry is an exact name or a namespace glob. An agent entry is `main`,
 * `subagent`, or `preset:<name>`; a rule with an agent scope never matches an
 * unknown identity.
 */
export interface RuleScope {
  readonly tools?: readonly string[];
  readonly agents?: readonly string[];
}

export interface CommandRule {
  /** Stable identity; renaming or editing the rule never changes it. */
  readonly id: string;
  /** Optional custom display name; never used for matching or identity. */
  readonly name?: string;
  readonly comment?: string;
  readonly enabled?: boolean;
  readonly scope?: RuleScope;
  /** At least one condition; several conditions are alternatives (OR). */
  readonly conditions: readonly RuleCondition[];
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
  /**
   * Optional declared document format. Absent means the implicit current format
   * (`arbiter-config-v1`); a declaration is preserved so content identity
   * distinguishes it from the implicit legacy document.
   */
  readonly format?: string;
  readonly enabled: boolean;
  /** The boundary applied when a session is enabled; never enables one itself. */
  readonly boundary: ExecutionBoundary;
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

/**
 * A machine-stable issue code plus its interpolation parameters.
 *
 * `code` lets the UI resolve a localized sentence through the host locale
 * instead of rendering a backend English phrase; `message` remains the
 * developer-facing fallback and keeps protocol/log output unchanged.
 */
export interface ConfigIssueDetail {
  readonly code?: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

export interface ConfigError extends ConfigIssueDetail {
  readonly path: string;
  readonly message: string;
}

export interface ConfigWarning extends ConfigIssueDetail {
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

/** How one rule condition evaluated against one call. */
export type RuleConditionOutcome = 'match' | 'no-match' | 'unknown';

/**
 * One condition's result, kept per condition so the configuration UI can explain
 * a decision without re-running the matcher.
 *
 * `unknown` means the needed structure could not be determined (for example an
 * unresolved redirect target); it is not a match and never grants a verdict. A
 * target that simply does not exist for this call is `no-match` and carries a
 * reason instead.
 */
export interface RuleConditionResult {
  readonly index: number;
  readonly target: RuleTarget;
  readonly kind: RuleKind;
  readonly pattern: RulePattern;
  readonly outcome: RuleConditionOutcome;
  readonly reason?:
    | 'scope'
    | 'missing'
    | 'empty-selection'
    | 'unsupported-value'
    | 'value-mismatch'
    | 'resolved'
    | 'unresolved-structure'
    | 'parse-error';
  /** JSONPath expression for an `argument` condition. */
  readonly path?: string;
  readonly multi?: RuleMultiMode;
  /** Selected values, in document order, for an `argument` condition. */
  readonly values?: readonly unknown[];
  readonly matchedValues?: readonly unknown[];
  readonly matchedValue?: string;
}

/** One rule's result, including every condition it evaluated. */
export interface RuleResult {
  readonly index: number;
  readonly id: string;
  readonly name?: string;
  readonly verdict: RuleVerdict;
  readonly outcome: RuleConditionOutcome;
  readonly conditions: readonly RuleConditionResult[];
}

export interface RuleMatchDetail {
  readonly index: number;
  readonly id: string;
  readonly name?: string;
  readonly verdict: RuleVerdict;
  readonly effective: boolean;
  readonly target: RuleTarget;
  readonly conditionIndex: number;
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
      readonly reason:
        'no-match' | 'incomplete' | 'unresolved' | 'partial-allow';
    };

export interface RuleTestResult {
  readonly input: string;
  readonly tool: string;
  readonly path: RuleMatchDetail['verdict'] | 'review(default)';
  readonly rule: RuleMatchDetail | null;
  readonly matches: readonly RuleMatchDetail[];
  /** Every rule's condition-level result, for the rule tester's explanation. */
  readonly rules: readonly RuleResult[];
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
  readonly rules: readonly RuleResult[];
  readonly parse: ShellParse;
  readonly argv: readonly string[];
  readonly facts: DerivedFacts | null;
  readonly shadowed: readonly string[];
}

/**
 * One session's durable admission, folded from the session log.
 *
 * `enabled` is the user's own switch for this session and is never derived from
 * the global plugin flag, a host preset name, or the effective knob values.
 */
export interface SessionAdmission {
  readonly sessionId: string;
  /** The main session whose admission covers this one (itself for a main). */
  readonly rootSessionId: string;
  readonly enabled: boolean;
  readonly boundary: ExecutionBoundary;
  /** Sequence number of the record that decided this state. */
  readonly seq: number;
  readonly at: number;
  /** Stable identity of this state's content, reported back to clients. */
  readonly admissionRevision: string;
}

/** Why a session is or is not covered by the plugin's gate. */
export type AdmissionScopeReason =
  | 'session-enabled'
  | 'parent-session-enabled'
  | 'no-admission'
  | 'session-disabled'
  | 'parent-not-admitted'
  | 'parent-unresolved'
  | 'parent-cycle';

export interface AdmissionScope {
  readonly managed: boolean;
  readonly reason: AdmissionScopeReason;
  /** The enabled admission that covers the call, when managed. */
  readonly admission: SessionAdmission | null;
  /** Set when a subagent's parent chain could not be resolved. */
  readonly unresolvedParent: string | null;
}

/**
 * The backend-confirmed admission view returned to clients.
 *
 * `revision` is the effective configuration revision the answer was computed
 * under; `admissionRevision` identifies the session state itself.
 */
export interface SessionAdmissionView {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly enabled: boolean;
  readonly boundary: ExecutionBoundary;
  readonly revision: string;
  readonly admissionRevision: string | null;
  readonly seq: number | null;
  readonly at: number | null;
  readonly reason: AdmissionScopeReason;
  /** Whether this session's own calls would be gated right now. */
  readonly managed: boolean;
}
