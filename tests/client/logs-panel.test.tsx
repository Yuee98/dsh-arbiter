import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, test } from 'vitest';

import { ArbiterPage } from '../../src/client/index.js';
import { LogsPanel } from '../../src/client/panels/logs.js';
import { setupApiMock } from '../helpers/api-mock.js';
import { effectiveState } from '../helpers/client-state.js';
import { renderClient } from '../helpers/render-client.js';

const server = setupApiMock();

interface RowSpec {
  readonly callId: string;
  readonly ts: number;
  readonly tool?: string;
  readonly command?: string;
  readonly result?: string;
  readonly ruleId?: string | null;
  readonly unreadable?: boolean;
}

/** One decoded list row, as the host route produces it. */
function row(spec: RowSpec): Record<string, unknown> {
  return {
    callId: spec.callId,
    ts: spec.ts,
    sessionId: 'session-1',
    sessionKind: 'main',
    tool: spec.tool ?? 'bash',
    command: spec.command ?? `echo ${spec.callId}`,
    result: spec.result ?? 'review-allow',
    ruleId: spec.ruleId ?? null,
    ruleName: null,
    recordFormatVersion: 2,
    unreadable: spec.unreadable ?? false,
    unreadableReason: null,
  };
}

/**
 * One page of a fixed set, computed the way the host computes it.
 *
 * Newest first, tie-broken by `callId` descending, and bounded by a cursor row
 * rather than by a row count.
 */
function pageOf(
  matched: readonly RowSpec[],
  url: URL,
): Record<string, unknown> {
  const limit = Number(url.searchParams.get('limit') ?? '25');
  const ordered = [...matched].sort((left, right) =>
    right.ts === left.ts
      ? right.callId.localeCompare(left.callId)
      : right.ts - left.ts,
  );
  const afterTs = url.searchParams.get('afterTs');
  const afterCallId = url.searchParams.get('afterCallId');
  const beforeTs = url.searchParams.get('beforeTs');
  const beforeCallId = url.searchParams.get('beforeCallId');
  const tail = url.searchParams.get('tail') === '1';
  const indexOf = (ts: number, callId: string): number =>
    ordered.findIndex((item) => item.ts === ts && item.callId === callId);
  let start = 0;
  if (tail) {
    start = Math.max(ordered.length - limit, 0);
  } else if (afterTs !== null && afterCallId !== null) {
    const cursor = indexOf(Number(afterTs), afterCallId);
    start = cursor < 0 ? 0 : cursor + 1;
  } else if (beforeTs !== null && beforeCallId !== null) {
    const cursor = indexOf(Number(beforeTs), beforeCallId);
    start = cursor < 0 ? 0 : Math.max(cursor - limit, 0);
  }
  const rows = ordered.slice(start, start + limit);
  const first = rows[0];
  const last = rows[rows.length - 1];
  const remaining = Math.max(ordered.length - (start + rows.length), 0);
  return {
    ok: true,
    rows: rows.map(row),
    total: ordered.length,
    limit,
    nextCursor:
      last === undefined ? null : { ts: last.ts, callId: last.callId },
    prevCursor:
      first === undefined ? null : { ts: first.ts, callId: first.callId },
    anchor:
      ordered.length === 0
        ? null
        : { ts: ordered[0]?.ts ?? 0, callId: ordered[0]?.callId ?? '' },
    newer: 0,
    remaining,
  };
}

/**
 * A list route backed by a fixed set of rows plus the paging contract.
 *
 * The handler is the real decoding path: it returns the same shape the host
 * route produces, including the cursors and the traversal head, so the panel is
 * exercised against the contract rather than a stub of it.
 */
function listHandler(specs: readonly RowSpec[]) {
  return http.get('*/api/arbiter/logs', ({ request }) => {
    const url = new URL(request.url);
    const query = url.searchParams.get('q');
    const matched =
      query === null
        ? specs
        : specs.filter((item) => (item.command ?? '').includes(query));
    return HttpResponse.json(pageOf(matched, url));
  });
}

const SEEDED: readonly RowSpec[] = Array.from({ length: 60 }, (_, index) => ({
  callId: `call-${String(index).padStart(3, '0')}`,
  ts: 1_700_000_000_000 - index * 1_000,
  command: index === 3 ? 'git push --force' : `echo ${String(index)}`,
  result: index % 2 === 0 ? 'review-allow' : 'review-deny',
}));

