import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AuditStore, resolveAuditPath } from '../audit.js';
import {
  configHash,
  DEFAULT_CONFIG,
  parseConfig,
  parseDocument,
  stableHash,
} from '../config.js';
import { CONFIG_FORMAT_V2 } from '../config/format.js';
import { isRecord } from '../config/values.js';
import { loadSessionRecordApi, sessionRecordError } from '../records.js';
import type { ArbiterConfig } from '../types.js';
import type {
  ContextLike,
  RuntimeState,
  HostEnvironment,
  HostServices,
} from './types.js';

const RUNTIMES = new Map<string, RuntimeState>();

/** Which entry asked for one applied configuration. */
export type ConfigApplySource = 'startup' | 'file' | 'ui';

export interface ConfigActivation {
  /** False when the effective content is unchanged: no new activation row. */
  readonly changed: boolean;
  /** Identity of the content that is now in effect. */
  readonly revision: string;
  readonly snapshotId: string;
  /** True only when a new activation row was written. */
  readonly recorded: boolean;
  /** Audit failure, which never prevents the configuration from taking effect. */
  readonly auditError: string | null;
}

/**
 * A UI save can make the host reload the plugin before `save()` returns, so the
 * reload must be attributed to the UI rather than to a file change. The marker
 * therefore carries the exact normalized content of that save: only a reload of
 * that candidate may consume it, and an unrelated external reload stays `file`.
 */
const UI_APPLY_WINDOW_MS = 30_000;

export function markUiApply(
  runtime: RuntimeState,
  candidate: ArbiterConfig,
): void {
  runtime.pendingApplySource = {
    at: Date.now(),
    content: JSON.stringify(candidate),
  };
}

export function clearUiApply(runtime: RuntimeState): void {
  runtime.pendingApplySource = null;
}

function consumeApplySource(
  runtime: RuntimeState,
  candidate: ArbiterConfig,
): ConfigApplySource {
  const pending = runtime.pendingApplySource;
  const fresh =
    pending !== null && Date.now() - pending.at <= UI_APPLY_WINDOW_MS;
  // A marker only answers for its own content: an unrelated reload stays
  // `file` and must not consume a save that has not been reloaded yet.
  const matched = fresh && pending.content === JSON.stringify(candidate);
  if (matched || !fresh) runtime.pendingApplySource = null;
  if (matched) return 'ui';
  // The first application in a profile is the startup load. Later ones come
  // from an external document change, including a reload after an unload that
  // temporarily dropped the instance count to zero.
  return runtime.configApplications === 0 ? 'startup' : 'file';
}

/**
 * Tell the runtime's own consumers that a new configuration is in effect.
 *
 * A listener failure is logged and contained: the configuration already
 * committed, and a consumer that could not follow it must not roll it back.
 */
