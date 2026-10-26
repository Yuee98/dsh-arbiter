/**
 * Session admission answers, decoded strictly.
 *
 * The client has no licence to infer whether a session is admitted: the only
 * accepted answer is the backend-confirmed view from
 * `GET/POST /api/arbiter/sessions`. A malformed body therefore throws instead
 * of defaulting to "disabled", which would display a value no server confirmed.
 */

import type {
  AdmissionReason,
  SessionAdmissionResponse,
  SessionAdmissionView,
} from '../view-types.js';
import {
  boolean,
  choice,
  field,
  nullable,
  number,
  object,
  text,
} from './values.js';

/** The reasons `resolveScope` reports for one session (#4's contract). */
const REASONS = [
  'boundary-unconfirmed',
  'session-enabled',
  'parent-session-enabled',
  'no-admission',
  'session-disabled',
  'parent-not-admitted',
  'parent-unresolved',
  'parent-cycle',
] as const satisfies readonly AdmissionReason[];

function admissionView(value: unknown): SessionAdmissionView {
  const source = object(value);
  return {
    sessionId: field(source, 'sessionId', text),
    rootSessionId: field(source, 'rootSessionId', text),
    enabled: field(source, 'enabled', boolean),
    boundary: field(source, 'boundary', choice('guarded', 'trusted')),
    revision: field(source, 'revision', text),
    admissionRevision: field(source, 'admissionRevision', nullable(text)),
    seq: field(source, 'seq', nullable(number)),
    at: field(source, 'at', nullable(number)),
    reason: field(source, 'reason', choice(...REASONS)),
    managed: field(source, 'managed', boolean),
  };
}

export function sessionAdmissionResponse(
  value: unknown,
): SessionAdmissionResponse {
  const source = object(value);
  if (field(source, 'ok', boolean)) {
    const admission = admissionView(source['admission']);
    return { ok: true, admission, revision: admission.revision };
  }
  return {
    ok: false,
    code: field(source, 'code', text),
    message: field(source, 'message', text),
    revision: field(source, 'revision', text),
  };
}