/** The row button whose text contains a summary; a missing row is a failure. */
function rowButtonFor(summary: string): HTMLElement {
  const found = screen
    .getAllByRole('button')
    .find((candidate) => candidate.textContent.includes(summary));
  if (found === undefined) throw new Error(`no row button matching ${summary}`);
  return found;
}

describe('log list paging', () => {
  test('shows the first page, its total, and walks forward and back', async () => {
    server.use(listHandler(SEEDED));
    const { user } = renderClient(<LogsPanel />);
    expect(await screen.findByText('共 60 条')).toBeInTheDocument();
    expect(screen.getByText('第 1 / 3 页')).toBeInTheDocument();
    expect(screen.getByText('第 1–25 条')).toBeInTheDocument();
    // Page one starts at the newest row.
    expect(rowButtonFor('echo 0')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => {
      expect(screen.getByText('第 2 / 3 页')).toBeInTheDocument();
    });
    expect(screen.getByText('第 26–50 条')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '上一页' }));
    await waitFor(() => {
      expect(screen.getByText('第 1 / 3 页')).toBeInTheDocument();
    });
    expect(screen.getByText('第 1–25 条')).toBeInTheDocument();
  });

  test('disables the boundary moves instead of requesting past them', async () => {
    server.use(listHandler([{ callId: 'only', ts: 1 }]));
    const { user } = renderClient(<LogsPanel />);
    expect(await screen.findByText('第 1 / 1 页')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '下一页' }));
    // A disabled control is not a page move, so the position is unchanged.
    expect(screen.getByText('第 1 / 1 页')).toBeInTheDocument();
  });

  test('renders an empty audit trail as an empty list, not an error', async () => {
    server.use(listHandler([]));
    renderClient(<LogsPanel />);
    expect(await screen.findByText('没有记录。')).toBeInTheDocument();
    expect(screen.getByText('没有可浏览的页')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('renders an unavailable store as an error, never as an empty history', async () => {
    server.use(
      http.get('*/api/arbiter/logs', () =>
        HttpResponse.json(
          { ok: false, code: 'audit-unavailable', rows: [], total: 0 },
          { status: 503 },
        ),
      ),
    );
    renderClient(<LogsPanel />);
    // A 503 reaches the panel as a rejected promise, not as a decoded page, so
    // this is the transport path the storage-unavailable message must cover.
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('审计存储不可用');
    // The empty-state sentence would claim the records do not exist, and the
    // raw transport message is not an explanation the operator can act on.
    expect(screen.queryByText('没有记录。')).toBeNull();
    expect(status).not.toHaveTextContent('Arbiter request failed');
  });

  test('a filter change starts over at the first page', async () => {
    const requests: string[] = [];
    server.use(
      http.get('*/api/arbiter/logs', ({ request }) => {
        const url = new URL(request.url);
        requests.push(
          `${url.searchParams.get('afterCallId') === null ? 'first' : 'cursor'}:${String(url.searchParams.get('q'))}`,
        );
        const query = url.searchParams.get('q');
        const matched =
          query === null
            ? SEEDED
            : SEEDED.filter((item) => (item.command ?? '').includes(query));
        return HttpResponse.json(pageOf(matched, url));
      }),
    );
    const { user } = renderClient(<LogsPanel />);
    await screen.findByText('第 1 / 3 页');
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByText('第 2 / 3 页');
    const search = screen.getByRole('textbox', { name: '搜索' });
    await user.type(search, 'echo 1');
    await user.click(screen.getByRole('button', { name: '应用筛选' }));
    // The new filter's first read must not carry the old page's cursor.
    await waitFor(() => {
      expect(requests.at(-1)).toBe('first:echo 1');
    });
    expect(await screen.findByText('第 1 / 1 页')).toBeInTheDocument();
  });

  test('the reader stays on a historical page while new records arrive', async () => {
    let arrived = 0;
    server.use(
      http.get('*/api/arbiter/logs', ({ request }) => {
        const url = new URL(request.url);
        const page = pageOf(SEEDED, url);
        // A call lands above the traversal head: the rows under the reader must
        // not move, and the arrival is only reported when asked for.
        return HttpResponse.json({ ...page, newer: arrived });
      }),
    );
    const { user } = renderClient(<LogsPanel />);
    await screen.findByText('第 1 / 3 页');
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByText('第 2 / 3 页');
    // A new call arrives; nothing polls, so the table still shows page two.
    arrived = 1;
    expect(screen.getByText('第 2 / 3 页')).toBeInTheDocument();
    expect(rowButtonFor('echo 25')).toBeInTheDocument();
    // The explicit refresh reports the arrivals and offers the jump back.
    await user.click(screen.getByRole('button', { name: '刷新' }));
    expect(await screen.findByText(/有 1 条新记录/)).toBeInTheDocument();
    expect(screen.getByText('第 2 / 3 页')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '回到最新一页' }));
    await waitFor(() => {
      expect(screen.getByText('第 1 / 3 页')).toBeInTheDocument();
    });
  });

  test('a page whose rows were cleared is corrected to a page that has rows', async () => {
    const requests: string[] = [];
    let remaining = SEEDED.length;
    server.use(
      http.get('*/api/arbiter/logs', ({ request }) => {
        const url = new URL(request.url);
        const afterTs = url.searchParams.get('afterTs');
        const tail = url.searchParams.get('tail') === '1';
        // The tail was deleted after the reader advanced: the cursor points past
        // the last surviving row, so the read comes back empty with a total.
        if (afterTs !== null && !tail && remaining < 30) {
          requests.push('stale');
          return HttpResponse.json({
            ok: true,
            rows: [],
            total: remaining,
            limit: 25,
            nextCursor: null,
            prevCursor: null,
            anchor: { ts: SEEDED[0]?.ts ?? 0, callId: SEEDED[0]?.callId ?? '' },
            newer: 0,
            remaining: 0,
          });
        }
        requests.push(tail ? 'tail' : 'page');
        return HttpResponse.json(pageOf(SEEDED.slice(0, remaining), url));
      }),
    );
    const { user } = renderClient(<LogsPanel />);
    await screen.findByText('第 1 / 3 页');
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByText('第 2 / 3 页');
    remaining = 15;
    requests.length = 0;
    await user.click(screen.getByRole('button', { name: '刷新' }));
    // Exactly one correction follows the empty read, and it lands on real rows.
    await waitFor(() => {
      expect(screen.getByText('共 15 条')).toBeInTheDocument();
    });
    // Exactly one correction follows the empty read, and it lands on the last
    // page that still has rows — not on the first page, which would move the
    // reader somewhere they never asked to be.
    expect(requests).toEqual(['stale', 'tail']);
    expect(screen.getByText('第 1 / 1 页')).toBeInTheDocument();
    expect(rowButtonFor('echo 0')).toBeInTheDocument();
  });

  test('an insertion inside the read region never opens a page of already-seen rows', async () => {
    // Four rows, page size 25 is not enough to expose the arithmetic, so the
    // sample uses a page that ends exactly at the fourth row.
    const four: readonly RowSpec[] = [
      { callId: 'A', ts: 100 },
      { callId: 'B', ts: 90 },
      { callId: 'C', ts: 80 },
      { callId: 'D', ts: 70 },
    ];
    let extra: readonly RowSpec[] = [];
    server.use(
      http.get('*/api/arbiter/logs', ({ request }) => {
        const url = new URL(request.url);
        // The set grows from four to five after the reader has paged through it.
        const page = pageOf([...four, ...extra], url);
        return HttpResponse.json({
          ...page,
          limit: 5,
          remaining: 0,
        });
      }),
    );
    const { user } = renderClient(<LogsPanel />);
    await screen.findByText('共 4 条');
    extra = [{ callId: 'X', ts: 95 }];
    // The reported total is now five, but the traversal had no further page and
    // must not offer one: doing so would show an already-read row.
    await user.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => {
      expect(screen.getByText('共 5 条')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  });

  test('previous restores the page that was read, and keeps walking back', async () => {
    // Three pages of two rows. A backward *query* would return whatever now
    // precedes the cursor; restoring shows exactly the pages that were read, and
    // consumes each entry so repeated presses keep moving back.
    let withInsert = false;
    server.use(
      http.get('*/api/arbiter/logs', ({ request }) => {
        const url = new URL(request.url);
        const six: readonly RowSpec[] = [
          { callId: 'A', ts: 100 },
          { callId: 'B', ts: 90 },
          { callId: 'C', ts: 80 },
          { callId: 'D', ts: 70 },
          { callId: 'E', ts: 60 },
          { callId: 'F', ts: 50 },
        ];
        // X sorts between A and B once it exists; the traversal still counts the
        // six rows it started with.
        const specs: readonly RowSpec[] = withInsert
          ? [...six.slice(0, 1), { callId: 'X', ts: 95 }, ...six.slice(1)]
          : six;
        const afterCallId = url.searchParams.get('afterCallId');
        const start =
          afterCallId === null
            ? 0
            : specs.findIndex((item) => item.callId === afterCallId) + 1;
        const page = specs.slice(start, start + 2);
        const last = page[page.length - 1];
        return HttpResponse.json({
          ok: true,
          rows: page.map(row),
          total: 6,
          limit: 2,
          nextCursor:
            last === undefined ? null : { ts: last.ts, callId: last.callId },
          prevCursor:
            page[0] === undefined
              ? null
              : { ts: page[0].ts, callId: page[0].callId },
          anchor: { ts: 100, callId: 'A' },
          newer: 0,
          remaining: Math.max(6 - (start + page.length), 0),
        });
      }),
    );
    const { user } = renderClient(<LogsPanel />);
    await screen.findByText('共 6 条');
    expect(rowButtonFor('echo A')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => {
      expect(rowButtonFor('echo C')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => {
      expect(rowButtonFor('echo E')).toBeInTheDocument();
    });
    // The insertion lands between the pages the reader already walked.
    withInsert = true;
    // First Previous returns page two, not the inserted row.
    await user.click(screen.getByRole('button', { name: '上一页' }));
    await waitFor(() => {
      expect(rowButtonFor('echo C')).toBeInTheDocument();
    });
    expect(rowButtonFor('echo D')).toBeInTheDocument();
    expect(screen.queryByText('echo X', { exact: false })).toBeNull();
    // A second Previous keeps walking back instead of re-showing page two.
    await user.click(screen.getByRole('button', { name: '上一页' }));
    await waitFor(() => {
      expect(rowButtonFor('echo A')).toBeInTheDocument();
    });
    expect(rowButtonFor('echo B')).toBeInTheDocument();
    expect(screen.queryByText('echo C', { exact: false })).toBeNull();
    // At the start of the traversal there is nowhere left to go back to.
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  });

  test('a failed read leaves the reading position and its history untouched', async () => {
    let failNext = false;
    server.use(
      http.get('*/api/arbiter/logs', ({ request }) => {
        const url = new URL(request.url);
        if (failNext && url.searchParams.get('afterCallId') !== null) {
          return HttpResponse.json(
            { ok: false, code: 'audit-unavailable', rows: [], total: 0 },
            { status: 503 },
          );
        }
        return HttpResponse.json(pageOf(SEEDED, url));
      }),
    );
    const { user } = renderClient(<LogsPanel />);
    await screen.findByText('第 1 / 3 页');
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByText('第 2 / 3 页');
    // Page three fails: the reader stays on page two, and Previous still goes to
    // page one rather than to the page they were already looking at.
    failNext = true;
    await user.click(screen.getByRole('button', { name: '下一页' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      '审计存储不可用',
    );
    expect(screen.getByText('第 2 / 3 页')).toBeInTheDocument();
    failNext = false;
    await user.click(screen.getByRole('button', { name: '上一页' }));
    await waitFor(() => {
      expect(screen.getByText('第 1 / 3 页')).toBeInTheDocument();
    });
    expect(rowButtonFor('echo 0')).toBeInTheDocument();
  });

  test('a failed navigation stays failed through a later successful refresh', async () => {
    // Page one succeeds, Next fails, and then Refresh succeeds. The abandoned
    // move must not be committed by that unrelated success: Previous has to stay
    // disabled because the reader never left page one.
    let failNext = true;
    server.use(
      http.get('*/api/arbiter/logs', ({ request }) => {
        const url = new URL(request.url);
        if (failNext && url.searchParams.get('afterCallId') !== null) {
          return HttpResponse.json(
            { ok: false, code: 'audit-unavailable', rows: [], total: 0 },
            { status: 503 },
          );
        }
        return HttpResponse.json(pageOf(SEEDED, url));
      }),
    );
    const { user } = renderClient(<LogsPanel />);
    await screen.findByText('第 1 / 3 页');
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '下一页' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      '审计存储不可用',
    );
    expect(screen.getByText('第 1 / 3 页')).toBeInTheDocument();
    // The refresh re-reads page one; it is not the navigation that failed.
    failNext = false;
    await user.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => {
      expect(screen.queryByRole('status')).toBeNull();
    });
    expect(screen.getByText('第 1 / 3 页')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  });

  test('a failed navigation from page two still lets Previous reach page one', async () => {
    let failNext = false;
    server.use(
      http.get('*/api/arbiter/logs', ({ request }) => {
        const url = new URL(request.url);
        const afterCallId = url.searchParams.get('afterCallId');
        if (
          failNext &&
          afterCallId !== null &&
          afterCallId !== (SEEDED[24]?.callId ?? '')
        ) {
          return HttpResponse.json(
            { ok: false, code: 'audit-unavailable', rows: [], total: 0 },
            { status: 503 },
          );
        }
        return HttpResponse.json(pageOf(SEEDED, url));
      }),
    );
    const { user } = renderClient(<LogsPanel />);
    await screen.findByText('第 1 / 3 页');
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByText('第 2 / 3 页');
    failNext = true;
    await user.click(screen.getByRole('button', { name: '下一页' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      '审计存储不可用',
    );
    expect(screen.getByText('第 2 / 3 页')).toBeInTheDocument();
    failNext = false;
    await user.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => {
      expect(screen.queryByRole('status')).toBeNull();
    });
    // One Previous lands on page one, not on page two again.
    await user.click(screen.getByRole('button', { name: '上一页' }));
    await waitFor(() => {
      expect(screen.getByText('第 1 / 3 页')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  });

  test('the pager never advertises a page it cannot reach', async () => {
    // Five matching rows, page size five, but the host reports that no row
    // follows: the traversal ends at page one even though the total suggests a
    // second page. This is the state an insertion below the reader creates.
    server.use(
      http.get('*/api/arbiter/logs', () => {
        const specs = SEEDED.slice(0, 25);
        return HttpResponse.json({
          ok: true,
          rows: specs.map(row),
          // A live total larger than what the traversal can reach: an insertion
          // below the reader raised it, but no page follows.
          total: 30,
          limit: 25,
          nextCursor: { ts: 0, callId: 'last' },
          prevCursor: { ts: specs[0]?.ts ?? 0, callId: specs[0]?.callId ?? '' },
          anchor: { ts: specs[0]?.ts ?? 0, callId: specs[0]?.callId ?? '' },
          newer: 0,
          remaining: 0,
        });
      }),
    );
    renderClient(<LogsPanel />);
    await screen.findByText('共 30 条');
    // The count reflects the reachable pages, and Next is genuinely exhausted.
    expect(screen.getByText('第 1 / 1 页')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
    expect(screen.getByText('第 1–25 条')).toBeInTheDocument();
  });

  test('a filter change drops the remembered pages', async () => {
    server.use(listHandler(SEEDED));
    const { user } = renderClient(<LogsPanel />);
    await screen.findByText('第 1 / 3 页');
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByText('第 2 / 3 页');
    // Narrowing the set restarts it, so "previous" must not restore a page from
    // the result set the filter replaced.
    const search = screen.getByRole('textbox', { name: '搜索' });
    await user.type(search, 'echo 1');
    await user.click(screen.getByRole('button', { name: '应用筛选' }));
    expect(await screen.findByText('第 1 / 1 页')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  });

  test('the list offers main and subagent classification and sends it', async () => {
    let requested: string | null = null;
    server.use(
      http.get('*/api/arbiter/logs', ({ request }) => {
        const url = new URL(request.url);
        requested = url.searchParams.get('sessionKind');
        return HttpResponse.json(pageOf(SEEDED, url));
      }),
    );
    const { user } = renderClient(<LogsPanel />);
    await screen.findByText('共 60 条');
    const kind = screen.getByRole('combobox', { name: '会话类型' });
    expect(screen.getByRole('option', { name: '主会话' })).toBeInTheDocument();
    await user.selectOptions(kind, 'subagent');
    await user.click(screen.getByRole('button', { name: '应用筛选' }));
    await waitFor(() => {
      expect(requested).toBe('subagent');
    });
  });

  test('a filter that matches nothing explains the filter, not an empty audit', async () => {
    server.use(listHandler(SEEDED));
    const { user } = renderClient(<LogsPanel />);
    await screen.findByText('共 60 条');
    const search = screen.getByRole('textbox', { name: '搜索' });
    await user.type(search, 'no-such-command');
    await user.click(screen.getByRole('button', { name: '应用筛选' }));
    expect(
      await screen.findByText('没有符合筛选条件的记录。'),
    ).toBeInTheDocument();
    expect(screen.queryByText('没有记录。')).toBeNull();
  });
});

describe('log list detail loading', () => {
  test('loads a detail only when a row is opened', async () => {
    const detailRequests: string[] = [];
    server.use(
      listHandler(SEEDED),
      http.get('*/api/arbiter/log', ({ request }) => {
        const url = new URL(request.url);
        detailRequests.push(url.searchParams.get('callId') ?? '');
        return HttpResponse.json({
          ok: true,
          record: {
            callId: url.searchParams.get('callId') ?? '',
            ts: 1_700_000_000_000,
            sessionId: 'session-1',
            sessionKind: 'main',
            parentSession: null,
            tool: 'bash',
            arguments: { command: 'git push --force' },
            cwd: '/workspace',
            fingerprint: 'fp',
            configRevision: 'rev-1',
            approvalMode: 'normal',
            executionMode: 'trusted',
            result: 'review-deny',
            reason: 'force push is denied',
            trace: [],
            effect: null,
            sessionRecordState: 'written',
            signals: null,
            policyStrategy: null,
            decisionRules: [],
            executionStatus: 'pending',
            stages: [],
            snapshot: null,
            modelCalls: [],
            config: null,
          },
        });
      }),
    );
    const { user } = renderClient(<LogsPanel />);
    // Every list row is present before anything is opened.
    await screen.findByText(/git push --force/);
    expect(detailRequests).toEqual([]);
    await user.click(rowButtonFor('git push --force'));
    await waitFor(() => {
      expect(detailRequests).toEqual(['call-003']);
    });
    expect(await screen.findByText('force push is denied')).toBeInTheDocument();
    // Opening one row is one detail read, not a fetch of every page's material.
    expect(detailRequests).toHaveLength(1);
  });

  test('rows are reachable and openable from the keyboard', async () => {
    server.use(
      listHandler(SEEDED),
      http.get('*/api/arbiter/log', ({ request }) => {
        const url = new URL(request.url);
        return HttpResponse.json({
          ok: true,
          record: {
            callId: url.searchParams.get('callId') ?? '',
            ts: 1_700_000_000_000,
            sessionId: 'session-1',
            sessionKind: 'main',
            parentSession: null,
            tool: 'bash',
            arguments: {},
            cwd: '/workspace',
            fingerprint: 'fp',
            configRevision: 'rev-1',
            approvalMode: 'normal',
            executionMode: 'trusted',
            result: 'review-allow',
            reason: 'allowed by review',
            trace: [],
            effect: null,
            sessionRecordState: 'written',
            signals: null,
            policyStrategy: null,
            decisionRules: [],
            executionStatus: 'pending',
            stages: [],
            snapshot: null,
            modelCalls: [],
            config: null,
          },
        });
      }),
    );
    const { user } = renderClient(<LogsPanel />);
    await screen.findByText('共 60 条');
    const first = rowButtonFor('echo 0');
    first.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('allowed by review')).toBeInTheDocument();
  });

  test('a failing detail read reports the failure without losing the list', async () => {
    server.use(
      listHandler(SEEDED),
      http.get('*/api/arbiter/log', () =>
        HttpResponse.json({ ok: false, code: 'not-found' }, { status: 404 }),
      ),
    );
    const { user } = renderClient(<LogsPanel />);
    await screen.findByText('共 60 条');
    await user.click(rowButtonFor('echo 0'));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('读取调用记录失败');
    // The list itself is still there: a detail failure is not a list failure.
    expect(screen.getByText('共 60 条')).toBeInTheDocument();
  });
});

describe('log list stale responses', () => {
  test('an older response cannot overwrite a newer one', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    server.use(
      http.get('*/api/arbiter/logs', async ({ request }) => {
        const url = new URL(request.url);
        const query = url.searchParams.get('q');
        call += 1;
        if (query === 'slow') {
          // The older filter's response arrives last on purpose.
          await firstGate;
          return HttpResponse.json({
            ok: true,
            rows: [row({ callId: 'stale', ts: 1, command: 'stale row' })],
            total: 1,
            limit: 25,
            nextCursor: { ts: 1, callId: 'stale' },
            prevCursor: { ts: 1, callId: 'stale' },
            anchor: { ts: 1, callId: 'stale' },
            newer: 0,
            remaining: 0,
          });
        }
        return HttpResponse.json({
          ok: true,
          rows: [row({ callId: 'fresh', ts: 2, command: 'fresh row' })],
          total: 1,
          limit: 25,
          nextCursor: { ts: 2, callId: 'fresh' },
          prevCursor: { ts: 2, callId: 'fresh' },
          anchor: { ts: 2, callId: 'fresh' },
          newer: 0,
          remaining: 0,
        });
      }),
    );
    const { user } = renderClient(<LogsPanel />);
    await screen.findByText('fresh row');
    const search = screen.getByRole('textbox', { name: '搜索' });
    await user.type(search, 'slow');
    await user.click(screen.getByRole('button', { name: '应用筛选' }));
    // Replace the pending slow filter with a newer one before it resolves.
    await user.clear(search);
    await user.type(search, 'fast');
    await user.click(screen.getByRole('button', { name: '应用筛选' }));
    await screen.findByText('fresh row');
    releaseFirst?.();
    await waitFor(() => {
      expect(call).toBeGreaterThanOrEqual(3);
    });
    // The stale answer must not replace the rows the current filter produced.
    await waitFor(() => {
      expect(screen.queryByText('stale row')).toBeNull();
    });
    expect(screen.getByText('fresh row')).toBeInTheDocument();
  });

  test('a stale error does not replace a newer successful result', async () => {
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    server.use(
      http.get('*/api/arbiter/logs', async ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get('q') === 'fail') {
          await gate;
          return HttpResponse.json(
            { ok: false, code: 'audit-unavailable', rows: [], total: 0 },
            { status: 503 },
          );
        }
        return HttpResponse.json({
          ok: true,
          rows: [row({ callId: 'fresh', ts: 2, command: 'fresh row' })],
          total: 1,
          limit: 25,
          nextCursor: { ts: 2, callId: 'fresh' },
          prevCursor: { ts: 2, callId: 'fresh' },
          anchor: { ts: 2, callId: 'fresh' },
          newer: 0,
          remaining: 0,
        });
      }),
    );
    const { user } = renderClient(<LogsPanel />);
    await screen.findByText('fresh row');
    const search = screen.getByRole('textbox', { name: '搜索' });
    await user.type(search, 'fail');
    await user.click(screen.getByRole('button', { name: '应用筛选' }));
    await user.clear(search);
    await user.type(search, 'ok');
    await user.click(screen.getByRole('button', { name: '应用筛选' }));
    await screen.findByText('fresh row');
    releaseFirst?.();
    await waitFor(() => {
      expect(screen.getByText('fresh row')).toBeInTheDocument();
    });
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('log list locale wiring', () => {
  test('renders Chinese labels with interpolated counts and page numbers', async () => {
    server.use(listHandler(SEEDED));
    renderClient(<LogsPanel />);
    expect(await screen.findByText('共 60 条')).toBeInTheDocument();
    expect(screen.getByText('第 1 / 3 页')).toBeInTheDocument();
    expect(screen.getByText('第 1–25 条')).toBeInTheDocument();
    expect(screen.getByText('工具与摘要')).toBeInTheDocument();
    expect(screen.getByText('最终裁决')).toBeInTheDocument();
    // No bare key, blank label or "undefined" reached the DOM.
    const text = document.body.textContent;
    expect(text).not.toContain('logs.');
    expect(text).not.toContain('undefined');
  });

  test('keeps operator content verbatim while localizing the labels', async () => {
    server.use(
      listHandler([
        {
          callId: 'verbatim',
          ts: 1_700_000_000_000,
          tool: 'bash',
          command: 'gh pr view 42 --json title',
          result: 'review-deny',
          ruleId: 'no-push',
        },
      ]),
    );
    renderClient(<LogsPanel />);
    expect(
      await screen.findByText('gh pr view 42 --json title'),
    ).toBeInTheDocument();
    expect(screen.getByText('bash')).toBeInTheDocument();
    // The verdict label appears both in the filter options and on the row; the
    // row's own cell is the one that must not carry the raw protocol value.
    const verdictCells = screen.getAllByText('审查拒绝');
    expect(verdictCells.length).toBeGreaterThan(1);
    // The stored verdict is a protocol value; only its label is translated.
    expect(screen.queryByText('review-deny')).toBeNull();
  });

  test('falls back per key to Chinese when the host switches to English', async () => {
    server.use(listHandler(SEEDED));
    const view = renderClient(<LogsPanel />, { locale: 'en' });
    // English has no logs module yet, so every key falls back to Chinese.
    expect(await screen.findByText('共 60 条')).toBeInTheDocument();
    expect(screen.getByText('最终裁决')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('logs.');
    view.i18n.translate('logs.pager.next');
    expect(view.i18n.translate('logs.pager.next')).toBe('下一页');
  });

  test('marks a record whose format is newer than this build', async () => {
    server.use(
      listHandler([
        {
          callId: 'future',
          ts: 1_700_000_000_000,
          command: 'echo future',
          unreadable: true,
        },
      ]),
    );
    renderClient(<LogsPanel />);
    expect(
      await screen.findByText('该记录的格式高于当前插件版本，仅显示标识信息。'),
    ).toBeInTheDocument();
  });
});

describe('log panel wiring on the page', () => {
  test('the logs tab loads the list without fetching any detail', async () => {
    const detailRequests: string[] = [];
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      listHandler(SEEDED),
      http.get('*/api/arbiter/log', ({ request }) => {
        const url = new URL(request.url);
        detailRequests.push(url.searchParams.get('callId') ?? '');
        return HttpResponse.json(
          { ok: false, code: 'not-found' },
          { status: 404 },
        );
      }),
    );
    const { user } = renderClient(<ArbiterPage />);
    await user.click(await screen.findByRole('button', { name: '日志与详情' }));
    expect(await screen.findByText('共 60 条')).toBeInTheDocument();
    expect(screen.getByText('第 1 / 3 页')).toBeInTheDocument();
    expect(detailRequests).toEqual([]);
  });
});

describe('log list page count', () => {
  test('the page count is exact and does not shrink as the reader advances', async () => {
    // Three pages of 25. An insertion behind the reader raises the total before
    // page two is read; deriving pages from that total would advertise a fourth
    // page and then retract it on the last page.
    let withInsert = false;
    server.use(
      http.get('*/api/arbiter/logs', ({ request }) => {
        const url = new URL(request.url);
        const rows = withInsert
          ? [
              SEEDED[0] ?? { callId: 'x', ts: 0 },
              { callId: 'inserted', ts: 1_699_999_999_500 },
              ...SEEDED.slice(1),
            ]
          : SEEDED;
        const afterCallId = url.searchParams.get('afterCallId');
        const start =
          afterCallId === null
            ? 0
            : rows.findIndex((item) => item.callId === afterCallId) + 1;
        const page = rows.slice(start, start + 25);
        const last = page[page.length - 1];
        return HttpResponse.json({
          ok: true,
          rows: page.map(row),
          // The live total includes the insertion once it exists.
          total: rows.length,
          limit: 25,
          nextCursor:
            last === undefined ? null : { ts: last.ts, callId: last.callId },
          prevCursor:
            page[0] === undefined
              ? null
              : { ts: page[0].ts, callId: page[0].callId },
          anchor: {
            ts: SEEDED[0]?.ts ?? 0,
            callId: SEEDED[0]?.callId ?? '',
          },
          newer: 0,
          // The traversal itself still has the rows it started with.
          remaining: Math.max(SEEDED.length - (start + page.length), 0),
        });
      }),
    );
    const { user } = renderClient(<LogsPanel />);
    await screen.findByText('共 60 条');
    expect(screen.getByText('第 1 / 3 页')).toBeInTheDocument();
    withInsert = true;
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => {
      expect(screen.getByText('第 2 / 3 页')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => {
      expect(screen.getByText('第 3 / 3 页')).toBeInTheDocument();
    });
    // The count never advertised a fourth page along the way.
    expect(screen.queryByText('第 2 / 4 页')).toBeNull();
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  });
});

describe('log list position bookkeeping', () => {
  test('a last page shorter than the page size still ends the traversal', async () => {
    // 41 rows: page two is not full by design, and the "next" move must follow
    // the remaining count rather than a row count of one page.
    server.use(listHandler(SEEDED.slice(0, 41)));
    const { user } = renderClient(<LogsPanel />);
    await screen.findByText('共 41 条');
    expect(screen.getByText('第 1 / 2 页')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => {
      expect(screen.getByText('第 2 / 2 页')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '上一页' })).toBeEnabled();
    expect(screen.getByText('第 26–41 条')).toBeInTheDocument();
  });

  test('the position advances by the rows actually read', async () => {
    const specs = SEEDED.slice(0, 60);
    server.use(listHandler(specs));
    const { user } = renderClient(<LogsPanel />);
    await screen.findByText('第 1 / 3 页');
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByText('第 2 / 3 页');
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByText('第 3 / 3 页');
    expect(screen.getByText('第 51–60 条')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  });
});
