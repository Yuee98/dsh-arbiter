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
    await user.selectOptions(mode, 'no-ask');
    await user.click(screen.getByRole('button', { name: 'Reviewer' }));
    expect(
      await screen.findByRole('heading', { name: 'Reviewer 类型' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '状态与模式' }));
    expect(
      screen.getByLabelText('主会话审批模式', { exact: false }),
    ).toHaveValue('no-ask');
    await user.click(screen.getByRole('button', { name: '校验草稿' }));
    await waitFor(() => {
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        config: { modes: { main: 'no-ask', subagent: 'no-ask' } },
      });
    });
  });

  test('sends the disabled rule draft to the rule tester and renders both conclusions', async () => {
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
              cwd: '/workspace',
              path: 'review(default)',
              pathDetail: { kind: 'review-default', reason: 'no-match' },
              rule: null,
              matches: [],
              rules: [
                {
                  index: 0,
                  id: 'rule-1',
                  verdict: 'allow',
                  outcome: 'no-match',
                  conditions: [
                    {
                      index: 0,
                      target: 'command',
                      kind: 'regex',
                      pattern: '',
                      outcome: 'no-match',
                      reason: 'value-mismatch',
                    },
                  ],
                },
              ],
              parse: {
                status: 'ok',
                statements: 1,
                nodes: ['command'],
                completeness: 'complete',
                opaque: false,
                unresolved: [],
              },
              argv: ['pwd'],
              normalization: {
                raw: 'pwd',
                completeness: 'complete',
                issues: [],
                commands: [
                  {
                    text: 'pwd',
                    raw: 'pwd',
                    words: [
                      {
                        raw: 'pwd',
                        text: 'pwd',
                        status: 'static',
                        reasons: [],
                        value: 'pwd',
                      },
                    ],
                  },
                ],
              },
              shadowed: [],
            },
          ],
        });
      }),
    );
    const { user } = renderClient(<ArbiterPage />);
    await user.click(await screen.findByRole('button', { name: '规则' }));
    await user.click(screen.getByRole('button', { name: '新建规则' }));
    await user.click(screen.getByRole('checkbox', { name: /^启用规则/ }));
    // The test area is collapsed by default; its own entry opens it, and a row's
    // "测试" action focuses one rule without running anything.
    await user.click(screen.getByRole('button', { name: '规则测试' }));
    const input = screen.getByRole('textbox', { name: '命令' });
    await user.clear(input);
    await user.type(input, 'pwd');
    await user.click(screen.getByRole('button', { name: '运行测试' }));
    expect(
      await screen.findByText('review(default)', { exact: true }),
    ).toBeInTheDocument();
    // The explanation carries the normalization evidence the server sent: the
    // matched text and the per-word status, not only the final verdict.
    // The explanation is a native `<details>`; opening its summary is what a reader
    // does, and the word-level evidence must be there once it is open.
    await user.click(screen.getByText('查看详细解释'));
    const detail = await screen.findByTestId('rule-test-normalization');
    expect(detail).toHaveTextContent('匹配文本：pwd');
    expect(detail).toHaveTextContent('pwd → pwd（静态）');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      samples: [{ tool: 'bash', args: { command: 'pwd' } }],
      rules: [{ id: 'rule-1', enabled: false }],
      identity: 'main',
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
          config: { modes: { main: 'no-ask' } },
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
    await user.selectOptions(mode, 'no-ask');
    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    expect(await screen.findByText(/配置文件已被外部修改/)).toBeInTheDocument();
    expect(pageSaveStatus()).toHaveTextContent(
      '保存或应用失败；当前生效配置未改变。',
    );
    // The draft survives the rejected save.
    expect(
      screen.getByLabelText('主会话审批模式', { exact: false }),
    ).toHaveValue('no-ask');
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
          configFormat: 'arbiter-config-v3',
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

