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

function selectConfig(ctx: ContextLike, rawConfig: unknown) {
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

  return { home, scope, config, invalidConfigError, parsed };
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
  runtime.config = config;
  runtime.invalidConfigError = invalidConfigError;
  runtime.loadErrors = loadErrors;
  runtime.warnings = warnings;
  runtime.autoPresetError = null;
  runtime.accepting = true;
  runtime.instances += 1;

  return runtime;
}

function initializeAudit(
  runtime: RuntimeState,
  home: string,
  ctx: ContextLike,
): AuditStore | null {
  const audit = ensureAudit(runtime, home, ctx);
  if (audit !== null) {
    try {
      const snapshot = audit.saveConfigSnapshot(runtime.config);
      runtime.configSnapshotId = snapshot.snapshotId;
      runtime.effectiveRevision = snapshot.revision;
      audit.recordActivation(
        snapshot.snapshotId,
        snapshot.revision,
        'arbiter',
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
    runtime.effectiveRevision = configHash(runtime.config);
  }

  return audit;
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
  const { home, scope, config, invalidConfigError, parsed } = selectConfig(
    ctx,
    rawConfig,
  );
  const runtime = acquireRuntime(
    scope.key,
    config,
    invalidConfigError,
    parsed.errors,
    parsed.warnings,
  );
  const audit = initializeAudit(runtime, home, ctx);
  const host: HostEnvironment = {
    ctx,
    runtime,
    audit,
    currentAudit: () =>
      runtime.config.audit.enabled ? ensureAudit(runtime, home, ctx) : null,
    services: connectServices(ctx),
    lifecycle: traceLifecycle(),
  };
  maintainRuntime(host, home);
  return host;
}
