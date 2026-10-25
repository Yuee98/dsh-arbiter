import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, test } from 'vitest';

import { ArbiterPage } from '../../src/client/index.js';
import type { CoexistenceView } from '../../src/client/view-types.js';
import { setupApiMock } from '../helpers/api-mock.js';
import { effectiveState } from '../helpers/client-state.js';
import { renderClient } from '../helpers/render-client.js';

const server = setupApiMock();

const OFFICIAL = '@deepseek-ai/dsh-experimental-auto-review';

function blocking(overrides: Partial<CoexistenceView> = {}): CoexistenceView {
  return {
    detection: 'complete',
    missing: [],
    blocked: true,
    reason: 'official-running',
    official: {
      present: true,
      module: OFFICIAL,
      enabled: true,
      running: true,
      phase: 'active',
    },
    autoSlot: 'arbiter',
    conflicts: [
      {
        id: 'official-auto-review',
        severity: 'blocking',
        kind: 'official-auto-review',
        source: OFFICIAL,
        entryId: 'auto-review',
        capability: 'permissionPresets.auto',
        detail: null,
      },
    ],
    notices: [
      {
        id: 'coexistence-1',
        conflictId: 'official-auto-review',
        severity: 'blocking',
        kind: 'official-auto-review',
        source: OFFICIAL,
        capability: 'permissionPresets.auto',
        at: 1_700_000_000_000,
        acknowledged: false,
      },
    ],
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function warningOnly(
  overrides: Partial<CoexistenceView> = {},
): CoexistenceView {
  return {
    ...blocking(),
    blocked: false,
    reason: null,
    official: {
      present: false,
      module: OFFICIAL,
      enabled: false,
      running: false,
      phase: null,
    },
    conflicts: [
      {
        id: 'hook:other:tools/pre-execute',
        severity: 'warning',
        kind: 'approval-hook',
        source: 'third-party-reviewer',
        entryId: 'other',
        capability: 'tools/pre-execute',
        detail: 'prepend',
      },
    ],
    notices: [
      {
        id: 'coexistence-2',
        conflictId: 'hook:other:tools/pre-execute',
        severity: 'warning',
        kind: 'approval-hook',
        source: 'third-party-reviewer',
        capability: 'tools/pre-execute',
        at: 1_700_000_000_000,
        acknowledged: false,
      },
    ],
    ...overrides,
  };
}

/** The one notice this fixture always produces; useful for its exact id. */
const NOTICE_ID = 'coexistence-1';

function acknowledgedNotice(): CoexistenceView['notices'][number] {
  const first = blocking().notices[0];
  if (first === undefined) throw new TypeError('fixture has no notice');
  return { ...first, acknowledged: true };
}

function useState(coexistence: CoexistenceView | null): void {
  server.use(
    http.get('*/api/arbiter/state', () =>
      HttpResponse.json({ ...effectiveState(), coexistence }),
    ),
  );
}

describe('conflict reasons and handling guidance', () => {
  test('an official conflict shows why it blocks and how to clear it', async () => {
    useState(blocking());
    renderClient(<ArbiterPage />);
    const alert = await screen.findByRole('alertdialog', {
      name: '存在冲突的审批提供者',
    });
    // The exact reason names the provider the host actually observed.
    expect(alert).toHaveTextContent(OFFICIAL);
    expect(alert).toHaveTextContent('正在运行');
    // The way out is a concrete instruction, not a bare error.
    expect(alert).toHaveTextContent('插件管理');
    expect(alert).toHaveTextContent('停用官方 Auto Review');
    // The persistent section keeps the unresolved state visible.
    expect(await screen.findByText(/正在实际运行/)).toBeInTheDocument();
    expect(
      screen.getByText(/请在插件管理中关闭官方 Auto Review/),
    ).toBeInTheDocument();
  });

  test('acknowledging the reminder keeps the conflict visible', async () => {
    let acknowledged = false;
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json({
          ...effectiveState(),
          coexistence: blocking({
            notices: acknowledged ? [acknowledgedNotice()] : blocking().notices,
          }),
        }),
      ),
      http.post('*/api/arbiter/coexistence', async ({ request }) => {
        const body: unknown = await request.json();
        expect(body).toEqual({ noticeIds: [NOTICE_ID] });
        acknowledged = true;
        return HttpResponse.json({
          ok: true,
          coexistence: blocking({ notices: [acknowledgedNotice()] }),
        });
      }),
    );
    const { user } = renderClient(<ArbiterPage />);
    const alert = await screen.findByRole('alertdialog', {
      name: '存在冲突的审批提供者',
    });
    await user.click(within(alert).getByRole('button', { name: '知道了' }));
    // The reminder is gone for this period…
    await waitFor(() => {
      expect(
        screen.queryByRole('alertdialog', { name: '存在冲突的审批提供者' }),
      ).toBeNull();
    });
    // …but the conflict, its severity and its guidance are still on screen.
    expect(screen.getByText(/阻止/)).toBeInTheDocument();
    expect(
      screen.getByText(/请在插件管理中关闭官方 Auto Review/),
    ).toBeInTheDocument();
  });

  test('a third-party listener is a warning, not a block', async () => {
    useState(warningOnly());
    renderClient(<ArbiterPage />);
    // A warning uses a lightweight notice, never a modal.
    const notice = await screen.findByText('其他插件可能影响审批');
    expect(notice).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(
      screen.getAllByText(/third-party-reviewer 注册了 tools\/pre-execute/),
    ).toHaveLength(2);
    expect(
      screen.getByText(
        /Arbiter 继续按当前模式审查，现有门禁与其他宿主 guard 保持不变。/,
      ),
    ).toBeInTheDocument();
  });

  test('a partial detection says which surfaces were missing', async () => {
    useState(
      warningOnly({
        detection: 'partial',
        missing: ['loader'],
        conflicts: [],
        notices: [],
      }),
    );
    renderClient(<ArbiterPage />);
    expect(
      await screen.findByText(/部分公开接口不可用（loader）/),
    ).toBeInTheDocument();
    expect(
      screen.getByText('未检测到可能冲突的审批提供者。'),
    ).toBeInTheDocument();
  });
});

