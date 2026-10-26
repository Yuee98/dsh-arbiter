/**
 * The call list's query state and paging arithmetic.
 *
 * Kept free of React and fetch so the contracts the issue names can be tested
 * directly:
 *
 * - **A page is keyed to a row, not to a row count.** A traversal continues from
 *   the last row it read, so a call inserted anywhere — above the window, below
 *   it, or between two rows sharing a timestamp — cannot shift what the next
 *   page contains. Counting skipped rows could.
 * - **A filter change starts a new result set.** It drops the cursor, because a
 *   position in the old result set says nothing about the new one.
 * - **Reading position belongs to the reader.** Nothing here moves the cursor on
 *   its own; only an explicit interaction, or a correction after the rows under
 *   the reader were deleted, changes it.
 */
import type { LogAnchor } from './view-types.js';
import type { Translate } from './i18n.js';
import { LOG_PAGE_SIZE } from './decoders/logs.js';

/**
 * One list query: the filters and the page size.
 *
 * The cursor is not part of it. A cursor is where this particular read continues
 * from, not a property of the filter, and keeping it out means a filter edit
 * cannot accidentally carry a position into a different result set.
 */
export interface LogQuery {
  readonly limit: number;
  readonly result: string;
  readonly tool: string;
  readonly session: string;
  /** `main` or `subagent`; empty means both. */
  readonly sessionKind: string;
  readonly rule: string;
  /** Inclusive local date (`YYYY-MM-DD`); blank means unbounded. */
  readonly from: string;
  /** Inclusive local date (`YYYY-MM-DD`); blank means unbounded. */
  readonly to: string;
  readonly query: string;
  readonly deniedOnly: boolean;
  readonly reviewFailureOnly: boolean;
}

/** Where a read continues from: after this row, the page before it, or the end. */
export interface LogCursor {
  readonly after: LogAnchor | null;
  readonly before: LogAnchor | null;
  /** True when the read should return the oldest page of the set. */
  readonly tail: boolean;
}

/** The first read: no cursor, no filter. */
export const FIRST_PAGE: LogCursor = { after: null, before: null, tail: false };

/** The oldest page: what a reader is moved to when their page lost its rows. */
export const LAST_PAGE: LogCursor = { after: null, before: null, tail: true };

/** The verdicts the result filter offers, in a stable operator-facing order. */
export const RESULT_OPTIONS = [
  '',
  'allow',
  'deny',
  'review-allow',
  'review-deny',
  'review-escalate',
  'human-allow',
  'human-deny',
  'human-abort',
  'fallback-deny',
] as const;

const VERDICT_KEYS: Readonly<Record<string, string>> = {
  allow: 'logs.verdicts.allow',
  deny: 'logs.verdicts.deny',
  'review-allow': 'logs.verdicts.reviewAllow',
  'review-deny': 'logs.verdicts.reviewDeny',
  'review-escalate': 'logs.verdicts.reviewEscalate',
  'human-allow': 'logs.verdicts.humanAllow',
  'human-deny': 'logs.verdicts.humanDeny',
  'human-abort': 'logs.verdicts.humanAbort',
  'fallback-deny': 'logs.verdicts.fallbackDeny',
};

/**
 * A verdict's display label.
 *
 * The stored value is a protocol identifier; it may gain a label but must not
 * change. An unrecognized verdict (a value written by a newer build) is shown
 * verbatim rather than hidden behind a placeholder.
 */
export function verdictLabel(translate: Translate, result: string): string {
  const key = VERDICT_KEYS[result];
  return key === undefined ? result : translate(key);
}

/** The first page with no filter applied. */
export function initialQuery(): LogQuery {
  return {
    limit: LOG_PAGE_SIZE,
    result: '',
    tool: '',
    session: '',
    sessionKind: '',
    rule: '',
    from: '',
    to: '',
    query: '',
    deniedOnly: false,
    reviewFailureOnly: false,
  };
}

/**
 * Page numbers for a pager that reads by cursor.
 *
 * `remaining` is how many matching rows the host counted *after* this page inside
 * the traversal, so the number of pages below is exact. It is deliberately not
 * derived from `total`: the total includes calls that arrived behind the reader,
 * and counting those would advertise pages that cannot be reached — the pager
 * would then retract them as the reader advanced.
 */
