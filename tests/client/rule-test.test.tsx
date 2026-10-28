import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, test } from 'vitest';

import { RuleTest } from '../../src/client/components/rules/rule-test.js';
import { ArbiterI18nProvider } from '../../src/client/i18n-provider.js';
import { cloneDraft } from '../../src/client/view-helpers.js';
import type { Draft } from '../../src/client/view-types.js';
import { setupApiMock } from '../helpers/api-mock.js';
import { effectiveState } from '../helpers/client-state.js';
import { renderClient } from '../helpers/render-client.js';

const server = setupApiMock();

/**
 * The focused rule allows a deploy whose every selected environment is `test`.
 *
 * Paired with a force-ask on any deploy below: force-ask outranks allow, so this
 * rule matches while the whole draft still takes another path. A "deny under
 * force-ask" fixture would be impossible — deny is the highest priority.
 */
const ALLOW_TEST_ENV: Draft['rules'][number] = {
  id: 'allow-test-env',
  name: '测试环境免审',
  conditions: [
    {
      target: 'argument',
      path: '$.environments[*]',
      multi: 'all',
      kind: 'exact',
      pattern: 'test',
    },
  ],
  verdict: 'allow',
};

/** The rule that actually wins: force-ask outranks the allow above. */
const ASK_DEPLOY: Draft['rules'][number] = {
  id: 'ask-deploy',
  name: '部署需要人工审批',
  conditions: [{ target: 'tool', kind: 'exact', pattern: 'deploy' }],
  verdict: 'force-ask',
};

/** An allow that only covers a single test environment value. */
const ALLOW_TEST: Draft['rules'][number] = {
  id: 'allow-test',
  conditions: [
    {
      target: 'argument',
      path: '$.environments[*]',
      multi: 'all',
      kind: 'exact',
      pattern: 'test',
    },
  ],
  verdict: 'allow',
};

/** A draft the page would hold; the tester reads it, never the saved document. */
function draftWith(rules: Draft['rules']): Draft {
  return { ...cloneDraft(effectiveState().config), rules };
}

/** The evaluator's answer: the allow matched, an outranking force-ask decided. */
function overriddenAnswer() {
  return {
    ok: true,
    results: [
      {
        input: '{"environments":["test"]}',
        tool: 'deploy',
        cwd: '/workspace',
        path: 'force-ask',
        pathDetail: {
          kind: 'rule',
          verdict: 'force-ask',
          ruleId: 'ask-deploy',
        },
        rule: {
          index: 1,
          id: 'ask-deploy',
          verdict: 'force-ask',
          effective: true,
          target: 'tool',
          conditionIndex: 0,
          nodeIndex: 0,
          matchedText: 'deploy',
        },
        matches: [
          {
            index: 1,
            id: 'ask-deploy',
            verdict: 'force-ask',
            effective: true,
            target: 'tool',
            conditionIndex: 0,
            nodeIndex: 0,
            matchedText: 'deploy',
          },
          {
            index: 0,
            id: 'allow-test-env',
            name: '测试环境免审',
            verdict: 'allow',
            effective: false,
            target: 'argument',
            conditionIndex: 0,
            nodeIndex: 0,
            matchedText: 'test',
          },
        ],
        rules: [
          {
            index: 0,
            id: 'allow-test-env',
            name: '测试环境免审',
            verdict: 'allow',
            outcome: 'match',
            conditions: [
              {
                index: 0,
                target: 'argument',
                kind: 'exact',
                pattern: 'test',
                path: '$.environments[*]',
                multi: 'all',
                outcome: 'match',
                reason: 'resolved',
                values: ['test'],
                matchedValues: ['test'],
              },
            ],
          },
          {
            index: 1,
            id: 'ask-deploy',
            verdict: 'force-ask',
            outcome: 'match',
            conditions: [
              {
                index: 0,
                target: 'tool',
                kind: 'exact',
                pattern: 'deploy',
                outcome: 'match',
                reason: 'resolved',
              },
            ],
          },
        ],
        parse: {
          status: 'ok',
          statements: 1,
          nodes: ['tool'],
          completeness: 'complete',
          opaque: false,
          unresolved: [],
        },
        argv: [],
        shadowed: ['allow-test-env(allow)'],
      },
    ],
  };
}

