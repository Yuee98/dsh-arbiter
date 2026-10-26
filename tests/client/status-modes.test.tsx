import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, test } from 'vitest';

import { ArbiterPage } from '../../src/client/index.js';
import { effectiveState } from '../helpers/client-state.js';
import { setupApiMock } from '../helpers/api-mock.js';
import { renderClient } from '../helpers/render-client.js';

const server = setupApiMock();

/** The page's own reads; a requested admission write would show up here. */
function usePageHandlers(options: { readonly writes: string[] }): void {
  server.use(
    http.get('*/api/arbiter/state', () => HttpResponse.json(effectiveState())),
    http.get('*/api/arbiter/credentials', () =>
      HttpResponse.json({
        state: 'unconfigured',
        configured: false,
        source: null,
      }),
    ),
    http.get('*/api/arbiter/sessions', () =>
      HttpResponse.json({
        ok: false,
        code: 'session-required',
        message: 'sessionId is required',
        revision: 'effective-1',
      }),
    ),
    http.post('*/api/arbiter/sessions', () => {
      options.writes.push('write');
      return HttpResponse.json({
        ok: false,
        code: 'refused',
        message: '',
        revision: 'r',
      });
    }),
    http.post('*/api/arbiter/validate', () =>
      HttpResponse.json({ ok: true, errors: [], warnings: [] }),
    ),
  );
}

const APPROVAL_TEXT: readonly {
  readonly label: string;
  readonly help: RegExp;
}[] = [
  {
    label: '交互审批',
    help: /同样进行自动审查/u,
  },
  {
    label: '自动审批',
    help: /不新发起审批/u,
  },
  {
    label: '自动审批 · 推进',
    help: /自动批准更多符合条件的操作/u,
  },
];

describe('approval-mode settings', () => {
  test('renders every mode tooltip through the locale, including auto review on normal', async () => {
    usePageHandlers({ writes: [] });
    const { user } = renderClient(<ArbiterPage />);
    const main = await screen.findByLabelText('主会话审批模式', {
      exact: false,
    });
    await waitFor(() => {
      expect(main).toHaveValue('normal');
    });
    // A real `<select>`: its options are reachable through the accessible
    // role, not by walking the DOM.
    const mainSelect = screen.getByRole('combobox', {
      name: /主会话审批模式/u,
    });
    for (const entry of APPROVAL_TEXT) {
      expect(
        within(mainSelect).getByRole('option', { name: entry.label }),
      ).toBeInTheDocument();
    }

    // Each mode's hint is the one for the *selected* value, so the tooltip is
    // checked by selecting that mode rather than by scraping all three at once.
    for (const entry of APPROVAL_TEXT) {
      await user.selectOptions(main, entry.label);
      // The subagent select renders the shared `strict` hint too, so a mode
      // both selects share legitimately matches more than once.
      expect((await screen.findAllByText(entry.help)).length).toBeGreaterThan(
        0,
      );
    }
    // `normal` is the key claim: it reviews automatically too, and asks a human
    // only when the review's conclusion needs one.
    await user.selectOptions(main, '交互审批');
    expect(screen.getByText(/同样进行自动审查/u)).toBeInTheDocument();
    expect(
      screen.getByText(/只有审查结论需要人工决定时才发起审批/u),
    ).toBeInTheDocument();
  });

  test('states that subagents have one shared mode and no per-subagent switch', async () => {
    usePageHandlers({ writes: [] });
    renderClient(<ArbiterPage />);
    await screen.findByLabelText('子任务审批模式', { exact: false });
    expect(
      screen.getByText(
        '所有子任务统一使用子任务审批模式，不提供单个子任务的模式开关。',
      ),
    ).toBeInTheDocument();
    // Only the two settings selects exist; no third control hints at an
    // individual subagent override.
    expect(screen.queryByLabelText(/单个子任务/u)).toBeNull();
    expect(screen.queryByLabelText(/子任务覆盖/u)).toBeNull();
  });

  test('shows both execution boundaries with their real sandbox consequence', async () => {
    usePageHandlers({ writes: [] });
    const { user } = renderClient(<ArbiterPage />);
    const boundary = await screen.findByLabelText('执行边界', { exact: false });
    expect(boundary).toHaveValue('guarded');
    expect(
      screen.getByText(/调用仍受宿主工作区文件沙箱约束/u),
    ).toBeInTheDocument();

    await user.selectOptions(boundary, 'trusted');
    await waitFor(() => {
      expect(boundary).toHaveValue('trusted');
    });
    expect(screen.getByText(/不施加工作区文件沙箱/u)).toBeInTheDocument();
    // Changing the option is a draft edit, not an admission switch.
    expect(screen.getByText(/修改配置不会启用任何会话/u)).toBeInTheDocument();
  });

  test('never posts an admission while the configuration is edited or saved', async () => {
    const writes: string[] = [];
    usePageHandlers({ writes });
    server.use(
      http.post('*/api/arbiter/save', () =>
        HttpResponse.json({
          ok: true,
          saved: true,
          changed: true,
          effective: true,
          effectiveRevision: 'effective-2',
          configSnapshotId: 'snapshot-2',
          activationRecorded: true,
          configFormat: 'arbiter-config-v1',
          configFormatExplicit: false,
          auditError: null,
          warnings: [],
        }),
      ),
    );
    const { user } = renderClient(<ArbiterPage />);
    const boundary = await screen.findByLabelText('执行边界', { exact: false });
    await user.selectOptions(boundary, 'trusted');
    await user.selectOptions(
      screen.getByLabelText('主会话审批模式', { exact: false }),
      'progress',
    );
    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    await waitFor(() => {
      expect(
        screen.getByTestId('arbiter-save-status'),
      ).not.toBeEmptyDOMElement();
    });
    expect(writes).toEqual([]);
  });
});
