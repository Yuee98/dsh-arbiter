import type { ComponentType } from 'react';
import type { ArbiterConfig, CommandRule } from '../types.js';
import type { LocaleService } from './i18n.js';
import type { ConfigIssueView } from './view-issues.js';

export type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer U)[]
    ? Mutable<U>[]
    : T[K] extends object
      ? Mutable<T[K]>
      : T[K];
};

export type Draft = Mutable<ArbiterConfig>;
export type DraftRule = Mutable<CommandRule>;

export interface AuditHealthView {
  readonly state: 'ok' | 'degraded' | 'unavailable' | 'disabled';
  readonly lastError: string | null;
  readonly dropped: number;
  readonly pending: number;
}

export interface AuditStats {
  readonly calls: number;
  readonly modelCalls: number;
  readonly bytes: number;
  readonly results: readonly {
    readonly result: string;
    readonly count: number;
  }[];
}

export interface StateResponse {
  readonly name: string;
  readonly enabled: boolean;
  readonly config: ArbiterConfig;
  readonly sourceConfig: unknown;
  readonly effectiveRevision: string;
  readonly configSnapshotId: string;
  readonly configFormat: string;
  readonly configFormatExplicit: boolean;
  readonly fileRevision: string | null;
  readonly documentPath: string | null;
  readonly invalidConfigError: string | null;
  readonly loadErrors: readonly ConfigIssueView[];
  readonly warnings: readonly ConfigIssueView[];
  readonly configHistoryComplete: boolean;
  readonly autoPresetError: string | null;
  readonly configHistory: readonly {
    readonly id: string;
    readonly activatedAt: number;
    readonly revision: string;
    readonly entry: string;
    readonly scope: string;
    readonly snapshotId: string;
  }[];
  readonly audit: {
    readonly health: AuditHealthView;
    readonly path: string | null;
    readonly bytes: number;
    readonly stats: AuditStats | null;
  };
  readonly coverage: {
    readonly gated: readonly string[];
    readonly notGated: readonly string[];
  };
  readonly policyVersion: string;
  readonly modes: { readonly main: string; readonly subagent: string };
  readonly executionMode: string;
  readonly reviewerType: string;
  readonly sessionRecordErrors: readonly (readonly [string, string])[];
}

/** The API result of one save; `saved` and effective identity are separate. */
export interface SaveResponse {
  readonly ok: boolean;
  readonly saved: boolean;
  readonly changed: boolean;
  readonly effective: boolean;
  readonly effectiveRevision: string;
  readonly configSnapshotId: string;
  readonly activationRecorded: boolean;
  readonly configFormat: string;
  readonly configFormatExplicit: boolean;
  readonly auditError: string | null;
  readonly warnings: readonly ConfigIssueView[];
}

/**
 * One row of the call list.
 *
 * The row exists to locate a call: identity, the one-line operation summary and
 * the final verdict. The reason, stage chain, arguments and model traffic are
 * read only when the row is opened, so a page never carries them.
 */
export interface LogRow {
  readonly callId: string;
  readonly ts: number;
  readonly sessionId: string;
  readonly sessionKind: string;
  readonly tool: string;
  /** The command, the code, or a bounded JSON excerpt — never the whole input. */
  readonly command: string;
  readonly result: string;
  readonly ruleId: string | null;
  /** True when the stored record's format is newer than this build. */
  readonly unreadable: boolean;
}

/** The newest record a traversal is anchored at. */
export interface LogAnchor {
  readonly ts: number;
  readonly callId: string;
}

/**
 * One decoded list page and the cursors that continue it.
 *
 * Paging is keyed to a row, not to a row count: `nextCursor` is the last row of
 * this page, and the next request asks for what follows it. A call arriving
 * anywhere in the order therefore cannot shift the rows under the reader.
 * `newer` counts arrivals above the traversal head, which a total delta cannot.
 */
export interface LogPage {
  /** False when the host could not read the audit store at all. */
  readonly ok: boolean;
  readonly rows: readonly LogRow[];
  readonly total: number;
  readonly limit: number;
  readonly nextCursor: LogAnchor | null;
  readonly prevCursor: LogAnchor | null;
  readonly anchor: LogAnchor | null;
  readonly newer: number;
  /** How many matching rows follow this page inside the traversal. */
  readonly remaining: number;
  readonly code: string | undefined;
}