function openTester(rules: Draft['rules'] = [ALLOW_TEST_ENV, ASK_DEPLOY]): {
  readonly user: ReturnType<typeof renderClient>['user'];
  readonly draft: Draft;
} {
  const draft = draftWith(rules);
  const { user } = renderClient(
    <RuleTest
      draft={draft}
      focusedRule={draft.rules[0] ?? null}
      focusRequest={1}
    />,
  );
  return { user, draft };
}

describe('rule test panel', () => {
  test('a header test action opens the tester and focuses its sample', async () => {
    const draft = draftWith([ALLOW_TEST_ENV]);
    const { user, rerender, i18n } = renderClient(
      <RuleTest draft={draft} focusedRule={null} focusRequest={0} />,
    );
    // Collapsed by default: the sample is not rendered until asked for.
    expect(screen.queryByTestId('rule-test-body')).toBeNull();
    await user.click(screen.getByRole('button', { name: '规则测试' }));
    expect(screen.getByTestId('rule-test-body')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.queryByTestId('rule-test-body')).toBeNull();

    // The list's counter is what re-opens it, including for the same rule.
    rerender(
      <ArbiterI18nProvider i18n={i18n}>
        <RuleTest
          draft={draft}
          focusedRule={draft.rules[0] ?? null}
          focusRequest={1}
        />
      </ArbiterI18nProvider>,
    );
    const body = await screen.findByTestId('rule-test-body');
    await waitFor(() => {
      expect(body).toHaveFocus();
    });
    // Opening is not running: no request went out.
    expect(screen.queryByTestId('rule-test-answer')).toBeNull();
  });

  test('explains an unresolved review path without inventing a blocked allow', async () => {
    server.use(
      http.post('*/api/arbiter/test', () =>
        HttpResponse.json({
          ok: true,
          results: [
            {
              input: 'echo a > $TARGET',
              tool: 'bash',
              cwd: '/workspace',
              path: 'review(default)',
              pathDetail: { kind: 'review-default', reason: 'unresolved' },
              rule: null,
              matches: [],
              rules: [
                {
                  index: 0,
                  id: 'allow-redirect',
                  verdict: 'allow',
                  outcome: 'unknown',
                  conditions: [
                    {
                      index: 0,
                      target: 'file_redirect',
                      kind: 'glob',
                      pattern: '/srv/**',
                      outcome: 'unknown',
                      reason: 'unresolved-structure',
                    },
                  ],
                },
              ],
              parse: {
                status: 'ok',
                statements: 1,
                nodes: ['command', 'file_redirect'],
                completeness: 'partial',
                opaque: false,
                unresolved: ['$TARGET'],
              },
              argv: ['echo', 'a'],
              shadowed: [],
            },
          ],
        }),
      ),
    );
    // A lone allow whose condition cannot be judged: the evaluator reports
    // `unresolved`, but no rule outranks it.
    const draft = draftWith([
      {
        id: 'allow-redirect',
        conditions: [
          { target: 'file_redirect', kind: 'glob', pattern: '/srv/**' },
        ],
        verdict: 'allow',
      },
    ]);
    const { user } = renderClient(
      <RuleTest
        draft={draft}
        focusedRule={draft.rules[0] ?? null}
        focusRequest={1}
      />,
    );
    await user.click(screen.getByRole('button', { name: '运行测试' }));
    const pathSection = await screen.findByTestId('rule-test-path');
    // No allow matched, so neither the allow-specific sentence nor a claim about
    // a higher-priority rule would be supported by this answer: with a single
    // allow rule there is no higher-priority rule at all.
    expect(pathSection).toHaveTextContent('存在无法判断的规则');
    expect(pathSection).not.toHaveTextContent('高优先级');
    expect(pathSection).not.toHaveTextContent('allow 未被采用');
    expect(await screen.findByTestId('rule-test-rule')).toHaveAttribute(
      'data-arbiter-test-rule-state',
      'unknown',
    );
  });

  test('tests the whole unsaved draft, not the saved document', async () => {
    const requests: unknown[] = [];
    server.use(
      http.post('*/api/arbiter/test', async ({ request }) => {
        requests.push(await request.json());
        return HttpResponse.json(overriddenAnswer());
      }),
    );
    const { user, draft } = openTester();
    const args = screen.getByRole('textbox', { name: '工具参数' });
    await user.clear(args);
    fireEvent.change(args, {
      target: { value: '{"environments":["test"]}' },
    });
    const tool = screen.getByRole('textbox', { name: '工具' });
    await user.clear(tool);
    await user.type(tool, 'deploy');
    await user.click(screen.getByRole('button', { name: '运行测试' }));
    await screen.findByText('本规则匹配', { exact: true });
    expect(requests).toEqual([
      expect.objectContaining({
        samples: [
          {
            tool: 'deploy',
            args: { environments: ['test'] },
          },
        ],
        // Every rule travels with the request, including the one that is not
        // the focused rule: priority is decided over the whole draft.
        rules: draft.rules,
        identity: 'main',
      }),
    ]);
  });

  test('keeps the rule conclusion separate from an overriding final path', async () => {
    server.use(
      http.post('*/api/arbiter/test', () =>
        HttpResponse.json(overriddenAnswer()),
      ),
    );
    const { user } = openTester();
    await user.click(screen.getByRole('button', { name: '运行测试' }));

    await screen.findByText('本规则匹配', { exact: true });
    const ruleSection = screen.getByTestId('rule-test-rule');
    expect(ruleSection).toHaveAttribute(
      'data-arbiter-test-rule-state',
      'match',
    );
    expect(within(ruleSection).getByText('匹配')).toBeVisible();

    const pathSection = screen.getByTestId('rule-test-path');
    expect(pathSection).toHaveAttribute('data-arbiter-test-path', 'force-ask');
    expect(within(pathSection).getByText(/必须人工.*ask-deploy/)).toBeVisible();
    // The shadowed match is explained, not hidden behind the final verdict.
    await user.click(screen.getByText('查看详细解释'));
    expect(screen.getByText('被覆盖或遮蔽的命中')).toBeVisible();
    // The shadowed rule is named specifically: a broad text match over the
    // whole panel would also pass on the winning rule's own entry.
    const shadowEntry = screen.getByText(/allow-test-env（免审放行）/);
    expect(shadowEntry).toHaveTextContent('未生效');
    expect(screen.queryByText(/ask-deploy（必须人工）未生效/)).toBeNull();
  });

  test('shows JSONPath values and whether any or all of them matched', async () => {
    server.use(
      http.post('*/api/arbiter/test', () =>
        HttpResponse.json(overriddenAnswer()),
      ),
    );
    const { user } = openTester();
    await user.click(screen.getByRole('button', { name: '运行测试' }));
    await user.click(screen.getByText('查看详细解释'));

    expect(screen.getByText(/JSONPath：\$\.environments\[\*\]/)).toBeVisible();
    expect(screen.getByText(/多值匹配：全部/)).toBeVisible();
    expect(screen.getByText('取得值（1）')).toBeVisible();
    expect(screen.getByText('匹配值（1）')).toBeVisible();
    const condition = screen.getByTestId('rule-test-condition');
    expect(condition).toHaveAttribute('data-arbiter-test-condition', '0');
    // Both selected values are listed, and the matched one is listed again in
    // the matched-values group; the check is on both groups, not one text node.
    expect(within(condition).getAllByText('test')).toHaveLength(2);
    expect(within(condition).getByText(/匹配值（1）/)).toBeVisible();
  });

  test('explains an empty selection instead of calling it a full match', async () => {
    server.use(
      http.post('*/api/arbiter/test', () =>
        HttpResponse.json({
          ok: true,
          results: [
            {
              input: 'deploy',
              tool: 'deploy',
              cwd: '/workspace',
              path: 'review(default)',
              pathDetail: { kind: 'review-default', reason: 'no-match' },
              rule: null,
              matches: [],
              rules: [
                {
                  index: 0,
                  id: 'allow-test',
                  verdict: 'allow',
                  outcome: 'no-match',
                  conditions: [
                    {
                      index: 0,
                      target: 'argument',
                      kind: 'exact',
                      pattern: 'test',
                      path: '$.environments[*]',
                      multi: 'all',
                      outcome: 'no-match',
                      reason: 'empty-selection',
                      values: [],
                    },
                  ],
                },
              ],
              parse: {
                status: 'ok',
                statements: 1,
                nodes: ['tool'],
                completeness: 'complete',
                opaque: false,
                unresolved: [],
              },
              argv: [],
              shadowed: [],
            },
          ],
        }),
      ),
    );
    const draft = draftWith([ALLOW_TEST]);
    const { user } = renderClient(
      <RuleTest
        draft={draft}
        focusedRule={draft.rules[0] ?? null}
        focusRequest={1}
      />,
    );
    await user.click(screen.getByRole('button', { name: '运行测试' }));
    await user.click(await screen.findByText('查看详细解释'));
    expect(screen.getByText(/多值匹配：全部/)).toBeVisible();
    expect(screen.getAllByText(/未选中任何值/).length).toBeGreaterThanOrEqual(
      2,
    );
    expect(screen.queryByText(/结果：匹配/)).toBeNull();
  });

  test('locates a JSON syntax error at the input instead of testing it', async () => {
    let requests = 0;
    server.use(
      http.post('*/api/arbiter/test', () => {
        requests += 1;
        return HttpResponse.json(overriddenAnswer());
      }),
    );
    const { user } = openTester();
    await user.selectOptions(screen.getByLabelText('输入方式'), 'arguments');
    const input = screen.getByRole('textbox', { name: '工具参数' });
    await user.clear(input);
    await user.type(input, '{{ broken');
    await user.click(screen.getByRole('button', { name: '运行测试' }));

    expect(await screen.findByText(/参数 JSON 格式错误/)).toBeVisible();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    // A malformed sample is not submitted: nothing is evaluated as a non-match.
    expect(requests).toBe(0);
  });

  test('locates an invalid selector at the condition the backend names', async () => {
    server.use(
      http.post('*/api/arbiter/test', () =>
        HttpResponse.json(
          {
            ok: false,
            code: 'invalid-rule',
            message: 'the submitted rules are not valid',
            errors: [
              {
                path: 'rules[0].conditions[0].path',
                message: 'invalid JSONPath: unexpected token',
                code: 'rule.path-invalid',
                params: { path: '$.' },
              },
            ],
          },
          { status: 400 },
        ),
      ),
    );
    const { user } = openTester();
    await user.click(screen.getByRole('button', { name: '运行测试' }));
    const notice = await screen.findByText(/整份规则无法测试/);
    expect(notice).toHaveTextContent('rules[0].conditions[0].path');
    expect(notice).toHaveTextContent('JSONPath 无效');
  });

  test('offers to locate a rejected selector at the rule it belongs to', async () => {
    server.use(
      http.post('*/api/arbiter/test', () =>
        HttpResponse.json(
          {
            ok: false,
            code: 'invalid-rule',
            message: 'the submitted rules are not valid',
            errors: [
              {
                path: 'rules[1].conditions[0].path',
                message: 'invalid JSONPath: unexpected token',
                code: 'rule.path-invalid',
              },
            ],
          },
          { status: 400 },
        ),
      ),
    );
    const located: {
      readonly ruleId: string | null;
      readonly conditionIndex: number | null;
    }[] = [];
    const draft = draftWith([ALLOW_TEST_ENV, ASK_DEPLOY]);
    const { user } = renderClient(
      <RuleTest
        draft={draft}
        focusedRule={draft.rules[0] ?? null}
        focusRequest={1}
        onLocateIssue={(target) => located.push(target)}
      />,
    );
    await user.click(screen.getByRole('button', { name: '运行测试' }));
    // The path is not just printed: it is an action that names its target.
    await user.click(
      await screen.findByRole('button', {
        name: '定位到 rules[1].conditions[0].path',
      }),
    );
    // The action resolves the submitted index to the rule's stable id while the
    // error still belongs to that draft, so a later reorder cannot retarget it.
    expect(located).toEqual([
      {
        path: 'rules[1].conditions[0].path',
        ruleId: 'ask-deploy',
        conditionIndex: 0,
      },
    ]);
  });

  test('withdraws its location actions once the draft moves', async () => {
    server.use(
      http.post('*/api/arbiter/test', () =>
        HttpResponse.json(
          {
            ok: false,
            code: 'invalid-rule',
            message: 'the submitted rules are not valid',
            errors: [
              {
                // The second condition of the ruled-with-redirects rule.
                path: 'rules[1].conditions[1].path',
                message: 'invalid JSONPath: unexpected token',
                code: 'rule.path-invalid',
              },
            ],
          },
          { status: 400 },
        ),
      ),
    );
    const located: unknown[] = [];
    const draft = draftWith([ALLOW_TEST_ENV, ASK_DEPLOY]);
    const { user, rerender, i18n } = renderClient(
      <RuleTest
        draft={draft}
        focusedRule={draft.rules[0] ?? null}
        focusRequest={1}
        onLocateIssue={(target) => located.push(target)}
      />,
    );
    await user.click(screen.getByRole('button', { name: '运行测试' }));
    const action = await screen.findByRole('button', {
      name: '定位到 rules[1].conditions[1].path',
    });
    expect(action).toBeVisible();

    // Delete an earlier condition on the same rule. The ordinal no longer names
    // the same field, so the retained action would focus the wrong one.
    const moved = {
      ...draft,
      rules: draft.rules.map((rule, index) =>
        index === 1
          ? {
              ...rule,
              conditions: rule.conditions.filter(
                (_condition, conditionIndex) => conditionIndex !== 0,
              ),
            }
          : rule,
      ),
    } as Draft;
    rerender(
      <ArbiterI18nProvider i18n={i18n}>
        <RuleTest
          draft={moved}
          focusedRule={moved.rules[0] ?? null}
          focusRequest={1}
          onLocateIssue={(target) => located.push(target)}
        />
      </ArbiterI18nProvider>,
    );

    expect(
      screen.queryByRole('button', {
        name: '定位到 rules[1].conditions[1].path',
      }),
    ).toBeNull();
    expect(await screen.findByText(/草稿已改变/)).toBeVisible();
    expect(located).toEqual([]);
  });

  test('imports a recorded call with its original tool input', async () => {
    const argumentsValue = {
      environments: ['test', 'production'],
      target: { path: '/srv/app' },
      dryRun: false,
    };
    server.use(
      http.get('*/api/arbiter/logs', () =>
        HttpResponse.json({
          ok: true,
          rows: [
            {
              callId: 'call-77',
              ts: 1_700_000_000_000,
              tool: 'deploy',
              sessionKind: 'subagent',
              command: 'deploy',
              result: 'allow',
              reason: 'matched',
              ruleId: null,
              approvalMode: 'normal',
              decisionRules: [],
            },
          ],
          total: 1,
          health: { state: 'ok', lastError: null, dropped: 0, pending: 0 },
        }),
      ),
      http.get('*/api/arbiter/log', () =>
        HttpResponse.json({
          ok: true,
          record: {
            callId: 'call-77',
            tool: 'deploy',
            sessionKind: 'subagent',
            arguments: argumentsValue,
            cwd: '/srv/deploy',
          },
        }),
      ),
      http.post('*/api/arbiter/test', async ({ request }) => {
        const body: unknown = await request.json();
        return HttpResponse.json({
          ok: true,
          results: [
            {
              ...overriddenAnswer().results[0],
              request: body,
            },
          ],
        });
      }),
    );
    const { user } = openTester();
    await user.click(screen.getByRole('button', { name: '从调用记录带入' }));
    await user.click(
      await screen.findByRole('button', { name: /带入 deploy 调用 call-77/ }),
    );

    // The recorded arguments object is preserved field for field, including the
    // nested path and the boolean that a string-only import would drop.
    const input = await screen.findByRole('textbox', { name: '工具参数' });
    expect(input).toHaveValue(JSON.stringify(argumentsValue, null, 2));
    expect(screen.getByLabelText('工具')).toHaveValue('deploy');
    // The recorded context is part of the evaluation input, so it is restored
    // too: a rule scoped to subagent, or a relative redirect, would otherwise
    // be answered under the wrong identity or directory.
    expect(screen.getByLabelText('Agent')).toHaveValue('subagent');
    expect(screen.getByLabelText('工作目录')).toHaveValue('/srv/deploy');

    const [request] = await Promise.all([
      new Promise<unknown>((resolve) => {
        server.events.on('request:start', async ({ request: started }) => {
          if (!started.url.includes('/api/arbiter/test')) return;
          resolve(await started.clone().json());
        });
      }),
      user.click(screen.getByRole('button', { name: '运行测试' })),
    ]);
    expect(request).toMatchObject({
      samples: [{ tool: 'deploy', args: argumentsValue, cwd: '/srv/deploy' }],
      identity: 'subagent',
    });
  });

  test('marks an old result as needing a retest after an edit', async () => {
    server.use(
      http.post('*/api/arbiter/test', () =>
        HttpResponse.json(overriddenAnswer()),
      ),
    );
    const { user } = openTester();
    await user.click(screen.getByRole('button', { name: '运行测试' }));
    await screen.findByText('本规则匹配', { exact: true });
    expect(screen.queryByText(/需要重新测试/)).toBeNull();

    // The old answer stays readable but is no longer presented as current.
    const input = screen.getByRole('textbox', { name: '工具参数' });
    await user.type(input, ' ');
    expect(await screen.findByText(/需要重新测试/)).toBeVisible();
    expect(screen.getByText('本规则匹配', { exact: true })).toBeVisible();
  });

  test('keeps the answer but marks it stale when the focused rule changes', async () => {
    const draft = draftWith([ALLOW_TEST_ENV, ASK_DEPLOY]);
    server.use(
      http.post('*/api/arbiter/test', () =>
        HttpResponse.json(overriddenAnswer()),
      ),
    );
    const { user, rerender, i18n } = renderClient(
      <RuleTest
        draft={draft}
        focusedRule={draft.rules[0] ?? null}
        focusRequest={1}
      />,
    );
    await user.click(screen.getByRole('button', { name: '运行测试' }));
    const conclusion = await screen.findByTestId('rule-test-rule');
    expect(conclusion).toHaveAttribute('data-arbiter-test-rule-state', 'match');
    expect(screen.queryByText(/需要重新测试/)).toBeNull();

    // Another rule's header action re-targets the tester. The previous answer
    // still exists, but it answers about the earlier rule, so it must not read
    // as the current rule's conclusion.
    rerender(
      <ArbiterI18nProvider i18n={i18n}>
        <RuleTest
          draft={draft}
          focusedRule={draft.rules[1] ?? null}
          focusRequest={1}
        />
      </ArbiterI18nProvider>,
    );
    expect(await screen.findByText(/需要重新测试/)).toBeVisible();
    expect(screen.getByTestId('rule-test-rule')).toBeInTheDocument();
  });

  test('marks a stale result when a draft rule changes', async () => {
    const draft = draftWith([ALLOW_TEST_ENV, ASK_DEPLOY]);
    server.use(
      http.post('*/api/arbiter/test', () =>
        HttpResponse.json(overriddenAnswer()),
      ),
    );
    const { user, rerender, i18n } = renderClient(
      <RuleTest
        draft={draft}
        focusedRule={draft.rules[0] ?? null}
        focusRequest={1}
      />,
    );
    await user.click(screen.getByRole('button', { name: '运行测试' }));
    await screen.findByText('本规则匹配', { exact: true });
    expect(screen.queryByText(/需要重新测试/)).toBeNull();

    const edited = {
      ...draft,
      rules: draft.rules.map((rule) =>
        rule.id === 'ask-deploy' ? { ...rule, verdict: 'deny' as const } : rule,
      ),
    } as Draft;
    rerender(
      <ArbiterI18nProvider i18n={i18n}>
        <RuleTest
          draft={edited}
          focusedRule={edited.rules[0] ?? null}
          focusRequest={1}
        />
      </ArbiterI18nProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText(/需要重新测试/)).toBeVisible();
    });
  });
});

