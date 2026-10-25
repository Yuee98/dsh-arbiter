import { act, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ConfigActions } from '../../src/client/components/config-actions.js';
import type { SaveStatus } from '../../src/client/components/config-actions.js';
import { useArbiterTranslation } from '../../src/client/i18n-provider.js';
import { renderClient } from '../helpers/render-client.js';

function CatalogSummary() {
  const t = useArbiterTranslation();
  return <p>{t('summary')}</p>;
}

function actions(
  overrides: {
    readonly busy?: boolean;
    readonly canSave?: boolean;
    readonly dirty?: boolean;
    readonly status?: SaveStatus;
    readonly fileRevision?: string | null;
    readonly auditNotice?: string | null;
    readonly formatExplicit?: boolean;
  } = {},
) {
  const handlers = { onValidate: vi.fn(), onReload: vi.fn(), onSave: vi.fn() };
  const ui = (
    <ConfigActions
      fileRevision={
        overrides.fileRevision === undefined ? 'file-7' : overrides.fileRevision
      }
      effectiveRevision="eff-3"
      snapshotId="cfg-abc123"
      format="arbiter-config-v1"
      formatExplicit={overrides.formatExplicit ?? false}
      documentPath="/project/cordis.yml"
      dirty={overrides.dirty ?? true}
      busy={overrides.busy ?? false}
      canSave={overrides.canSave ?? true}
      status={overrides.status ?? 'idle'}
      auditNotice={overrides.auditNotice ?? null}
      {...handlers}
    />
  );
  return { ui, handlers };
}

function saveStatus(): HTMLElement {
  return screen.getByTestId('arbiter-save-status');
}

describe('configuration actions', () => {
  test('shows file revision, effective revision, snapshot and format separately', () => {
    const { ui } = actions();
    renderClient(ui);
    const group = within(screen.getByRole('group', { name: '配置操作' }));
    expect(screen.getByText('文件修订 file-7')).toBeVisible();
    expect(screen.getByText('生效修订 eff-3')).toBeVisible();
    expect(screen.getByText('内容快照 cfg-abc123')).toBeVisible();
    expect(
      screen.getByText(/格式 arbiter-config-v1（未声明，沿用旧前缀语义）/),
    ).toHaveAttribute('data-arbiter-config-format', 'arbiter-config-v1');
    expect(screen.getByText(/\/project\/cordis\.yml/)).toBeVisible();
    expect(group.getByRole('button', { name: '保存并应用' })).toBeEnabled();
  });

  test('declared formats are not marked as the implicit legacy document', () => {
    const { ui } = actions({ formatExplicit: true });
    renderClient(ui);
    expect(screen.getByText('格式 arbiter-config-v1')).toBeVisible();
    expect(screen.queryByText(/沿用旧前缀语义/)).toBeNull();
  });

  test('an unreadable file revision explains why saving is unavailable', () => {
    const { ui } = actions({ fileRevision: null, canSave: false });
    renderClient(ui);
    expect(screen.getByText('文件修订不可用')).toBeVisible();
    expect(screen.getByRole('button', { name: '保存并应用' })).toBeDisabled();
  });

  test('dispatches real user actions without saving on render', async () => {
    const { ui, handlers } = actions();
    const { user } = renderClient(ui);
    const group = within(screen.getByRole('group', { name: '配置操作' }));
    expect(handlers.onSave).not.toHaveBeenCalled();
    await user.click(group.getByRole('button', { name: '校验草稿' }));
    await user.click(group.getByRole('button', { name: '重新读取' }));
    await user.click(group.getByRole('button', { name: '保存并应用' }));
    expect(handlers.onValidate).toHaveBeenCalledTimes(1);
    expect(handlers.onReload).toHaveBeenCalledTimes(1);
    expect(handlers.onSave).toHaveBeenCalledTimes(1);
  });

  test('reports an unsaved draft as not yet effective', () => {
    const { ui } = actions({ dirty: true });
    renderClient(ui);
    expect(saveStatus()).toHaveTextContent('草稿未保存；当前生效配置未改变。');
    expect(saveStatus()).toHaveAttribute('data-arbiter-save-status', 'idle');
  });

  test('distinguishes saved-and-effective from saved-without-change', () => {
    const saved = actions({ dirty: false, status: 'saved' });
    const { unmount } = renderClient(saved.ui);
    expect(saveStatus()).toHaveTextContent('已保存并生效。');
    unmount();

    const unchanged = actions({ dirty: false, status: 'unchanged' });
    renderClient(unchanged.ui);
    expect(saveStatus()).toHaveTextContent(
      '已保存；内容与当前生效配置相同，未新增生效记录。',
    );
  });

  test('a failed save never claims the draft became effective', () => {
    const { ui } = actions({ dirty: true, status: 'failed' });
    renderClient(ui);
    expect(saveStatus()).toHaveTextContent(
      '保存或应用失败；当前生效配置未改变。',
    );
  });

  test('a localized audit notice is shown unchanged instead of translated twice', () => {
    const notice = '生效配置已切换，但审计历史未写入：database is locked';
    const { ui } = actions({
      dirty: false,
      status: 'saved',
      auditNotice: notice,
    });
    renderClient(ui);
    expect(saveStatus()).toHaveTextContent('已保存并生效。');
    expect(saveStatus()).toHaveTextContent(notice);
    // The explanatory sentence must appear exactly once.
    expect(
      (saveStatus().textContent.match(/审计历史未写入/gu) ?? []).length,
    ).toBe(1);
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
    // English has no config module yet: every key falls back per key.
    expect(screen.getByRole('button', { name: '保存并应用' })).toBeVisible();
    expect(screen.getByText('文件修订 file-7')).toBeVisible();
    expect(screen.getByText('内容快照 cfg-abc123')).toBeVisible();
    expect(saveStatus()).toHaveTextContent('草稿未保存；当前生效配置未改变。');
    expect(document.body.textContent).not.toMatch(
      /config\.[a-zA-Z]|undefined|\[object Object\]/,
    );
  });
});