export function pageInfo(
  index: number,
  limit: number,
  total: number,
  remaining: number,
): {
  readonly page: number;
  readonly pages: number;
  readonly first: number;
  readonly last: number;
} {
  if (total <= 0 || limit <= 0) return { page: 0, pages: 0, first: 0, last: 0 };
  const page = Math.floor(Math.max(index, 0) / limit) + 1;
  const ahead = Math.ceil(Math.max(remaining, 0) / limit);
  return {
    page,
    pages: page + ahead,
    first: (page - 1) * limit + 1,
    last: Math.min(page * limit, total),
  };
}

/**
 * A date input's instant, or undefined when it is blank or unusable.
 *
 * The filter is a local calendar day, so the lower edge is local midnight and
 * the upper edge is the last millisecond of that day. Reading them as UTC would
 * silently shift the range by the machine's offset.
 */
export function epochOfDate(
  value: string,
  edge: 'start' | 'end',
): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value.trim());
  if (match === null) return undefined;
  const [, year, month, day] = match;
  if (year === undefined || month === undefined || day === undefined)
    return undefined;
  const start = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    0,
    0,
    0,
    0,
  );
  if (Number.isNaN(start.getTime())) return undefined;
  if (start.getMonth() !== Number(month) - 1 || start.getDate() !== Number(day))
    return undefined;
  if (edge === 'start') return start.getTime();
  // The day's end is the next local midnight minus a millisecond, not "start plus
  // 24 hours": a daylight-saving transition makes a local day 23 or 25 hours
  // long, and a fixed duration would include an hour of the next day or drop the
  // last one.
  const next = new Date(
    Number(year),
    Number(month) - 1,
    Number(day) + 1,
    0,
    0,
    0,
    0,
  );
  if (Number.isNaN(next.getTime())) return undefined;
  return next.getTime() - 1;
}

/**
 * One page request's query string.
 *
 * Blank filters are omitted rather than sent as empty text: an empty equality
 * would be a filter the operator did not ask for. A half cursor is never sent;
 * the host treats an incomplete pair as "start a traversal", which would move
 * the reader.
 */
export function paramsOf(
  query: LogQuery,
  cursor: LogCursor = FIRST_PAGE,
): URLSearchParams {
  const params = new URLSearchParams({ limit: String(query.limit) });
  if (cursor.tail) {
    params.set('tail', '1');
  } else if (cursor.before !== null) {
    params.set('beforeTs', String(cursor.before.ts));
    params.set('beforeCallId', cursor.before.callId);
  } else if (cursor.after !== null) {
    params.set('afterTs', String(cursor.after.ts));
    params.set('afterCallId', cursor.after.callId);
  }
  if (query.result.length > 0) params.set('result', query.result);
  if (query.tool.trim().length > 0) params.set('tool', query.tool.trim());
  if (query.session.trim().length > 0)
    params.set('session', query.session.trim());
  if (query.sessionKind.length > 0)
    params.set('sessionKind', query.sessionKind);
  if (query.rule.trim().length > 0) params.set('rule', query.rule.trim());
  if (query.query.trim().length > 0) params.set('q', query.query.trim());
  const from = epochOfDate(query.from, 'start');
  if (from !== undefined) params.set('from', String(from));
  const to = epochOfDate(query.to, 'end');
  if (to !== undefined) params.set('to', String(to));
  if (query.deniedOnly) params.set('denied', '1');
  if (query.reviewFailureOnly) params.set('reviewFailure', '1');
  return params;
}

/** True when any filter is active; the empty state explains itself differently. */
export function hasFilters(query: LogQuery): boolean {
  return (
    query.result.length > 0 ||
    query.tool.trim().length > 0 ||
    query.session.trim().length > 0 ||
    query.sessionKind.length > 0 ||
    query.rule.trim().length > 0 ||
    query.query.trim().length > 0 ||
    epochOfDate(query.from, 'start') !== undefined ||
    epochOfDate(query.to, 'end') !== undefined ||
    query.deniedOnly ||
    query.reviewFailureOnly
  );
}
