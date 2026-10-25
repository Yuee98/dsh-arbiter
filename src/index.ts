/**
 * dsh-arbiter host entry.
 *
 * One `tools/pre-execute` gate decides every call: command rules first, then a
 * real reviewer, then the plugin's own human-approval settlement. The gate
 * never waits for audit persistence, and an audit failure never changes the
 * permission result.
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  AuditStore,
  fingerprintOf,
  resolveAuditPath,
  type CallRecord,
} from './audit.js';
import {
  configHash,
  DEFAULT_CONFIG,
  modeForSession,
  parseConfig,
  stableHash,
} from './config.js';
import {
  applyProbeOverrides,
  decideReview,
  reclassifySignals,
  type StrategyName,
} from './policy.js';
import {
  buildReviewSnapshot,
  type AgentLike,
  type SessionLike,
  type SessionsLike,
} from './snapshot.js';
import {
  runChatReviewer,
  runDecisionReviewer,
  type LlmLike,
} from './reviewer.js';
import {
  appendRecord,
  loadSessionRecordApi,
  recordOf,
  sessionRecordError,
  sessionRecordReady,
} from './records.js';
import { evaluateCall, testRules } from './rules/match.js';
import {
  generateCandidates,
  persistCandidates,
  replayPolicy,
} from './suggestions.js';
import type {
  ArbiterConfig,
  CallResult,
  CommandRule,
  PreToolDecision,
  PriorVerdictItem,
  ReviewSignals,
  ReviewSnapshot,
  SessionKind,
  TraceStage,
} from './types.js';

export const name = 'arbiter';

export const inject = [
  'tools',
  'sessions',
  'llm',
  'approval',
  'permissionPresets',
  'workingDirectory',
];

type Listener = (...args: never[]) => unknown;

interface LoggerLike {
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
  get(key: string): unknown;
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

interface ToolExecutionLike {
  readonly callId: string;
  readonly rootCallId?: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly signal: AbortSignal;
  readonly agent?: AgentLike;
  readonly parent?: unknown;
  readonly schema?: unknown;
}

interface ToolResultLike {
  readonly isError?: boolean;
  readonly content?: readonly {
    readonly type?: string;
    readonly text?: string;
  }[];
  readonly error?: { readonly message?: string };
}

interface ApprovalServiceLike {
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

interface PermissionPresetsLike {
  registerAuto?(admit: () => void): () => void;
  current?(session: SessionLike): string;
  set?(session: SessionLike, preset: string): void;
}

interface WorkingDirectoryLike {
  ensure(agent: AgentLike, signal?: AbortSignal): Promise<string>;
}

interface CredentialsLike {
  resolve(ref: string): Promise<{ readonly value: string } | undefined>;
  describe?(
    ref: string,
  ): Promise<{ readonly configured: boolean; readonly source?: string }>;
}

interface ConfigEditorEntryLike {
  readonly options: {
    readonly id: string;
    readonly name?: string;
    readonly config?: unknown;
  };
  readonly fiber?: unknown;
}

interface ConfigEditorLike {
  readonly documentPath: string;
  entries(): readonly ConfigEditorEntryLike[];
  edit(
    entry: ConfigEditorEntryLike,
    change: (current: unknown, inherited: unknown) => unknown,
  ): Promise<void>;
}

interface ProfileContextLike {
  readonly home: string;
  readonly dir: string;
  readonly name: string;
}

interface CommandsLike {
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

interface FetchRouteLike {
  readonly path: string;
  readonly methods: readonly string[];
  readonly requestBody: 'buffered' | 'streaming';
  readonly fetch: (request: Request) => Promise<Response>;
}

interface ConnectionLike {
  readonly fetch: {
    register(route: FetchRouteLike): () => void;
  };
}

interface TurnSessionLike extends SessionLike {
  readonly seq?: number;
}

interface RuntimeState {
  config: ArbiterConfig;
  effectiveRevision: string;
  configSnapshotId: string;
  invalidConfigError: string | null;
  loadErrors: readonly {
    readonly path: string;
    readonly message: string;
  }[];
  warnings: readonly { readonly path: string; readonly message: string }[];
  audit: AuditStore | null;
  auditError: string | null;
  autoPresetError: string | null;
  readonly priorVerdicts: Map<string, PriorVerdictItem[]>;
  readonly breakers: Map<string, { readonly denials: number[] }>;
  readonly reviewCounts: Map<string, number>;
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
}

/**
 * One runtime per profile in this process. A Loader reconciliation replaces
 * the plugin instance (and its listeners) but must not invalidate a review
 * already waiting on a model or a human, nor close the audit database out from
 * under a request that is still settling.
 */
const RUNTIMES = new Map<string, RuntimeState>();

/** How long one unload may wait for in-flight reviews before rolling back. */
export const UNLOAD_DRAIN_MS = 30_000;

/**
 * Thrown from `permissionPresets.registerAuto()`'s admission callback.
 *
 * The preset service calls the callback before it appends `permission/preset`
 * or writes a sandbox/approval knob, so this failure is the whole rejection:
 * the previous session state stays exactly as it was.
 */
export const AUTO_REJECTION_HINT =
  '此入口不受 Arbiter 支持。请在会话权限菜单中选择"自动审查（Arbiter）"。';

export class AutoEntryRejected extends Error {
  constructor() {
    super(AUTO_REJECTION_HINT);
    this.name = 'AutoEntryRejected';
  }
}

/**
 * `/permission` commands currently inside their handler, keyed by command id.
 *
 * `command/run` is committed before the handler runs and `command/done` after
 * it settles, so this counter is a public way to tell a user switch from the
 * host restoring a stored preset during session publication. The admission
 * callback has no arguments; without this signal a legacy `auto` session could
 * not be loaded at all.
 */
const permissionCommandsInFlight = new Map<string, string>();

function releaseRuntime(runtime: RuntimeState): void {
  if (runtime.instances > 0 || runtime.active > 0) return;
  runtime.audit?.close();
  runtime.audit = null;
}

function ensureAudit(
  runtime: RuntimeState,
  home: string,
  ctx: ContextLike,
): AuditStore | null {
  if (runtime.audit !== null && !runtime.audit.closed) {
    runtime.audit.updateConfig(runtime.config.audit);
    return runtime.audit;
  }
  try {
    const audit = new AuditStore(resolveAuditPath(home), runtime.config.audit);
    runtime.audit = audit;
    runtime.auditError = null;
    return audit;
  } catch (error) {
    runtime.audit = null;
    runtime.auditError = error instanceof Error ? error.message : String(error);
    ctx.logger.error(
      'arbiter: audit storage unavailable: %s',
      runtime.auditError,
    );
    return null;
  }
}

const ROUTE_BASE = '/api/arbiter';

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sessionKindOf(agent: AgentLike): SessionKind {
  const header = agent.session.header;
  if (header?.origin === 'subagent' || header?.parentSession !== undefined)
    return 'subagent';
  return 'main';
}

function approvalDisplay(): { en: string; zh: string } {
  return {
    en: 'Arbiter needs a human decision for this call. Approve it only if its action, target and scope are intended.',
    zh: 'Arbiter 需要人工决定此调用。仅当操作、目标与范围符合预期时才批准。',
  };
}

function modelReasonFor(decision: {
  readonly decisionRules: readonly string[];
}): string {
  const rule = decision.decisionRules[0];
  if (rule === undefined) return 'the review did not approve this action';
  switch (rule) {
    case 'R1':
      return 'sensitive material would leave the machine';
    case 'R2':
      return 'critical risk of irreversible damage';
    case 'R3':
      return 'no sufficient authorization was found';
    case 'R4':
      return 'bulk irreversible destruction requires a human decision';
    case 'R5':
      return 'the risk exceeds the selected policy ceiling';
    case 'R6':
      return 'bulk external sending exceeds the selected policy ceiling';
    case 'R8':
      return 'the available signals are insufficient';
    default:
      return 'the review did not approve this action';
  }
}

