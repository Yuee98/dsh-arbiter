import type { AuditStore, CallRecord } from '../audit.js';
import type { AgentLike, SessionLike, SessionsLike } from '../snapshot.js';
import type { LlmLike } from '../reviewer.js';
import type {
  ArbiterConfig,
  HistoryStatus,
  PriorVerdictItem,
  ReviewSignals,
  ReviewSnapshot,
  SessionKind,
  TraceStage,
} from '../types.js';

export type Listener = (...args: never[]) => unknown;

export interface LoggerLike {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ContextLike {
  get(key: 'profileContext'): ProfileContextLike | undefined;
  get(key: 'sandboxPolicy'): { readonly defaultMode?: string } | undefined;
  get(key: 'sessions'): SessionsLike | undefined;
  get(key: 'llm'): LlmLike | undefined;
  get(key: 'approval'): ApprovalServiceLike | undefined;
  get(key: 'permissionPresets'): PermissionPresetsLike | undefined;
  get(key: 'workingDirectory'): WorkingDirectoryLike | undefined;
  get(key: 'credentials'): CredentialsLike | undefined;
  get(key: 'configEditor'): ConfigEditorLike | undefined;
  get(key: 'commands'): CommandsLike | undefined;
  get(key: 'connection'): ConnectionLike | undefined;
  /**
   * Any other service, including the Loader that coexistence reads.
   *
   * A host without a Loader or event bus (a stub, an older deployment) makes the
   * detection report a partial view instead of a conflict-free one.
   */
  get(key: string): unknown;
  /** The event bus; `_hooks` is the only public listener registry it exposes. */
  readonly events?: { readonly _hooks?: unknown };
  /** This plugin's own fiber, excluded from the competing-listener set. */
  readonly fiber?: unknown;
  on(
    event: string,
    listener: Listener,
    options?: { prepend?: boolean; global?: boolean },
  ): () => void;
  effect(callback: () => unknown, label?: string): unknown;
  inject(
    services: readonly string[],
    callback: (ctx: ContextLike) => unknown,
  ): unknown;
  logger: LoggerLike;
}

/** The session's latest host permission values; `null` when never observed. */
export interface Knobs {
  readonly sandbox: string | null;
  readonly approval: string | null;
}

/** One session event a boundary change appends. */
export interface KnobWrite {
  readonly type: 'sandbox/mode' | 'approval/policy';
  readonly value: string;
}

export interface ToolExecutionLike {
  readonly callId: string;
  readonly rootCallId?: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly signal: AbortSignal;
  readonly agent?: AgentLike;
  readonly parent?: unknown;
  readonly schema?: unknown;
}

export interface ToolResultLike {
  readonly isError?: boolean;
  readonly content?: readonly {
    readonly type?: string;
    readonly text?: string;
  }[];
  readonly error?: { readonly message?: string };
}

export interface ApprovalServiceLike {
  config?: { readonly policy?: string };
  overrideOf?(session: SessionLike): string | undefined;
  request(request: {
    readonly agent: AgentLike;
    readonly toolName: string;
    readonly callId?: string;
    readonly reason: string;
    readonly displayReason?: { readonly en: string; readonly zh: string };
    readonly signal?: AbortSignal;
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>;
}

export interface PermissionPresetsLike {
  registerAuto?(admit: () => void): () => void;
  current?(session: SessionLike): string;
  set?(session: SessionLike, preset: string): void;
}

export interface WorkingDirectoryLike {
  ensure(agent: AgentLike, signal?: AbortSignal): Promise<string>;
}

/**
 * The host's public per-assembly context.
 *
 * `agent` is present for a real model request and absent on a diagnostic
 * assembly; `scope` is the host's own opaque identity and is not read here.
 */
export interface AssembleContextLike {
  readonly agent?: AgentLike;
}

/** One runtime-context contribution, as the host registry accepts it. */
export interface PromptContextRegistrationLike {
  readonly name: string;
  readonly order: number;
  readonly text: string | ((context: AssembleContextLike) => string);
  readonly interpolate?: boolean;
  /** Keep this context when the deployment suppresses optional runtime context. */
  readonly required?: boolean;
}

/** The centrally ordered placements this plugin reads. */
export type PromptContextOrderNameLike = 'APPROVAL_POLICY';

/**
 * The slice of the host `systemPrompt` service this plugin uses.
 *
 * Only context registration and the central order lookup are read: assembly,
 * sections, tools and variables belong to the host and to other plugins.
 */
export interface SystemPromptLike {
  context(registration: PromptContextRegistrationLike): () => void;
  getContextOrder(name: PromptContextOrderNameLike): number;
}

export interface CredentialsLike {
  resolve(ref: string): Promise<{ readonly value: string } | undefined>;
  describe?(
    ref: string,
  ): Promise<{ readonly configured: boolean; readonly source?: string }>;
}

export interface ConfigEditorEntryLike {
  readonly options: {
    readonly id: string;
    readonly name?: string;
    readonly config?: unknown;
  };
  readonly fiber?: unknown;
}

export interface ConfigEditorLike {
  readonly documentPath: string;
  entries(): readonly ConfigEditorEntryLike[];
  edit(
    entry: ConfigEditorEntryLike,
    change: (current: unknown, inherited: unknown) => unknown,
  ): Promise<void>;
}

export interface ProfileContextLike {
  readonly home: string;
  readonly dir: string;
  readonly name: string;
}

export interface CommandsLike {
  register(definition: {
    readonly name: string;
    readonly description: string;
    readonly input?: { readonly hint?: string };
    readonly handler: (input: {
      readonly agent: AgentLike;
      readonly rawInput: string;
    }) => { readonly kind: 'success' | 'error'; readonly text: string };
  }): unknown;
}

export interface FetchRouteLike {
  readonly path: string;
  readonly methods: readonly string[];
  readonly requestBody: 'buffered' | 'streaming';
  readonly fetch: (request: Request) => Promise<Response>;
}

export interface ConnectionLike {
  readonly fetch: {
    register(route: FetchRouteLike): () => void;
  };
}

export interface TurnSessionLike extends SessionLike {
  readonly seq?: number;
}

export interface RuntimeState {
  config: ArbiterConfig;
  effectiveRevision: string;
  configSnapshotId: string;
  /** The format of the document currently in effect. */
  configFormat: string;
  /** Whether that document declared its format instead of inheriting it. */
  configFormatExplicit: boolean;
  /** A UI save awaiting its Loader reload, keyed to the exact content. */
  pendingApplySource: { readonly at: number; readonly content: string } | null;
  /** How many activation rows this runtime has written, including reloads. */
  configActivations: number;
  /** How many documents this runtime has applied, recorded or not. */
  configApplications: number;
  /** True once an activation row could not be recorded for a real switch. */
  historyIncomplete: boolean;
  invalidConfigError: string | null;
  loadErrors: readonly {
    readonly path: string;
    readonly message: string;
  }[];
  warnings: readonly { readonly path: string; readonly message: string }[];
  audit: AuditStore | null;
  auditError: string | null;
  autoPresetError: string | null;
  /**
   * Whether this runtime holds the host's single Auto slot.
   *
   * `registered` means this plugin's `registerAuto` disposer is live; `other`
   * means the slot was already taken when this plugin tried (the host throws
   * for a second registration); `unavailable` means the host exposes no slot at
   * all. Only the first lets `permissionPresets.resolve('auto')` describe this
   * plugin, so the distinction is what coexistence reports.
   */
  autoSlot: 'unknown' | 'registered' | 'other' | 'unavailable';
  readonly priorVerdicts: Map<string, PriorVerdictItem[]>;
  /** How complete each session's last prior-verdict window is. */
  readonly historyStatus: Map<string, HistoryStatus>;
  /** Sessions whose runtime history was explicitly reset, and when. */
  readonly historyReset: Map<string, number>;
  /** Sessions this runtime already attempted a recovery read for, and when. */
  readonly historyRecovered: Map<string, number>;
  /** Sessions whose decision record could not be written, and why. */
  readonly sessionRecordFailures: Map<string, string>;
  /**
   * Rows whose position relative to a reset cannot be determined.
   *
   * Separate from a write failure: the record exists, only its ordering is
   * unknown, and the read must say so instead of claiming completeness.
   */
  readonly historyBoundaryAmbiguity: Map<string, string>;
  readonly breakers: Map<string, { readonly denials: number[] }>;
  readonly reviewCounts: Map<string, number>;
  /**
   * The host turn each live session is currently in.
   *
   * The session log is the authority, so this is a cache of what `turn/start`
   * announced, not a second counter: it exists because the gate must know the
   * turn *before* the pending call's own event is written. A session with no
   * entry has never announced a turn, and the snapshot then reports the turn as
   * unknown rather than inventing one.
   */
  readonly currentTurn: Map<string, number>;
  readonly sessionRecordErrors: Map<string, string>;
  readonly legacyAutoRestores: { readonly at: number }[];
  readonly autoRejections: {
    readonly at: number;
    readonly sessionId: string;
  }[];
  readonly pending: Map<
    string,
    { readonly sessionId: string; readonly ts: number }
  >;
  instances: number;
  active: number;
  /** False once unload begins: no new call is gated. */
  accepting: boolean;
  /**
   * Called after every configuration activation (startup, file, UI). Used to
   * re-apply the execution boundary to sessions that are still enabled; it is
   * never a second configuration state.
   */
  readonly configListeners: Set<(config: ArbiterConfig) => void>;
}

export interface HostServices {
  readonly sessions: SessionsLike | undefined;
  readonly llm: LlmLike | undefined;
  readonly approval: ApprovalServiceLike | undefined;
  readonly presets: PermissionPresetsLike | undefined;
  readonly workingDirectory: WorkingDirectoryLike | undefined;
  credentials: CredentialsLike | undefined;
  configEditor: ConfigEditorLike | undefined;
  commands: CommandsLike | undefined;
}

/** Explicit dependencies shared by the host adapters. */
export interface HostEnvironment {
  readonly ctx: ContextLike;
  readonly runtime: RuntimeState;
  readonly audit: AuditStore | null;
  readonly currentAudit: () => AuditStore | null;
  readonly services: HostServices;
  readonly lifecycle: (event: string, data?: Record<string, unknown>) => void;
  /**
   * The runtime history owner, once the entry has constructed it.
   *
   * A reset is a lifecycle action on that object, so the owner of the lifecycle
   * (a command, a session teardown, a test) needs a way to reach it without
   * rebuilding the selector. It stays optional because the host is usable before
   * the entry finishes wiring.
   */
  history?: {
    resetSession(sessionId: string): void;
    clearRecordFailure(sessionId: string): void;
    windowFor(sessionId: string): {
      readonly items: readonly PriorVerdictItem[];
      readonly status: HistoryStatus;
    };
  };
}

export interface AuditExtras {
  readonly effect: unknown;
  /** The review's own reason, when the review produced one. */
  readonly reviewReason: string | null;
  readonly signals: ReviewSignals | null;
  readonly snapshot: ReviewSnapshot | null;
  readonly strategy: string | null;
  readonly decisionRules: readonly string[];
  readonly modelAttempts: CallRecord['modelAttempts'];
  readonly ruleId: string | null;
}

export interface CallContext {
  readonly exec: ToolExecutionLike;
  readonly agent: AgentLike;
  readonly session: SessionLike;
  readonly sessionKind: SessionKind;
  readonly mode: string;
  readonly cwd: string;
  readonly trace: TraceStage[];
}
