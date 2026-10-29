/**
 * Shared, host-independent types for dsh-arbiter.
 *
 * The host half and the browser half both compile these definitions. Keep this
 * module free of Node.js and DSH imports.
 */

import type { ShellParse } from './shell/parse.js';
import type { NormalizationDetail } from './shell/types.js';

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
 * How a rule combines its own conditions.
 *
 * `any` keeps the historical meaning (one certain match decides). `all` requires
 * every condition to hold, and for the structural targets the *same node* must
 * satisfy all of them — otherwise a rule could pair a command from one statement
 * with a redirect from another and authorize both.
 *
 * This is a different layer from `RuleMultiMode`: that one combines the values
 * one condition selected, this one combines conditions.
 */
export type RuleCombine = 'all' | 'any';

/** The structural targets whose conditions must be satisfied by one node. */
export const STRUCTURAL_TARGETS = [
  'command',
  'file_redirect',
  'variable_assignment',
] as const;

/** Whether a target reads shell structure rather than a single call value. */
export function isStructuralTarget(target: RuleTarget): boolean {
  return (STRUCTURAL_TARGETS as readonly RuleTarget[]).includes(target);
}

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
  /**
   * How several conditions combine. Required when there is more than one
   * condition; a single condition keeps it optional because both values mean the
   * same thing.
   */
  readonly combine?: RuleCombine;
  /** At least one condition; `combine` decides whether they all or any must hold. */
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
  /**
   * The rule's display name as it stood when this decision ran.
   *
   * A rule can be renamed or deleted later, so the audit row must carry the
   * name it used: re-reading the live configuration to render history would
   * silently rewrite what the record says happened.
   */
  readonly ruleName?: string;
  readonly decisionRules?: readonly string[];
  readonly configRevision?: string;
  /**
   * The configuration content snapshot that governed this stage.
   *
   * Each stage records its own identity because a configuration can change
   * while one call is in flight; the record must explain each stage by the
   * configuration that was in effect for it, not by whatever runs last.
   */
  readonly configSnapshotId?: string;
  /**
   * How a `combine: all` rule's conjunction was satisfied, when one ruled.
   *
   * A conjunction's reason is the pair of facts that jointly permitted the call,
   * so recording only the first matching condition would describe the decision as
   * something narrower than it was. Absent for `any` rules and for records
   * written before the connective existed; readers report the gap rather than
   * reconstruct a witness from the current rule.
   */
  readonly conjunction?: RuleConjunctionEvidence;
  readonly at: number;
}

/** One witness node per conjunction group, as observed when the rule ruled. */
export interface RuleConjunctionEvidence {
  readonly combine: RuleCombine;
  readonly groups: readonly RuleConjunctionGroup[];
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
  /**
   * The host turn this message was written in, when the log identifies turns.
   *
   * A human instruction from an earlier turn is still evidence — it stays in
   * force until something newer and applicable conflicts with it — so this is
   * attribution, not an expiry. `null`/absent means the log carried no turn at
   * that point, which is unknown rather than turn zero.
   */
  readonly turn?: number;
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
  /**
   * The structured status of this call's recorded result.
   *
   * Absent means no result was observed: the call was an attempt, and the
   * snapshot must not present an attempt as a completed step. Only the status is
   * kept — never the output text, which may contain injected instructions and is
   * large. `ok` is the host's own `isError` inverted; no exit code is invented
   * when the event does not carry one.
   */
  readonly result?: { readonly ok: boolean };
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
  /**
   * The stored stage chain, when a durable source could supply it.
   *
   * `trace` is the result sequence every record carries and is what ordering and
   * dedup use. This keeps what a projection loses — each stage's own reason, rule
   * and time — so a chain another source only partly recorded can be completed
   * from evidence rather than guessed. It is absent when no source had it.
   */
  readonly stages?: readonly {
    readonly stage: string;
    readonly result: string;
    readonly reason: string | null;
    readonly ruleId: string | null;
    readonly decisionRules: readonly string[];
    readonly configRevision: string | null;
    readonly ts: number;
  }[];
  /**
   * Facts two sources disagreed on for this same call.
   *
   * They are reported, never resolved: a differing stage or result is shown as
   * both observations so the reviewer cannot read a conclusion that no single
   * source actually recorded.
   */
  readonly conflicts?: readonly {
    readonly field: string;
    readonly observed: readonly string[];
  }[];
  /**
   * More disagreement was observed for this call than an entry can represent.
   *
   * It travels with the entry rather than in a side table, so it is bounded by the
   * window and scoped to the session that produced it. A dropped call takes its
   * flag with it, and no other session can inherit it.
   */
  readonly conflictsTruncated?: boolean;
}