function notifyConfigListeners(
  runtime: RuntimeState,
  config: ArbiterConfig,
): void {
  for (const listener of runtime.configListeners) {
    try {
      listener(config);
    } catch (error) {
      console.warn(
        'arbiter: configuration listener failed: %s',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

export function releaseRuntime(runtime: RuntimeState): void {
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

/**
 * The per-profile continuity copy. It is a fallback only: the profile patch
 * stays the single editable source, and a deleted copy is not an error.
 */
export function lastGoodPath(
  home: string,
  scope: { readonly key: string },
): string {
  return join(home, 'arbiter', 'last-good', `${scope.key}.json`);
}

/**
 * The recovery copy's wrapper.
 *
 * The effective configuration always holds canonical rules, even when the profile
 * document used the legacy format, so the copy is validated as the canonical
 * format. The wrapper also remembers the declaration the running configuration
 * actually had — absent, `arbiter-config-v1`, or `arbiter-config-v2` — because
 * that declaration is part of the configuration's content identity: dropping it
 * or forcing v2 would change the hash, the reported format and whether the format
 * counts as explicit.
 */
interface LastGoodDocument {
  readonly format: typeof CONFIG_FORMAT_V2;
  /** `true` when the running configuration declared a format at all. */
  readonly sourceFormatExplicit: boolean;
  readonly sourceFormat: string | null;
  readonly config: ArbiterConfig;
}

function readLastGood(path: string): ArbiterConfig | null {
  try {
    const text = readFileSync(path, 'utf8');
    const stored: unknown = JSON.parse(text);
    if (!isRecord(stored) || !isRecord(stored['config'])) return null;
    const parsed = parseConfig({
      ...stored['config'],
      format: CONFIG_FORMAT_V2,
    });
    if (parsed.errors.length > 0) return null;
    const sourceFormat = stored['sourceFormat'];
    const sourceFormatExplicit = stored['sourceFormatExplicit'] === true;
    const { format: _canonical, ...effective } = parsed.config;
    // Restore exactly the declaration the configuration ran with.
    if (!sourceFormatExplicit) return effective;
    return typeof sourceFormat === 'string'
      ? { ...effective, format: sourceFormat }
      : effective;
  } catch {
    return null;
  }
}

/** Persist the recovery copy with its original format identity preserved. */
function writeLastGood(path: string, config: ArbiterConfig): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const document: LastGoodDocument = {
      format: CONFIG_FORMAT_V2,
      sourceFormatExplicit: config.format !== undefined,
      sourceFormat: config.format ?? null,
      config,
    };
    writeFileSync(path, JSON.stringify(document, null, 2), 'utf8');
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
 * runtime state. Audit storage stays shared per DSH data instance; approval
 * policy must not leak between profiles in the same home.
 */
export function profileScope(ctx: ContextLike): {
  readonly name: string;
  readonly key: string;
} {
  const profile = ctx.get('profileContext');
  const name = profile?.name ?? 'default';
  const identity = profile?.dir ?? `${profileHome(ctx)}/${name}`;
  return { name, key: `${name}-${stableHash(identity).slice(0, 8)}` };
}

function sameContent(left: ArbiterConfig, right: ArbiterConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Apply one validated configuration and record the activation.
 *
 * Content identity decides everything: identical content reuses the snapshot and
 * adds no activation row for a later reload, while every real switch (including
 * restoring an old document) reuses or creates the matching snapshot and writes
 * one activation row for the entry that applied it. The very first application
 * of a profile records its activation even when it is the unchanged default.
 * Audit failures are reported and never block activation.
 */
/** Record the applied content and its activation, or explain why it is missing. */
function persistActivation(
  host: HostEnvironment,
  audit: AuditStore,
  candidate: ArbiterConfig,
  source: ConfigApplySource,
  record: boolean,
): { readonly snapshotId: string; readonly revision: string } | null {
  const { runtime } = host;
  const snapshot = audit.saveConfigSnapshot(candidate);
  if (snapshot === null) {
    runtime.historyIncomplete = true;
    runtime.auditError = audit.health().lastError;
    return null;
  }
  if (!record) return snapshot;
  if (
    !audit.recordActivation(
      snapshot.snapshotId,
      snapshot.revision,
      source,
      'profile',
    )
  ) {
    runtime.historyIncomplete = true;
    runtime.auditError = audit.health().lastError;
    host.ctx.logger.error(
      'arbiter: activation record failed: %s',
      runtime.auditError,
    );
    return null;
  }
  // Counters move only after the row was actually inserted.
  runtime.configActivations += 1;
  return snapshot;
}

export function applyConfig(
  host: HostEnvironment,
  candidate: ArbiterConfig,
  source: ConfigApplySource,
): ConfigActivation {
  const { runtime, ctx } = host;
  const previous = runtime.config;
  const changed = !sameContent(previous, candidate);
  const firstApplication = runtime.configApplications === 0;
  runtime.configApplications += 1;
  const revision = configHash(candidate);
  // The effective configuration commits only here, after validation succeeded
  // and after the host accepted the document.
  runtime.config = candidate;
  notifyConfigListeners(runtime, candidate);
  // Continuity data follows the committed configuration, never the candidate
  // that was merely parsed: a later application failure must not leave a
  // recovery copy the runtime never actually ran. The first accepted document
  // also seeds it, so a cold restart can recover it even without a change.
  if (changed || firstApplication)
    writeLastGood(lastGoodPath(profileHome(ctx), profileScope(ctx)), candidate);
  runtime.configFormat = candidate.format ?? 'arbiter-config-v1';
  runtime.configFormatExplicit = candidate.format !== undefined;
  const audit = ensureAudit(runtime, profileHome(ctx), ctx);
  const record = changed || runtime.configSnapshotId === 'cfg-unavailable';
  if (audit === null) {
    runtime.effectiveRevision = revision;
    // Without audit storage there is no verifiable snapshot for this content.
    runtime.configSnapshotId = 'cfg-unavailable';
    if (record) runtime.historyIncomplete = true;
    return {
      changed,
      revision,
      snapshotId: runtime.configSnapshotId,
      recorded: false,
      auditError: runtime.auditError,
    };
  }
  // The store contains its own failures, so a null result means "not
  // persisted" rather than an exception escaping into configuration apply.
  const snapshot = persistActivation(host, audit, candidate, source, record);
  if (snapshot === null) {
    runtime.effectiveRevision = revision;
    // The retained id belongs to previous content, so it must not be reported
    // as the identity of what now runs.
    runtime.configSnapshotId = 'cfg-unavailable';
    return {
      changed,
      revision,
      snapshotId: runtime.configSnapshotId,
      recorded: false,
      auditError: runtime.auditError,
    };
  }
  // The snapshot becomes this content's identity only after it was persisted.
  runtime.configSnapshotId = snapshot.snapshotId;
  runtime.effectiveRevision = snapshot.revision;
  runtime.auditError = null;
  // Retention is housekeeping after the metadata is committed: a cleanup
  // failure must not revoke a snapshot and activation that were persisted.
  try {
    audit.runRetention();
  } catch (error) {
    // Cleanup failed but the history itself is complete: log it as a cleanup
    // problem instead of reporting the activation as unrecorded.
    ctx.logger.warn(
      'arbiter: audit retention failed after activation: %s',
      error instanceof Error ? error.message : String(error),
    );
  }
  return {
    changed,
    revision: snapshot.revision,
    snapshotId: snapshot.snapshotId,
    recorded: record,
    auditError: null,
  };
}

/** Parse and select the document in effect, keeping the current one when invalid. */
function selectConfig(
  ctx: ContextLike,
  rawConfig: unknown,
  runtime: RuntimeState | undefined,
) {
  const home = profileHome(ctx);
  const scope = profileScope(ctx);
  const parsed = parseDocument(rawConfig);
  let config = parsed.config;
  let invalidConfigError: string | null = null;
  if (parsed.errors.length > 0) {
    // Developer-facing continuity detail; the UI renders the structured
    // `loadErrors` through the locale so no English sentence becomes UI copy.
    invalidConfigError = parsed.errors
      .map((error) => `${error.path}: ${error.message}`)
      .join('; ');
    // Keep the configuration already in effect, then this profile's previous
    // document, and only then the confirmed defaults.
    config =
      runtime?.config ??
      readLastGood(lastGoodPath(home, scope)) ??
      DEFAULT_CONFIG;
    ctx.logger.error(
      'arbiter: configuration is invalid; using the last effective configuration: %s',
      invalidConfigError,
    );
  }
  return { home, config, invalidConfigError, parsed };
}

function acquireRuntime(
  scopeKey: string,
  config: ArbiterConfig,
  invalidConfigError: string | null,
  loadErrors: RuntimeState['loadErrors'],
  warnings: RuntimeState['warnings'],
): RuntimeState {
  const existing = RUNTIMES.get(scopeKey);
  const runtime: RuntimeState = existing ?? {
    config,
    effectiveRevision: configHash(config),
    configSnapshotId: 'cfg-unavailable',
    configFormat: config.format ?? 'arbiter-config-v1',
    configFormatExplicit: config.format !== undefined,
    pendingApplySource: null,
    configActivations: 0,
    configApplications: 0,
    historyIncomplete: false,
    invalidConfigError,
    loadErrors: loadErrors,
    warnings: warnings,
    audit: null,
    auditError: null,
    autoPresetError: null,
    priorVerdicts: new Map(),
    historyStatus: new Map(),
    historyReset: new Map(),
    historyRecovered: new Map(),
    sessionRecordFailures: new Map(),
    historyBoundaryAmbiguity: new Map(),
    breakers: new Map(),
    reviewCounts: new Map(),
    sessionRecordErrors: new Map(),
    legacyAutoRestores: [],
    autoRejections: [],
    pending: new Map(),
    instances: 0,
    active: 0,
    accepting: true,
    configListeners: new Set(),
  };
  if (existing === undefined) RUNTIMES.set(scopeKey, runtime);
  runtime.invalidConfigError = invalidConfigError;
  runtime.loadErrors = loadErrors;
  runtime.warnings = warnings;
  runtime.autoPresetError = null;
  runtime.accepting = true;
  runtime.instances += 1;
  return runtime;
}

function traceLifecycle(): HostEnvironment['lifecycle'] {
  const tracePath = process.env['ARBITER_TRACE_PATH'];
  return (event, data = {}) => {
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
}

function connectServices(ctx: ContextLike): HostServices {
  const services: HostServices = {
    sessions: ctx.get('sessions'),
    llm: ctx.get('llm'),
    approval: ctx.get('approval'),
    presets: ctx.get('permissionPresets'),
    workingDirectory: ctx.get('workingDirectory'),
    credentials: ctx.get('credentials'),
    configEditor: ctx.get('configEditor'),
    commands: ctx.get('commands'),
  };
  ctx.inject(['credentials'], (child) => {
    services.credentials = child.get('credentials');
  });
  ctx.inject(['configEditor'], (child) => {
    services.configEditor = child.get('configEditor');
  });
  ctx.inject(['commands'], (child) => {
    services.commands = child.get('commands');
  });
  return services;
}

function maintainRuntime(host: HostEnvironment, home: string): void {
  const { ctx, runtime } = host;
  const retentionTimer = setInterval(
    () => {
      ensureAudit(runtime, home, ctx)?.runRetention();
    },
    60 * 60 * 1000,
  );
  retentionTimer.unref();
  ctx.effect(
    () => () => {
      clearInterval(retentionTimer);
    },
    'arbiter retention',
  );
  loadSessionRecordApi()
    .then((api) => {
      if (api !== null) return;
      runtime.sessionRecordErrors.set(
        'startup',
        sessionRecordError() ?? 'session record API unavailable',
      );
      ctx.logger.warn(
        'arbiter: session records disabled: %s',
        sessionRecordError(),
      );
    })
    .catch(() => undefined);
}

export function initializeHost(
  ctx: ContextLike,
  rawConfig: unknown,
): HostEnvironment {
  const scope = profileScope(ctx);
  const previous = RUNTIMES.get(scope.key);
  const { home, config, invalidConfigError, parsed } = selectConfig(
    ctx,
    rawConfig,
    previous,
  );
  const runtime = acquireRuntime(
    scope.key,
    config,
    invalidConfigError,
    parsed.errors,
    parsed.warnings,
  );
  const host: HostEnvironment = {
    ctx,
    runtime,
    audit: ensureAudit(runtime, home, ctx),
    currentAudit: () =>
      runtime.config.audit.enabled ? ensureAudit(runtime, home, ctx) : null,
    services: connectServices(ctx),
    lifecycle: traceLifecycle(),
  };
  // An invalid document never replaces the configuration in effect: the
  // selected fallback equals the current content, so no activation is recorded.
  applyConfig(host, config, consumeApplySource(runtime, config));
  maintainRuntime(host, home);
  return host;
}
