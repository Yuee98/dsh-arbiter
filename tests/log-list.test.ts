import { describe, expect, test } from 'vitest';

import { epochOfDate, pageInfo, paramsOf } from '../src/client/log-list.js';
import { initialQuery } from '../src/client/log-list.js';

/**
 * The pure log-list helpers.
 *
 * Two of them encode arithmetic that is easy to get subtly wrong and impossible
 * to see in a rendered page: a local calendar day's boundaries, and how many
 * pages remain.
 */
describe('local calendar day boundaries', () => {
  test('a day bounds from its own midnight to the next one', () => {
    const start = epochOfDate('2026-10-26', 'start');
    const end = epochOfDate('2026-10-26', 'end');
    expect(start).toBe(new Date(2026, 9, 26, 0, 0, 0, 0).getTime());
    // The last millisecond of the day, not the first of the next.
    expect(end).toBe(new Date(2026, 9, 27, 0, 0, 0, 0).getTime() - 1);
    expect(new Date(end ?? 0).getDate()).toBe(26);
  });

  test('a day is not assumed to be 24 hours long', () => {
    // Whatever the host time zone, the bounds are the day's own midnights, so a
    // daylight-saving transition cannot add or drop an hour of the filter.
    for (const date of ['2026-03-08', '2026-11-01']) {
      const start = epochOfDate(date, 'start');
      const end = epochOfDate(date, 'end');
      if (start === undefined || end === undefined)
        throw new Error(`${date} must parse`);
      const parts = date.split('-').map(Number);
      const month = parts[1] ?? 0;
      const day = parts[2] ?? 0;
      const nextMidnight = new Date(
        new Date(start).getFullYear(),
        month - 1,
        day + 1,
        0,
        0,
        0,
        0,
      ).getTime();
      expect(end).toBe(nextMidnight - 1);
      // The end belongs to the selected date, not to the following one.
      expect(new Date(end).getDate()).toBe(day);
    }
  });

  test('an unusable date is absent from the query instead of becoming epoch zero', () => {
    const base = initialQuery();
    expect(paramsOf({ ...base, from: '2026-13-01' }).has('from')).toBe(false);
    expect(paramsOf({ ...base, from: 'not a date' }).has('from')).toBe(false);
    expect(paramsOf({ ...base, to: '' }).has('to')).toBe(false);
    expect(paramsOf({ ...base, from: '2026-10-26' }).has('from')).toBe(true);
  });
});

describe('pager arithmetic with a known remaining count', () => {
  test('the page count follows the rows the traversal can still reach', () => {
    // 35 rows remain after page one: two more pages, so three in total.
    expect(pageInfo(0, 25, 60, 35)).toMatchObject({ page: 1, pages: 3 });
    expect(pageInfo(25, 25, 60, 10)).toMatchObject({ page: 2, pages: 3 });
    // The last page: no rows remain, so nothing is advertised beyond it even
    // though the live total may include calls behind the reader.
    expect(pageInfo(50, 25, 60, 0)).toMatchObject({ page: 3, pages: 3 });
    expect(pageInfo(50, 25, 200, 0)).toMatchObject({ page: 3, pages: 3 });
  });

  test('the displayed range stays inside the total', () => {
    expect(pageInfo(0, 25, 60, 35)).toMatchObject({ first: 1, last: 25 });
    expect(pageInfo(25, 25, 60, 10)).toMatchObject({ first: 26, last: 50 });
    expect(pageInfo(50, 25, 60, 0)).toMatchObject({ first: 51, last: 60 });
  });

  test('an empty set has no page and no range', () => {
    expect(pageInfo(0, 25, 0, 0)).toEqual({
      page: 0,
      pages: 0,
      first: 0,
      last: 0,
    });
  });
});

describe('the page request query string', () => {
  test('a cursor is sent as a complete pair, never half of one', () => {
    const base = initialQuery();
    const forward = paramsOf(base, {
      after: { ts: 100, callId: 'call-a' },
      before: null,
      tail: false,
    });
    expect(forward.get('afterTs')).toBe('100');
    expect(forward.get('afterCallId')).toBe('call-a');
    expect(forward.has('beforeTs')).toBe(false);

    const first = paramsOf(base);
    expect(first.has('afterTs')).toBe(false);
    expect(first.has('afterCallId')).toBe(false);
    expect(first.has('beforeTs')).toBe(false);
    expect(first.get('limit')).toBe('25');
  });

  test('a tail read is named rather than expressed as an offset', () => {
    const tail = paramsOf(initialQuery(), {
      after: null,
      before: null,
      tail: true,
    });
    expect(tail.get('tail')).toBe('1');
    expect(tail.has('afterTs')).toBe(false);
    expect(tail.has('beforeTs')).toBe(false);
  });

  test('blank filters are omitted and confirmed ones are sent', () => {
    const base = initialQuery();
    const params = paramsOf({
      ...base,
      result: 'review-deny',
      tool: ' bash ',
      session: 'session-1',
      sessionKind: 'subagent',
      rule: 'no-push',
      query: 'gh pr view',
      deniedOnly: true,
      reviewFailureOnly: true,
    });
    expect(params.get('result')).toBe('review-deny');
    expect(params.get('tool')).toBe('bash');
    expect(params.get('session')).toBe('session-1');
    expect(params.get('sessionKind')).toBe('subagent');
    expect(params.get('rule')).toBe('no-push');
    expect(params.get('q')).toBe('gh pr view');
    expect(params.get('denied')).toBe('1');
    expect(params.get('reviewFailure')).toBe('1');
  });
});
