import { describe, expect, test } from 'vitest';

import { sessionAdmissionResponse } from '../../src/client/decoders/admission.js';

const VIEW = {
  sessionId: 'session-1',
  rootSessionId: 'session-1',
  enabled: true,
  boundary: 'guarded',
  revision: 'revision-1',
  admissionRevision: 'admission-1',
  seq: 12,
  at: 1_700_000_000_000,
  reason: 'session-enabled',
  managed: true,
} as const;

describe('session admission decoder', () => {
  test('decodes a confirmed answer into the confirmed view', () => {
    expect(
      sessionAdmissionResponse({ ok: true, admission: VIEW, revision: 'r' }),
    ).toEqual({ ok: true, admission: VIEW, revision: 'revision-1' });
  });

  test('decodes a refusal answer with its own revision', () => {
    expect(
      sessionAdmissionResponse({
        ok: false,
        code: 'boundary-unconfirmed',
        message: 'the host did not confirm the boundary',
        revision: 'revision-2',
      }),
    ).toEqual({
      ok: false,
      code: 'boundary-unconfirmed',
      message: 'the host did not confirm the boundary',
      revision: 'revision-2',
    });
  });

  test('accepts an admission without a record', () => {
    const view = {
      ...VIEW,
      enabled: false,
      admissionRevision: null,
      seq: null,
      at: null,
      reason: 'no-admission',
      managed: false,
    };
    expect(
      sessionAdmissionResponse({ ok: true, admission: view, revision: 'r' }),
    ).toMatchObject({ admission: { enabled: false, admissionRevision: null } });
  });

  test.each([
    ['an unknown boundary', { ...VIEW, boundary: 'danger-full-access' }],
    ['an unknown reason', { ...VIEW, reason: 'made-up' }],
    ['a missing session id', { ...VIEW, sessionId: undefined }],
    ['a non-boolean flag', { ...VIEW, enabled: 'yes' }],
    ['a non-numeric seq', { ...VIEW, seq: 'twelve' }],
  ])('rejects %s instead of inventing state', (_label, admission) => {
    expect(() =>
      sessionAdmissionResponse({ ok: true, admission, revision: 'r' }),
    ).toThrow();
  });

  test('rejects an answer with no admission at all', () => {
    expect(() =>
      sessionAdmissionResponse({ ok: true, revision: 'r' }),
    ).toThrow();
  });

  test('rejects a body that is not an object', () => {
    expect(() => sessionAdmissionResponse(null)).toThrow();
    expect(() => sessionAdmissionResponse([])).toThrow();
  });
});
