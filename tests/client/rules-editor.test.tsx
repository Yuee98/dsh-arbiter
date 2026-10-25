import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, test } from 'vitest';

import { ArbiterPage } from '../../src/client/index.js';
import { setupApiMock } from '../helpers/api-mock.js';
import { effectiveState } from '../helpers/client-state.js';
import { renderClient } from '../helpers/render-client.js';

const server = setupApiMock();

/** Every save body this file observes, reset before each case. */
const saved: unknown[] = [];

beforeEach(() => {
  saved.length = 0;
});

/** The rule list; every row is a list item inside it. */
function rows(): readonly HTMLElement[] {
  return within(screen.getByRole('list', { name: '规则' })).getAllByRole(
    'listitem',
  );
}

function row(id: string): HTMLElement {
  const found = rows().find(
    (entry) => entry.getAttribute('data-rule-row') === id,
  );
  if (found === undefined) throw new Error(`missing rule ${id}`);
  return found;
}

function savedBody() {
  return {
    ok: true,
    saved: true,
    changed: true,
    effective: true,
    effectiveRevision: 'effective-2',
    configSnapshotId: 'snapshot-2',
    activationRecorded: true,
    configFormat: 'arbiter-config-v2',
    configFormatExplicit: true,
    auditError: null,
    warnings: [],
  };
}

function baseHandlers(): void {
  server.use(
    http.get('*/api/arbiter/state', () => HttpResponse.json(effectiveState())),
    http.post('*/api/arbiter/validate', () =>
      HttpResponse.json({ ok: true, errors: [], warnings: [] }),
    ),
    http.post('*/api/arbiter/config/save', async ({ request }) => {
      saved.push(await request.json());
      return HttpResponse.json(savedBody());
    }),
  );
}

async function openRules() {
  const view = renderClient(<ArbiterPage />);
  await view.user.click(await screen.findByRole('button', { name: '规则' }));
  await screen.findByRole('heading', { name: '规则' });
  return view.user;
}

async function addRule(user: ReturnType<typeof renderClient>['user']) {
  await user.click(screen.getByRole('button', { name: '新建规则' }));
  const created = rows();
  const last = created[created.length - 1];
  if (last === undefined) throw new Error('no rule row appeared');
  return last.getAttribute('data-rule-row') ?? '';
}

function conditionGroups(id: string): readonly HTMLElement[] {
  return within(row(id)).getAllByRole('group', { name: /^条件 [0-9]+$/ });
}

