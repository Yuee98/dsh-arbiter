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

/**
 * The two modes, and the one sentence that actually distinguishes them.
 *
 * Both apply the shared matrix; only the human question differs. A test that
 * checked "auto review happens" per mode would now pass for either one, so the
 * distinguishing claim is what each entry asserts.
 */
const APPROVAL_TEXT: readonly {
  readonly label: string;
  readonly help: RegExp;
}[] = [
  {
    label: '交互审批（ask）',
    help: /需要人工决定时向真人发起审批/u,
  },
  {
    label: '自动审批（no-ask）',
    help: /需要人工决定的调用不提问、不执行/u,
  },
];

describe('approval-mode settings', () => {
  test('renders both modes with the one thing that differs between them', async () => {
    usePageHandlers({ writes: [] });
    const { user } = renderClient(<ArbiterPage />);
    const main = await screen.findByLabelText('主会话审批模式', {
      exact: false,
    });
    await waitFor(() => {
      expect(main).toHaveValue('ask');
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
    // checked by selecting that mode rather than by scraping both at once.
    for (const entry of APPROVAL_TEXT) {
      await user.selectOptions(main, entry.label);
      // Both selects can legitimately render the same hint, so a shared mode
      // matches more than once.
      expect((await screen.findAllByText(entry.help)).length).toBeGreaterThan(
        0,
      );
    }
    // The key claim: `ask` reviews with the same matrix and asks a person only
    // when that matrix escalates. It is not a stricter review.
    await user.selectOptions(main, '交互审批（ask）');
    expect(
      screen.getByText(/需要人工决定时向真人发起审批/u),
    ).toBeInTheDocument();
    expect(screen.getByText(/模式只决定是否提问/u)).toBeInTheDocument();
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

  test('pins the subtask select to no-ask and disables it', async () => {
    usePageHandlers({ writes: [] });
    const { user } = renderClient(<ArbiterPage />);
    const subtask = await screen.findByRole('combobox', {
      name: /子任务审批模式/u,
    });
    // The control keeps its shape; only the choice is gone.
    expect(subtask).toBeDisabled();
    expect(subtask).toHaveValue('no-ask');
    expect(
      within(subtask).getByRole('option', { name: '自动审批（no-ask）' }),
    ).toBeInTheDocument();
    expect(
      within(subtask).queryByRole('option', { name: '交互审批（ask）' }),
    ).toBeNull();
    // The hint says why it is not a choice, rather than leaving a greyed box.
    expect(
      screen.getByText(/宿主把委派子会话的审批策略固定为 never/u),
    ).toBeInTheDocument();
    // A disabled select cannot be changed, so the draft stays as it loaded.
    await user.selectOptions(subtask, 'no-ask');
    expect(subtask).toHaveValue('no-ask');
    // The main session's mode remains a real choice.
    expect(
      screen.getByRole('combobox', { name: /主会话审批模式/u }),
    ).toBeEnabled();
  });

  test('shows both execution boundaries with their real sandbox consequence', async () => {
    usePageHandlers({ writes: [] });
    const { user } = renderClient(<ArbiterPage />);
    const guardedRadio = await screen.findByRole('radio', { name: 'guarded' });
    const trustedRadio = screen.getByRole('radio', { name: 'trusted' });
    expect(guardedRadio).toBeChecked();
    expect(
      screen.getByText(/调用仍受宿主工作区文件沙箱约束/u),
    ).toBeInTheDocument();

    await user.click(trustedRadio);
    await waitFor(() => {
      expect(trustedRadio).toBeChecked();
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
          configFormat: 'arbiter-config-v3',
          configFormatExplicit: false,
          auditError: null,
          warnings: [],
        }),
      ),
    );
    const { user } = renderClient(<ArbiterPage />);
    const trustedRadio = await screen.findByRole('radio', { name: 'trusted' });
    await user.click(trustedRadio);
    await user.selectOptions(
      screen.getByLabelText('主会话审批模式', { exact: false }),
      '自动审批（no-ask）',
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
