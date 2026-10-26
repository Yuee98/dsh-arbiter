/**
 * The coexistence read/acknowledge API.
 *
 * One route, two verbs: `GET` re-reads the host and returns the current
 * assessment (a reconnect is therefore current, not a stale startup snapshot),
 * `POST` marks notices as read. Neither verb changes a conflict, an admission or
 * a gate decision — acknowledgement is user feedback, not resolution.
 */

import type { CoexistenceMonitor } from './coexistence.js';
import { isRecord } from './coexistence-detect.js';
import { jsonResponse, readJsonBody } from './http.js';
import type { FetchRouteLike } from './types.js';

const COEXISTENCE_PATH = '/api/arbiter/coexistence';

/** How many notice ids one acknowledgement may carry. */
const MAX_ACKNOWLEDGED = 50;

function readIds(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) return null;
    if (ids.length >= MAX_ACKNOWLEDGED) return null;
    ids.push(item);
  }
  return ids;
}

export function coexistenceRoute(monitor: CoexistenceMonitor): FetchRouteLike {
  return {
    path: COEXISTENCE_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'GET') {
        return jsonResponse({ ok: true, coexistence: monitor.read('api') });
      }
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        return jsonResponse(
          { ok: false, code: 'bad-request', message: String(error) },
          400,
        );
      }
      if (!isRecord(body)) {
        return jsonResponse(
          {
            ok: false,
            code: 'bad-request',
            message: 'body must be an object carrying noticeIds',
          },
          400,
        );
      }
      const ids = readIds(body['noticeIds']);
      if (ids === null) {
        return jsonResponse(
          {
            ok: false,
            code: 'invalid-notice-ids',
            message: 'noticeIds must be a bounded array of non-empty strings',
          },
          400,
        );
      }
      return jsonResponse({
        ok: true,
        coexistence: monitor.acknowledge(ids),
      });
    },
  };
}