describe('interpolation and Chinese fallback', () => {
  test('a template is filled rather than rendered raw', async () => {
    useState(warningOnly());
    renderClient(<ArbiterPage />);
    const rows = await screen.findAllByText(
      /third-party-reviewer 注册了 tools\/pre-execute/,
    );
    for (const row of rows) {
      expect(row.textContent).not.toContain('{source}');
      expect(row.textContent).not.toContain('{capability}');
      expect(row.textContent).not.toContain('undefined');
    }
  });

  test('a missing English key falls back to Chinese per entry', async () => {
    useState(blocking());
    const { i18n, locale } = renderClient(<ArbiterPage />);
    await screen.findByRole('alertdialog', {
      name: '存在冲突的审批提供者',
    });
    locale.setLocale('en');
    await waitFor(() => {
      // English has no coexistence module yet: every leaf falls back to the
      // Chinese sentence instead of a key, a blank or `undefined`.
      const alert = screen.getByRole('alertdialog');
      expect(alert).toHaveTextContent('存在冲突的审批提供者');
      expect(alert.textContent).not.toMatch(/coexistence\./);
      expect(alert.textContent).not.toContain('undefined');
    });
    expect(i18n.translate('coexistence.title')).toBe('审批提供者共存');
    // A key with no translation anywhere still renders as the key, never blank.
    expect(i18n.translate('coexistence.missing.key')).toBe(
      'coexistence.missing.key',
    );
  });

  test('the state update replaces a stale conflict with the live one', async () => {
    const first = blocking();
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json({ ...effectiveState(), coexistence: first }),
      ),
    );
    const { user } = renderClient(<ArbiterPage />);
    await screen.findByRole('alertdialog', {
      name: '存在冲突的审批提供者',
    });
    // A later read reports no conflict: the section must follow the host.
    useState(
      warningOnly({ conflicts: [], notices: [], blocked: false, reason: null }),
    );
    await user.click(screen.getByRole('button', { name: '重新读取' }));
    await waitFor(() => {
      expect(
        screen.queryByRole('alertdialog', { name: '存在冲突的审批提供者' }),
      ).toBeNull();
    });
    expect(
      await screen.findByText('未检测到可能冲突的审批提供者。'),
    ).toBeInTheDocument();
  });
});
