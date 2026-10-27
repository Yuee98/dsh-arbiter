import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, test } from 'vitest';

import { ArbiterPage } from '../../src/client/index.js';
import { setupApiMock } from '../helpers/api-mock.js';
import { effectiveState } from '../helpers/client-state.js';
import { renderClient } from '../helpers/render-client.js';

const server = setupApiMock();

/** A gate whose release this test controls, for in-flight responses. */
function deferred() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

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
    await user.click(within(row(id)).getByRole('button', { name: /^复制/ }));

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

  test('duplicating a two-condition rule keeps its connective', async () => {
    baseHandlers();
    const user = await openRules();
    const id = await addRule(user);
    await user.click(within(row(id)).getByRole('button', { name: '添加条件' }));
    await user.click(within(row(id)).getByRole('radio', { name: '任一满足' }));
    await user.click(within(row(id)).getByRole('button', { name: /^复制/ }));

    const copyId = rows()[1]?.getAttribute('data-rule-row') ?? '';
    // A copy is the same rule with a new id: dropping the connective would leave
    // a multi-condition rule that v3 refuses to save, and show the default here.
    // The summary names it even before the row is expanded.
    expect(
      within(row(copyId)).getByRole('checkbox', { name: /任一满足/ }),
    ).toBeInTheDocument();
    await user.click(
      within(row(copyId)).getByRole('button', { name: /^(展开|编辑)规则/ }),
    );
    expect(
      within(row(copyId)).getByRole('radio', { name: '任一满足' }),
    ).toBeChecked();
    expect(conditionGroups(copyId)).toHaveLength(2);
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

  test('a multi-word custom name keeps the space that was just typed', async () => {
    baseHandlers();
    const user = await openRules();
    const id = await addRule(user);
    const name = within(row(id)).getByRole('textbox', { name: '显示名称' });
    // Inner spaces belong to the name; no keystroke may collapse them.
    await user.type(name, '只读 查询');
    expect(name).toHaveValue('只读 查询');

    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]).toMatchObject({
      config: { rules: [{ id, name: '只读 查询' }] },
    });
  });

  test('a regular-expression pattern is never rewritten while typing', async () => {
    baseHandlers();
    const user = await openRules();
    const id = await addRule(user);
    const pattern = within(row(id)).getByRole('textbox', { name: '表达式' });
    // Anchors, escapes and quantifiers are ordinary text to this field.
    await user.type(pattern, '^gh pr (view|list)\\s+\\d+$');
    expect(pattern).toHaveValue('^gh pr (view|list)\\s+\\d+$');
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
                kind: 'regex',
                pattern: '^gh pr (view|list)\\s+\\d+$',
              },
            ],
          },
        ],
      },
    });
  });

  test('a JSONPath stays exactly as typed, brackets and quotes included', async () => {
    baseHandlers();
    const user = await openRules();
    const id = await addRule(user);
    await user.selectOptions(
      within(row(id)).getByRole('combobox', { name: '匹配对象' }),
      'argument',
    );
    const path = within(row(id)).getByRole('textbox', { name: 'JSONPath' });
    // Braces and quotes are user-event syntax, so the value is pasted.
    await user.click(path);
    await user.paste("$['a.b'][*].path");
    expect(path).toHaveValue("$['a.b'][*].path");
    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]).toMatchObject({
      config: {
        rules: [{ id, conditions: [{ path: "$['a.b'][*].path" }] }],
      },
    });
  });

  test('adding and removing a condition keeps the chosen connective', async () => {
    baseHandlers();
    const user = await openRules();
    const id = await addRule(user);
    // A new rule starts on "all": adding a condition narrows it.
    await user.click(within(row(id)).getByRole('button', { name: '添加条件' }));
    expect(conditionGroups(id)).toHaveLength(2);
    expect(within(row(id)).getByText('条件组合方式')).toBeVisible();
    const allRadio = within(row(id)).getByRole('radio', {
      name: '全部满足',
    });
    expect(allRadio).toBeChecked();

    // Switch to "any", drop back to one condition, then add another: the value
    // must survive the round trip instead of being reset to the default.
    const anyRadio = within(row(id)).getByRole('radio', {
      name: '任一满足',
    });
    await user.click(anyRadio);
    const second = conditionGroups(id)[1];
    if (second === undefined)
      throw new Error('the second condition is missing');
    await user.click(within(second).getByRole('button', { name: '删除条件' }));
    await user.click(within(second).getByRole('button', { name: /确认删除/ }));
    expect(conditionGroups(id)).toHaveLength(1);
    await user.click(within(row(id)).getByRole('button', { name: '添加条件' }));
    expect(
      within(row(id)).getByRole('radio', { name: '任一满足' }),
    ).toBeChecked();
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
        format: 'arbiter-config-v3',
        rules: [
          {
            id,
            verdict: 'force-review',
            enabled: true,
            combine: 'all',
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

  test('a decimal typed into a numeric exact pattern keeps every digit', async () => {
    baseHandlers();
    const user = await openRules();
    const id = await addRule(user);
    await user.selectOptions(
      within(row(id)).getByRole('combobox', { name: '匹配对象' }),
      'argument',
    );
    await user.type(
      within(row(id)).getByRole('textbox', { name: 'JSONPath' }),
      '$.retries',
    );
    const pattern = within(row(id)).getByRole('textbox', {
      name: '表达式',
    });
    // The type selector appears once a value exists, so the number is typed as
    // text and then declared numeric.
    await user.type(pattern, '1.5');
    await user.selectOptions(
      within(row(id)).getByRole('combobox', { name: '值类型' }),
      'number',
    );
    expect(
      within(row(id)).getByRole('combobox', { name: '值类型' }),
    ).toHaveValue('number');
    // The number editor replaced the text field; it shows the same value.
    const numberInput = within(row(id)).getByRole('textbox', {
      name: '表达式',
    });
    expect(numberInput).toHaveValue('1.5');
    await user.clear(numberInput);
    // While editing, the field may be empty...
    expect(numberInput).toHaveValue('');
    await user.tab();
    // ...and leaving it shows the number the draft actually holds.
    expect(
      within(row(id)).getByRole('textbox', { name: '表达式' }),
    ).toHaveValue('1.5');

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
                target: 'argument',
                path: '$.retries',
                kind: 'exact',
                pattern: 1.5,
              },
            ],
          },
        ],
      },
    });
  });

  test('a negative numeric pattern survives its leading minus', async () => {
    baseHandlers();
    const user = await openRules();
    const id = await addRule(user);
    await user.selectOptions(
      within(row(id)).getByRole('combobox', { name: '匹配对象' }),
      'argument',
    );
    await user.type(
      within(row(id)).getByRole('textbox', { name: 'JSONPath' }),
      '$.offset',
    );
    await user.type(
      within(row(id)).getByRole('textbox', { name: '表达式' }),
      '-3',
    );
    await user.selectOptions(
      within(row(id)).getByRole('combobox', { name: '值类型' }),
      'number',
    );
    const pattern = within(row(id)).getByRole('textbox', {
      name: '表达式',
    });
    await user.clear(pattern);
    pattern.focus();
    // Type key by key so the intermediate `-` is really rendered.
    await user.keyboard('-');
    expect(pattern).toHaveValue('-');
    await user.keyboard('3');
    expect(pattern).toHaveValue('-3');
    // Blur shows what the draft holds; it is the same negative number.
    await user.tab();
    expect(pattern).toHaveValue('-3');

    // Clearing is an edit while focused; leaving the field shows the number the
    // draft actually holds, rather than a half-typed value.
    await user.clear(pattern);
    expect(pattern).toHaveValue('');
    await user.tab();
    expect(pattern).toHaveValue('-3');

    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    // The typed number is a JSON number, not the string "-3".
    expect(saved[0]).toMatchObject({
      config: {
        rules: [
          {
            id,
            conditions: [
              {
                target: 'argument',
                path: '$.offset',
                kind: 'exact',
                pattern: -3,
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
      within(row(id)).getByRole('button', { name: /^(展开|编辑)规则/ }),
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
    await user.click(within(row(third)).getByRole('button', { name: /^上移/ }));
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
    expect(
      within(row(second)).getByRole('button', { name: /^上移/ }),
    ).toBeDisabled();
    expect(
      within(row(second)).getByRole('button', { name: /^下移/ }),
    ).toBeDisabled();

    // Two-step inline delete: first arm, then confirm
    await user.click(
      within(row(third)).getByRole('button', { name: /^删除规则/ }),
    );
    await user.click(
      within(row(third)).getByRole('button', { name: /^确认删除/ }),
    );
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

  test('a blank exact pattern allows selecting null or keeping string without inventing values', async () => {
    baseHandlers();
    const user = await openRules();
    const id = await addRule(user);
    await user.selectOptions(
      within(row(id)).getByRole('combobox', { name: '匹配对象' }),
      'argument',
    );
    await user.type(
      within(row(id)).getByRole('textbox', { name: 'JSONPath' }),
      '$.retries',
    );

    // Value type selector is always available
    expect(
      within(row(id)).getByRole('combobox', { name: '值类型' }),
    ).toHaveValue('string');

    // Selecting null sets pattern to null
    await user.selectOptions(
      within(row(id)).getByRole('combobox', { name: '值类型' }),
      'null',
    );

    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]).toMatchObject({
      config: {
        rules: [{ id, conditions: [{ target: 'argument', pattern: null }] }],
      },
    });
  });

  test('selecting number on blank exact condition blocks save until completed', async () => {
    baseHandlers();
    const user = await openRules();
    const id = await addRule(user);
    await user.selectOptions(
      within(row(id)).getByRole('combobox', { name: '匹配对象' }),
      'argument',
    );
    await user.type(
      within(row(id)).getByRole('textbox', { name: 'JSONPath' }),
      '$.count',
    );

    // Select number on blank pattern: enters pending state without inventing 0
    await user.selectOptions(
      within(row(id)).getByRole('combobox', { name: '值类型' }),
      'number',
    );
    expect(
      within(row(id)).getByRole('textbox', { name: '表达式' }),
    ).toHaveValue('');

    // Attempting to save blocks and reports incomplete issue
    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    expect(saved).toHaveLength(0);
    expect(await screen.findByText(/配置校验失败，未保存/)).toHaveTextContent(
      /请先完成精确匹配条件的值输入/,
    );

    // Typing a valid number completes the condition
    await user.type(
      within(row(id)).getByRole('textbox', { name: '表达式' }),
      '5',
    );
    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]).toMatchObject({
      config: {
        rules: [{ id, conditions: [{ target: 'argument', pattern: 5 }] }],
      },
    });
  });

  test('switching target away from argument discards pending exact type and allows saving string condition', async () => {
    baseHandlers();
    const user = await openRules();
    const id = await addRule(user);
    await user.selectOptions(
      within(row(id)).getByRole('combobox', { name: '匹配对象' }),
      'argument',
    );
    await user.type(
      within(row(id)).getByRole('textbox', { name: 'JSONPath' }),
      '$.count',
    );

    // Enter pending number state
    await user.selectOptions(
      within(row(id)).getByRole('combobox', { name: '值类型' }),
      'number',
    );
    expect(
      within(row(id)).getByRole('textbox', { name: '表达式' }),
    ).toHaveValue('');

    // Switch target to tool
    await user.selectOptions(
      within(row(id)).getByRole('combobox', { name: '匹配对象' }),
      'tool',
    );
    await user.type(
      within(row(id)).getByRole('textbox', { name: '表达式' }),
      'bash',
    );

    // Save succeeds without incomplete exact value error
    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]).toMatchObject({
      config: {
        rules: [{ id, conditions: [{ target: 'tool', pattern: 'bash' }] }],
      },
    });
  });

  test('a deliberate exact empty string is kept as a value', async () => {
    baseHandlers();
    const user = await openRules();
    const id = await addRule(user);
    await user.selectOptions(
      within(row(id)).getByRole('combobox', { name: '匹配对象' }),
      'argument',
    );
    await user.type(
      within(row(id)).getByRole('textbox', { name: 'JSONPath' }),
      '$.label',
    );
    const pattern = within(row(id)).getByRole('textbox', {
      name: '表达式',
    });
    await user.type(pattern, 'x');
    await user.selectOptions(
      within(row(id)).getByRole('combobox', { name: '值类型' }),
      'string',
    );
    // Emptying a typed value keeps the field as text; only a value typed from
    // scratch counts as "no value yet". Text is never auto-converted here.
    await user.clear(pattern);
    expect(
      within(row(id)).getByRole('combobox', { name: '值类型' }),
    ).toHaveValue('string');
    expect(
      within(row(id)).getByRole('textbox', { name: '表达式' }),
    ).toHaveValue('');
  });

  test('a typed literal becomes the boolean it spells, and text again on a text target', async () => {
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
    // Type the literal as text first; the type selector needs a value.
    await user.type(
      within(row(id)).getByRole('textbox', { name: '表达式' }),
      'true',
    );
    // Selecting the boolean type parses the literal; it does not force false.
    await user.selectOptions(
      within(row(id)).getByRole('combobox', { name: '值类型' }),
      'boolean',
    );
    expect(
      within(row(id)).getByRole('combobox', { name: '表达式' }),
    ).toHaveValue('true');

    // `command` compares text, so the typed value becomes its JSON spelling.
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
    await user.click(within(row(id)).getByRole('button', { name: /^测试/ }));

    // The tester is only a focus request: the block opens, carries the rule it
    // answers about, and no sample is submitted until the operator asks.
    expect(await screen.findByTestId('rule-test-body')).toBeVisible();
    expect(screen.getByTestId('rule-test-body')).toHaveFocus();
    expect(screen.getByTestId('rule-test-target')).toHaveTextContent(
      '只读查询',
    );
    expect(tests).toBe(0);
  });
});

describe('locale handling', () => {
  test('an English host renders the released rules editor, never a bare key', async () => {
    baseHandlers();
    const view = renderClient(<ArbiterPage />, { locale: 'en' });
    // Since #23 the rules module is a declared English translation, so the tab,
    // the heading and the editor controls read in English.
    await view.user.click(await screen.findByRole('button', { name: 'Rules' }));
    await screen.findByRole('heading', { name: 'Rules' });
    await view.user.click(screen.getByRole('button', { name: 'New rule' }));
    expect(
      screen.getByRole('textbox', { name: 'Display name' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /^Behavior/ })).toHaveValue(
      'force-review',
    );
    // A brand-new rule has one condition, so the connective control is not shown
    // yet; the heading names what the list is rather than claiming a combination.
    expect(screen.getByText('Match conditions')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add condition' })).toBeVisible();
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
    await user.click(within(first).getByRole('button', { name: /确认删除/ }));

    // The draft stays editable and explains why it cannot be applied.
    expect(screen.getByText(/没有匹配条件/)).toBeInTheDocument();
    expect(
      within(row(id)).getByRole('button', { name: '添加条件' }),
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
      within(row('rule-1')).getByRole('button', { name: /^(展开|编辑)规则/ }),
    );
    expect(
      within(row('rule-1')).getByText(
        /规则「rule-1」可能被 force-review 规则「rule-2」遮蔽/,
      ),
    ).toBeInTheDocument();
    await user.click(
      within(row('rule-2')).getByRole('button', { name: /^(展开|编辑)规则/ }),
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
    const gate = deferred();
    let handled: (() => void) | undefined;
    const answered = new Promise<void>((resolve) => {
      handled = resolve;
    });
    server.use(
      http.post('*/api/arbiter/validate', async () => {
        await gate.promise;
        const body = HttpResponse.json({
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
        handled?.();
        return body;
      }),
    );
    const user = await openRules();
    const id = await addRule(user);
    await user.click(screen.getByRole('button', { name: '校验草稿' }));
    // The draft changes while the request is in flight.
    await user.type(
      within(row(id)).getByRole('textbox', { name: '表达式' }),
      'gh pr view',
    );
    gate.release();
    // Synchronize on the response actually being handled before asserting.
    await answered;
    await waitFor(() => {
      expect(screen.queryByText(/配置校验失败/)).toBeNull();
    });
    expect(within(row(id)).queryByText(/匹配表达式不能为空/)).toBeNull();
  });

  test('reloading a draft discards an answer for the previous draft', async () => {
    baseHandlers();
    const gate = deferred();
    let handled: (() => void) | undefined;
    const answered = new Promise<void>((resolve) => {
      handled = resolve;
    });
    server.use(
      http.post('*/api/arbiter/validate', async () => {
        await gate.promise;
        const body = HttpResponse.json({
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
        handled?.();
        return body;
      }),
    );
    const user = await openRules();
    await addRule(user);
    await user.click(screen.getByRole('button', { name: '校验草稿' }));
    // Reload replaces the draft, so the old validation is about nothing.
    await user.click(screen.getByRole('button', { name: '重新读取' }));
    gate.release();
    // The answer is consumed only after the reload has already replaced the
    // draft, which is exactly the stale case.
    await answered;
    await waitFor(() => {
      expect(screen.queryByRole('list', { name: '规则' })).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByTestId('arbiter-save-status')).toHaveTextContent(
        '当前草稿与生效配置一致。',
      );
    });
    expect(screen.queryByText(/配置校验失败/)).toBeNull();
    expect(screen.queryByText(/匹配表达式不能为空/)).toBeNull();
  });

  test('a save rejection does not attach its findings to a newer draft', async () => {
    baseHandlers();
    const gate = deferred();
    let handled: (() => void) | undefined;
    const answered = new Promise<void>((resolve) => {
      handled = resolve;
    });
    server.use(
      http.post('*/api/arbiter/config/save', async ({ request }) => {
        saved.push(await request.json());
        await gate.promise;
        const body = HttpResponse.json(
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
        handled?.();
        return body;
      }),
    );
    const user = await openRules();
    const doomed = await addRule(user);
    const kept = await addRule(user);
    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    // The user deletes the offending rule before the rejection arrives.
    await user.click(
      within(row(doomed)).getByRole('button', { name: /^删除规则/ }),
    );
    await user.click(
      within(row(doomed)).getByRole('button', { name: /^确认删除/ }),
    );
    gate.release();
    await answered;

    // The failure is still reported, but the surviving rule carries no finding
    // that was produced for the deleted one.
    expect(await screen.findByText(/配置校验失败，未保存/)).toBeInTheDocument();
    expect(
      within(row(kept)).queryByText(/每条规则至少需要一个匹配条件/),
    ).toBeNull();
  });

  test('edits made while the post-save reload is pending are preserved', async () => {
    baseHandlers();
    const reloadGate = deferred();
    let stateCalls = 0;
    server.use(
      http.get('*/api/arbiter/state', async () => {
        stateCalls += 1;
        const loaded = effectiveState();
        // The reload after a save reports the new identities.
        if (stateCalls === 1) return HttpResponse.json(loaded);
        await reloadGate.promise;
        return HttpResponse.json({
          ...loaded,
          fileRevision: 'file-2',
          effectiveRevision: 'effective-2',
          configSnapshotId: 'snapshot-2',
        });
      }),
    );
    const user = await openRules();
    const id = await addRule(user);
    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    await waitFor(() => {
      expect(stateCalls).toBe(2);
    });

    // The save succeeded and its reload is still pending; the user edits.
    await user.type(
      within(row(id)).getByRole('textbox', { name: '表达式' }),
      'typed during reload',
    );
    reloadGate.release();

    // The new identities arrive, and the newer edit is still an unsaved draft.
    await waitFor(() => {
      expect(screen.getByText('文件修订 file-2')).toBeVisible();
    });
    expect(
      within(row(id)).getByRole('textbox', { name: '表达式' }),
    ).toHaveValue('typed during reload');
    expect(screen.getByTestId('arbiter-save-status')).toHaveTextContent(
      '草稿未保存',
    );
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

/**
 * The rule tester's rejected-selector action, through the real panel.
 *
 * The tester reports `rules[N].conditions[M].path`; this proves the action from
 * the tester reaches the editor that owns that field — the rule expands and the
 * JSONPath input for that exact condition takes focus. It is the integration
 * point between the two components, not a second test of either one.
 */
describe('rule tester selector location', () => {
  test('a rejected selector focuses the condition that owns it', async () => {
    baseHandlers();
    server.use(
      http.post('*/api/arbiter/test', () =>
        HttpResponse.json(
          {
            ok: false,
            code: 'invalid-rule',
            message: 'the submitted rules are not valid',
            errors: [
              {
                // The second rule's second condition, so a wrong index would be
                // visible as the wrong rule or the wrong condition.
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
    const user = await openRules();

    // Two rules, each with two OR conditions; the second condition of the second
    // rule is the one the backend rejects.
    const first = await addRule(user);
    await user.click(
      within(row(first)).getByRole('button', { name: '添加条件' }),
    );
    const second = await addRule(user);
    await user.click(
      within(row(second)).getByRole('button', { name: '添加条件' }),
    );
    const groups = conditionGroups(second);
    expect(groups).toHaveLength(2);
    const target = groups[1];
    if (target === undefined) throw new Error('missing second condition');
    await user.selectOptions(
      within(target).getByRole('combobox', { name: '匹配对象' }),
      'argument',
    );
    const jsonPath = within(target).getByRole('textbox', { name: 'JSONPath' });
    await user.click(jsonPath);
    await user.paste('$.');

    // Run from the tester for the first rule; the rejection belongs to the
    // second one, so locating it has to move as well as expand.
    await user.click(within(row(first)).getByRole('button', { name: /^测试/ }));
    await user.click(screen.getByRole('button', { name: '运行测试' }));
    const locate = await screen.findByRole('button', {
      name: '定位到 rules[1].conditions[1].path',
    });
    await user.click(locate);

    // The owning rule is expanded and the exact condition's JSONPath field has
    // focus; neither the first rule nor the first condition would do.
    await waitFor(() => {
      expect(
        within(row(second)).getByRole('textbox', { name: 'JSONPath' }),
      ).toBeVisible();
    });
    expect(jsonPath).toHaveFocus();
    expect(
      within(row(first)).queryByRole('textbox', { name: 'JSONPath' }),
    ).toBeNull();
  });
});

describe('condition combining', () => {
  async function twoConditions(): Promise<{
    readonly user: ReturnType<typeof renderClient>['user'];
    readonly id: string;
  }> {
    baseHandlers();
    const user = await openRules();
    const id = await addRule(user);
    await user.click(within(row(id)).getByRole('button', { name: '添加条件' }));
    return { user, id };
  }

  test('the control appears only once a second condition exists', async () => {
    baseHandlers();
    const user = await openRules();
    const id = await addRule(user);
    // One condition: both values judge identically, so offering the choice would
    // ask a question that has no consequence.
    expect(
      within(row(id)).queryByRole('radiogroup', { name: '条件组合方式' }),
    ).toBeNull();
    await user.click(within(row(id)).getByRole('button', { name: '添加条件' }));
    expect(
      within(row(id)).getByRole('radio', { name: '全部满足' }),
    ).toBeChecked();
  });

  test('a conjunction over two kinds of structure states its limitation', async () => {
    const { user, id } = await twoConditions();
    const [first, second] = conditionGroups(id);
    if (first === undefined || second === undefined)
      throw new Error('two conditions were expected');
    // One command condition and one redirect condition can come from different
    // statements, so the editor must not let the rule look narrower than it is.
    await user.selectOptions(
      within(second).getByRole('combobox', { name: '匹配对象' }),
      'file_redirect',
    );
    expect(within(row(id)).getByText(/可能来自不同的语句/)).toBeVisible();

    // Switching to "any" removes the claim, so the note must go with it.
    await user.click(within(row(id)).getByRole('radio', { name: '任一满足' }));
    expect(within(row(id)).queryByText(/可能来自不同的语句/)).toBeNull();
  });

  test('one structural target alone does not raise the limitation note', async () => {
    const { id } = await twoConditions();
    // Two command conditions are judged node by node, so there is no statement to
    // be confused about.
    expect(within(row(id)).queryByText(/可能来自不同的语句/)).toBeNull();
  });
});

describe('source warnings outlive draft edits', () => {
  test('an unresolved warning from the loaded file stays visible until it is reloaded', async () => {
    // A misspelled field in an externally edited v2 file: the document still
    // loads with the meaning it declares, and the warning is about the file on
    // disk — not about whatever the draft currently holds.
    baseHandlers();
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json({
          ...effectiveState(),
          warnings: [
            {
              path: 'rules[0].combinee',
              message: 'unknown field "combinee"',
              code: 'rule.unknown-field',
              params: { field: 'combinee' },
            },
          ],
        }),
      ),
    );
    const view = renderClient(<ArbiterPage />);
    // The page-level notice and the rule's own hint both report it, so count
    // rather than search for a single node.
    const warnings = await screen.findAllByText(/未知字段/);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toHaveTextContent('rules[0].combinee');

    // Editing an unrelated setting must not hide a problem in the file that is
    // still unchanged on disk.
    await view.user.click(await screen.findByRole('button', { name: '规则' }));
    await view.user.click(screen.getByRole('button', { name: '新建规则' }));
    const stillShown = screen.getAllByText(/未知字段/);
    expect(stillShown.length).toBeGreaterThan(0);
    expect(stillShown[0]).toHaveTextContent('rules[0].combinee');
  });
});

describe('source findings classification', () => {
  test('a configuration error from the file is not also reported as a warning', async () => {
    // The host rejected the file, so the error belongs to the error presentation.
    // Listing it as a warning too would call an invalid configuration advisory.
    baseHandlers();
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json({
          ...effectiveState(),
          loadErrors: [
            {
              path: 'rules[0].combine',
              message: 'a rule with several conditions must state "combine"',
              code: 'rule.combine-required',
            },
          ],
          warnings: [],
        }),
      ),
    );
    renderClient(<ArbiterPage />);
    const error = await screen.findByText(/必须声明条件组合方式/);
    expect(error).toHaveTextContent('rules[0].combine');
    // The same text must not appear a second time as an informational notice.
    expect(screen.queryAllByText(/必须声明条件组合方式/)).toHaveLength(1);
  });
});

describe('source warnings after a save', () => {
  test('a warning the save resolved does not outlive it, even with a pending edit', async () => {
    // The file changed: the field the warning was about is gone. A draft edit
    // made while the save's reload is in flight must not preserve that warning,
    // because it no longer describes anything on disk.
    const reloadGate = deferred();
    let stateCalls = 0;
    server.use(
      http.get('*/api/arbiter/state', async () => {
        stateCalls += 1;
        const loaded = effectiveState();
        if (stateCalls === 1) {
          return HttpResponse.json({
            ...loaded,
            warnings: [
              {
                path: 'rules[0].combinee',
                message: 'unknown field "combinee"',
                code: 'rule.unknown-field',
                params: { field: 'combinee' },
              },
            ],
          });
        }
        // The saved document no longer carries the misspelled field.
        await reloadGate.promise;
        return HttpResponse.json({
          ...loaded,
          fileRevision: 'file-2',
          effectiveRevision: 'effective-2',
          configSnapshotId: 'snapshot-2',
          warnings: [],
        });
      }),
    );
    baseHandlers();
    server.use(
      http.get('*/api/arbiter/state', async () => {
        stateCalls += 1;
        const loaded = effectiveState();
        if (stateCalls === 1) {
          return HttpResponse.json({
            ...loaded,
            warnings: [
              {
                path: 'rules[0].combinee',
                message: 'unknown field "combinee"',
                code: 'rule.unknown-field',
                params: { field: 'combinee' },
              },
            ],
          });
        }
        await reloadGate.promise;
        return HttpResponse.json({
          ...loaded,
          fileRevision: 'file-2',
          effectiveRevision: 'effective-2',
          configSnapshotId: 'snapshot-2',
          warnings: [],
        });
      }),
    );
    const user = await openRules();
    expect((await screen.findAllByText(/未知字段/)).length).toBeGreaterThan(0);

    const id = await addRule(user);
    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    await waitFor(() => {
      expect(stateCalls).toBe(2);
    });
    // Edit while the reload is in flight, so the draft is newer than the save.
    await user.type(
      within(row(id)).getByRole('textbox', { name: '表达式' }),
      'typed during reload',
    );
    reloadGate.release();

    await waitFor(() => {
      expect(screen.getByText('文件修订 file-2')).toBeVisible();
    });
    // The warning described the replaced file, so it is gone; the draft survives.
    expect(screen.queryAllByText(/未知字段/)).toHaveLength(0);
    expect(
      within(row(id)).getByRole('textbox', { name: '表达式' }),
    ).toHaveValue('typed during reload');
  });

  test('closing rule tester restores focus to toolbar opener button', async () => {
    baseHandlers();
    const user = await openRules();
    const testToolbarBtn = screen.getByRole('button', { name: '规则测试' });
    testToolbarBtn.focus();
    await user.click(testToolbarBtn);

    const dialog = await screen.findByRole('dialog', { name: '规则测试' });
    expect(dialog).toBeInTheDocument();

    const closeBtn = screen.getByRole('button', { name: '关闭' });
    await user.click(closeBtn);

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '规则测试' })).toBeNull();
    });
    expect(testToolbarBtn).toHaveFocus();
  });

  test('closing rule tester restores focus to per-rule test button', async () => {
    baseHandlers();
    const user = await openRules();
    const id = await addRule(user);
    const ruleTestBtn = within(row(id)).getByRole('button', {
      name: /测试规则/,
    });
    ruleTestBtn.focus();
    await user.click(ruleTestBtn);

    const dialog = await screen.findByRole('dialog', { name: '规则测试' });
    expect(dialog).toBeInTheDocument();

    const closeBtn = screen.getByRole('button', { name: '关闭' });
    await user.click(closeBtn);

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '规则测试' })).toBeNull();
    });
    expect(ruleTestBtn).toHaveFocus();
  });

  test('closing rule tester when opener is removed safely falls back to surviving button', async () => {
    baseHandlers();
    const user = await openRules();
    const testToolbarBtn = screen.getByRole('button', { name: '规则测试' });
    await user.click(testToolbarBtn);

    const dialog = await screen.findByRole('dialog', { name: '规则测试' });
    expect(dialog).toBeInTheDocument();

    // Disconnect toolbar button
    testToolbarBtn.remove();

    const closeBtn = screen.getByRole('button', { name: '关闭' });
    await user.click(closeBtn);

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '规则测试' })).toBeNull();
    });
    // Active element safely fell back to surviving button
    expect(screen.getByRole('button', { name: '校验草稿' })).toHaveFocus();
  });
});
