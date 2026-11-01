import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuditStore,
  type CallRecord,
  type ToolResultObservation,
  type ToolResultRead,
} from '../../src/audit.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

export function resultObservation(
  overrides: Partial<ToolResultObservation> = {},
): ToolResultObservation {
  return {
    sessionId: 'session',
    callId: 'query',
    observedAt: Date.now(),
    status: 'success',
    contentState: 'available',
    parts: [{ kind: 'text', channel: 'stdout', text: 'directory entries\n' }],
    ...overrides,
  };
}
export function resultFixture() {
  const root = mkdtempSync(join(tmpdir(), 'arbiter-tool-results-'));
  const path = join(root, 'audit.db');
  const stores: AuditStore[] = [];
  const open = () => {
    const store = new AuditStore(path, DEFAULT_CONFIG.audit);
    stores.push(store);
    return store;
  };
  return {
    root,
    path,
    open,
    close: () => {
      for (const store of stores) store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
export function resultMetadata(result: ToolResultRead) {
  if (result.metadata === null)
    throw new Error(`missing result metadata: ${result.state}`);
  return result.metadata;
}
export function resultFile(result: ToolResultRead, path: string): string {
  if (result.fileRef === null) throw new Error('missing result file reference');
  return join(`${path}.results`, result.fileRef);
}
export function resultCall(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: 'query',
    ts: Date.now(),
    sessionId: 'session',
    sessionKind: 'main',
    parentSession: null,
    profile: null,
    workspace: null,
    tool: 'bash',
    arguments: { command: 'ls' },
    cwd: '/workspace',
    fingerprint: 'bash:query',
    configRevision: 'revision',
    configSnapshotId: 'config',
    approvalMode: 'ask',
    executionMode: 'trusted',
    result: 'allow',
    reason: 'allowed',
    trace: [],
    effect: null,
    sessionRecordState: 'written',
    snapshot: null,
    modelAttempts: [],
    scores: null,
    reviewStage: null,
    usage: null,
    decisionRules: [],
    executionStatus: 'pending',
    ...overrides,
  };
}
