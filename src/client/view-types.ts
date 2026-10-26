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

/** One detected conflict with another approval provider. */
export interface CoexistenceConflictView {
  readonly id: string;
  /** `blocking` stops a new takeover; `warning` only informs. */
  readonly severity: 'blocking' | 'warning';
  readonly kind: 'official-auto-review' | 'auto-slot' | 'approval-hook';
  /** The module, entry or synthetic slot the conflict came from. */
  readonly source: string;
  readonly entryId: string | null;
  /** The observable capability, e.g. `tools/pre-execute`. */
  readonly capability: string;
  readonly detail: string | null;
}

/** One reminder for a continuous conflict period. */
export interface CoexistenceNoticeView {
  readonly id: string;
  readonly conflictId: string;
  readonly severity: 'blocking' | 'warning';
  readonly kind: CoexistenceConflictView['kind'];
  readonly source: string;
  readonly capability: string;
  readonly at: number;
  /** True once the user closed it; the conflict itself still stands. */
  readonly acknowledged: boolean;
  /** Whether the period that produced this notice has already ended. */
  readonly retired?: boolean;
}

/**
 * The Auto-slot capability problem that survives conflict resolution.
 *
 * A cleared official conflict does not prove this plugin holds the Auto entry:
 * a registration that already failed stays failed. The UI shows this separately
 * so "conflict gone" is never presented as "fully healthy".
 */
export type AutoSlotProblemView =
  | null
  | {
      readonly kind: 'registration-failed';
      readonly error: string | null;
      readonly recovery: 'reload-plugin';
    }
  | {
      readonly kind: 'slot-unavailable';
      readonly error: null;
      readonly recovery: 'host-unsupported';
    };

/**
 * What the host could establish about other approval providers.
 *
 * `detection: 'partial'` means a public surface was missing, so "no conflict"
 * is explicit about its limits instead of claiming a clean state.
 */
export interface CoexistenceView {
  readonly detection: 'complete' | 'partial';
  readonly missing: readonly string[];
  readonly blocked: boolean;
  readonly reason: 'official-running' | null;
  readonly official: {
    readonly present: boolean;
    readonly module: string;
    readonly enabled: boolean;
    readonly running: boolean;
    readonly phase: string | null;
  };
  readonly autoSlot: 'arbiter' | 'other' | 'unknown';
  readonly autoSlotProblem: AutoSlotProblemView;
  readonly conflicts: readonly CoexistenceConflictView[];
  readonly notices: readonly CoexistenceNoticeView[];
  /** How many times this runtime observed the host on its own. */
  readonly observations: number;
  readonly updatedAt: number;
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
  /** Absent when the payload predates coexistence detection. */
  readonly coexistence: CoexistenceView | null;
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

export interface LogRow {
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

export interface LogDetail {
  readonly callId: string;
  readonly ts: number;
  readonly sessionId: string;
  readonly sessionKind: string;
  readonly parentSession: string | null;
  readonly tool: string;
  readonly arguments: unknown;
  readonly cwd: string;
  readonly fingerprint: string;
  readonly configRevision: string;
  readonly approvalMode: string;
  readonly executionMode: string;
  readonly result: string;
  readonly reason: string;
  readonly trace: readonly unknown[];
  readonly effect: unknown;
  readonly sessionRecordState: string;
  readonly signals: unknown;
  readonly policyStrategy: string | null;
  readonly decisionRules: readonly string[];
  readonly executionStatus: string;
  readonly stages: readonly {
    readonly seq: number;
    readonly stage: string;
    readonly result: string;
    readonly reason: string | null;
    readonly ruleId: string | null;
    readonly decisionRules: readonly string[];
    readonly configRevision: string | null;
    readonly ts: number;
  }[];
  readonly snapshot: unknown;
  readonly modelCalls: readonly {
    readonly requestId: string;
    readonly attempt: number;
    readonly backend: string;
    readonly protocol: string;
    readonly request: unknown;
    readonly responseText: string | null;
    readonly parsed: unknown;
    readonly error: string | null;
    readonly startedAt: number;
    readonly durationMs: number;
    readonly estimatedInputTokens: number;
    readonly usage: unknown;
  }[];
  readonly config: unknown;
}

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

export interface SlotProps {
  readonly view?: string;
}

export interface ClientContext {
  readonly locale: LocaleService;
  /**
   * Service lookup that does not require declaring `inject`.
   *
   * The dynamic-access seam of the plugin context: reading an optional service
   * this plugin does not depend on is only safe through this, because a plain
   * property read of an undeclared service throws.
   */
  readonly reflect?: {
    get(name: string, strict?: boolean): unknown;
  };
  effect(callback: () => () => void, label?: string): unknown;
  readonly slots: {
    inject(name: string, callback: () => unknown): void;
    register(
      options: {
        readonly name: string;
        readonly key?: string;
        readonly id?: string;
      },
      component: ComponentType<SlotProps>,
    ): unknown;
  };
}
