import { jsonResponse } from './http.js';
import type { HostEnvironment, FetchRouteLike } from './types.js';

export function logsRoute(host: HostEnvironment): FetchRouteLike {
  const { audit, runtime } = host;
  return {
    path: `/api/arbiter/logs`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => {
      if (audit === null) {
        return Promise.resolve(
          jsonResponse({
            ok: false,
            code: 'audit-unavailable',
            rows: [],
            total: 0,
            health: {
              state: 'unavailable',
              lastError: runtime.auditError,
              dropped: 0,
              pending: 0,
            },
          }),
        );
      }
      const url = new URL(request.url);
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      return Promise.resolve(
        jsonResponse({
          ok: true,
          ...audit.listCalls({
            limit: Number(url.searchParams.get('limit') ?? '100'),
            offset: Number(url.searchParams.get('offset') ?? '0'),
            ...(url.searchParams.get('result') === null
              ? {}
              : { result: url.searchParams.get('result') ?? '' }),
            ...(url.searchParams.get('tool') === null
              ? {}
              : { tool: url.searchParams.get('tool') ?? '' }),
            ...(url.searchParams.get('session') === null
              ? {}
              : { sessionId: url.searchParams.get('session') ?? '' }),
            ...(url.searchParams.get('q') === null
              ? {}
              : { query: url.searchParams.get('q') ?? '' }),
            ...(from === null ? {} : { from: Number(from) }),
            ...(to === null ? {} : { to: Number(to) }),
          }),
        }),
      );
    },
  };
}

export function logRoute(host: HostEnvironment): FetchRouteLike {
  const { audit } = host;
  return {
    path: `/api/arbiter/log`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => {
      const callId = new URL(request.url).searchParams.get('callId') ?? '';
      if (audit === null) {
        return Promise.resolve(
          jsonResponse({ ok: false, code: 'audit-unavailable' }, 404),
        );
      }
      const record = audit.getCall(callId);
      return Promise.resolve(
        record === null
          ? jsonResponse({ ok: false, code: 'not-found' }, 404)
          : jsonResponse({ ok: true, record }),
      );
    },
  };
}

export function clearRoute(host: HostEnvironment): FetchRouteLike {
  const { audit } = host;
  return {
    path: `/api/arbiter/clear`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: () => {
      if (audit === null) {
        return Promise.resolve(
          jsonResponse({ ok: false, code: 'audit-unavailable' }, 409),
        );
      }
      return Promise.resolve(
        jsonResponse({ ok: true, deleted: audit.clearCalls() }),
      );
    },
  };
}
