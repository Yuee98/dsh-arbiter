/**
 * The call list's query state and paging arithmetic.
 *
 * Kept free of React and fetch so the two contracts the issue names can be
 * tested directly:
 *
 * - **A filter change starts a new result set.** It resets the window to the
 *   first page, because page 3 of the old filter says nothing about page 3 of
 *   the new one.
 * - **Reading position belongs to the reader.** Nothing in this module moves the
 *   window on its own; only an explicit interaction or a correction to a window
 *   that no longer has rows changes it.
 */
import type { Translate } from './i18n.js';
import { LOG_PAGE_SIZE } from './decoders/logs.js';

/** One list query: the window plus every confirmed filter. */
export interface LogQuery {
  readonly limit: number;
  readonly offset: number;
  readonly result: string;
  readonly tool: string;
  readonly session: string;
  readonly rule: string;
  /** Inclusive local date (`YYYY-MM-DD`); blank means unbounded. */
  readonly from: string;
  /** Inclusive local date (`YYYY-MM-DD`); blank means unbounded. */
  readonly to: string;
  readonly query: string;
  readonly deniedOnly: boolean;
  readonly reviewFailureOnly: boolean;
}

/** The filter fields, i.e. everything a filter edit may change. */
export type LogFilterPatch = Partial<Omit<LogQuery, 'offset' | 'limit'>>;

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
    offset: 0,
    result: '',
    tool: '',
    session: '',
    rule: '',
    from: '',
    to: '',
    query: '',
    deniedOnly: false,
    reviewFailureOnly: false,
  };
}

/** Apply a filter edit and start over at the first page. */
export function withFilters(query: LogQuery, patch: LogFilterPatch): LogQuery {
  return { ...query, ...patch, offset: 0 };
}

/**
 * The last page that still has a row.
 *
 * A window can outlive its rows: the newest page was cleared, retention ran, or
 * the filter narrowed the set. Moving to this offset shows the reader the last
 * real page instead of an empty tail with a valid total.
 */
export function clampToLastPage(
  offset: number,
  total: number,
  limit: number,
): number {
  if (total <= 0 || limit <= 0) return 0;
  return Math.min(Math.max(offset, 0), Math.floor((total - 1) / limit) * limit);
}

/** Page numbers for the pager; a request for the first page of nothing is 0/0. */
export function pageInfo(
  offset: number,
  limit: number,
  total: number,
): {
  readonly page: number;
  readonly pages: number;
  readonly first: number;
  readonly last: number;
} {
  if (total <= 0 || limit <= 0) return { page: 0, pages: 0, first: 0, last: 0 };
  return {
    page: Math.floor(offset / limit) + 1,
    pages: Math.ceil(total / limit),
    first: offset + 1,
    last: Math.min(offset + limit, total),
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
  return start.getTime() + 24 * 60 * 60 * 1000 - 1;
}

/**
 * One page request's query string.
 *
 * Blank filters are omitted rather than sent as empty text: an empty equality
 * would be a filter the operator did not ask for, and the route treats an empty
 * value as "no filter" only by convention.
 */
export function paramsOf(query: LogQuery): URLSearchParams {
  const params = new URLSearchParams({
    limit: String(query.limit),
    offset: String(query.offset),
  });
  if (query.result.length > 0) params.set('result', query.result);
  if (query.tool.trim().length > 0) params.set('tool', query.tool.trim());
  if (query.session.trim().length > 0)
    params.set('session', query.session.trim());
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
    query.rule.trim().length > 0 ||
    query.query.trim().length > 0 ||
    epochOfDate(query.from, 'start') !== undefined ||
    epochOfDate(query.to, 'end') !== undefined ||
    query.deniedOnly ||
    query.reviewFailureOnly
  );
}