describe('rule list header and inline editing', () => {
  test('a new rule is enabled, force-review and defaults to a RE2 command', async () => {
    baseHandlers();
    const user = await openRules();
    const id = await addRule(user);

    expect(row(id)).toHaveAttribute('data-rule-verdict', 'force-review');
    expect(
      within(row(id)).getByRole('checkbox', { name: /^启用规则/ }),
    ).toBeChecked();
    expect(
      within(row(id)).getByRole('combobox', { name: /^行为/ }),
    ).toHaveValue('force-review');
    expect(
      within(row(id)).getByRole('combobox', { name: '匹配对象' }),
    ).toHaveValue('command');
    expect(
      within(row(id)).getByRole('combobox', { name: '匹配方式' }),
    ).toHaveValue('regex');
    // The inline body never repeats the header's switch or verdict control.
    expect(
      within(screen.getByRole('region', { name: '匹配条件' })).queryByRole(
        'combobox',
        { name: /^行为/ },
      ),
    ).toBeNull();
  });

  test('a tool-argument condition defaults to exact with any selected value', async () => {
    baseHandlers();
    const user = await openRules();
    const id = await addRule(user);
    await user.selectOptions(
      within(row(id)).getByRole('combobox', { name: '匹配对象' }),
      'argument',
    );

    expect(
      within(row(id)).getByRole('combobox', { name: '匹配方式' }),
    ).toHaveValue('exact');
    expect(
      within(row(id)).getByRole('combobox', { name: '多值匹配' }),
    ).toHaveValue('any');
    expect(
      within(row(id)).getByRole('textbox', { name: 'JSONPath' }),
    ).toBeVisible();
  });

  test('a duplicated rule gets a new id and starts disabled', async () => {
    baseHandlers();
    const user = await openRules();
    const id = await addRule(user);
    await user.selectOptions(
      within(row(id)).getByRole('combobox', { name: /^行为/ }),
      'deny',
    );
    await user.click(within(row(id)).getByText('更多'));
    await user.click(within(row(id)).getByRole('button', { name: '复制' }));

    expect(rows()).toHaveLength(2);
    const copy = rows()[1];
    if (copy === undefined) throw new Error('the copy row is missing');
    const copyId = copy.getAttribute('data-rule-row') ?? '';
    expect(copyId).not.toBe(id);
    expect(
      within(copy).getByRole('checkbox', { name: /^启用规则/ }),
    ).not.toBeChecked();
    expect(within(copy).getByRole('combobox', { name: /^行为/ })).toHaveValue(
      'deny',
    );
  });

  test('a custom name replaces the summary and can be restored', async () => {
    baseHandlers();
    const user = await openRules();
    const id = await addRule(user);
    const name = within(row(id)).getByRole('textbox', { name: '显示名称' });

    // With no custom name the placeholder is the automatic summary.
    expect(name).toHaveAttribute('placeholder', expect.stringContaining('RE2'));
    await user.type(name, '只读查询');
    expect(name).toHaveValue('只读查询');
    // The row's name input carries the custom name; the summary stays a title.
    expect(
      within(row(id)).getByRole('textbox', { name: '显示名称' }),
    ).toHaveValue('只读查询');

    await user.click(
      within(row(id)).getByRole('button', { name: '恢复自动名称' }),
    );
    expect(
      within(row(id)).getByRole('textbox', { name: '显示名称' }),
    ).toHaveValue('');
    expect(
      within(row(id)).queryByRole('button', { name: '恢复自动名称' }),
    ).toBeNull();
  });

  test('adding and removing an alternative keeps conditions as OR', async () => {
    baseHandlers();
    const user = await openRules();
    const id = await addRule(user);
    await user.click(
      within(row(id)).getByRole('button', { name: '添加条件（或）' }),
    );
    expect(conditionGroups(id)).toHaveLength(2);
    expect(within(row(id)).getByText('满足以下任一条件')).toBeVisible();

    const second = conditionGroups(id)[1];
    if (second === undefined)
      throw new Error('the second condition is missing');
    await user.click(within(second).getByRole('button', { name: '删除条件' }));
    expect(conditionGroups(id)).toHaveLength(1);
  });

  test('multi-value mode, case-insensitivity and the path reach the save body', async () => {
    baseHandlers();
    const user = await openRules();
    const id = await addRule(user);
    await user.selectOptions(
      within(row(id)).getByRole('combobox', { name: '匹配对象' }),
      'argument',
    );
    await user.type(
      within(row(id)).getByRole('textbox', { name: 'JSONPath' }),
      '$.environments',
    );
    await user.selectOptions(
      within(row(id)).getByRole('combobox', { name: '匹配方式' }),
      'glob',
    );
    await user.type(
      within(row(id)).getByRole('textbox', { name: '表达式' }),
      'prod-*',
    );
    await user.selectOptions(
      within(row(id)).getByRole('combobox', { name: '多值匹配' }),
      'all',
    );
    await user.click(
      within(row(id)).getByRole('checkbox', { name: '忽略大小写' }),
    );
    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]).toMatchObject({
      config: {
        format: 'arbiter-config-v2',
        rules: [
          {
            id,
            verdict: 'force-review',
            enabled: true,
            conditions: [
              {
                target: 'argument',
                path: '$.environments',
                kind: 'glob',
                pattern: 'prod-*',
                multi: 'all',
                caseSensitive: false,
              },
            ],
          },
        ],
      },
    });
  });

  test('collapsing a row keeps every edit in the draft', async () => {
    baseHandlers();
    const user = await openRules();
    const id = await addRule(user);
    await user.type(
      within(row(id)).getByRole('textbox', { name: '表达式' }),
      'gh pr view(?: .*)?',
    );
    await user.type(
      within(row(id)).getByRole('textbox', { name: '备注' }),
      '只读查询',
    );
    await user.click(
      within(row(id)).getByRole('button', { name: /^收起规则/ }),
    );
    expect(
      within(row(id)).queryByRole('textbox', { name: '表达式' }),
    ).toBeNull();
    await user.click(
      within(row(id)).getByRole('button', { name: /^编辑规则/ }),
    );
    expect(
      within(row(id)).getByRole('textbox', { name: '表达式' }),
    ).toHaveValue('gh pr view(?: .*)?');
    expect(within(row(id)).getByRole('textbox', { name: '备注' })).toHaveValue(
      '只读查询',
    );
  });

  test('rule names may repeat and both rules stay in the draft', async () => {
    baseHandlers();
    const user = await openRules();
    const first = await addRule(user);
    await user.type(
      within(row(first)).getByRole('textbox', { name: '显示名称' }),
      '同名规则',
    );
    const second = await addRule(user);
    await user.type(
      within(row(second)).getByRole('textbox', { name: '显示名称' }),
      '同名规则',
    );

    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]).toMatchObject({
      config: { rules: [{ name: '同名规则' }, { name: '同名规则' }] },
    });
  });

  test('reordering stays inside one verdict and deleting removes only that rule', async () => {
    baseHandlers();
    const user = await openRules();
    const first = await addRule(user);
    const second = await addRule(user);
    const third = await addRule(user);

    // All three start on force-review, so the move is allowed.
    await user.click(within(row(third)).getByText('更多'));
    await user.click(within(row(third)).getByRole('button', { name: '上移' }));
    expect(rows().map((entry) => entry.getAttribute('data-rule-row'))).toEqual([
      first,
      third,
      second,
    ]);

    // A rule whose neighbour has another verdict cannot be reordered past it.
    await user.selectOptions(
      within(row(second)).getByRole('combobox', { name: /^行为/ }),
      'deny',
    );
    await user.click(within(row(second)).getByText('更多'));
    expect(
      within(row(second)).getByRole('button', { name: '上移' }),
    ).toBeDisabled();
    expect(
      within(row(second)).getByRole('button', { name: '下移' }),
    ).toBeDisabled();
    await user.click(within(row(second)).getByText('更多'));

    await user.click(within(row(third)).getByText('更多'));
    await user.click(within(row(third)).getByRole('button', { name: '删除' }));
    expect(rows().map((entry) => entry.getAttribute('data-rule-row'))).toEqual([
      first,
      second,
    ]);
  });

  test('typing a comma-separated scope keeps both tools and both agents', async () => {
    baseHandlers();
    const user = await openRules();
    const id = await addRule(user);
    await user.type(
      within(row(id)).getByRole('textbox', { name: '工具' }),
      'bash, deploy',
    );
    await user.type(
      within(row(id)).getByRole('textbox', { name: 'Agent' }),
      'main, subagent',
    );
    // The visible text is exactly what was typed, not a rewritten list.
    expect(within(row(id)).getByRole('textbox', { name: '工具' })).toHaveValue(
      'bash, deploy',
    );

    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]).toMatchObject({
      config: {
        rules: [
          {
            id,
            scope: {
              tools: ['bash', 'deploy'],
              agents: ['main', 'subagent'],
            },
          },
        ],
      },
    });
  });

  test('a scope field normalizes only after it loses focus', async () => {
    baseHandlers();
    const user = await openRules();
    const id = await addRule(user);
    const tools = within(row(id)).getByRole('textbox', { name: '工具' });
    await user.type(tools, 'bash, , deploy,');
    // While editing, the raw text stays so the caret does not jump.
    expect(tools).toHaveValue('bash, , deploy,');
    await user.tab();
    expect(tools).toHaveValue('bash, deploy');
  });

  test('switching a boolean exact value to another type keeps its meaning', async () => {
    baseHandlers();
    const user = await openRules();
    const id = await addRule(user);
    await user.selectOptions(
      within(row(id)).getByRole('combobox', { name: '匹配对象' }),
      'argument',
    );
    await user.type(
      within(row(id)).getByRole('textbox', { name: 'JSONPath' }),
      '$.dryRun',
    );
    const type = within(row(id)).getByRole('combobox', { name: '值类型' });
    await user.selectOptions(type, 'string');
    await user.clear(within(row(id)).getByRole('textbox', { name: '表达式' }));
    await user.type(
      within(row(id)).getByRole('textbox', { name: '表达式' }),
      'true',
    );
    // Selecting the boolean type parses the literal; it does not force false.
    await user.selectOptions(type, 'boolean');
    expect(
      within(row(id)).getByRole('combobox', { name: '表达式' }),
    ).toHaveValue('true');
    await user.selectOptions(
      within(row(id)).getByRole('combobox', { name: '匹配对象' }),
      'command',
    );
    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]).toMatchObject({
      config: {
        rules: [
          {
            id,
            conditions: [
              {
                target: 'command',
                kind: 'exact',
                pattern: 'true',
              },
            ],
          },
        ],
      },
    });
  });

  test('the header test action focuses the tester without running it', async () => {
    let tests = 0;
    baseHandlers();
    server.use(
      http.post('*/api/arbiter/test', () => {
        tests += 1;
        return HttpResponse.json({ ok: true, results: [] });
      }),
    );
    const user = await openRules();
    const id = await addRule(user);
    await user.type(
      within(row(id)).getByRole('textbox', { name: '显示名称' }),
      '只读查询',
    );
    await user.click(within(row(id)).getByRole('button', { name: '测试' }));

    expect(await screen.findByText('聚焦规则：只读查询')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '输入' })).toHaveFocus();
    expect(tests).toBe(0);
  });
});