function deny(reason: string): PreToolDecision {
  return {
    kind: 'deny',
    reason,
    info: {
      name: 'ArbiterDeniedError',
      code: 'ARBITER_DENIED',
      reason,
    },
  };
}

const CALL_RESULTS: readonly CallResult[] = [
  'allow',
  'deny',
  'force-ask',
  'force-review',
  'review-allow',
  'review-deny',
  'review-escalate',
  'human-allow',
  'human-deny',
  'human-abort',
  'fallback-deny',
];

function asCallResult(value: unknown): CallResult | null {
  return typeof value === 'string'
    ? (CALL_RESULTS.find((entry) => entry === value) ?? null)
    : null;
}

function readLastGood(path: string): ArbiterConfig | null {
  try {
    const text = readFileSync(path, 'utf8');
    const parsed = parseConfig(JSON.parse(text));
    return parsed.errors.length === 0 ? parsed.config : null;
  } catch {
    return null;
  }
}

function writeLastGood(path: string, config: ArbiterConfig): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
  } catch {
    // Best-effort continuity aid; the configuration file remains authoritative.
  }
}

function profileHome(ctx: ContextLike): string {
  const profile = ctx.get('profileContext');
  return profile?.home ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh');
}

/**
 * A profile-scoped identity separates last-good configuration and in-memory
 * runtime runtime. Audit storage stays shared per DSH data instance; approval
 * policy must not leak between profiles in the same home.
 */
function profileScope(ctx: ContextLike): {
  readonly name: string;
  readonly key: string;
} {
  const profile = ctx.get('profileContext');
  const name = profile?.name ?? 'default';
  const identity = profile?.dir ?? `${profileHome(ctx)}/${name}`;
  return { name, key: `${name}-${stableHash(identity).slice(0, 8)}` };
}

function lastGoodPath(home: string, scope: { readonly key: string }): string {
  return join(home, 'arbiter', 'last-good', `${scope.key}.json`);
}

