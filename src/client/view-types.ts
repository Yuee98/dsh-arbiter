import type { ComponentType } from 'react';
import type {
  ArbiterConfig,
  CommandRule,
  ConfigError,
  ConfigWarning,
} from '../types.js';
import type { LocaleService } from './i18n.js';

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
  readonly loadErrors: readonly ConfigError[];
  readonly warnings: readonly ConfigWarning[];
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
  readonly warnings: readonly ConfigWarning[];
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
