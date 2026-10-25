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
 * A list route backed by a fixed set of rows plus the paging contract.
 *
 * The handler is the real decoding path: it returns the same shape the host
 * route produces, including the window it read and the traversal anchor, so the
 * panel is exercised against the contract rather than a stub of it.
 */
function listHandler(specs: readonly RowSpec[]) {
  return http.get('*/api/arbiter/logs', ({ request }) => {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get('limit') ?? '25');
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const query = url.searchParams.get('q');
    const matched =
      query === null
        ? specs
        : specs.filter((item) => (item.command ?? '').includes(query));
    const anchorTs = url.searchParams.get('anchorTs');
    const anchorCallId = url.searchParams.get('anchorCallId');
    const anchor =
      anchorTs === null || anchorCallId === null
        ? matched.length === 0
          ? null
          : { ts: matched[0]?.ts ?? 0, callId: matched[0]?.callId ?? '' }
        : { ts: Number(anchorTs), callId: anchorCallId };
    return HttpResponse.json({
      ok: true,
      rows: matched.slice(offset, offset + limit).map(row),
      total: matched.length,
      limit,
      offset,
      anchor,
      newer: 0,
    });
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
  test('shows the first page, its total, and walks forward', async () => {
    const offsets: number[] = [];
    server.use(
      http.get('*/api/arbiter/logs', ({ request }) => {
        const url = new URL(request.url);
        const offset = Number(url.searchParams.get('offset') ?? '0');
        offsets.push(offset);
        return HttpResponse.json({
          ok: true,
          rows: SEEDED.slice(offset, offset + 25).map(row),
          total: SEEDED.length,
          limit: 25,
          offset,
          anchor: { ts: SEEDED[0]?.ts ?? 0, callId: SEEDED[0]?.callId ?? '' },
          newer: 0,
        });
      }),
    );
    const { user } = renderClient(<LogsPanel />);
    expect(await screen.findByText('共 60 条')).toBeInTheDocument();
    expect(screen.getByText('第 1 / 3 页')).toBeInTheDocument();
    expect(screen.getByText('第 1–25 条')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => {
      expect(screen.getByText('第 2 / 3 页')).toBeInTheDocument();
    });
    expect(offsets).toEqual([0, 25]);
    expect(screen.getByText('第 26–50 条')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '上一页' }));
    await waitFor(() => {
      expect(screen.getByText('第 1 / 3 页')).toBeInTheDocument();
    });
    expect(offsets).toEqual([0, 25, 0]);
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

  test('renders a failed read as an error, never as an empty history', async () => {
    server.use(
      http.get('*/api/arbiter/logs', () =>
        HttpResponse.json(
          { ok: false, code: 'audit-unavailable', rows: [], total: 0 },
          { status: 503 },
        ),
      ),
    );
    renderClient(<LogsPanel />);
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('读取调用记录失败');
    // The empty-state sentence would claim the records do not exist.
    expect(screen.queryByText('没有记录。')).toBeNull();
  });

  test('a filter change starts over at the first page', async () => {
    const requests: string[] = [];
    server.use(
      http.get('*/api/arbiter/logs', ({ request }) => {
        const url = new URL(request.url);
        requests.push(
          `${String(url.searchParams.get('offset'))}:${String(url.searchParams.get('q'))}`,
        );
        const query = url.searchParams.get('q');
        const matched =
          query === null
            ? SEEDED
            : SEEDED.filter((item) => (item.command ?? '').includes(query));
        const offset = Number(url.searchParams.get('offset') ?? '0');
        return HttpResponse.json({
          ok: true,
          rows: matched.slice(offset, offset + 25).map(row),
          total: matched.length,
          limit: 25,
          offset,
          anchor: { ts: 1_000, callId: 'anchor' },
          newer: 0,
        });
      }),
    );
    const { user } = renderClient(<LogsPanel />);
    await screen.findByText('第 1 / 3 页');
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByText('第 2 / 3 页');
    const search = screen.getByRole('textbox', { name: '搜索' });
    await user.type(search, 'echo 1');
    await user.click(screen.getByRole('button', { name: '应用筛选' }));
    await waitFor(() => {
      expect(requests.at(-1)).toBe('0:echo 1');
    });
    // The new filter has a single page, and the window restarted at the top.
    expect(await screen.findByText('第 1 / 1 页')).toBeInTheDocument();
  });

  test('the reader stays on a historical page while new records arrive', async () => {
    let newest = 0;
    let total = 60;
    server.use(
      http.get('*/api/arbiter/logs', ({ request }) => {
        const url = new URL(request.url);
        const offset = Number(url.searchParams.get('offset') ?? '0');
        // Call 61 lands after the traversal started; because the reader holds an
        // anchor, the rows under them must not move.
        const rows = SEEDED.slice(offset, offset + 25).map(row);
        return HttpResponse.json({
          ok: true,
          rows,
          total,
          limit: 25,
          offset,
          anchor: { ts: SEEDED[0]?.ts ?? 0, callId: SEEDED[0]?.callId ?? '' },
          newer: newest,
        });
      }),
    );
    const { user } = renderClient(<LogsPanel />);
    await screen.findByText('第 1 / 3 页');
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByText('第 2 / 3 页');
    // A new call arrives; nothing polls, so the table still shows page two.
    newest = 1;
    total = 61;
    expect(screen.getByText('第 2 / 3 页')).toBeInTheDocument();
    expect(screen.getByText('echo 25', { exact: false })).toBeInTheDocument();
    // The explicit refresh reports the arrivals and offers the jump back.
    await user.click(screen.getByRole('button', { name: '刷新' }));
    const notice = await screen.findByText(/有 1 条新记录/);
    expect(notice).toBeInTheDocument();
    expect(screen.getByText('第 2 / 3 页')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '回到最新一页' }));
    await waitFor(() => {
      expect(screen.getByText('第 1 / 3 页')).toBeInTheDocument();
    });
  });

  test('a cleared last page is corrected to the page that still has rows', async () => {
    const requests: string[] = [];
    server.use(
      http.get('*/api/arbiter/logs', ({ request }) => {
        const url = new URL(request.url);
        const offset = Number(url.searchParams.get('offset') ?? '0');
        requests.push(String(offset));
        // Page three (offset 50) was cleared while the reader was on it: the
        // remaining rows occupy offsets 0–14 only.
        const remaining = 15;
        return HttpResponse.json({
          ok: true,
          rows: SEEDED.slice(offset, offset + 25)
            .map(row)
            .slice(0, Math.max(remaining - offset, 0)),
          total: remaining,
          limit: 25,
          offset,
          anchor: { ts: SEEDED[0]?.ts ?? 0, callId: SEEDED[0]?.callId ?? '' },
          newer: 0,
        });
      }),
    );
    const { user } = renderClient(<LogsPanel />);
    await screen.findByText('第 1 / 1 页');
    // Force the stale window the cleanup creates, then read again through the
    // same correction path the panel uses.
    requests.length = 0;
    await user.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => {
      expect(screen.getByText('共 15 条')).toBeInTheDocument();
    });
    expect(
      screen.queryByText('这一页没有记录，已跳到有内容的最后一页。'),
    ).toBeNull();
    expect(screen.getByText('第 1 / 1 页')).toBeInTheDocument();
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
            offset: 0,
            anchor: { ts: 1, callId: 'stale' },
            newer: 0,
          });
        }
        return HttpResponse.json({
          ok: true,
          rows: [row({ callId: 'fresh', ts: 2, command: 'fresh row' })],
          total: 1,
          limit: 25,
          offset: 0,
          anchor: { ts: 2, callId: 'fresh' },
          newer: 0,
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
          offset: 0,
          anchor: { ts: 2, callId: 'fresh' },
          newer: 0,
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