test('renders a localized validation sentence from a stable issue code', async () => {
  server.use(
    http.get('*/api/arbiter/state', () => HttpResponse.json(effectiveState())),
    http.post('*/api/arbiter/config/save', () =>
      HttpResponse.json(
        {
          ok: false,
          code: 'config-invalid',
          errors: [
            {
              path: 'reviewer.decision.url',
              message: 'must be an http(s) URL',
              code: 'reviewer.url-scheme',
            },
            {
              path: 'context.customRules',
              message: 'must be at most 2000 characters',
              code: 'length.customRules',
              params: { max: 2000 },
            },
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
  const alert = await screen.findByText(/配置校验失败，未保存/);
  expect(alert).toHaveTextContent('reviewer.decision.url: 必须是 http(s) URL');
  // Interpolated parameters are rendered from the translation, not the backend.
  expect(alert).toHaveTextContent('不得超过 2000 个字符');
  expect(alert).not.toHaveTextContent('must be an http(s) URL');
});

test('a warning without a known code keeps its backend sentence', async () => {
  server.use(
    http.get('*/api/arbiter/state', () =>
      HttpResponse.json({
        ...effectiveState(),
        warnings: [
          {
            path: 'rules.legacy',
            message: 'legacy backend phrasing',
            code: 'config.unmapped-code',
          },
        ],
      }),
    ),
  );
  renderClient(<ArbiterPage />);
  expect(await screen.findByText(/legacy backend phrasing/)).toHaveTextContent(
    'rules.legacy: legacy backend phrasing',
  );
});

test('an explicitly declared format survives decode, draft and the actual save request', async () => {
  const bodies: unknown[] = [];
  server.use(
    http.get('*/api/arbiter/state', () =>
      HttpResponse.json({
        ...effectiveState(),
        config: { ...effectiveState().config, format: 'arbiter-config-v3' },
        configFormat: 'arbiter-config-v3',
        configFormatExplicit: true,
      }),
    ),
    http.post('*/api/arbiter/validate', async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json({ ok: true, errors: [], warnings: [] });
    }),
    http.post('*/api/arbiter/config/save', async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json({
        ok: true,
        saved: true,
        changed: false,
        effective: true,
        effectiveRevision: 'effective-1',
        configSnapshotId: 'snapshot-1',
        activationRecorded: false,
        configFormat: 'arbiter-config-v3',
        configFormatExplicit: true,
        auditError: null,
        warnings: [],
      });
    }),
  );
  const { user } = renderClient(<ArbiterPage />);
  const mode = await screen.findByLabelText('主会话审批模式', { exact: false });
  await user.selectOptions(mode, 'no-ask');
  await user.click(screen.getByRole('button', { name: '校验草稿' }));
  await user.click(screen.getByRole('button', { name: '保存并应用' }));
  await waitFor(() => {
    expect(bodies).toHaveLength(2);
  });
  for (const body of bodies) {
    expect(body).toMatchObject({
      config: {
        format: 'arbiter-config-v3',
        modes: { main: 'no-ask' },
      },
    });
  }
});

test('an undeclared document saves with an explicit declaration', async () => {
  const bodies: unknown[] = [];
  const savedRule = {
    id: 'keep-me',
    conditions: [
      { target: 'command', kind: 'regex', pattern: 'gh pr view(?: .*)?' },
    ],
    verdict: 'allow',
  };
  server.use(
    http.get('*/api/arbiter/state', () =>
      HttpResponse.json({
        ...effectiveState(),
        config: { ...effectiveState().config, rules: [savedRule] },
        // The profile document declares no format of its own.
        configFormat: 'arbiter-config-v3',
        configFormatExplicit: false,
      }),
    ),
    http.post('*/api/arbiter/config/save', async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json({
        ok: true,
        saved: true,
        changed: true,
        effective: true,
        effectiveRevision: 'effective-2',
        configSnapshotId: 'snapshot-2',
        activationRecorded: true,
        configFormat: 'arbiter-config-v3',
        configFormatExplicit: true,
        auditError: null,
        warnings: [],
      });
    }),
  );
  const { user } = renderClient(<ArbiterPage />);
  // Change an unrelated setting; the rule itself is untouched.
  const mode = await screen.findByLabelText('主会话审批模式', { exact: false });
  await user.selectOptions(mode, 'no-ask');
  await user.click(screen.getByRole('button', { name: '保存并应用' }));
  await waitFor(() => {
    expect(bodies).toHaveLength(1);
  });
  // A draft that carries rules states the format it was written for, so the saved
  // document names the rule model rather than relying on the reading of absence.
  expect(bodies[0]).toMatchObject({
    config: { format: 'arbiter-config-v3', modes: { main: 'no-ask' } },
  });
});

test('a known rule compile failure is localized while its id stays data', async () => {
  server.use(
    http.get('*/api/arbiter/state', () => HttpResponse.json(effectiveState())),
    http.post('*/api/arbiter/config/save', () =>
      HttpResponse.json(
        {
          ok: false,
          code: 'config-invalid',
          errors: [
            {
              path: 'rules[0]',
              message: 'invalid regex: missing closing ) (rule "gh")',
              code: 'rule.regex-syntax',
              params: { id: 'gh', message: 'missing closing )' },
            },
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
  const alert = await screen.findByText(/配置校验失败，未保存/);
  expect(alert).toHaveTextContent(
    'rules[0]: 正则表达式无效：missing closing )',
  );
  expect(alert).not.toHaveTextContent('invalid regex');
});
