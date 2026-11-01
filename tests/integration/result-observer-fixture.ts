import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeHost } from '../../src/host/runtime.js';
import { SessionAdmissions } from '../../src/host/session-admission.js';
import { ToolResultObserver } from '../../src/host/tool-result-observer.js';
import { callRedactor } from '../../src/host/call-snapshot.js';
import { discoverLog } from '../../src/snapshot/source-redaction.js';
import type { SessionEventLike } from '../../src/snapshot.js';
import type { ToolExecutionLike } from '../../src/host/types.js';
import { createStubContext } from '../helpers/host-stub.js';
import { admitSession } from '../helpers/session-records.js';

export function observationSession(id = 'session', parentSession?: string) {
  const events: SessionEventLike[] = [];
  const session = {
    id,
    header: {
      cwd: '/workspace',
      ...(parentSession === undefined ? {} : { parentSession }),
    },
    inheritedEventCount: 0,
    get seq() {
      return events.length;
    },
    events,
    snapshotEvents: (from = 0, to = events.length) => events.slice(from, to),
    append: (type: string, data: unknown) => {
      events.push({
        type,
        data,
        seq: events.length,
        time: Date.now(),
        ignorable: type.startsWith('plugin:'),
      });
    },
  };
  return session;
}
export function observerFixture() {
  const root = mkdtempSync(join(tmpdir(), 'arbiter-result-observer-'));
  const session = observationSession();
  admitSession(session, { boundary: 'trusted' });
  const dir = join(root, 'profiles', 'result-observer');
  mkdirSync(dir, { recursive: true });
  const { ctx, disposers } = createStubContext({
    profileContext: { home: root, dir, name: 'result-observer' },
    sessions: {
      get: (id) => (id === session.id ? session : undefined),
      list: () => [session],
    },
  });
  const host = initializeHost(ctx, { format: 'arbiter-config-v3' });
  const admissions = new SessionAdmissions(host);
  const observer = new ToolResultObserver(host, admissions);
  const audit = host.currentAudit();
  if (audit === null) throw new Error('missing real audit');
  const exec = (callId: string, name = 'bash'): ToolExecutionLike => ({
    callId,
    name,
    arguments: { command: 'ls' },
    signal: new AbortController().signal,
    agent: { session },
  });
  const workflow = callRedactor(host, session);
  return {
    root,
    session,
    host,
    audit,
    observer,
    exec,
    reader: {
      discover: (log: Parameters<typeof discoverLog>[0]) => {
        discoverLog(log, workflow);
      },
      read: (receipt: Parameters<typeof audit.getToolResult>[2] & {}) =>
        audit.getToolResult(receipt.sessionId, receipt.callId, receipt),
    },
    workflow,
    disposeObserver: () => {
      for (const dispose of disposers) dispose();
    },
    close: () => {
      for (const dispose of disposers.reverse()) dispose();
      audit.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
