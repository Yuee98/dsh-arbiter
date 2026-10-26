import type { ComponentType } from 'react';
import type {
  ArbiterConfig,
  CommandRule,
  ExecutionBoundary,
  RulePath,
  RuleTestResult,
} from '../types.js';
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

/**
 * One tester answer.
 *
 * `pathDetail` is the evaluator's structured rule path; the host sends it next
 * to the legacy `path` word so the page can explain a `review(default)` reason
 * without re-deriving priority. `cwd` is the directory the evaluation actually
 * used, so a relative-path answer is reproducible.
 */
export interface RuleTestResultView extends RuleTestResult {
  readonly pathDetail: RulePath;
  readonly cwd: string;
}

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
 * The decision stage that ended one call, as the session log still says it.
 *
 * The stages are distinct because the agent and the user are told different
 * things: a rule, a model review, an unavailable approval channel, a person's
 * refusal and an abandoned question are not interchangeable, and none of the
 * last three may read as "the user rejected this". `boundary` is the guarded
 * refusal the gate records when the host boundary could not be confirmed.
 */
export type ArbiterDenialSource =
  | 'rule'
  | 'review'
  | 'fallback'
  | 'human'
  | 'abort'
  | 'boundary'
  | 'unattributed';

/**
 * One Arbiter denial as a session row may report it.
 *
 * `reason` is the display line (bounded), `fullReason` the recorded text, and
 * `truncated` states that the bound was actually applied — a row explains that
 * it shortened something rather than silently dropping it. `reason` is `null`
 * when the record carries no usable text, which is a fact about the record and
 * not an invitation to invent one.
 */
