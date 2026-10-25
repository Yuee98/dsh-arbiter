import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, test } from 'vitest';

import { ArbiterPage } from '../../src/client/index.js';
import { setupApiMock } from '../helpers/api-mock.js';
import { effectiveState } from '../helpers/client-state.js';
import { renderClient } from '../helpers/render-client.js';

const server = setupApiMock();

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
});