/**
 * Why part of a detail is not shown.
 *
 * The host sends a stable code so the page can render a localized sentence; an
 * unrecognized code falls back to a generic sentence rather than a bare key.
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

export interface CallDetailStageView {
  readonly seq: number;
  readonly stage: string;
  readonly result: string;
  readonly reason: string | null;
  readonly ruleId: string | null;
  readonly ruleName: string | null;
  readonly decisionRules: readonly string[];
  readonly configRevision: string | null;
  readonly configSnapshotId: string | null;
  readonly ts: number | null;
}

export interface CallDetailModelAttemptView {
  readonly requestId: string;
  readonly attempt: number;
  readonly backend: string;
  readonly protocol: string;
  readonly templateId: string | null;
  readonly request: unknown;
  /** The model's own answer; shown as received, never relabelled as a reason. */
  readonly responseText: string | null;
  readonly parsed: unknown;
  readonly error: string | null;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly estimatedInputTokens: number;
  readonly usage: unknown;
}

/**
 * One call's detail, from the audit store or a partial runtime record.
 *
 * `source` says which: a session-sourced detail is the minimal verdict record,
 * so the page reports the absent layers instead of pretending they were read.
 */
export interface CallDetailView {
  readonly callId: string;
  readonly source: 'audit' | 'session';
  readonly recordFormatVersion: number | null;
  readonly unreadable: boolean;
  readonly unreadableReason: string | null;
  readonly overview: {
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
    /** The final permission verdict; `null` when no source stated one. */
    readonly verdict: string | null;
    readonly verdictReason: string | null;
    readonly configRevision: string | null;
    readonly fingerprint: string | null;
    readonly execution: {
      readonly status: string | null;
      readonly startedAt: number | null;
      readonly finishedAt: number | null;
    };
    readonly cancelled: boolean;
  };
  readonly basis: {
    readonly rule: {
      readonly ruleId: string;
      readonly ruleName: string | null;
    } | null;
    readonly decisionRules: readonly string[];
    /** Disagreements between sources for this same call, both readings kept. */
    readonly conflicts: readonly {
      readonly field: string;
      readonly observed: readonly string[];
    }[];
    readonly conflictsTruncated: boolean;
    readonly policyStrategy: string | null;
    readonly chain: readonly CallDetailStageView[] | null;
    /**
     * Whether the record proves a model review ran.
     *
     * `none` is a rule short-circuit (no review material expected), `reviewed`
     * means absent material is a real gap, and `unknown` means the stored record
     * does not establish either.
     */
    readonly reviewState: 'none' | 'reviewed' | 'unknown';
    readonly trace: readonly string[];
    readonly signals: unknown;
    readonly evidence: readonly unknown[];
    readonly materials: readonly unknown[];
    readonly evidenceTruncated: boolean;
    readonly snapshotMissing: readonly string[];
    readonly historyStatus: unknown;
    readonly effect: unknown;
  };
  readonly raw: {
    readonly arguments: unknown;
    readonly argumentsSchema: unknown;
    readonly snapshot: unknown;
    readonly config: unknown;
    readonly configFormatVersion: number | null;
    readonly snapshotFormatVersion: number | null;
    readonly modelAttempts: readonly CallDetailModelAttemptView[];
    readonly templates: readonly unknown[];
    readonly sessionRecordState: string | null;
  };
  readonly missing: readonly CallDetailMissingCode[];
  /**
   * How many reported gaps this build has no wording for.
   *
   * A newer host may report a code this build does not know. It is counted so
   * the page still says material is unavailable instead of dropping the fact or
   * rendering the raw token.
   */
  readonly missingUnknown: number;
}

/**
 * What one detail request settled at.
 *
 * The absence cases are distinct on purpose: "no source holds this call" is a
 * clean answer, "the stored structure cannot be read" is a degraded one, and a
 * transport failure is neither. Collapsing them would tell the operator the
 * wrong thing about their own history.
 */
export type CallDetailState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly detail: CallDetailView }
  | { readonly kind: 'record-unavailable' }
  | { readonly kind: 'audit-unavailable' }
  | { readonly kind: 'failed'; readonly message: string };

