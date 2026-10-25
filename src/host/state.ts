import { sessionRecordError, sessionRecordReady } from '../records.js';
import { executionModeName } from './common.js';
import type { HostEnvironment } from './types.js';
import type { ConfigurationAccess } from './configuration.js';

export function statePayload(
  host: HostEnvironment,
  configuration: ConfigurationAccess,
): unknown {
  const { ctx, runtime, audit } = host;
  const name = 'arbiter';
  const configEditor = host.services.configEditor;
  const entry = configuration.entry();
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
    fileRevision: configuration.fileRevision(),
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
    sessionRecordErrors: [...runtime.sessionRecordErrors.entries()].slice(-20),
  };
}
