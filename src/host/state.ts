import { sessionRecordError, sessionRecordReady } from '../records.js';
import type { CoexistenceMonitor } from './coexistence.js';
import { executionModeName } from './common.js';
import type { HostEnvironment } from './types.js';
import type { ConfigurationAccess } from './configuration.js';
import type { SessionAdmissions } from './session-admission.js';

interface AuditView {
  readonly history: readonly unknown[];
  readonly health: unknown;
  readonly path: string | null;
  readonly bytes: number;
  readonly stats: unknown;
}

/**
 * Read audit-derived state without letting audit failures block or mislabel the
 * effective configuration.
 *
 * A configuration can be applied while SQLite is broken, so the state API must
 * report the effective revision plus an explicit "history incomplete" view
 * instead of failing the whole response or reusing a stale audit reference.
 */
function auditView(host: HostEnvironment): AuditView {
  const { runtime } = host;
  const audit = host.currentAudit();
  if (audit === null) {
    return {
      history: [],
      health: {
        state: runtime.config.audit.enabled ? 'unavailable' : 'disabled',
        lastError: runtime.auditError,
        dropped: 0,
        pending: 0,
      },
      path: null,
      bytes: 0,
      stats: null,
    };
  }
  try {
    return {
      history: audit.configHistory(20),
      health: audit.health(),
      path: audit.databasePath,
      bytes: audit.databaseBytes,
      stats: audit.stats(),
    };
  } catch (error) {
    runtime.auditError = error instanceof Error ? error.message : String(error);
    host.ctx.logger.warn(
      'arbiter: audit state read failed: %s',
      runtime.auditError,
    );
    return {
      history: [],
      health: {
        state: 'unavailable',
        lastError: runtime.auditError,
        dropped: 0,
        pending: 0,
      },
      path: audit.databasePath,
      bytes: 0,
      stats: null,
    };
  }
}

export function statePayload(
  host: HostEnvironment,
  configuration: ConfigurationAccess,
  admissions?: SessionAdmissions,
  coexistence?: CoexistenceMonitor,
): unknown {
  const { ctx, runtime } = host;
  const name = 'arbiter';
  const configEditor = host.services.configEditor;
  const entry = configuration.entry();
  const audit = auditView(host);
  return {
    name,
    enabled: runtime.config.enabled,
    autoEntry: {
      rejected: true,
      rejections: runtime.autoRejections.length,
      legacyAutoRestores: runtime.legacyAutoRestores.length,
      registrationError: runtime.autoPresetError,
      // Who holds the host's single Auto slot, as this runtime proved it: a
      // registration that threw is a different answer from one that never ran.
      slot: runtime.autoSlot,
    },
    sessionRecords: {
      ready: sessionRecordReady(),
      error: sessionRecordError(),
      failures: [...runtime.sessionRecordErrors.entries()],
    },
    config: runtime.config,
    // Per-session admission lives in the session log, not this payload; the
    // summary only reports what this runtime currently covers so a client can
    // read the confirmed state without inferring it from a preset name.
    admission: admissions?.summary() ?? null,
    // Conflicts are read from the host on this call, so a page reload reports
    // what runs now instead of what was true at startup. The payload carries no
    // notice state of its own: acknowledgements belong to the coexistence route.
    coexistence: coexistence?.summary() ?? null,
    sourceConfig: entry?.options.config ?? null,
    effectiveRevision: runtime.effectiveRevision,
    configSnapshotId: runtime.configSnapshotId,
    configFormat: runtime.configFormat,
    configFormatExplicit: runtime.configFormatExplicit,
    fileRevision: configuration.fileRevision(),
    documentPath: configEditor?.documentPath ?? null,
    invalidConfigError: runtime.invalidConfigError,
    loadErrors: runtime.loadErrors,
    warnings: runtime.warnings,
    autoPresetError: runtime.autoPresetError,
    configHistory: audit.history,
    // SQLite reopening does not repair an activation row that was never written.
    configHistoryComplete:
      runtime.auditError === null && !runtime.historyIncomplete,
    audit: {
      health: audit.health,
      path: audit.path,
      bytes: audit.bytes,
      stats: audit.stats,
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
    sessionRecordErrors: [...runtime.sessionRecordErrors.entries()].slice(-20),
  };
}
