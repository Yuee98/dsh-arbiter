import { act, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ConfigActions } from '../../src/client/components/config-actions.js';
import { useArbiterTranslation } from '../../src/client/i18n-provider.js';
import { renderClient } from '../helpers/render-client.js';

function CatalogSummary() {
  const t = useArbiterTranslation();
  return <p>{t('summary')}</p>;
}

function actions(
  overrides: { readonly busy?: boolean; readonly canSave?: boolean } = {},
) {
  const handlers = { onValidate: vi.fn(), onReload: vi.fn(), onSave: vi.fn() };
  const ui = (
    <ConfigActions
      revision="r42"
      documentPath="/project/cordis.yml"
      dirty
      busy={overrides.busy ?? false}
      canSave={overrides.canSave ?? true}
      {...handlers}
    />
  );
  return { ui, handlers };
}

describe('configuration actions', () => {
  test('renders interpolated state and dispatches real user actions without saving on render', async () => {
    const { ui, handlers } = actions();
    const { user } = renderClient(ui);
    const group = within(screen.getByRole('group', { name: '配置操作' }));
    expect(screen.getByText(/配置修订 r42/)).toHaveTextContent(
      '/project/cordis.yml · 有未保存草稿',
    );
    expect(handlers.onSave).not.toHaveBeenCalled();
    await user.click(group.getByRole('button', { name: '校验草稿' }));
    await user.click(group.getByRole('button', { name: '重新读取' }));
    await user.click(group.getByRole('button', { name: '保存并应用' }));
    expect(handlers.onValidate).toHaveBeenCalledTimes(1);
    expect(handlers.onReload).toHaveBeenCalledTimes(1);
    expect(handlers.onSave).toHaveBeenCalledTimes(1);
  });

  test('busy actions are disabled and cannot issue another save', async () => {
    const { ui, handlers } = actions({ busy: true });
    const { user } = renderClient(ui);
    const save = screen.getByRole('button', { name: '处理中…' });
    expect(save).toBeDisabled();
    await user.click(save);
    expect(handlers.onSave).not.toHaveBeenCalled();
    for (const button of screen.getAllByRole('button'))
      expect(button).toBeDisabled();
  });

  test('read-only configuration disables save while keeping reload and validation available', () => {
    const { ui } = actions({ canSave: false });
    renderClient(ui);
    expect(screen.getByRole('button', { name: '保存并应用' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '重新读取' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '校验草稿' })).toBeEnabled();
  });

  test('host language changes rerender mounted UI and unfinished English falls back to Chinese', () => {
    const { ui } = actions();
    const { locale } = renderClient(
      <>
        {ui}
        <CatalogSummary />
      </>,
    );
    expect(
      screen.getByText(
        '命令规则、真实自动审查、审批模式、审计与离线规则建议。',
      ),
    ).toBeVisible();
    act(() => {
      locale.setLocale('en');
    });
    expect(
      screen.getByText(
        'Command rules, real auto review, approval modes, audit and offline rule suggestions.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: '保存并应用' })).toBeVisible();
    expect(screen.getByText(/配置修订 r42/)).toBeVisible();
  });
});