/**
 * How much of this session's prior-verdict history is accounted for.
 *
 * Coverage is a different question from capacity, and the two can hold at once:
 * a window can be cut by capacity while every selected entry is fully known, or
 * be small while a source could not answer. Reporting them as one exclusive
 * value would have to hide one of the two facts.
 *
 *   - `known-empty`: every configured source answered, and there is no prior
 *     verdict. Nothing is missing.
 *   - `complete`: every selected entry is fully accounted for. It does not claim
 *     the session had no older verdicts — `windowTruncated` says whether it did.
 *   - `partial`: a source was unavailable or cleaned, or a chain is incomplete
 *     or carries a disagreement. What was read is used; `reason` says what is
 *     unknown.
 *   - `unknown`: memory is gone and no source could supply a readable record, so
 *     whether verdicts ever existed is unknown. It must not be presented as "no
 *     prior verdicts".
 */
export type HistoryCoverage =
  'known-empty' | 'complete' | 'partial' | 'unknown';

/** Per-source outcome of one history read, for the detail view and tests. */
export interface HistorySourceState {
  /** Present when this source answered; the count it contributed afterwards. */
  readonly read: number;
  /** Set to why this source could not answer, or `null` when it did. */
  readonly unavailable: string | null;
}

export interface HistoryStatus {
  readonly coverage: HistoryCoverage;
  /**
   * Whether the capacity window dropped older candidates.
   *
   * This is the normal window cut, and it is kept separate from coverage so a
   * truncated window is never reported as missing history. The review budget's
   * own trim stays on `historyTruncated` and `budget.truncatedSegments`.
   */
  readonly windowTruncated: boolean;
  /** What is unknown, when coverage is `partial` or `unknown`. */
  readonly reason: string | null;
  /**
   * Sources that answered, so "0 because a new session" stays distinguishable
   * from "0 because nothing could be read".
   */
  readonly sources: {
    readonly memory: HistorySourceState;
    readonly session: HistorySourceState;
    readonly audit: HistorySourceState;
  };
  /** Whether an older, pre-reset history is being withheld on purpose. */
  readonly reset: boolean;
}

/**
 * What kind of observation a completeness item records.
 *
 * The four kinds are different facts and take different paths:
 *
 *   - `known-empty`: the source answered and the answer was "nothing here". A
 *     configured-off source or a readable session with no human message is
 *     known-empty; it is not a failure and it never blocks.
 *   - `unreadable`: a source that should have answered did not.
 *   - `truncated`: material was found but this submission cannot carry all of it.
 *   - `unrelated`: material outside the current turn or outside the review's
 *     scope was dropped on purpose. Losing it is the normal case.
 *   - `summarized`: a lossy summary stands in for originals the log still holds.
 */
export type MaterialGapKind =
  'known-empty' | 'unreadable' | 'truncated' | 'unrelated' | 'summarized';

/** Which material an item is about. */
export type MaterialSource =
  | 'pending-action'
  | 'session-human'
  | 'parent-human'
  | 'project-rules'
  | 'custom-rules'
  | 'tool-window'
  | 'checkpoints'
  | 'prior-verdicts';

/**
 * One reported observation about this submission's material.
 *
 * `blocking` is the only field a decision depends on, and it is set by the
 * reader that observed the gap — never by the reviewer. A gap that blocks means
 * the material behind this review cannot be assembled from the host's own
 * records; that is `insufficient-material`, which is a different outcome from a
 * failed reviewer call.
 */
export interface MaterialGapItem {
  readonly source: MaterialSource;
  readonly kind: MaterialGapKind;
  readonly reason: string;
  readonly blocking: boolean;
}

/** The three material states a review can be prepared from. */
export type MaterialStatus = 'complete' | 'incomplete' | 'insufficient';

/**
 * The M0 report: what this submission can say about itself.
 *
 * This covers only gaps the host and adapter layer can identify reliably. A
 * model that declines to answer is `review-failure`, not a material gap, and
 * this structure never claims to have detected a semantic abstention.
 */