function executionModeName(ctx: ContextLike): string {
  const policy = ctx.get('sandboxPolicy');
  return policy?.defaultMode === 'danger-full-access' ? 'trusted' : 'guarded';
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function readJsonBody(request: Request): Promise<unknown> {
  return request
    .text()
    .then((text) =>
      text.trim().length === 0 ? {} : (JSON.parse(text) as unknown),
    );
}

function asRule(value: unknown): CommandRule | null {
  const parsed = parseConfig({ rules: [value] });
  if (parsed.errors.length > 0) return null;
  return parsed.config.rules[0] ?? null;
}

export function apply(ctx: ContextLike, rawConfig: unknown): void {
  const home = profileHome(ctx);
  const scope = profileScope(ctx);
  const lastGood = lastGoodPath(home, scope);
  const parsed = parseConfig(rawConfig);
  let config = parsed.config;
  let invalidConfigError: string | null = null;
  if (parsed.errors.length > 0) {
    invalidConfigError = parsed.errors
      .map((error) => `${error.path}: ${error.message}`)
      .join('; ');
    const previous = readLastGood(lastGood);
    config = previous ?? DEFAULT_CONFIG;
    ctx.logger.error(
      'arbiter: configuration is invalid; using the last effective configuration: %s',
      invalidConfigError,
    );
  } else {
    writeLastGood(lastGood, config);
  }

  const existing = RUNTIMES.get(scope.key);
  const runtime: RuntimeState = existing ?? {
    config,
    effectiveRevision: configHash(config),
    configSnapshotId: 'cfg-unavailable',
    invalidConfigError,
    loadErrors: parsed.errors,
    warnings: parsed.warnings,
    audit: null,
    auditError: null,
    autoPresetError: null,
    priorVerdicts: new Map(),
    breakers: new Map(),
    reviewCounts: new Map(),
    sessionRecordErrors: new Map(),
    legacyAutoRestores: [],
    autoRejections: [],
    pending: new Map(),
    instances: 0,
    active: 0,
    accepting: true,
  };
  if (existing === undefined) RUNTIMES.set(scope.key, runtime);
  runtime.config = config;
  runtime.invalidConfigError = invalidConfigError;
  runtime.loadErrors = parsed.errors;
  runtime.warnings = parsed.warnings;
  runtime.autoPresetError = null;
  runtime.accepting = true;
  runtime.instances += 1;

  const audit = ensureAudit(runtime, home, ctx);
  if (audit !== null) {
    try {
      const snapshot = audit.saveConfigSnapshot(config);
      runtime.configSnapshotId = snapshot.snapshotId;
      runtime.effectiveRevision = snapshot.revision;
      audit.recordActivation(
        snapshot.snapshotId,
        snapshot.revision,
        name,
        'profile',
      );
      audit.runRetention();
    } catch (error) {
      runtime.auditError =
        error instanceof Error ? error.message : String(error);
      ctx.logger.error(
        'arbiter: audit snapshot failed: %s',
        runtime.auditError,
      );
    }
  } else {
    runtime.configSnapshotId = 'cfg-unavailable';
    runtime.effectiveRevision = configHash(config);
  }

  const currentAudit = (): AuditStore | null =>
    runtime.config.audit.enabled ? ensureAudit(runtime, home, ctx) : null;

  /**
   * Lifecycle trace for integration tests.
   *
   * Purely observational: it records when the gate is entered, when a session
   * is registered as managed, and when unload begins/rolls back, so a test can
   * prove which call was inside which window. It is disabled unless
   * `ARBITER_TRACE_PATH` is set, and it never changes a decision.
   */
  const tracePath = process.env['ARBITER_TRACE_PATH'];
  const lifecycle = (
    event: string,
    data: Record<string, unknown> = {},
  ): void => {
    if (tracePath === undefined || tracePath === '') return;
    try {
      appendFileSync(
        tracePath,
        JSON.stringify({ at: Date.now(), event, ...data }) + '\n',
      );
    } catch {
      // Tracing must never affect the gate.
    }
  };

  ctx.effect(
    () => async () => {
      // Unload order, and why it is this order:
      //
      //   1. stop admitting new calls;
      //   2. roll the permission back FIRST, synchronously;
      //   3. only then wait for in-flight work to settle;
      //   4. release resources.
      //
      // Step 2 must not wait for step 3. A call that arrives after admission
      // stopped is no longer gated, so it runs under whatever permission the
      // session currently has. If the rollback waited for the drain, that call
      // would run under the old (possibly danger-full-access) permission —
      // exactly the window this plugin must not leave open. Rolling back first
      // means such a call is handled by the host under the narrower policy.
      runtime.accepting = false;
      lifecycle('unload/stop-admission', {
        active: runtime.active,
        managed: managed.size,
      });
      for (const [sessionId, session] of managed) {
        // Re-check: a permission switch may have landed before this point.
        if (!managed.has(sessionId)) continue;
        const rolled = rollbackSession(session, 'plugin-unload');
        lifecycle('unload/rollback', { sessionId, changed: rolled });
        managed.delete(sessionId);
      }
      const rolledAt = Date.now();
      const started = Date.now();
      while (runtime.active > 0 && Date.now() - started < UNLOAD_DRAIN_MS) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      lifecycle('unload/drained', {
        active: runtime.active,
        waitedMs: Date.now() - started,
        rolledBeforeDrainMs: rolledAt - started,
      });
      if (runtime.active > 0) {
        ctx.logger.warn(
          'arbiter: unload drain window elapsed with %s call(s) still active',
          String(runtime.active),
        );
      }
      lifecycle('unload/release', { managed: managed.size });
      runtime.instances -= 1;
      releaseRuntime(runtime);
    },
    'arbiter runtime',
  );

  // Background retention: time and capacity cleanup must also run for a
  // long-lived profile, not only at plugin apply time.
  const retentionTimer = setInterval(
    () => {
      ensureAudit(runtime, home, ctx)?.runRetention();
    },
    60 * 60 * 1_000,
  );
  retentionTimer.unref();
  ctx.effect(
    () => () => {
      clearInterval(retentionTimer);
    },
    'arbiter retention',
  );

  // Resolve the public plugin-record writer before anything can write a
  // record. A failure is retained and surfaces through the status route; it
  // never degrades to `session.append` (an event the cold reader refuses).
  loadSessionRecordApi()
    .then((api) => {
      if (api === null) {
        runtime.sessionRecordErrors.set(
          'startup',
          sessionRecordError() ?? 'session record API unavailable',
        );
        ctx.logger.warn(
          'arbiter: session records disabled: %s',
          sessionRecordError(),
        );
      }
    })
    .catch(() => undefined);

  const sessions = ctx.get('sessions');
  const llm = ctx.get('llm');
  const approval = ctx.get('approval');
  const presets = ctx.get('permissionPresets');
  const workingDirectory = ctx.get('workingDirectory');
  let credentials = ctx.get('credentials');
  let configEditor = ctx.get('configEditor');
  let commands = ctx.get('commands');
  ctx.inject(['credentials'], (child) => {
    credentials = child.get('credentials');
  });
  ctx.inject(['configEditor'], (child) => {
    configEditor = child.get('configEditor');
  });
  ctx.inject(['commands'], (child) => {
    commands = child.get('commands');
  });

  const ensureCwd = async (
    agent: AgentLike,
    signal: AbortSignal,
  ): Promise<string> => {
    if (workingDirectory !== undefined) {
      try {
        return await workingDirectory.ensure(agent, signal);
      } catch {
        // Fall through to the session header.
      }
    }
    return agent.session.header?.cwd ?? process.cwd();
  };

  const breakerOpen = (sessionId: string): boolean => {
    if (runtime.config.breaker.mode === 'off') return false;
    const breaker = runtime.breakers.get(sessionId);
    if (breaker === undefined) return false;
    const now = Date.now();
    const window = breaker.denials.filter((ts) => now - ts < 60 * 60 * 1_000);
    breaker.denials.splice(0, breaker.denials.length, ...window);
    const preset =
      runtime.config.breaker.mode === 'custom'
        ? {
            consecutive: runtime.config.breaker.consecutiveDenials,
            window: runtime.config.breaker.windowDenials,
            size: runtime.config.breaker.windowSize,
          }
        : runtime.config.breaker.preset === 'strict'
          ? { consecutive: 2, window: 4, size: 10 }
          : runtime.config.breaker.preset === 'lenient'
            ? { consecutive: 5, window: 10, size: 20 }
            : { consecutive: 3, window: 6, size: 10 };
    let consecutive = 0;
    for (let index = breaker.denials.length - 1; index >= 0; index -= 1) {
      consecutive += 1;
      if (index === 0) break;
    }
    return (
      consecutive >= preset.consecutive ||
      breaker.denials.filter((ts) => now - ts < 30 * 60 * 1_000).length >=
        preset.window
    );
  };

  const noteDenial = (sessionId: string): void => {
    const breaker = runtime.breakers.get(sessionId) ?? { denials: [] };
    breaker.denials.push(Date.now());
    runtime.breakers.set(sessionId, breaker);
  };

  const resetBreaker = (sessionId: string): void => {
    runtime.breakers.delete(sessionId);
  };

  const priorFor = (sessionId: string): PriorVerdictItem[] => {
    const limit = Math.max(1, runtime.config.context.historyMaxItems);
    const inMemory = runtime.priorVerdicts.get(sessionId) ?? [];
    if (inMemory.length > 0) return inMemory.slice(-limit);
    const restored: PriorVerdictItem[] = [];
    const session = sessions?.get?.(sessionId);
    if (session !== undefined && typeof session.snapshotEvents === 'function') {
      try {
        for (const event of session.snapshotEvents()) {
          const committed = recordOf(event);
          if (committed?.type !== 'plugin:arbiter/decision') continue;
          if (!isRecord(committed.data)) continue;
          const data = committed.data;
          const result = asCallResult(data['result']);
          if (typeof data['tool'] !== 'string' || result === null) continue;
          restored.push({
            ts:
              typeof committed.time === 'number'
                ? committed.time
                : committed.seq,
            callId:
              typeof data['callId'] === 'string'
                ? data['callId']
                : `seq-${String(committed.seq)}`,
            configRevision:
              typeof data['configRevision'] === 'string'
                ? data['configRevision']
                : 'unknown',
            tool: data['tool'],
            fingerprint:
              typeof data['fingerprint'] === 'string'
                ? data['fingerprint']
                : '',
            trace: Array.isArray(data['trace'])
              ? data['trace'].filter(
                  (entry): entry is string => typeof entry === 'string',
                )
              : [],
            result,
            ...(typeof data['reason'] === 'string'
              ? { reason: data['reason'] }
              : {}),
            ...(typeof data['ruleId'] === 'string'
              ? { ruleId: data['ruleId'] }
              : {}),
            ...(Array.isArray(data['decisionRules'])
              ? {
                  decisionRules: data['decisionRules'].filter(
                    (entry): entry is string => typeof entry === 'string',
                  ),
                }
              : {}),
          });
        }
      } catch {
        // A missing record source is reported through the snapshot's missing list.
      }
    }
    const priorAudit = currentAudit();
    if (priorAudit !== null) {
      try {
        const seen = new Set(restored.map((item) => item.callId));
        for (const row of priorAudit.priorVerdictsForSession(
          sessionId,
          limit,
        )) {
          if (seen.has(row.callId)) continue;
          const result = asCallResult(row.result);
          if (result === null) continue;
          seen.add(row.callId);
          restored.push({
            ts: row.ts,
            callId: row.callId,
            configRevision: row.configRevision,
            tool: row.tool,
            fingerprint: row.fingerprint,
            trace: row.trace,
            result,
            ...(row.reason === '' ? {} : { reason: row.reason }),
            ...(row.ruleId === null ? {} : { ruleId: row.ruleId }),
            decisionRules: row.decisionRules,
          });
        }
      } catch {
        // Ignore; the reviewer sees a missing-history marker instead.
      }
    }
    const sorted = restored
      .sort((left, right) => left.ts - right.ts)
      .slice(-limit);
    runtime.priorVerdicts.set(sessionId, sorted);
    return sorted;
  };

  /**
   * Sessions this plugin currently gates.
   *
   * A session joins when the gate first decides a call for it and is recorded
   * in the session log; it leaves when the user switches permission, or when
   * this plugin is unloaded. Only these sessions are rolled back on unload —
   * a session the user moved off arbiter keeps whatever it moved to.
   */
  const managed = new Map<string, SessionLike>();

  /**
   * The session's own last permission facts, folded from its log.
   *
   * Absent means the session never recorded an override, so its effective
   * permission is the deployment default — which is not something this plugin
   * wrote and therefore not something it may rewrite on the way out.
   */
  const sessionPermission = (
    session: SessionLike,
  ): { sandbox: string | null; approval: string | null } => {
    let sandbox: string | null = null;
    let approval: string | null = null;
    if (typeof session.snapshotEvents !== 'function') {
      return { sandbox, approval };
    }
    for (const event of session.snapshotEvents()) {
      if (event.type === 'sandbox/mode' && isRecord(event.data)) {
        const mode = event.data['mode'];
        if (typeof mode === 'string') sandbox = mode;
      } else if (event.type === 'approval/policy' && isRecord(event.data)) {
        const policy = event.data['policy'];
        if (typeof policy === 'string') approval = policy;
      }
    }
    return { sandbox, approval };
  };

  /** Roll one still-managed session back to workspace-write + ask. */
  const rollbackSession = (session: SessionLike, reason: string): boolean => {
    try {
      if (typeof session.append !== 'function') return false;
      const current = sessionPermission(session);
      const needsSandbox =
        current.sandbox !== null && current.sandbox !== 'workspace-write';
      const needsApproval =
        current.approval !== null && current.approval !== 'ask';
      // Nothing this plugin widened: leave the log alone rather than writing a
      // no-op permission event into it.
      if (!needsSandbox && !needsApproval) return false;
      if (needsSandbox)
        session.append('sandbox/mode', { mode: 'workspace-write' });
      if (needsApproval) session.append('approval/policy', { policy: 'ask' });
      ctx.logger.info(
        'arbiter: session %s rolled back to workspace-write + ask (%s)',
        session.id ?? 'unknown',
        reason,
      );
      return true;
    } catch (error) {
      ctx.logger.warn(
        'arbiter: session %s rollback failed: %s',
        session.id ?? 'unknown',
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  };

  const appendSessionRecord = (
    session: SessionLike,
    record: {
      readonly callId: string;
      readonly tool: string;
      readonly fingerprint: string;
      readonly trace: readonly string[];
      readonly result: CallResult;
      readonly reason: string;
      readonly ruleId: string | null;
      readonly decisionRules: readonly string[];
      readonly configRevision: string;
      readonly effect: unknown;
    },
  ): string => {
    const payload = {
      version: 1,
      ...record,
      ts: Date.now(),
    };
    const state = appendRecord(session, 'plugin:arbiter/decision', payload);
    if (state === 'written') return 'written';
    runtime.sessionRecordErrors.set(record.callId, state);
    return state;
  };

  const rememberPrior = (sessionId: string, item: PriorVerdictItem): void => {
    const list = runtime.priorVerdicts.get(sessionId) ?? [];
    list.push(item);
    runtime.priorVerdicts.set(
      sessionId,
      list.slice(-Math.max(1, runtime.config.context.historyMaxItems)),
    );
  };

  const finalize = (
    exec: ToolExecutionLike,
    session: SessionLike,
    sessionKind: SessionKind,
    _mode: string,
    trace: TraceStage[],
    result: CallResult,
    reason: string,
    options: {
      readonly cwd: string;
      readonly approvalMode: string;
      readonly effect: unknown;
      readonly signals: ReviewSignals | null;
      readonly snapshot: ReviewSnapshot | null;
      readonly strategy: string | null;
      readonly decisionRules: readonly string[];
      readonly modelAttempts: CallRecord['modelAttempts'];
      readonly ruleId: string | null;
    },
  ): void => {
    const sessionId = session.id ?? 'unknown';
    const fingerprint = fingerprintOf(exec.name, exec.arguments);
    const executionStatus =
      result === 'allow' ||
      result === 'review-allow' ||
      result === 'human-allow'
        ? 'pending'
        : 'not-started';
    const sessionRecordState = appendSessionRecord(session, {
      callId: exec.callId,
      tool: exec.name,
      fingerprint,
      trace: trace.map((stage) => stage.result),
      result,
      reason,
      ruleId: options.ruleId,
      decisionRules: options.decisionRules,
      configRevision: runtime.effectiveRevision,
      effect: options.effect,
    });
    const record: CallRecord = {
      callId: exec.callId,
      ts: Date.now(),
      sessionId,
      sessionKind,
      parentSession: session.header?.parentSession ?? null,
      profile: ctx.get('profileContext')?.name ?? null,
      workspace: options.cwd,
      tool: exec.name,
      arguments: exec.arguments,
      cwd: options.cwd,
      fingerprint,
      configRevision: runtime.effectiveRevision,
      configSnapshotId: runtime.configSnapshotId,
      approvalMode: options.approvalMode,
      executionMode: executionModeName(ctx),
      result,
      reason,
      trace,
      effect: options.effect,
      sessionRecordState,
      snapshot: options.snapshot,
      modelAttempts: options.modelAttempts,
      signals: options.signals,
      policyStrategy: options.strategy,
      decisionRules: options.decisionRules,
      executionStatus,
    };
    currentAudit()?.enqueue(record);
    if (record.executionStatus === 'pending') {
      runtime.pending.set(exec.callId, { sessionId, ts: record.ts });
    }
    if (
      result === 'deny' ||
      result === 'review-deny' ||
      result === 'human-deny' ||
      result === 'human-abort' ||
      result === 'fallback-deny'
    ) {
      noteDenial(sessionId);
      rememberPrior(sessionId, {
        ts: record.ts,
        callId: exec.callId,
        configRevision: runtime.effectiveRevision,
        tool: exec.name,
        fingerprint,
        trace: trace.map((stage) => stage.result),
        result,
        reason,
        ...(options.ruleId === null ? {} : { ruleId: options.ruleId }),
        decisionRules: options.decisionRules,
      });
    } else if (result === 'review-allow' || result === 'human-allow') {
      resetBreaker(sessionId);
    }
  };

  const settleHuman = async (
    exec: ToolExecutionLike,
    agent: AgentLike,
    mode: string,
    sessionKind: SessionKind,
    trace: TraceStage[],
    reason: string,
    cwd: string,
    session: SessionLike,
    auditExtras: {
      readonly effect: unknown;
      readonly signals: ReviewSignals | null;
      readonly snapshot: ReviewSnapshot | null;
      readonly strategy: string | null;
      readonly decisionRules: readonly string[];
      readonly modelAttempts: CallRecord['modelAttempts'];
      readonly ruleId: string | null;
    },
  ): Promise<PreToolDecision> => {
    if (isAborted(exec.signal)) return { kind: 'cancel' };
    const finishFallback = (
      reasonCode: string,
      text: string,
    ): PreToolDecision => {
      trace.push({
        stage: 'fallback',
        result: 'fallback-deny',
        reason: reasonCode,
        at: Date.now(),
      });
      finalize(exec, session, sessionKind, mode, trace, 'fallback-deny', text, {
        ...auditExtras,
        cwd,
        approvalMode: mode,
      });
      return deny(text);
    };

    if (mode !== 'normal') {
      return finishFallback(
        'automatic_mode_no_human',
        'Not executed [fallback-deny]: this call requires human approval, but the selected mode does not open approval requests.',
      );
    }
    if (sessionKind !== 'main') {
      return finishFallback(
        'subagent_no_human_channel',
        'Not executed [fallback-deny]: this subagent has no human approval channel.',
      );
    }
    if (approval === undefined) {
      return finishFallback(
        'approval_channel_unavailable',
        'Not executed [fallback-deny]: no human approval channel is available.',
      );
    }
    const policy =
      approval.overrideOf?.(session) ?? approval.config?.policy ?? 'ask';
    if (policy === 'never') {
      return finishFallback(
        'host_approval_policy_never',
        'Not executed [fallback-deny]: the host approval policy rejects prompts in this session.',
      );
    }

    let outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
    try {
      outcome = await approval.request({
        agent,
        toolName: exec.name,
        callId: exec.callId,
        reason,
        displayReason: approvalDisplay(),
        signal: exec.signal,
      });
    } catch (error) {
      trace.push({
        stage: 'fallback',
        result: 'fallback-deny',
        reason: `approval_error: ${error instanceof Error ? error.message : String(error)}`,
        at: Date.now(),
      });
      const text =
        'Not executed [fallback-deny]: the human approval channel failed.';
      finalize(exec, session, sessionKind, mode, trace, 'fallback-deny', text, {
        ...auditExtras,
        cwd,
        approvalMode: mode,
      });
      return deny(text);
    }

    const mapped: CallResult =
      outcome === 'allowed-once'
        ? 'human-allow'
        : outcome === 'rejected'
          ? 'human-deny'
          : outcome === 'cancelled'
            ? 'human-abort'
            : 'fallback-deny';
    trace.push({
      stage: outcome === 'unavailable' ? 'fallback' : 'human',
      result: mapped,
      reason:
        outcome === 'allowed-once'
          ? 'human_approved'
          : outcome === 'rejected'
            ? 'human_rejected'
            : outcome === 'cancelled'
              ? 'approval_cancelled'
              : 'approval_unavailable',
      at: Date.now(),
    });
    const text =
      mapped === 'human-allow'
        ? 'Arbiter: the user approved this call.'
        : mapped === 'human-deny'
          ? 'Not executed [human-deny]: the user rejected this call.'
          : mapped === 'human-abort'
            ? 'Not executed [human-abort]: the approval ended without a grant or denial.'
            : 'Not executed [fallback-deny]: no approval answerer was available.';
    finalize(exec, session, sessionKind, mode, trace, mapped, text, {
      ...auditExtras,
      cwd,
      approvalMode: mode,
    });
    return mapped === 'human-allow' ? { kind: 'allow' } : deny(text);
  };

  ctx.on(
    'tools/pre-execute',
    async (
      exec: ToolExecutionLike,
      next: () => Promise<PreToolDecision>,
    ): Promise<PreToolDecision> => {
      // A stopped or unloading plugin never gates a call: it has already
      // rolled its sessions back, so the host's own policy applies.
      if (!runtime.config.enabled || !runtime.accepting) {
        lifecycle('gate/skipped', {
          callId: exec.callId,
          tool: exec.name,
          sessionId: exec.agent?.session.id ?? null,
          accepting: runtime.accepting,
        });
        return next();
      }
      if (isAborted(exec.signal)) return { kind: 'cancel' };
      const agent = exec.agent;
      if (agent === undefined) {
        // Programmatic calls without an agent have no session, evidence or
        // approval channel. This is a declared coverage gap, not an allow.
        return next();
      }
      runtime.active += 1;
      try {
        const session = agent.session;
        const sessionId = session.id ?? 'unknown';
        // The gate is where this plugin actually takes a session over, so this
        // is also what an unload must roll back (and only this).
        managed.set(sessionId, session);
        lifecycle('gate/entered', {
          callId: exec.callId,
          tool: exec.name,
          sessionId,
          active: runtime.active,
        });
        // Publish the call identity on the review stream, so an adapter can
        // attribute a held review to the exact call without guessing. This is
        // an extra option; it does not change what the reviewer is asked.
        const reviewTrace = (stage: string): void => {
          lifecycle(`review/${stage}`, { callId: exec.callId, sessionId });
        };
        const sessionKind = sessionKindOf(agent);
        const mode = modeForSession(runtime.config, sessionKind);
        const strategy: StrategyName =
          mode === 'progress' ? 'progress' : 'normal';
        const thresholds =
          strategy === 'progress'
            ? runtime.config.policy.progress
            : runtime.config.policy.normal;
        let cwd = process.cwd();
        try {
          cwd = await ensureCwd(agent, exec.signal);
        } catch {
          // Keep the process cwd; the snapshot records the actual value.
        }
        const trace: TraceStage[] = [];
        const prior = priorFor(sessionId);

        const evaluation = evaluateCall({
          rules: runtime.config.rules.filter((rule) => rule.enabled !== false),
          tool: exec.name,
          arguments: exec.arguments,
          identity: sessionKind,
          workspaceRoot: cwd,
          cwd,
          parentAuthorizationPresent:
            session.header?.parentSession === undefined ? null : null,
          historyTruncated:
            prior.length >= runtime.config.context.historyMaxItems,
          overlapsDeniedEffect: false,
        });
        trace.push({
          stage: 'rule',
          result:
            evaluation.path.kind === 'rule'
              ? evaluation.path.verdict
              : 'review(default)',
          ...(evaluation.path.kind === 'rule'
            ? { ruleId: evaluation.path.ruleId }
            : {}),
          ...(evaluation.path.kind === 'review-default'
            ? { reason: evaluation.path.reason }
            : {}),
          configRevision: runtime.effectiveRevision,
          at: Date.now(),
        });
        const effect =
          evaluation.facts === null ? null : { ...evaluation.facts };

        if (
          evaluation.path.kind === 'rule' &&
          evaluation.path.verdict === 'deny'
        ) {
          finalize(
            exec,
            session,
            sessionKind,
            mode,
            trace,
            'deny',
            'Not executed [deny-rule]: a deny command rule matched this call.',
            {
              cwd,
              approvalMode: mode,
              effect,
              signals: null,
              snapshot: null,
              strategy,
              decisionRules: [],
              modelAttempts: [],
              ruleId: evaluation.path.ruleId,
            },
          );
          return deny(
            'Not executed [deny-rule]: a deny command rule matched this call.',
          );
        }

        if (
          evaluation.path.kind === 'rule' &&
          evaluation.path.verdict === 'force-ask'
        ) {
          return await settleHuman(
            exec,
            agent,
            mode,
            sessionKind,
            trace,
            'force-ask requires a human decision for this call.',
            cwd,
            session,
            {
              effect,
              signals: null,
              snapshot: null,
              strategy,
              decisionRules: [],
              modelAttempts: [],
              ruleId: evaluation.path.ruleId,
            },
          );
        }

        if (
          evaluation.path.kind === 'rule' &&
          evaluation.path.verdict === 'allow'
        ) {
          finalize(
            exec,
            session,
            sessionKind,
            mode,
            trace,
            'allow',
            'Arbiter: a complete allow rule covered this call.',
            {
              cwd,
              approvalMode: mode,
              effect,
              signals: null,
              snapshot: null,
              strategy,
              decisionRules: [],
              modelAttempts: [],
              ruleId: evaluation.path.ruleId,
            },
          );
          return { kind: 'allow' };
        }

        const hint =
          evaluation.path.kind === 'rule' &&
          evaluation.path.verdict === 'force-review'
            ? evaluation.path.hint
            : undefined;

        if (breakerOpen(sessionId)) {
          trace.push({
            stage: 'review',
            result: 'error-escalate',
            reason: 'circuit_open',
            at: Date.now(),
          });
          return await settleHuman(
            exec,
            agent,
            mode,
            sessionKind,
            trace,
            'Review circuit breaker is open for this session.',
            cwd,
            session,
            {
              effect,
              signals: null,
              snapshot: null,
              strategy,
              decisionRules: [],
              modelAttempts: [],
              ruleId:
                evaluation.path.kind === 'rule' ? evaluation.path.ruleId : null,
            },
          );
        }

        let snapshotBundle;
        try {
          if (llm === undefined) throw new Error('llm service is unavailable');
          snapshotBundle = await buildReviewSnapshot({
            agent,
            ...(sessions === undefined ? {} : { sessions }),
            tool: exec.name,
            arguments: exec.arguments,
            callId: exec.callId,
            cwd,
            config: runtime.config,
            facts: evaluation.facts,
            ...(hint === undefined ? {} : { hint }),
            priorVerdicts: prior,
            sessionRecordGap:
              runtime.sessionRecordErrors.get(exec.callId) ?? null,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          trace.push({
            stage: 'review',
            result: 'error-escalate',
            reason: `snapshot_error: ${message}`,
            configRevision: runtime.effectiveRevision,
            at: Date.now(),
          });
          return await settleHuman(
            exec,
            agent,
            mode,
            sessionKind,
            trace,
            message,
            cwd,
            session,
            {
              effect,
              signals: null,
              snapshot: null,
              strategy,
              decisionRules: [],
              modelAttempts: [],
              ruleId:
                evaluation.path.kind === 'rule' ? evaluation.path.ruleId : null,
            },
          );
        }

        const count = runtime.reviewCounts.get(sessionId) ?? 0;
        runtime.reviewCounts.set(sessionId, count + 1);
        if (
          runtime.config.reviewBudget !== null &&
          count + 1 === runtime.config.reviewBudget
        ) {
          ctx.logger.warn(
            'arbiter: review budget (%s) reached for this session; reviews continue (the budget is advisory)',
            String(runtime.config.reviewBudget),
          );
        }
        let modelResult: Awaited<ReturnType<typeof runChatReviewer>>;
        if (runtime.config.reviewer.type === 'chat') {
          reviewTrace('start');
          modelResult = await runChatReviewer(
            {
              llm,
              session,
              chat: runtime.config.reviewer.chat,
              thresholds,
              signal: exec.signal,
            },
            snapshotBundle.snapshot,
            snapshotBundle,
            exec.callId,
          );
          reviewTrace(modelResult.ok ? 'settled' : 'failed');
        } else {
          modelResult = await runDecisionReviewer(
            {
              fetch: globalThis.fetch,
              credentials,
              decision: runtime.config.reviewer.decision,
              thresholds,
              signal: exec.signal,
            },
            snapshotBundle.snapshot,
            {
              user: snapshotBundle.user,
              estimatedInputTokens: snapshotBundle.estimatedInputTokens,
            },
            exec.callId,
          );
        }

        if (isAborted(exec.signal)) return { kind: 'cancel' };
        // The model response keeps its original protocol, but the policy that
        // forms the not-yet-made decision is the one effective now.
        const currentMode = modeForSession(runtime.config, sessionKind);
        const currentStrategy: StrategyName =
          currentMode === 'progress' ? 'progress' : 'normal';
        const currentThresholds =
          currentStrategy === 'progress'
            ? runtime.config.policy.progress
            : runtime.config.policy.normal;
        if (!modelResult.ok) {
          trace.push({
            stage: 'review',
            result: 'error-escalate',
            reason: modelResult.error,
            configRevision: runtime.effectiveRevision,
            at: Date.now(),
          });
          return await settleHuman(
            exec,
            agent,
            currentMode,
            sessionKind,
            trace,
            `review failed: ${modelResult.error}`,
            cwd,
            session,
            {
              effect,
              signals: null,
              snapshot: snapshotBundle.snapshot,
              strategy: currentStrategy,
              decisionRules: [],
              modelAttempts: modelResult.attempts,
              ruleId:
                evaluation.path.kind === 'rule' ? evaluation.path.ruleId : null,
            },
          );
        }

        const signals = reclassifySignals(
          applyProbeOverrides(
            modelResult.signals,
            evaluation.facts,
            runtime.config.policy.probeMode,
          ),
          currentThresholds,
        );
        const policy = decideReview(
          signals,
          currentStrategy,
          currentThresholds,
        );
        trace.push({
          stage: 'review',
          result: policy.verdict,
          reason: policy.reason,
          decisionRules: policy.decisionRules,
          configRevision: runtime.effectiveRevision,
          at: Date.now(),
        });
        const auditExtras = {
          effect,
          signals,
          snapshot: snapshotBundle.snapshot,
          strategy: currentStrategy,
          decisionRules: policy.decisionRules,
          modelAttempts: modelResult.attempts,
          ruleId:
            evaluation.path.kind === 'rule' ? evaluation.path.ruleId : null,
        };
        if (policy.verdict === 'review-allow') {
          finalize(
            exec,
            session,
            sessionKind,
            currentMode,
            trace,
            'review-allow',
            'Arbiter: the review allowed this call.',
            { ...auditExtras, cwd, approvalMode: currentMode },
          );
          return { kind: 'allow' };
        }
        if (policy.verdict === 'review-deny') {
          const text = `Not executed [review-deny]: ${modelReasonFor(policy)}.`;
          finalize(
            exec,
            session,
            sessionKind,
            currentMode,
            trace,
            'review-deny',
            text,
            {
              ...auditExtras,
              cwd,
              approvalMode: currentMode,
            },
          );
          return deny(text);
        }
        return await settleHuman(
          exec,
          agent,
          currentMode,
          sessionKind,
          trace,
          `review requires a human decision: ${modelReasonFor(policy)}`,
          cwd,
          session,
          { ...auditExtras },
        );
      } finally {
        runtime.active -= 1;
        releaseRuntime(runtime);
      }
    },
    { prepend: true },
  );

  ctx.on('tools/result', (exec: ToolExecutionLike, result: ToolResultLike) => {
    if (!runtime.pending.has(exec.callId)) return;
    runtime.pending.delete(exec.callId);
    currentAudit()?.updateExecution(
      exec.callId,
      result.isError === true ? 'failed' : 'success',
    );
  });

  ctx.on(
    'session/event',
    (
      session: TurnSessionLike,
      event: {
        readonly type?: string;
        readonly data?: unknown;
      },
    ) => {
      if (event.type === 'turn/start') {
        const id = session.id;
        if (id !== undefined) resetBreaker(id);
      }
      if (
        event.type === 'permission/preset' &&
        isRecord(event.data) &&
        typeof session.id === 'string'
      ) {
        // The user chose a host preset: this session is no longer managed, so
        // an unload must leave the chosen permission alone.
        managed.delete(session.id);
      }
      if (
        event.type === 'command/run' &&
        isRecord(event.data) &&
        event.data['name'] === 'permission'
      ) {
        const commandId = event.data['commandId'];
        if (typeof commandId === 'string') {
          permissionCommandsInFlight.set(commandId, session.id ?? 'unknown');
        }
        return;
      }
      if (event.type === 'command/done' && isRecord(event.data)) {
        const commandId = event.data['commandId'];
        if (typeof commandId === 'string') {
          const owner = permissionCommandsInFlight.get(commandId);
          permissionCommandsInFlight.delete(commandId);
          // A failed `/permission auto` never exited arbiter: report it and
          // leave the session state exactly as it was.
          if (
            owner !== undefined &&
            event.data['kind'] === 'error' &&
            typeof event.data['text'] === 'string' &&
            event.data['text'].includes(AUTO_REJECTION_HINT)
          ) {
            runtime.autoRejections.push({ at: Date.now(), sessionId: owner });
          }
        }
      }
    },
  );

  // Custom rule tester/status command. Headless profiles have no command
  // adapter, so registration is optional.
  if (commands !== undefined) {
    try {
      commands.register({
        name: 'arbiter',
        description: 'dsh-arbiter status and rule test',
        input: { hint: 'status | test <command>' },
        handler: ({ rawInput }) => {
          const trimmed = rawInput.trim();
          if (trimmed.startsWith('test')) {
            const input = trimmed.slice('test'.length).trim();
            if (input.length === 0) {
              return {
                kind: 'error' as const,
                text: 'usage: /arbiter test <command>',
              };
            }
            const result = testRules(input, runtime.config.rules, {
              identity: 'main',
              workspaceRoot: process.cwd(),
              cwd: process.cwd(),
            });
            return {
              kind: 'success' as const,
              text: `${result.path}${result.rule === null ? '' : ` (${result.rule.id})`}`,
            };
          }
          if (trimmed.startsWith('mode')) {
            const target = trimmed.slice('mode'.length).trim();
            if (target !== 'trusted' && target !== 'guarded') {
              return {
                kind: 'error' as const,
                text: 'usage: /arbiter mode trusted|guarded',
              };
            }
            // The old entry applied the host's `auto` preset for trusted,
            // which is now rejected. Report the removal instead of silently
            // writing a permission the user did not ask for.
            if (target === 'trusted') {
              return {
                kind: 'error' as const,
                text: [
                  'arbiter: /arbiter mode trusted was removed.',
                  'trusted / guarded are chosen on the arbiter config page and applied through the session permission menu entry "自动审查（Arbiter）".',
                  'The native auto preset is not supported by Arbiter.',
                ].join('\n'),
              };
            }
            return {
              kind: 'error' as const,
              text: [
                'arbiter: /arbiter mode was removed.',
                'trusted / guarded are chosen on the arbiter config page and applied through the session permission menu entry "自动审查（Arbiter）".',
              ].join('\n'),
            };
          }
          const main = runtime.config.modes.main;
          const sub = runtime.config.modes.subagent;
          return {
            kind: 'success' as const,
            text: [
              `arbiter ${runtime.config.enabled ? 'enabled' : 'disabled'} · revision ${runtime.effectiveRevision}`,
              `main=${main} subagent=${sub} execution=${executionModeName(ctx)}`,
              `rules=${String(runtime.config.rules.length)} reviewer=${runtime.config.reviewer.type}`,
              `audit=${audit === null ? 'unavailable' : audit.health().state}`,
              ...(invalidConfigError === null
                ? []
                : [`config error: ${invalidConfigError}`]),
            ].join('\n'),
          };
        },
      });
    } catch (error) {
      ctx.logger.warn('arbiter: command registration skipped: %s', error);
    }
  }

  // Native `/permission auto` is not a supported entry while arbiter is the
  // approval provider. `apply()` runs this admission callback before it writes
  // any preset or knob, so throwing here keeps the previous enabled state,
  // sandbox and approval policy untouched.
  //
  // A stored `auto` identity is admitted during session publication instead:
  // `pinInitialPermission()` calls the same callback when it restores a log
  // that already ends at `auto`. Refusing that would roll the session load
  // back, so a restore in progress is allowed through and reported.
  if (presets?.registerAuto !== undefined) {
    try {
      ctx.effect(
        () =>
          presets.registerAuto?.(() => {
            // Outside the plugin's approval scope, leave the host's own auto
            // entry alone.
            if (!runtime.config.enabled) return;
            // A `/permission` command is being handled right now: this is a
            // user switch, so reject it before any preset or knob is written.
            if (permissionCommandsInFlight.size > 0) {
              throw new AutoEntryRejected();
            }
            // No command is open: the host is publishing a stored `auto`
            // identity. Refusing here would roll the session load back.
            runtime.legacyAutoRestores.push({ at: Date.now() });
            ctx.logger.warn(
              'arbiter: session restored with a stored "auto" identity; the native auto entry stays rejected for new switches',
            );
          }),
        'arbiter preset',
      );
    } catch (error) {
      runtime.autoPresetError =
        error instanceof Error ? error.message : String(error);
      ctx.logger.warn(
        'arbiter: auto preset registration failed: %s',
        runtime.autoPresetError,
      );
    }
  }

  const fileRevision = (): string | null => {
    if (configEditor === undefined) return null;
    try {
      return stableHash(readFileSync(configEditor.documentPath, 'utf8'));
    } catch {
      return null;
    }
  };

  const arbiterEntry = (): ConfigEditorEntryLike | undefined =>
    configEditor?.entries().find((entry) => entry.options.id === name);

  const statePayload = (): unknown => {
    const entry = arbiterEntry();
    return {
      name,
      enabled: runtime.config.enabled,
      autoEntry: {
        rejected: true,
        rejections: runtime.autoRejections.length,
        legacyAutoRestores: runtime.legacyAutoRestores.length,
        registrationError: runtime.autoPresetError,
      },
      sessionRecords: {
        ready: sessionRecordReady(),
        error: sessionRecordError(),
        failures: [...runtime.sessionRecordErrors.entries()],
      },
      config: runtime.config,
      sourceConfig: entry?.options.config ?? null,
      effectiveRevision: runtime.effectiveRevision,
      configSnapshotId: runtime.configSnapshotId,
      fileRevision: fileRevision(),
      documentPath: configEditor?.documentPath ?? null,
      invalidConfigError: runtime.invalidConfigError,
      loadErrors: runtime.loadErrors,
      warnings: runtime.warnings,
      autoPresetError: runtime.autoPresetError,
      configHistory: audit?.configHistory(20) ?? [],
      audit: {
        health: audit?.health() ?? {
          state: 'unavailable',
          lastError: runtime.auditError,
          dropped: 0,
          pending: 0,
        },
        path: audit?.databasePath ?? null,
        bytes: audit?.databaseBytes ?? 0,
        stats: audit?.stats() ?? null,
      },
      coverage: {
        gated: [
          'native tools (bash, read, write, web, terminal, ...)',
          'MCP tools before the RPC is sent',
          'outer run_code call',
          'run_code -> tools.* inner calls',
          'in-process subagent tool calls',
        ],
        notGated: [
          'direct Node fs/fetch/child_process effects inside run_code',
          'workflow internal orchestration steps',
          'MCP server internals after the RPC',
          'processes started by bash after the bash call was allowed',
        ],
      },
      policyVersion: runtime.config.policy.version,
      modes: runtime.config.modes,
      executionMode: executionModeName(ctx),
      reviewerType: runtime.config.reviewer.type,
      sessionRecordErrors: [...runtime.sessionRecordErrors.entries()].slice(
        -20,
      ),
    };
  };

  ctx.inject(['connection'], (registrationContext) => {
    const connection = registrationContext.get('connection');
    if (connection === undefined) return;
    const routes: FetchRouteLike[] = [
      {
        path: `${ROUTE_BASE}/state`,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: () => Promise.resolve(jsonResponse(statePayload())),
      },
      {
        path: `${ROUTE_BASE}/config/save`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          if (configEditor === undefined) {
            return jsonResponse(
              {
                ok: false,
                code: 'config-readonly',
                message: 'config editor is unavailable',
              },
              409,
            );
          }
          const entry = arbiterEntry();
          if (entry === undefined) {
            return jsonResponse(
              {
                ok: false,
                code: 'config-entry-missing',
                message: 'profile entry "arbiter" is not addressable',
              },
              409,
            );
          }
          let body: unknown;
          try {
            body = await readJsonBody(request);
          } catch (error) {
            return jsonResponse(
              { ok: false, code: 'bad-request', message: String(error) },
              400,
            );
          }
          if (!isRecord(body) || typeof body['revision'] !== 'string') {
            return jsonResponse(
              {
                ok: false,
                code: 'bad-request',
                message: 'revision is required',
              },
              400,
            );
          }
          const currentFileRevision = fileRevision();
          if (
            currentFileRevision !== null &&
            body['revision'] !== currentFileRevision
          ) {
            return jsonResponse(
              {
                ok: false,
                code: 'config-conflict',
                message: 'the profile patch changed after this draft was read',
                fileRevision: currentFileRevision,
              },
              409,
            );
          }
          const candidate = parseConfig(body['config']);
          if (candidate.errors.length > 0) {
            return jsonResponse(
              {
                ok: false,
                code: 'config-invalid',
                errors: candidate.errors,
                warnings: candidate.warnings,
              },
              422,
            );
          }
          try {
            await configEditor.edit(entry, () => candidate.config);
          } catch (error) {
            return jsonResponse(
              {
                ok: false,
                code: 'config-rejected',
                message: error instanceof Error ? error.message : String(error),
              },
              422,
            );
          }
          return jsonResponse({
            ok: true,
            fileRevision: fileRevision(),
            warnings: candidate.warnings,
          });
        },
      },
      {
        path: `${ROUTE_BASE}/validate`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let body: unknown;
          try {
            body = await readJsonBody(request);
          } catch (error) {
            return jsonResponse(
              { ok: false, code: 'bad-request', message: String(error) },
              400,
            );
          }
          const candidate = parseConfig(
            isRecord(body) ? body['config'] : undefined,
          );
          return jsonResponse({
            ok: candidate.errors.length === 0,
            errors: candidate.errors,
            warnings: candidate.warnings,
          });
        },
      },
      {
        path: `${ROUTE_BASE}/credentials`,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
          const ref = runtime.config.reviewer.decision.apiKeyRef;
          if (credentials === undefined) {
            return jsonResponse({
              ok: true,
              ref,
              configured: false,
              source: null,
              supported: false,
            });
          }
          try {
            const info = await credentials.describe?.(ref);
            return jsonResponse({
              ok: true,
              ref,
              configured: info?.configured ?? false,
              source: info?.source ?? null,
              supported: true,
            });
          } catch (error) {
            return jsonResponse({
              ok: false,
              ref,
              configured: false,
              source: null,
              supported: true,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        },
      },
      {
        path: `${ROUTE_BASE}/test`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let body: unknown;
          try {
            body = await readJsonBody(request);
          } catch (error) {
            return jsonResponse(
              { ok: false, code: 'bad-request', message: String(error) },
              400,
            );
          }
          if (!isRecord(body) || !Array.isArray(body['inputs'])) {
            return jsonResponse(
              {
                ok: false,
                code: 'bad-request',
                message: 'inputs must be an array',
              },
              400,
            );
          }
          const rules = Array.isArray(body['rules'])
            ? body['rules'].flatMap((value) => {
                const rule = asRule(value);
                return rule === null ? [] : [rule];
              })
            : runtime.config.rules;
          const cwd =
            typeof body['cwd'] === 'string' ? body['cwd'] : process.cwd();
          const results = body['inputs']
            .filter((input): input is string => typeof input === 'string')
            .map((input) =>
              testRules(input, rules, {
                identity: 'main',
                workspaceRoot: cwd,
                cwd,
              }),
            );
          return jsonResponse({ ok: true, results });
        },
      },
      {
        path: `${ROUTE_BASE}/logs`,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: (request) => {
          if (audit === null) {
            return Promise.resolve(
              jsonResponse({
                ok: false,
                code: 'audit-unavailable',
                rows: [],
                total: 0,
                health: {
                  state: 'unavailable',
                  lastError: runtime.auditError,
                  dropped: 0,
                  pending: 0,
                },
              }),
            );
          }
          const url = new URL(request.url);
          const from = url.searchParams.get('from');
          const to = url.searchParams.get('to');
          return Promise.resolve(
            jsonResponse({
              ok: true,
              ...audit.listCalls({
                limit: Number(url.searchParams.get('limit') ?? '100'),
                offset: Number(url.searchParams.get('offset') ?? '0'),
                ...(url.searchParams.get('result') === null
                  ? {}
                  : { result: url.searchParams.get('result') ?? '' }),
                ...(url.searchParams.get('tool') === null
                  ? {}
                  : { tool: url.searchParams.get('tool') ?? '' }),
                ...(url.searchParams.get('session') === null
                  ? {}
                  : { sessionId: url.searchParams.get('session') ?? '' }),
                ...(url.searchParams.get('q') === null
                  ? {}
                  : { query: url.searchParams.get('q') ?? '' }),
                ...(from === null ? {} : { from: Number(from) }),
                ...(to === null ? {} : { to: Number(to) }),
              }),
            }),
          );
        },
      },
      {
        path: `${ROUTE_BASE}/log`,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: (request) => {
          const callId = new URL(request.url).searchParams.get('callId') ?? '';
          if (audit === null) {
            return Promise.resolve(
              jsonResponse({ ok: false, code: 'audit-unavailable' }, 404),
            );
          }
          const record = audit.getCall(callId);
          return Promise.resolve(
            record === null
              ? jsonResponse({ ok: false, code: 'not-found' }, 404)
              : jsonResponse({ ok: true, record }),
          );
        },
      },
      {
        path: `${ROUTE_BASE}/suggestions`,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: () =>
          Promise.resolve(
            jsonResponse({
              ok: true,
              candidates: audit?.listCandidates() ?? [],
              health: audit?.health() ?? { state: 'unavailable' },
            }),
          ),
      },
      {
        path: `${ROUTE_BASE}/analyze`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          if (audit === null)
            return jsonResponse({ ok: false, code: 'audit-unavailable' }, 409);
          const body: unknown = await readJsonBody(request).catch(() => ({}));
          const windowDays =
            isRecord(body) && typeof body['windowDays'] === 'number'
              ? body['windowDays']
              : 30;
          const minOccurrences =
            isRecord(body) && typeof body['minOccurrences'] === 'number'
              ? body['minOccurrences']
              : 3;
          const windowEnd = Date.now();
          const windowStart =
            windowEnd - Math.max(1, windowDays) * 24 * 60 * 60 * 1_000;
          const proposals = generateCandidates(audit, {
            windowStart,
            windowEnd,
            minOccurrences: Math.max(2, minOccurrences),
            maxCandidates: 20,
          });
          const created = persistCandidates(
            audit,
            proposals,
            windowStart,
            windowEnd,
          );
          return jsonResponse({ ok: true, proposals, created });
        },
      },
      {
        path: `${ROUTE_BASE}/suggestions/act`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const store = currentAudit();
          if (store === null)
            return jsonResponse({ ok: false, code: 'audit-unavailable' }, 409);
          let body: unknown;
          try {
            body = await readJsonBody(request);
          } catch (error) {
            return jsonResponse(
              { ok: false, code: 'bad-request', message: String(error) },
              400,
            );
          }
          if (!isRecord(body) || typeof body['candidateId'] !== 'string') {
            return jsonResponse({ ok: false, code: 'bad-request' }, 400);
          }
          const candidateId = body['candidateId'];
          const candidate = store
            .listCandidates()
            .find((item) => item.candidateId === candidateId);
          if (candidate === undefined)
            return jsonResponse({ ok: false, code: 'not-found' }, 404);
          if (body['action'] === 'reject') {
            store.updateCandidateStatus(
              candidateId,
              'rejected',
              typeof body['note'] === 'string' ? body['note'] : null,
            );
            return jsonResponse({ ok: true, status: 'rejected' });
          }
          if (body['action'] !== 'accept') {
            return jsonResponse(
              {
                ok: false,
                code: 'bad-request',
                message: 'action must be accept or reject',
              },
              400,
            );
          }
          const rule = asRule(body['rule'] ?? candidate.rule);
          if (rule === null)
            return jsonResponse({ ok: false, code: 'rule-invalid' }, 422);
          if (configEditor === undefined)
            return jsonResponse({ ok: false, code: 'config-readonly' }, 409);
          const entry = arbiterEntry();
          if (entry === undefined)
            return jsonResponse(
              { ok: false, code: 'config-entry-missing' },
              409,
            );

          // Idempotency: a previous attempt can have applied the config and
          // then lost the candidate-status write during Loader reconciliation.
          if (
            runtime.config.rules.some((existing) => existing.id === rule.id)
          ) {
            try {
              currentAudit()?.updateCandidateStatus(
                candidateId,
                'accepted',
                null,
              );
            } catch {
              // The rule is already effective; report the durable config state.
            }
            return jsonResponse({
              ok: true,
              status: 'accepted',
              rule,
              alreadyApplied: true,
            });
          }

          const next: ArbiterConfig = {
            ...runtime.config,
            rules: [...runtime.config.rules, rule],
          };
          const validated = parseConfig(next);
          if (validated.errors.length > 0) {
            return jsonResponse(
              { ok: false, code: 'config-invalid', errors: validated.errors },
              422,
            );
          }
          try {
            await configEditor.edit(entry, (current) => {
              const currentConfig = parseConfig(current).config;
              if (
                currentConfig.rules.some((existing) => existing.id === rule.id)
              ) {
                throw new Error(`rule "${rule.id}" already exists`);
              }
              return {
                ...currentConfig,
                rules: [...currentConfig.rules, rule],
              };
            });
          } catch (error) {
            return jsonResponse(
              {
                ok: false,
                code: 'config-rejected',
                message: error instanceof Error ? error.message : String(error),
              },
              422,
            );
          }

          // The config is effective now. Candidate status is an audit-side
          // settlement; failing to write it must not turn a successful apply
          // into a reported failure. A retry finds the rule and settles it.
          let warning: string | null = null;
          try {
            const settled = currentAudit();
            if (settled === null)
              throw new Error('audit storage is unavailable');
            settled.updateCandidateStatus(candidateId, 'accepted', null);
          } catch (error) {
            warning = `rule applied, candidate status not persisted: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
          return jsonResponse({
            ok: true,
            status: 'accepted',
            rule,
            ...(warning === null ? {} : { warning }),
          });
        },
      },
      {
        path: `${ROUTE_BASE}/replay`,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: () => {
          if (audit === null) {
            return Promise.resolve(
              jsonResponse({ ok: false, code: 'audit-unavailable' }, 409),
            );
          }
          return Promise.resolve(
            jsonResponse({
              ok: true,
              ...replayPolicy(
                audit,
                runtime.config.policy.normal,
                runtime.config.policy.progress,
              ),
            }),
          );
        },
      },
      {
        path: `${ROUTE_BASE}/clear`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: () => {
          if (audit === null) {
            return Promise.resolve(
              jsonResponse({ ok: false, code: 'audit-unavailable' }, 409),
            );
          }
          return Promise.resolve(
            jsonResponse({ ok: true, deleted: audit.clearCalls() }),
          );
        },
      },
    ];
    ctx.effect(() => {
      const disposers = routes.map((route) => connection.fetch.register(route));
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'arbiter routes');
  });

  ctx.logger.info(
    'arbiter: enabled=%s revision=%s rules=%s reviewer=%s audit=%s',
    String(runtime.config.enabled),
    runtime.effectiveRevision,
    String(runtime.config.rules.length),
    runtime.config.reviewer.type,
    audit === null ? 'unavailable' : 'ready',
  );
}