/** One model the host catalog offers for a provider route. */
export interface ModelOptionView {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

/** One provider route with its successfully loaded models. */
export interface ModelGroupView {
  readonly id: string;
  readonly name: string;
  readonly models: readonly ModelOptionView[];
}

/**
 * One provider whose catalog lookup failed.
 *
 * The host's own message is replaced by a stable code: a provider error may
 * quote endpoint or credential material, which must not reach the page.
 */
export interface ModelCatalogFailureView {
  readonly id: string;
  readonly name: string;
  readonly code: string;
}

/** The read-only Reviewer model directory. */
export interface ModelCatalogView {
  /**
   * False when the whole directory could not be read.
   *
   * This is not the same as an empty directory: a composition with no models
   * still answers `loaded: true` with no groups, so a failure must never render
   * as "nothing is configured".
   */
  readonly loaded: boolean;
  /** False when this composition has no LLM service at all. */
  readonly supported: boolean;
  readonly groups: readonly ModelGroupView[];
  readonly failures: readonly ModelCatalogFailureView[];
}

/** What the host could determine about one credential reference. */
export type CredentialState =
  'configured' | 'unconfigured' | 'unsupported' | 'unavailable';

/** Credential presence only; the value never leaves the host credential store. */
export interface CredentialStatusView {
  readonly state: CredentialState;
  readonly configured: boolean;
  readonly source: string | null;
}

/** One attempt of a Reviewer connection test, as the host recorded it. */
export interface ReviewerProbeAttemptView {
  readonly attempt: number;
  readonly backend: string;
  readonly protocol: string;
  readonly durationMs: number;
  /** Submitted material, already free of credentials. */
  readonly request: unknown;
  readonly responseText: string | null;
  readonly parsed: unknown;
  readonly error: string | null;
}

/**
 * One completed connection test.
 *
 * A pass means the answer satisfied the formal parser, not that the action would
 * be allowed; the signals stay raw so the dialog can show what the model said.
 */
/**
 * Why a probe did not pass. The host sends a stable code; the page owns the
 * wording, and an unrecognized code renders a sentence rather than a bare key.
 */
export type ReviewerProbeFailure =
  | 'model-required'
  | 'credential-missing'
  | 'unauthorized'
  | 'rate-limited'
  | 'unavailable'
  | 'network'
  | 'timed-out'
  | 'invalid-output'
  | 'cancelled'
  | 'unknown';

export type ReviewerProbeView =
  | {
      readonly status: 'passed';
      readonly backend: string;
      readonly provider: string;
      readonly model: string;
      readonly protocol: string;
      readonly durationMs: number;
      readonly repairs: number;
      readonly attempts: readonly ReviewerProbeAttemptView[];
    }
  | {
      readonly status: 'failed' | 'cancelled';
      readonly backend: string;
      readonly provider: string;
      readonly model: string;
      readonly protocol: string;
      readonly durationMs: number;
      readonly failure: ReviewerProbeFailure;
      readonly attempts: readonly ReviewerProbeAttemptView[];
    };

/**
 * The rules panel's stable interface.
 *
 * The draft and its mutator stay owned by the page, so the tester panel can be
 * replaced or extended without the editor growing another responsibility. The
 * selection is held by the panel rather than the page: it is view state, not
 * configuration.
 */
export interface RulesPanelProps {
  readonly draft: Draft;
  readonly onDraft: (mutator: (draft: Draft) => void) => void;
  /** Backend validation findings for the current draft, already decoded. */
  readonly errors?: readonly ConfigIssueView[];
  readonly warnings?: readonly ConfigIssueView[];
}

/**
 * The rule-list interface a tester panel can drive.
 *
 * `onTest` is a focus request, not an execution: the header action reveals the
 * tester for one rule and never runs it, so saving never depends on testing.
 */
export interface RuleListProps {
  readonly draft: Draft;
  readonly selectedId: string | null;
  readonly errors?: readonly ConfigIssueView[];
  readonly warnings?: readonly ConfigIssueView[];
  readonly onSelect: (id: string | null) => void;
  readonly onDraft: (mutator: (draft: Draft) => void) => void;
  readonly onTest: (id: string) => void;
}

export interface SlotProps {
  readonly view?: string;
}

export interface ClientContext {
  readonly locale: LocaleService;
  effect(callback: () => () => void, label?: string): unknown;
  readonly slots: {
    inject(name: string, callback: () => unknown): void;
    register(
      options: { readonly name: string; readonly key?: string },
      component: ComponentType<SlotProps>,
    ): unknown;
  };
}
