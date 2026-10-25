import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, test } from 'vitest';

import { ArbiterPage } from '../../src/client/index.js';
import { setupApiMock } from '../helpers/api-mock.js';
import { effectiveState } from '../helpers/client-state.js';
import { renderClient } from '../helpers/render-client.js';

const server = setupApiMock();

function pageSaveStatus(): HTMLElement {
  return screen.getByTestId('arbiter-save-status');
}

describe('prototype page after panel extraction', () => {
  test('keeps an edited approval mode across tabs and sends that draft for validation', async () => {
    const requests: unknown[] = [];
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
      http.post('*/api/arbiter/validate', async ({ request }) => {
        requests.push(await request.json());
        return HttpResponse.json({ ok: true, errors: [], warnings: [] });
      }),
    );
    const { user } = renderClient(<ArbiterPage />);
    const mode = await screen.findByLabelText('主会话审批模式', {
      exact: false,
    });
    await user.selectOptions(mode, 'strict');
    await user.click(screen.getByRole('button', { name: 'Reviewer' }));
    expect(
      await screen.findByRole('heading', { name: 'Reviewer 类型' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '状态与模式' }));
    expect(
      screen.getByLabelText('主会话审批模式', { exact: false }),
    ).toHaveValue('strict');
    await user.click(screen.getByRole('button', { name: '校验草稿' }));
    await waitFor(() => {
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        config: { modes: { main: 'strict', subagent: 'strict' } },
      });
    });
  });

  test('sends the disabled rule draft to the rule tester and renders the decoded result', async () => {
    const requests: unknown[] = [];
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      http.post('*/api/arbiter/test', async ({ request }) => {
        requests.push(await request.json());
        return HttpResponse.json({
          ok: true,
          results: [
            {
              input: 'pwd',
              tool: 'bash',
              path: 'review(default)',
              rule: null,
              matches: [],
              parse: {
                status: 'ok',
                statements: 1,
                nodes: ['command'],
                completeness: 'complete',
                opaque: false,
                unresolved: [],
              },
              argv: ['pwd'],
              shadowed: [],
            },
          ],
        });
      }),
    );
    const { user } = renderClient(<ArbiterPage />);
    await user.click(await screen.findByRole('button', { name: '规则' }));
    await user.click(screen.getByRole('button', { name: '+ 添加规则' }));
    await user.click(screen.getByRole('checkbox', { name: '启用' }));
    const input = screen.getByRole('textbox', { name: '输入' });
    await user.clear(input);
    await user.type(input, 'pwd');
    await user.click(screen.getByRole('button', { name: '运行测试' }));
    expect(
      await screen.findByText('review(default)', { exact: true }),
    ).toBeInTheDocument();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      inputs: ['pwd'],
      rules: [{ id: 'rule-1', enabled: false }],
    });
  });

  test('keeps the draft on a conflict and reports that nothing was applied', async () => {
    let saves = 0;
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      http.post('*/api/arbiter/config/save', async ({ request }) => {
        saves += 1;
        expect(await request.json()).toMatchObject({
          revision: 'file-1',
          config: { modes: { main: 'progress' } },
        });
        return HttpResponse.json(
          {
            ok: false,
            code: 'config-conflict',
            message: 'the profile patch changed after this draft was read',
            fileRevision: 'file-2',
          },
          { status: 409 },
        );
      }),
    );
    const { user } = renderClient(<ArbiterPage />);
    const mode = await screen.findByLabelText('主会话审批模式', {
      exact: false,
    });
    await user.selectOptions(mode, 'progress');
    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    expect(await screen.findByText(/配置文件已被外部修改/)).toBeInTheDocument();
    expect(pageSaveStatus()).toHaveTextContent(
      '保存或应用失败；当前生效配置未改变。',
    );
    // The draft survives the rejected save.
    expect(
      screen.getByLabelText('主会话审批模式', { exact: false }),
    ).toHaveValue('progress');
    expect(saves).toBe(1);
  });

  test('reports a successful save as saved and effective with new identities', async () => {
    let stateCalls = 0;
    server.use(
      http.get('*/api/arbiter/state', () => {
        stateCalls += 1;
        const state = effectiveState();
        return HttpResponse.json(
          stateCalls === 1
            ? state
            : {
                ...state,
                effectiveRevision: 'effective-2',
                configSnapshotId: 'snapshot-2',
                fileRevision: 'file-2',
              },
        );
      }),
      http.post('*/api/arbiter/config/save', () =>
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
    await screen.findByLabelText('主会话审批模式', { exact: false });
    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    await waitFor(() => {
      expect(screen.getByText('已保存并生效。')).toBeVisible();
    });
    expect(pageSaveStatus()).toHaveTextContent('已保存并生效。');
    expect(screen.getByText('生效修订 effective-2')).toBeVisible();
    expect(screen.getByText('内容快照 snapshot-2')).toBeVisible();
    expect(screen.getByText('文件修订 file-2')).toBeVisible();
  });

  test('shows validation errors from a rejected save without claiming effectiveness', async () => {
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      http.post('*/api/arbiter/config/save', () =>
        HttpResponse.json(
          {
            ok: false,
            code: 'config-invalid',
            errors: [
              { path: 'rules[0]', message: 'regex patterns must be anchored' },
            ],
            warnings: [],
          },
          { status: 422 },
        ),
      ),
    );
    const { user } = renderClient(<ArbiterPage />);
    await screen.findByLabelText('主会话审批模式', { exact: false });
    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    expect(await screen.findByText(/配置校验失败，未保存/)).toHaveTextContent(
      'rules[0]: regex patterns must be anchored',
    );
    expect(pageSaveStatus()).toHaveTextContent(
      '保存或应用失败；当前生效配置未改变。',
    );
    expect(screen.queryByText('已保存并生效。')).toBeNull();
  });

  test('a report-only apply failure names the reason and keeps the effective revision', async () => {
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      http.post('*/api/arbiter/config/save', () =>
        HttpResponse.json(
          {
            ok: false,
            code: 'config-rejected',
            message: 'Configuration entry is no longer available',
          },
          { status: 422 },
        ),
      ),
    );
    const { user } = renderClient(<ArbiterPage />);
    await screen.findByLabelText('主会话审批模式', { exact: false });
    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    expect(await screen.findByText(/配置应用失败，未生效/)).toHaveTextContent(
      'Configuration entry is no longer available',
    );
    expect(screen.getByText('生效修订 effective-1')).toBeVisible();
    expect(pageSaveStatus()).toHaveTextContent(
      '保存或应用失败；当前生效配置未改变。',
    );
  });
});
