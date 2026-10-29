import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { StateResponse } from '../../src/client/view-types.js';

export function effectiveState(): StateResponse {
  return {
    name: 'arbiter',
    enabled: true,
    config: DEFAULT_CONFIG,
    sourceConfig: null,
    effectiveRevision: 'effective-1',
    configSnapshotId: 'snapshot-1',
    configFormat: 'arbiter-config-v3',
    configFormatExplicit: false,
    fileRevision: 'file-1',
    documentPath: '/isolated/profile/cordis.patch.yml',
    invalidConfigError: null,
    loadErrors: [],
    warnings: [],
    autoPresetError: null,
    configHistory: [],
    configHistoryComplete: true,
    audit: {
      health: { state: 'ok', lastError: null, dropped: 0, pending: 0 },
      path: '/isolated/audit.sqlite',
      bytes: 0,
      stats: { calls: 0, modelCalls: 0, bytes: 0, results: [] },
    },
    coverage: { gated: ['native tools'], notGated: ['tool internals'] },
    policyVersion: 'arbiter-policy-v2',
    modes: { main: 'normal', subagent: 'strict' },
    executionMode: 'guarded',
    reviewerType: 'chat',
    sessionRecordErrors: [['session-1', 'disk unavailable']],
    // The default fixture is a host that reports no conflict; a case that needs
    // one spread its own value over this state.
    coexistence: null,
  };
}
