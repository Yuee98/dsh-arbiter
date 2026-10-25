import type { CallAnchor, CallFilter } from '../audit/types.js';
import { jsonResponse } from './http.js';
import type { HostEnvironment, FetchRouteLike } from './types.js';

/**
 * A numeric query parameter, or `undefined` when it is absent or unusable.
 *
 * `Number('')` is `0` and `Number('abc')` is `NaN`; neither is a page window the
 * caller asked for, so both fall back to the store's default instead of
 * silently becoming a different query.
 */
function numericParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim().length === 0) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** A text query parameter, or `undefined` when the caller omitted it. */
function textParam(url: URL, name: string): string | undefined {
  const raw = url.searchParams.get(name);
  return raw === null ? undefined : raw;
}

/** An integer query parameter: fractions are not a window the caller asked for. */
function integerParam(url: URL, name: string): number | undefined {
  const value = numericParam(url, name);
  return value === undefined ? undefined : Math.trunc(value);
}

/** A `1`/`true` flag; the client sends `1`, and `false` is simply absent. */
function flagParam(url: URL, name: string): boolean | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  return raw === '1' || raw === 'true';
}

/** The list filter one logs request asked for, with omitted parameters absent. */
function filterOf(url: URL): CallFilter {
  const filter: {
    limit?: number;
    offset?: number;
    result?: string;
    tool?: string;
    sessionId?: string;
    sessionKind?: string;
    ruleId?: string;
    deniedOnly?: boolean;
    reviewFailureOnly?: boolean;
    query?: string;
    from?: number;
    to?: number;
  } = {};
  const limit = integerParam(url, 'limit');
  if (limit !== undefined) filter.limit = limit;
  const offset = integerParam(url, 'offset');
  if (offset !== undefined) filter.offset = offset;
  const result = textParam(url, 'result');
  if (result !== undefined) filter.result = result;
  const tool = textParam(url, 'tool');
  if (tool !== undefined) filter.tool = tool;
  const session = textParam(url, 'session');
  if (session !== undefined) filter.sessionId = session;
  const sessionKind = textParam(url, 'sessionKind');
  if (sessionKind !== undefined) filter.sessionKind = sessionKind;
  const rule = textParam(url, 'rule');
  if (rule !== undefined) filter.ruleId = rule;
  const denied = flagParam(url, 'denied');
  if (denied !== undefined) filter.deniedOnly = denied;
  const reviewFailure = flagParam(url, 'reviewFailure');
  if (reviewFailure !== undefined) filter.reviewFailureOnly = reviewFailure;
  const query = textParam(url, 'q');
  if (query !== undefined) filter.query = query;
  const from = numericParam(url, 'from');
  if (from !== undefined) filter.from = from;
  const to = numericParam(url, 'to');
  if (to !== undefined) filter.to = to;
  return filter;
}

/**
 * The traversal anchor, when the caller supplied one.
 *
 * An anchor is a pair, so a half-supplied one is treated as absent: silently
 * starting a fresh traversal would move a reader's window, which is the failure
 * the anchor exists to prevent.
 */
function anchorParam(url: URL): CallAnchor | undefined {
  const ts = integerParam(url, 'anchorTs');
  const callId = textParam(url, 'anchorCallId');
  if (ts === undefined || callId === undefined || callId.length === 0)
    return undefined;
  return { ts, callId };
}

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
            limit: 0,
            offset: 0,
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
      const filter = filterOf(url);
      const anchor = anchorParam(url);
      const listed = audit.listCalls(
        anchor === undefined ? filter : { ...filter, anchor },
      );
      // A database this build cannot interpret is an unreadable page, not an
      // empty history. Reporting it as a successful zero-row page would tell the
      // operator the records do not exist.
      if (listed.unreadable === true) {
        return Promise.resolve(
          jsonResponse(
            {
              ok: false,
              code: 'audit-unavailable',
              rows: [],
              total: 0,
              limit: listed.limit,
              offset: listed.offset,
              anchor: listed.anchor,
              newer: 0,
              health: audit.health(),
            },
            503,
          ),
        );
      }
      return Promise.resolve(
        jsonResponse({
          ok: true,
          rows: listed.rows,
          total: listed.total,
          limit: listed.limit,
          offset: listed.offset,
          anchor: listed.anchor,
          newer: listed.newer,
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
      const detail = audit.readCall(callId);
      if (detail.unreadable) {
        // A structure this build cannot read is not the same as a missing call.
        return Promise.resolve(
          jsonResponse(
            {
              ok: false,
              code: 'audit-unavailable',
              health: audit.health(),
            },
            503,
          ),
        );
      }
      return Promise.resolve(
        detail.record === null
          ? jsonResponse({ ok: false, code: 'not-found' }, 404)
          : jsonResponse({ ok: true, record: detail.record }),
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
      const cleared = audit.clearCalls();
      if (!cleared.ok) {
        // A failed delete is not an empty database: report it so the UI does not
        // tell the user the history is gone.
        return Promise.resolve(
          jsonResponse(
            {
              ok: false,
              code: 'audit-unavailable',
              health: audit.health(),
            },
            503,
          ),
        );
      }
      return Promise.resolve(
        jsonResponse({ ok: true, deleted: cleared.deleted }),
      );
    },
  };
}
