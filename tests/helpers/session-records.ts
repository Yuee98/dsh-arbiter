import { appendRecord } from '../../src/records.js';
import type { SessionRecordApi } from '../../src/records.js';
import type { SessionLike } from '../../src/snapshot.js';

/**
 * A test writer with the documented plugin-record contract.
 *
 * The real writer is `appendPluginRecord` from the running host installation,
 * which these Node tests do not mount. This double validates the record-type
 * grammar and writes through the session's own append, exactly where the host
 * writes; the stub session is responsible for producing the committed envelope
 * (`ignorable: true`), which is what the host does on every plugin record. The
 * real writer is covered by `tests/records.test.ts` and by the isolated DSH E2E
 * run; production code still imports only `appendPluginRecord`.
 */
export function recordingSessionApi(): SessionRecordApi {
  const RECORD_TYPE =
    /^plugin:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u;
  return {
    appendPluginRecord(session, type, data) {
      if (!RECORD_TYPE.test(type))
        throw new Error(`invalid record type ${type}`);
      if (typeof session.append !== 'function')
        throw new Error('session cannot append');
      const seq = session.snapshotEvents?.().length ?? 0;
      session.append(type, data);
      return seq;
    },
    pluginRecordOf(event) {
      if (event === null || typeof event !== 'object') return undefined;
      const value = event as {
        type?: unknown;
        seq?: unknown;
        time?: unknown;
        data?: unknown;
        ignorable?: unknown;
      };
      if (value.ignorable !== true) return undefined;
      if (typeof value.type !== 'string' || !RECORD_TYPE.test(value.type))
        return undefined;
      if (typeof value.seq !== 'number') return undefined;
      return {
        type: value.type,
        seq: value.seq,
        time: typeof value.time === 'number' ? value.time : undefined,
        data: value.data,
      };
    },
  };
}

/**
 * Enable one session the way the API does.
 *
 * Tests that need a managed session must not fake a flag: the plugin's own
 * admission record is what the gate and teardown read, so the fixture writes
 * it through the same production writer the plugin uses.
 */
export function admitSession(
  session: SessionLike,
  options: {
    readonly enabled?: boolean;
    readonly boundary?: 'guarded' | 'trusted';
  } = {},
): void {
  const id = session.id ?? 'unknown';
  const state = appendRecord(session, 'plugin:arbiter/admission', {
    version: 1,
    sessionId: id,
    rootSessionId: session.header?.parentSession ?? id,
    enabled: options.enabled ?? true,
    boundary: options.boundary ?? 'guarded',
    at: Date.now(),
  });
  if (state !== 'written') throw new Error(state);
}