export interface ArbiterDenialView {
  readonly source: ArbiterDenialSource;
  readonly reason: string | null;
  readonly truncated: boolean;
  readonly fullReason: string | null;
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

/** Why the backend resolved one session the way it did (#4's scope reasons). */
export type AdmissionReason =
  | 'boundary-unconfirmed'
  | 'session-enabled'
  | 'parent-session-enabled'
  | 'no-admission'
  | 'session-disabled'
  | 'parent-not-admitted'
  | 'parent-unresolved'
  | 'parent-cycle';

/** The two writes the selector may perform; the boundary stays configuration. */
export type AdmissionAction = 'enable' | 'disable';

/**
 * The backend-confirmed admission of one session.
 *
 * `revision` is the effective configuration revision the answer was computed
 * under, so a client compares answers with each other instead of trusting an
 * optimistic local value.
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
  readonly reason: AdmissionReason;
  readonly managed: boolean;
}

/** A confirmed view, or the refusal the host actually answered. */
export type SessionAdmissionResponse =
  | {
      readonly ok: true;
      readonly admission: SessionAdmissionView;
      readonly revision: string;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly revision: string;
    };

/**
 * The host permission surfaces the selector needs, as a structural shape.
 *
 * They are read through `ctx.get` rather than declared dependencies: a
 * composition without the host permission UI must still load the Arbiter
 * settings page, so the selector degrades instead of parking the plugin.
 *
 * The bridge has exactly two jobs: report the host's *current* selection and
 * its *selectable* presets, and run the host's own `/permission` command. It
 * never computes admission state and never derives the current preset from a
 * sandbox value.
 */
export interface HostPermissionCatalogOption {
  readonly value: string;
  readonly name: string;
  readonly description?: string;
}

/** The host's own current selection for the bound session. */
export interface HostPresetSelection {
  readonly currentValue: string;
  /** The host's own label for the current value, when the catalog lists it. */
  readonly name?: string;
  /** The catalog entry matching the current value, when the host lists it. */
  readonly option?: HostPermissionCatalogOption;
}

export interface HostBridge {
  /** Whether native switching is possible in this composition at all. */
  available(): boolean;
  /** The host's current preset for this session, or `null` when absent. */
  hostPreset(sessionId: string): HostPresetSelection | null;
  /**
   * The selectable host presets.
   *
   * `null` means the catalog could not be read (unavailable), never "loaded
   * and empty": those are different facts and the UI treats them differently.
   */
  catalog(): Promise<readonly HostPermissionCatalogOption[] | null>;
  /** Run the host's own `/permission <preset>` command for this session. */
  selectPreset(sessionId: string, preset: string): Promise<boolean>;
  /**
   * Subscribe to anything that may have changed admission on the host side.
   *
   * Invalidation only: `listener` triggers a read of the authoritative
   * admission route, and `onCatalogChanged` triggers a fresh catalog read. Both
   * receive no value, so neither can become a second store.
   *
   * The connection generation is read from the client connection service, not
   * from the session face.
   */
  observe(
    sessionId: string,
    listener: () => void,
    onCatalogChanged: () => void,
  ): () => void;
}

export interface SlotProps {
  readonly view?: string;
  /** Session-scoped slots supply the identity; other slots do not. */
  readonly sessionId?: string;
  /** Composer owner prop: the host currently refuses composer interaction. */
  readonly locked?: boolean;
  /** Injected host adapter; absent in a composition without the permission UI. */
  readonly bridge?: HostBridge;
}

/**
 * One contributed Conversation event Definition.
 *
 * Only the surface this plugin actually uses is declared: a match on a durable
 * event, a start that adopts the business state, and a view node built for the
 * `chat` target. The engine owns paging, Turn/Step placement and incremental
 * assembly, so the plugin never folds session events itself.
 */
/**
 * The Turn/Step a matched event was placed in, as the engine resolved it.
 *
 * `anchorSeq` alone only orders a row; the host groups and folds rows by their
 * Turn/Step membership, so a row that reports no placement is treated as a
 * session-level node and escapes its Turn's collapsing. This plugin therefore
 * carries the engine's own location through instead of substituting a constant.
 */
export type ConversationLocationPort =
  | { readonly kind: 'session' }
  | { readonly kind: 'turn'; readonly turn: unknown }
  | { readonly kind: 'step'; readonly turn: unknown; readonly step: unknown }
  | { readonly kind: 'unresolved' };

export interface ConversationDefinitionPort<State, Node> {
  readonly kind: string;
  readonly target: string;
  match(event: unknown): { readonly id: string; readonly role: 'start' } | null;
  start(context: unknown, match: { readonly event: unknown }): State;
  update(context: { readonly state: State }): State;
  buildViewNode(context: {
    readonly key: string;
    readonly id: string;
    readonly state: State | undefined;
    readonly start:
      | {
          readonly event: unknown;
          /**
           * Resolved placement; absent only if a caller omits it, which the
           * engine never does for a matched event.
           */
          readonly location?: ConversationLocationPort;
        }
      | undefined;
  }): Node | null;
}

export interface ClientContext {
  readonly locale: LocaleService;
  effect(callback: () => () => void, label?: string): unknown;
  /** Read one host client service without declaring it as a dependency. */
  get(name: string): unknown;
  /**
   * Start a child plugin once an optional service becomes available.
   *
   * This keeps an optional dependency optional: the parent plugin still mounts
   * without it, and the child's registrations belong to the child's lifetime.
   */
  inject(
    services: readonly string[],
    callback: (scoped: ConversationScopedContext) => void,
  ): unknown;
  readonly slots: {
    inject(name: string, callback: () => unknown): void;
    /**
     * Register one component into a slot.
     *
     * The props are the slot's own owner currency, so the component type is
     * generic here: a keyed Chat Node receives `node`, a config slot receives
     * `view`. Each registration site names the props it really receives.
     */
    register<P extends object>(
      options: {
        readonly name: string;
        readonly key?: string;
        /** Single slots render the lowest priority first; native sits at 0. */
        readonly priority?: number;
        readonly locale?: string;
        readonly inject?: (sessionId: string) => SlotProps;
      },
      component: ComponentType<P>,
    ): () => void;
  };
}

/**
 * The conversation half's event registry.
 *
 * Declared on its own because it is injected optionally: a composition without
 * a conversation surface still loads this plugin, and only the session row
 * stays inactive.
 */
export interface ConversationEventPort {
  readonly events: {
    register(definition: unknown): () => void;
  };
}

/** The narrowed child context an optional `uiConversation` injection yields. */
export interface ConversationScopedContext extends ClientContext {
  readonly uiConversation: ConversationEventPort;
}
