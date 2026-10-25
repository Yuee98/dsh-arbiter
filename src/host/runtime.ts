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
 * A UI save can make the host reload the plugin before `save()` returns. This
 * marker keeps that reload attributed to the UI instead of a file change.
 */
const UI_APPLY_WINDOW_MS = 30_000;

export function markUiApply(runtime: RuntimeState): void {
  runtime.pendingApplySource = Date.now();
}

export function clearUiApply(runtime: RuntimeState): void {
  runtime.pendingApplySource = null;
}

function consumeApplySource(runtime: RuntimeState): ConfigApplySource {
  const pending = runtime.pendingApplySource;
  runtime.pendingApplySource = null;
  if (pending !== null && Date.now() - pending <= UI_APPLY_WINDOW_MS)
    return 'ui';
  // The first application in a profile is the startup load. Later ones come
  // from an external document change, including a reload after an unload that
  // temporarily dropped the instance count to zero.
  return runtime.configApplications === 0 ? 'startup' : 'file';
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
export function applyConfig(
  host: HostEnvironment,
  candidate: ArbiterConfig,
  source: ConfigApplySource,
): ConfigActivation {
  const { runtime, ctx } = host;
  const previous = runtime.config;
  const changed = !sameContent(previous, candidate);
  const firstActivation = runtime.configSnapshotId === 'cfg-unavailable';
  runtime.configApplications += 1;
  const revision = configHash(candidate);
  // The effective configuration commits only here, after validation succeeded
  // and after the host accepted the document.
  runtime.config = candidate;
  // Continuity data follows the committed configuration, never the candidate
  // that was merely parsed: a later application failure must not leave a
  // recovery copy the runtime never actually ran.
  if (changed)
    writeLastGood(lastGoodPath(profileHome(ctx), profileScope(ctx)), candidate);
  runtime.configFormat = candidate.format ?? 'arbiter-config-v1';
  runtime.configFormatExplicit = candidate.format !== undefined;
  const audit = ensureAudit(runtime, profileHome(ctx), ctx);
  if (audit === null) {
    runtime.effectiveRevision = revision;
    // Without audit storage there is no verifiable snapshot: report the
    // unavailable identity rather than the previous document's snapshot.
    if (changed) runtime.configSnapshotId = 'cfg-unavailable';
    return {
      changed,
      revision,
      snapshotId: runtime.configSnapshotId,
      recorded: false,
      auditError: runtime.auditError,
    };
  }
  try {
    const snapshot = audit.saveConfigSnapshot(candidate);
    const record = changed || firstActivation;
    if (record) {
      // `entry` names the entry that applied the configuration; `scope` keeps
      // describing the owning profile layer.
      runtime.configActivations += 1;
      audit.recordActivation(
        snapshot.snapshotId,
        snapshot.revision,
        source,
        'profile',
      );
    }
    runtime.configSnapshotId = snapshot.snapshotId;
    runtime.effectiveRevision = snapshot.revision;
    audit.runRetention();
    runtime.auditError = null;
    return {
      changed,
      revision: snapshot.revision,
      snapshotId: snapshot.snapshotId,
      recorded: record,
      auditError: null,
    };
  } catch (error) {
    runtime.auditError = error instanceof Error ? error.message : String(error);
    runtime.effectiveRevision = revision;
    ctx.logger.error('arbiter: audit snapshot failed: %s', runtime.auditError);
    return {
      changed,
      revision,
      snapshotId: runtime.configSnapshotId,
      recorded: false,
      auditError: runtime.auditError,
    };
  }
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
    invalidConfigError,
    loadErrors: loadErrors,
    warnings: warnings,
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
  applyConfig(host, config, consumeApplySource(runtime));
  maintainRuntime(host, home);
  return host;
}