export interface MaterialCompleteness {
  readonly status: MaterialStatus;
  readonly items: readonly MaterialGapItem[];
  /** The blocking items, in the review contract's gap shape. */
  readonly gaps: readonly {
    readonly source: string;
    readonly reason: string;
  }[];
  /** One sentence naming the blocking sources, or `null` when none block. */
  readonly note: string | null;
}

export interface ReviewSnapshot {
  readonly version: 1;
  readonly createdAt: number;
  /**
   * The effective configuration revision this request was assembled under.
   *
   * The response is parsed by the protocol asked here and decided later under
   * whatever is effective then, so the audit needs to name both revisions; this
   * is the request-side one.
   */
  readonly configRevision: string;
  readonly callId: string;
  readonly sessionId: string;
  readonly sessionKind: SessionKind;
  readonly parentSessionId?: string;
  readonly tool: string;
  readonly cwd: string;
  /**
   * The host turn this review belongs to, when the log named one.
   *
   * `null` means the log carried no turn identity; the tool window then covered
   * the whole readable history and `completeness` says so.
   */
  readonly turn: number | null;
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
  /** What this submission can say about prior verdicts; see {@link HistoryCoverage}. */
  readonly historyStatus: HistoryStatus;
  /** What this submission can and cannot see; see {@link MaterialCompleteness}. */
  readonly completeness: MaterialCompleteness;
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
  /**
   * The immutable template snapshot this attempt was rendered from, or absent
   * when the backend has no reusable template (the decision protocol sends a
   * fixed structure, so it carries none).
   */
  readonly templateId?: string;
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
  /**
   * For `combine: all`, the nodes that satisfied this condition *and* every
   * other condition on the same structural target.
   *
   * Only this set may contribute coverage. A condition that matched a node no
   * sibling condition matched covers nothing: otherwise a rule could pair a
   * command from one statement with a redirect from another and call the pair
   * allowed. Absent for `any`, where each condition's own matches are the cover.
   */
  readonly witnessValues?: readonly string[];
}

/**
 * One conjunction group: the conditions of a rule that share a target, and the
 * nodes that satisfied all of them.
 *
 * Kept per target so the tester can say "the redirect condition had no matching
 * node" instead of collapsing the rule into a single verdict.
 */
export interface RuleConjunctionGroup {
  readonly target: RuleTarget;
  /** Condition indices evaluated in this group, in rule order. */
  readonly conditionIndices: readonly number[];
  readonly outcome: RuleConditionOutcome;
  /** Node text that satisfied every structural condition in the group. */
  readonly witnessText?: string;
  /**
   * The matched value of each condition in a `tool` or `argument` group.
   *
   * Those targets have no node to name, so without this a matched value group
   * carries nothing historical readers can show — and a conjunction recorded as
   * "command and argument" would look like a command-only decision.
   */
  readonly witnessValues?: readonly RuleConjunctWitness[];
}

/** One condition's matched text inside a conjunction group. */
export interface RuleConjunctWitness {
  readonly conditionIndex: number;
  readonly text: string;
}

/** One rule's result, including every condition it evaluated. */
export interface RuleResult {
  readonly index: number;
  readonly id: string;
  readonly name?: string;
  readonly verdict: RuleVerdict;
  readonly combine?: RuleCombine;
  readonly outcome: RuleConditionOutcome;
  readonly conditions: readonly RuleConditionResult[];
  /** Present for `all`: how each target's conjunction resolved. */
  readonly groups?: readonly RuleConjunctionGroup[];
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
  /**
   * Original command, matched text, per-word status and structural issues.
   *
   * Optional so a caller that only needs the verdict can ignore it; the host
   * route always sends it so the tester can show why a word was not normalized.
   */
  readonly normalization?: NormalizationDetail | null;
  readonly shadowed: readonly string[];
  readonly error?: string;
}

export type {
  NormalizationCommand,
  NormalizationDetail,
  NormalizationIssue,
  NormalizationWord,
} from './shell/types.js';

export interface RuleEvaluation {
  readonly path: RulePath;
  readonly matches: readonly RuleMatchDetail[];
  readonly rules: readonly RuleResult[];
  readonly parse: ShellParse;
  readonly argv: readonly string[];
  /** How the command text was normalized, for explanations and the tester. */
  readonly normalization: NormalizationDetail | null;
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
  | 'boundary-unconfirmed'
  | 'session-enabled'
  | 'parent-session-enabled'
  | 'no-admission'
  | 'session-disabled'
  /** Coverage was refused because another approval provider was running. */
  | 'coverage-refused'
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