describe('final path, precedence and composite coverage', () => {
  /** A composed command: the allow names the first command only. */
  function composedAnswer() {
    return {
      ok: true,
      results: [
        {
          input: 'gh pr view 42 && rm -rf /tmp/x',
          tool: 'bash',
          cwd: '/workspace',
          path: 'review(default)',
          pathDetail: { kind: 'review-default', reason: 'partial-allow' },
          rule: null,
          matches: [
            {
              index: 0,
              id: 'allow-gh',
              verdict: 'allow',
              effective: true,
              target: 'command',
              conditionIndex: 0,
              nodeIndex: 0,
              matchedText: 'gh pr view 42',
            },
          ],
          rules: [
            {
              index: 0,
              id: 'allow-gh',
              verdict: 'allow',
              outcome: 'match',
              conditions: [
                {
                  // A command condition: its matched text is a command the
                  // allow named, which is what the coverage list may show.
                  index: 0,
                  target: 'command',
                  kind: 'exact',
                  pattern: 'gh pr view 42',
                  outcome: 'match',
                  reason: 'resolved',
                  matchedValue: 'gh pr view 42',
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
          argv: ['gh', 'pr', 'view', '42', '&&', 'rm', '-rf', '/tmp/x'],
          normalization: {
            raw: 'gh pr view 42 && rm -rf /tmp/x',
            completeness: 'complete',
            issues: [],
            commands: [
              { text: 'gh pr view 42', raw: 'gh pr view 42', words: [] },
              { text: 'rm -rf /tmp/x', raw: 'rm -rf /tmp/x', words: [] },
            ],
          },
          shadowed: [],
        },
      ],
    };
  }

  test('the final path says what happens to the call, not only which rule won', async () => {
    server.use(
      http.post('*/api/arbiter/test', () =>
        HttpResponse.json(overriddenAnswer()),
      ),
    );
    const { user } = openTester();
    await user.click(screen.getByRole('button', { name: '运行测试' }));
    await screen.findByText('本规则匹配', { exact: true });

    const behavior = screen.getByTestId('rule-test-path-behavior');
    expect(behavior).toHaveAttribute(
      'data-arbiter-test-path-behavior',
      'force-ask',
    );
    // force-ask is a human decision, not a review: the sentence must say so.
    expect(behavior).toHaveTextContent(/每次人工/);
    // The effective rule id stays visible as data next to the localized label.
    expect(screen.getByTestId('rule-test-path')).toHaveTextContent(
      '必须人工审批（生效规则 ask-deploy）',
    );
  });

  test('the precedence list marks the deciding level and the outranked one', async () => {
    server.use(
      http.post('*/api/arbiter/test', () =>
        HttpResponse.json(overriddenAnswer()),
      ),
    );
    const { user } = openTester();
    await user.click(screen.getByRole('button', { name: '运行测试' }));
    await screen.findByText('本规则匹配', { exact: true });
    await user.click(screen.getByText('查看详细解释'));

    const priority = screen.getByTestId('rule-test-priority');
    expect(priority).toHaveTextContent('整份配置的优先级');
    // The list is the fixed order, so a wide force-review really does outrank a
    // narrow allow; each level reports what it did for this call.
    const levels = within(priority).getAllByRole('listitem');
    expect(
      levels.map((level) => level.getAttribute('data-arbiter-test-priority')),
    ).toEqual(['deny', 'force-ask', 'force-review', 'allow', 'fallback']);
    expect(levels[1]).toHaveAttribute(
      'data-arbiter-test-priority-decision',
      'effective',
    );
    // A decisive higher-priority rule beat this allow, so it was shadowed.
    expect(levels[3]).toHaveAttribute(
      'data-arbiter-test-priority-decision',
      'shadowed',
    );
    // Levels that never applied say so rather than being omitted.
    expect(levels[0]).toHaveAttribute(
      'data-arbiter-test-priority-decision',
      'none',
    );
    // The effective level names exactly one rule, not its whole tier.
    expect(levels[1]).toHaveTextContent('本次生效（ask-deploy）');
    expect(levels[1]).not.toHaveTextContent('allow-test-env');
    expect(priority).toHaveTextContent('ask-deploy');
    expect(priority).toHaveTextContent('allow-test-env');
    // The focused rule owns the allow level, which is where it actually sits.
    expect(priority).toHaveTextContent('（当前规则）');
  });

  test('a composite command shows which commands the allow did not cover', async () => {
    server.use(
      http.post('*/api/arbiter/test', () =>
        HttpResponse.json(composedAnswer()),
      ),
    );
    const { user } = openTester([ALLOW_TEST]);
    await user.click(screen.getByRole('button', { name: '运行测试' }));
    await screen.findByText('本规则匹配', { exact: true });
    await user.click(screen.getByText('查看详细解释'));

    const coverage = screen.getByTestId('rule-test-coverage');
    expect(coverage).toHaveAttribute('data-arbiter-test-coverage', 'partial');
    // Every command the evaluator saw is listed, with the ones the allow named.
    const nodes = within(coverage).getAllByRole('listitem');
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toHaveAttribute(
      'data-arbiter-test-coverage-node',
      'named',
    );
    expect(nodes[0]).toHaveTextContent('已命名：gh pr view 42');
    expect(nodes[1]).toHaveAttribute(
      'data-arbiter-test-coverage-node',
      'unnamed',
    );
    expect(nodes[1]).toHaveTextContent('未命名：rm -rf /tmp/x');
    // The documented cause here is an unnamed command, so the sentence says so.
    expect(coverage).toHaveTextContent(/还有 1 条命令没有被 allow 命名/);
    expect(coverage).toHaveTextContent('其中 1 条被 allow 条件命名');
    // The consequence is stated: the rest is not authorized as a side effect.
    expect(coverage).toHaveTextContent(/进入默认审查/);
  });
});
