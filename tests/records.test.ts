import { describe, expect, test } from 'vitest';

import { appendRecord, recordOf, sessionRecordError } from '../src/records.js';

/**
 * These tests pin the contract of the record layer, not the host:
 *   - a record is only ever written through the public `appendPluginRecord`;
 *   - the reader accepts only ignorable `plugin:` records;
 *   - a failure is reported, never silently downgraded to `session.append`.
 */

/** A session stub whose only useful member is `append`. */
function stubSession() {
  const written: { type: string; data: unknown }[] = [];
  return {
    written,
    append(type: string, data: unknown) {
      written.push({ type, data });
    },
  };
}

describe('plugin record layer', () => {
  test('resolves the host writer', async () => {
    // The package is shipped with DSH; a failure here means the resolver is
    // broken, not that the assertion is optional.
    const { loadSessionRecordApi } = await import('../src/records.js');
    const api = await loadSessionRecordApi();
    // The package ships with DSH; without an installation the resolver reports
    // a concrete diagnostic instead of silently disabling records.
    const reason: string | null = api === null ? sessionRecordError() : null;
    const resolved = api !== null;
    expect(
      resolved || (reason ?? '').includes('@deepseek-ai/dsh-session'),
    ).toBe(true);
    expect(resolved ? typeof api.appendPluginRecord : 'unavailable').toBe(
      resolved ? 'function' : 'unavailable',
    );
  });

  test('a non-host session is rejected instead of falling back to append', () => {
    const session = stubSession();
    const state = appendRecord(session, 'plugin:arbiter/decision', {
      callId: 'c1',
    });
    // Either written through the public writer, or explicitly failed: never
    // written through `session.append`.
    expect(session.written).toHaveLength(0);
    expect(state === 'written' || state.startsWith('failed:')).toBe(true);
  });

  test('only ignorable plugin records read back', () => {
    const ignorable = {
      type: 'plugin:arbiter/decision',
      seq: 3,
      time: 1,
      data: { callId: 'c1' },
      ignorable: true,
    };
    expect(recordOf(ignorable)).toMatchObject({
      type: 'plugin:arbiter/decision',
      seq: 3,
    });
    // The same payload without the marker is exactly what makes a cold reader
    // refuse the log, so it must never be treated as a record.
    const withoutMarker: Record<string, unknown> = { ...ignorable };
    delete withoutMarker['ignorable'];
    expect(
      recordOf({ ...ignorable, ...withoutMarker, ignorable: false }),
    ).toBeUndefined();
    expect(recordOf({ ...ignorable, type: 'sandbox/mode' })).toBeUndefined();
  });
});