describe('locale fallback', () => {
  test('an English host falls back to Chinese per missing rules key, never a bare key', async () => {
    baseHandlers();
    const view = renderClient(<ArbiterPage />, { locale: 'en' });
    await view.user.click(await screen.findByRole('button', { name: '规则' }));
    // en only carries common.json, so the whole rules module falls back to zh.
    await screen.findByRole('heading', { name: '规则' });
    await view.user.click(screen.getByRole('button', { name: '新建规则' }));
    expect(
      screen.getByRole('textbox', { name: '显示名称' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /^行为/ })).toHaveValue(
      'force-review',
    );
    expect(screen.getByText('满足以下任一条件')).toBeVisible();
    expect(
      screen.getByRole('button', { name: '添加条件（或）' }),
    ).toBeVisible();
    // No raw key, blank label or undefined placeholder anywhere in the editor.
    expect(document.body.textContent).not.toMatch(
      /rules\.[A-Za-z]+|undefined|\[object Object\]/u,
    );
  });
});

describe('rule validation feedback', () => {
  test('an empty condition list stays editable but the save is rejected', async () => {
    baseHandlers();
    server.use(
      http.post('*/api/arbiter/config/save', async ({ request }) => {
        saved.push(await request.json());
        return HttpResponse.json(
          {
            ok: false,
            code: 'config-invalid',
            errors: [
              {
                path: 'rules[0].conditions',
                message: 'a rule requires at least one condition',
                code: 'rule.conditions-empty',
              },
            ],
            warnings: [],
          },
          { status: 422 },
        );
      }),
    );
    const user = await openRules();
    const id = await addRule(user);
    const [first] = conditionGroups(id);
    if (first === undefined) throw new Error('the condition is missing');
    await user.click(within(first).getByRole('button', { name: '删除条件' }));

    // The draft stays editable and explains why it cannot be applied.
    expect(screen.getByText(/没有匹配条件/)).toBeInTheDocument();
    expect(
      within(row(id)).getByRole('button', { name: '添加条件（或）' }),
    ).toBeEnabled();

    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(await screen.findByText(/配置校验失败，未保存/)).toHaveTextContent(
      'rules[0].conditions: 每条规则至少需要一个匹配条件',
    );
    // The failure is located on the rule and does not claim effectiveness.
    expect(
      within(row(id)).getByText(/每条规则至少需要一个匹配条件/),
    ).toBeInTheDocument();
    expect(screen.getByTestId('arbiter-save-status')).toHaveTextContent(
      '保存或应用失败；当前生效配置未改变。',
    );
    expect(screen.queryByText('已保存并生效。')).toBeNull();
  });

  test('a shadowing warning is shown next to the rule and does not block saving', async () => {
    const loaded = effectiveState();
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json({
          ...loaded,
          config: {
            ...loaded.config,
            rules: [
              {
                id: 'rule-1',
                conditions: [
                  { target: 'command', kind: 'regex', pattern: 'gh pr view' },
                ],
                verdict: 'allow',
              },
              {
                id: 'rule-2',
                conditions: [
                  { target: 'command', kind: 'regex', pattern: 'gh pr' },
                ],
                verdict: 'force-review',
              },
            ],
          },
          warnings: [
            {
              path: 'rules.rule-1',
              message: 'allow rule "rule-1" may be shadowed by "rule-2"',
              code: 'rule.shadowed',
              params: { allow: 'rule-1', review: 'rule-2' },
            },
          ],
        }),
      ),
      http.post('*/api/arbiter/config/save', async ({ request }) => {
        saved.push(await request.json());
        return HttpResponse.json(savedBody());
      }),
    );
    const user = await openRules();
    // The warning is attached to the allow rule, not to the reviewer rule.
    await user.click(
      within(row('rule-1')).getByRole('button', { name: /^编辑规则/ }),
    );
    expect(
      within(row('rule-1')).getByText(
        /规则「rule-1」可能被 force-review 规则「rule-2」遮蔽/,
      ),
    ).toBeInTheDocument();
    await user.click(
      within(row('rule-2')).getByRole('button', { name: /^编辑规则/ }),
    );
    expect(
      within(row('rule-2')).queryByText(/可能被 force-review 规则/),
    ).toBeNull();

    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(screen.getByTestId('arbiter-save-status')).toHaveTextContent(
      '已保存并生效。',
    );
  });

  test('editing the draft drops findings that were reported for the old content', async () => {
    baseHandlers();
    server.use(
      http.post('*/api/arbiter/validate', () =>
        HttpResponse.json({
          ok: true,
          errors: [
            {
              path: 'rules[0].conditions[0].pattern',
              message: 'a match expression is required',
              code: 'rule.pattern-empty',
            },
          ],
          warnings: [],
        }),
      ),
    );
    const user = await openRules();
    const id = await addRule(user);
    await user.click(screen.getByRole('button', { name: '校验草稿' }));
    expect(
      await within(row(id)).findByText(/匹配表达式不能为空/),
    ).toBeInTheDocument();

    // Neither fixing nor deleting the rule may keep another rule's finding.
    await user.type(
      within(row(id)).getByRole('textbox', { name: '表达式' }),
      'gh pr view(?: .*)?',
    );
    expect(within(row(id)).queryByText(/匹配表达式不能为空/)).toBeNull();
  });

  test('a validation answer that arrives after an edit is discarded', async () => {
    baseHandlers();
    let release: (() => void) | undefined;
    server.use(
      http.post('*/api/arbiter/validate', async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return HttpResponse.json({
          ok: true,
          errors: [
            {
              path: 'rules[0].conditions[0].pattern',
              message: 'a match expression is required',
              code: 'rule.pattern-empty',
            },
          ],
          warnings: [],
        });
      }),
    );
    const user = await openRules();
    const id = await addRule(user);
    await user.click(screen.getByRole('button', { name: '校验草稿' }));
    await waitFor(() => {
      expect(release).toBeDefined();
    });
    // The draft changes while the request is in flight.
    await user.type(
      within(row(id)).getByRole('textbox', { name: '表达式' }),
      'gh pr view',
    );
    release?.();
    await waitFor(() => {
      expect(screen.queryByText(/配置校验失败/)).toBeNull();
    });
    expect(within(row(id)).queryByText(/匹配表达式不能为空/)).toBeNull();
  });

  test('a failed save keeps the expanded edits and the draft', async () => {
    baseHandlers();
    server.use(
      http.post('*/api/arbiter/config/save', () =>
        HttpResponse.json(
          {
            ok: false,
            code: 'config-conflict',
            message: 'the profile patch changed after this draft was read',
          },
          { status: 409 },
        ),
      ),
    );
    const user = await openRules();
    const id = await addRule(user);
    await user.type(
      within(row(id)).getByRole('textbox', { name: '表达式' }),
      'gh pr view(?: .*)?',
    );
    await user.click(screen.getByRole('button', { name: '保存并应用' }));

    expect(await screen.findByText(/配置文件已被外部修改/)).toBeInTheDocument();
    expect(
      within(row(id)).getByRole('textbox', { name: '表达式' }),
    ).toHaveValue('gh pr view(?: .*)?');
    expect(screen.getByTestId('arbiter-save-status')).toHaveTextContent(
      '保存或应用失败；当前生效配置未改变。',
    );
  });
});
