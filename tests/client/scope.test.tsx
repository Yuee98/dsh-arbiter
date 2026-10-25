import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, test } from 'vitest';

import { ArbiterPage } from '../../src/client/index.js';
import { setupApiMock } from '../helpers/api-mock.js';
import { effectiveState } from '../helpers/client-state.js';
import { renderClient } from '../helpers/render-client.js';

const server = setupApiMock();

const FIRST_RELEASE_TABS = [
  '状态与模式',
  '规则',
  'Reviewer',
  '策略与高级',
  '日志与详情',
];

/**
 * The first release keeps ordinary rule management, Reviewer settings and
 * logs. Offline rule suggestions are deferred: the tab, the analysis entry and
 * the accept/reject actions must not be reachable from the page, and the page
 * must not call their endpoints even when the user visits every tab.
 */
describe('first-release page scope', () => {
  test('does not render offline suggestion navigation or actions', async () => {
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      http.get('*/api/arbiter/credentials', () =>
        HttpResponse.json({
          configured: false,
          source: null,
          supported: false,
        }),
      ),
      http.get('*/api/arbiter/logs', () =>
        HttpResponse.json({
          ok: true,
          rows: [],
          total: 0,
          health: { state: 'ok', lastError: null, dropped: 0, pending: 0 },
        }),
      ),
      http.get('*/api/arbiter/replay', () =>
        HttpResponse.json({ ok: true, items: [] }),
      ),
      http.get('*/api/arbiter/suggestions', () =>
        HttpResponse.json({ ok: true, candidates: [] }),
      ),
    );
    const { user } = renderClient(<ArbiterPage />);
    await screen.findByRole('checkbox', { name: '启用 dsh-arbiter' });

    for (const label of FIRST_RELEASE_TABS) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: '离线建议' })).toBeNull();
    expect(screen.queryByRole('heading', { name: '离线规则建议' })).toBeNull();

    // Visiting every remaining tab must not surface suggestion controls either.
    for (const label of FIRST_RELEASE_TABS) {
      await user.click(screen.getByRole('button', { name: label }));
      expect(screen.queryByText('离线规则建议')).toBeNull();
      expect(
        screen.queryByRole('button', { name: '分析最近 30 天' }),
      ).toBeNull();
      expect(screen.queryByRole('button', { name: '确认添加' })).toBeNull();
    }
  });

  test('keeps rule management, rule testing, Reviewer and logs usable', async () => {
    const requested: string[] = [];
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      http.get('*/api/arbiter/credentials', () =>
        HttpResponse.json({
          configured: false,
          source: null,
          supported: false,
        }),
      ),
      http.get('*/api/arbiter/logs', ({ request }) => {
        requested.push(new URL(request.url).pathname);
        return HttpResponse.json({
          ok: true,
          rows: [],
          total: 0,
          health: { state: 'ok', lastError: null, dropped: 0, pending: 0 },
        });
      }),
      http.get('*/api/arbiter/suggestions', () => {
        requested.push('/api/arbiter/suggestions');
        return HttpResponse.json({ ok: true, candidates: [] });
      }),
      http.post('*/api/arbiter/test', () => {
        requested.push('/api/arbiter/test');
        return HttpResponse.json({ ok: true, results: [] });
      }),
    );
    const { user } = renderClient(<ArbiterPage />);
    await screen.findByRole('checkbox', { name: '启用 dsh-arbiter' });

    await user.click(screen.getByRole('button', { name: '规则' }));
    expect(screen.getByRole('heading', { name: '规则' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '运行测试' }));
    expect(requested).toContain('/api/arbiter/test');

    await user.click(screen.getByRole('button', { name: 'Reviewer' }));
    expect(
      screen.getByRole('heading', { name: 'Reviewer 类型' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '日志与详情' }));
    expect(
      screen.getByRole('heading', { name: '调用记录' }),
    ).toBeInTheDocument();
    expect(requested).toContain('/api/arbiter/logs');
    // Deferred endpoints are never requested by the first-release page.
    expect(requested).not.toContain('/api/arbiter/suggestions');
  });
});
