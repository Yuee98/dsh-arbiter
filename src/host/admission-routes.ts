/**
 * The session admission API.
 *
 * Two routes, one responsibility: read and change one session's admission.
 * They are the backend the session permission selector (#5) consumes; the
 * answer is always the confirmed state read back from the session log, never
 * an echo of the request.
 */

import { isRecord } from './common.js';
import { jsonResponse, readJsonBody } from './http.js';
import type { SessionAdmissions } from './session-admission.js';
import type { FetchRouteLike, HostEnvironment } from './types.js';

const SESSIONS_PATH = '/api/arbiter/sessions';

/**
 * One error answer shape.
 *
 * It always carries the effective configuration revision the answer was
 * computed under, so a client never promotes a stale identity after a failed
 * write.
 */
function failed(
  host: HostEnvironment,
  status: number,
  code: string,
  message: string,
): Response {
  return jsonResponse(
    { ok: false, code, message, revision: host.runtime.effectiveRevision },
    status,
  );
}

function sessionView(
  host: HostEnvironment,
  admissions: SessionAdmissions,
  id: string,
): Response {
  const view = admissions.view(id, host.runtime.effectiveRevision);
  if (view === null) {
    return failed(
      host,
      404,
      'session-unknown',
      `session ${id} is not available in this host`,
    );
  }
  return jsonResponse({ ok: true, admission: view, revision: view.revision });
}

/** A missing or empty `sessionId` never resolves to a default session. */
function readSessionId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

export function admissionsRoute(
  host: HostEnvironment,
  admissions: SessionAdmissions,
): FetchRouteLike {
  return {
    path: SESSIONS_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'GET') {
        const id = readSessionId(
          new URL(request.url).searchParams.get('sessionId'),
        );
        if (id === null)
          return failed(host, 400, 'session-required', 'sessionId is required');
        return sessionView(host, admissions, id);
      }
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        return failed(host, 400, 'bad-request', String(error));
      }
      if (!isRecord(body))
        return failed(host, 400, 'bad-request', 'body must be an object');
      const id = readSessionId(body['sessionId']);
      if (id === null)
        return failed(host, 400, 'session-required', 'sessionId is required');
      const action = body['action'];
      if (action !== 'enable' && action !== 'disable') {
        return failed(
          host,
          400,
          'invalid-action',
          'action must be enable or disable',
        );
      }
      // The boundary is a plugin-configuration setting, not a per-session
      // switch. A body that tries to set one is rejected instead of being
      // silently ignored, so no caller believes it overrode the configuration.
      if (body['boundary'] !== undefined) {
        return failed(
          host,
          400,
          'boundary-not-overridable',
          'the execution boundary is a configuration setting; omit boundary',
        );
      }
      if (action === 'disable') {
        const result = admissions.disable(id, 'api');
        return result.ok
          ? jsonResponse({
              ok: true,
              admission: result.view,
              revision: result.view.revision,
            })
          : failureResponse(host, result);
      }
      const result = admissions.enable(id);
      return result.ok
        ? jsonResponse({
            ok: true,
            admission: result.view,
            revision: result.view.revision,
          })
        : failureResponse(host, result);
    },
  };
}

function failureResponse(
  host: HostEnvironment,
  result: {
    readonly code: string;
    readonly message: string;
    readonly detail?: Readonly<Record<string, unknown>>;
  },
): Response {
  const status = result.code === 'session-unknown' ? 404 : 409;
  // A coexistence block is a policy refusal with guidance, not a malformed
  // request: keep the structured detail so the client can render the exact
  // reason and the way out instead of a bare sentence.
  return jsonResponse(
    {
      ok: false,
      code: result.code,
      message: result.message,
      revision: host.runtime.effectiveRevision,
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    },
    status,
  );
}
