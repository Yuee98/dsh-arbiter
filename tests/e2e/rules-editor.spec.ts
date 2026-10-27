import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures.js';
import type { DshHost } from './dsh/host.js';
import { dismissGettingStarted, openArbiterConfiguration } from './dsh/ui.js';

/**
 * The real rules editor.
 *
 * The scenario follows the confirmed journey: create a rule, edit it inline,
 * save and apply, then reload and read it back from the real state route. The
 * tester is not used, because saving must not depend on it.
 */

interface RuleState {
  readonly id: string;
  readonly name?: string;
  readonly verdict: string;
  readonly enabled?: boolean;
  readonly conditions: readonly unknown[];
  readonly scope?: unknown;
  readonly combine?: string;
}

interface ArbiterState {
  readonly configFormat: string;
  readonly invalidConfigError: string | null;
  readonly rules: readonly RuleState[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readState(value: unknown): ArbiterState {
  if (!isRecord(value)) throw new TypeError('state must be an object');
  const config = value['config'];
  if (!isRecord(config)) throw new TypeError('config must be an object');
  const rules = config['rules'];
  if (!Array.isArray(rules)) throw new TypeError('rules must be an array');
  const invalid = value['invalidConfigError'];
  return {
    configFormat:
      typeof value['configFormat'] === 'string' ? value['configFormat'] : '',
    invalidConfigError: invalid === null ? null : JSON.stringify(invalid),
    rules: rules.map((entry) => {
      if (!isRecord(entry)) throw new TypeError('rule must be an object');
      const conditions = entry['conditions'];
      if (!Array.isArray(conditions))
        throw new TypeError('conditions must be an array');
      const name = entry['name'];
      const enabled = entry['enabled'];
      const combine = entry['combine'];
      return {
        id: String(entry['id']),
        verdict: String(entry['verdict']),
        conditions,
        ...('scope' in entry ? { scope: entry['scope'] } : {}),
        ...(typeof name === 'string' ? { name } : {}),
        ...(typeof enabled === 'boolean' ? { enabled } : {}),
        // The projection kept only the fields the assertions needed; the
        // connective is now one of them.
        ...(typeof combine === 'string' ? { combine } : {}),
      };
    }),
  };
}

async function readArbiter(dsh: DshHost): Promise<ArbiterState> {
  const response = await fetch(`${dsh.origin}/api/arbiter/state`, {
    headers: { cookie: `${dsh.cookie.name}=${dsh.cookie.value}` },
  });
  expect(response.status).toBe(200);
  return readState(await response.json());
}

test.describe('rule editing in the real host', () => {
  test.use({ firstInstall: true });

  test(
    'creates, edits, saves and reads back an inline rule',
    { tag: '@smoke' },
    async ({ dshPage: page, dsh }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await openArbiterConfiguration(page);
      const plugin = page.locator('[data-arbiter-root]');
      await plugin.getByRole('button', { name: '规则', exact: true }).click();
      await expect(
        plugin.getByRole('heading', { name: '规则', exact: true }),
      ).toBeVisible();
      await expect(plugin.getByText(/^还没有规则/)).toBeVisible();

      await plugin
        .getByRole('button', { name: '新建规则', exact: true })
        .click();
      const row = plugin.locator('[data-rule-row]');
      await expect(row).toHaveCount(1);
      const id = await row.getAttribute('data-rule-row');
      expect(id).toBeTruthy();
      // A new rule is enabled and routes matching calls into review.
      await expect(row).toHaveAttribute('data-rule-verdict', 'force-review');
      await expect(
        row.getByRole('checkbox', { name: /^启用规则/ }),
      ).toBeChecked();
      await expect(row.getByRole('combobox', { name: /^行为/ })).toHaveValue(
        'force-review',
      );
      // The inline body is open for the new rule.
      await expect(
        row.getByRole('combobox', { name: '匹配方式', exact: true }),
      ).toHaveValue('regex');
      await expect(
        row.getByRole('textbox', { name: '表达式', exact: true }),
      ).toBeVisible();

      // Edit with the keyboard only: the name, the scope and the expression.
      await row
        .getByRole('textbox', { name: '显示名称', exact: true })
        .pressSequentially('只读查询');
      await row
        .getByRole('textbox', { name: '工具', exact: true })
        .pressSequentially('bash, deploy');
      await row
        .getByRole('textbox', { name: '表达式', exact: true })
        .pressSequentially('gh pr view(?: .*)?');
      await row
        .getByRole('textbox', { name: '备注', exact: true })
        .pressSequentially('只读命令');
      // The custom name replaces the automatic summary in the header.
      await expect(
        row.getByRole('textbox', { name: '显示名称', exact: true }),
      ).toHaveValue('只读查询');

      // A second condition is an alternative (OR), not a nested group.
      await row.getByRole('button', { name: '添加条件', exact: true }).click();
      await expect(row.getByRole('group', { name: /^条件 \d+$/ })).toHaveCount(
        2,
      );
      const second = row.getByRole('group', { name: /^条件 \d+$/ }).nth(1);
      await second
        .getByRole('combobox', { name: '匹配对象', exact: true })
        .selectOption('tool');
      await second
        .getByRole('combobox', { name: '匹配方式', exact: true })
        .selectOption('exact');
      await second
        .getByRole('textbox', { name: '表达式', exact: true })
        .pressSequentially('deploy');

      // Collapsing keeps the draft; the expanded layout comes back intact.
      await row
        .getByRole('button', { name: /^收起规则/, exact: false })
        .click();
      await expect(
        row.getByRole('textbox', { name: '表达式', exact: true }),
      ).toHaveCount(0);
      await row
        .getByRole('button', { name: /^编辑规则/, exact: false })
        .click();
      await expect(
        row.getByRole('textbox', { name: '表达式', exact: true }).first(),
      ).toHaveValue('gh pr view(?: .*)?');
      await expect(
        row.getByRole('textbox', { name: '备注', exact: true }),
      ).toHaveValue('只读命令');

      const before = await readArbiter(dsh);
      expect(before.rules).toEqual([]);

      // Save and apply through the shared save bar; the tester is untouched.
      const [save] = await Promise.all([
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/arbiter/config/save',
        ),
        plugin.getByRole('button', { name: '保存并应用', exact: true }).click(),
      ]);
      expect(save.status()).toBe(200);
      await expect(
        plugin.locator('[data-arbiter-save-status="saved"]'),
      ).toHaveText('已保存并生效。');

      const applied = await readArbiter(dsh);
      expect(applied.invalidConfigError).toBeNull();
      expect(applied.configFormat).toBe('arbiter-config-v3');
      expect(applied.rules).toHaveLength(1);
      const [saved] = applied.rules;
      expect(saved).toMatchObject({
        id,
        name: '只读查询',
        verdict: 'force-review',
        enabled: true,
        // The editor now records how the two conditions combine. "全部满足" is
        // the default for a rule the user builds here.
        combine: 'all',
        scope: { tools: ['bash', 'deploy'] },
      });
      expect(saved?.conditions).toHaveLength(2);
      expect(saved?.conditions[0]).toMatchObject({
        target: 'command',
        kind: 'regex',
        pattern: 'gh pr view(?: .*)?',
      });
      expect(saved?.conditions[1]).toMatchObject({
        target: 'tool',
        kind: 'exact',
        pattern: 'deploy',
      });

      // A refresh reads the applied rule back and keeps the editor usable.
      await page.reload();
      await dismissGettingStarted(page);
      await openArbiterConfiguration(page);
      const reloaded = page.locator('[data-arbiter-root]');
      await reloaded.getByRole('button', { name: '规则', exact: true }).click();
      const reloadedRow = reloaded.locator('[data-rule-row]');
      await expect(reloadedRow).toHaveCount(1);
      await expect(
        reloadedRow.getByRole('textbox', { name: '显示名称', exact: true }),
      ).toHaveValue('只读查询');
      await expect(
        reloadedRow.getByRole('combobox', { name: /^行为/ }),
      ).toHaveValue('force-review');
      await reloadedRow
        .getByRole('button', { name: /^编辑规则/, exact: false })
        .click();
      await expect(
        reloadedRow
          .getByRole('textbox', { name: '表达式', exact: true })
          .first(),
      ).toHaveValue('gh pr view(?: .*)?');
      expect((await readArbiter(dsh)).rules[0]?.id).toBe(id);
      expect(pageErrors).toEqual([]);
    },
  );

  test('a draft without conditions is editable but cannot be applied', async ({
    dshPage: page,
    dsh,
  }) => {
    await openArbiterConfiguration(page);
    const plugin = page.locator('[data-arbiter-root]');
    await plugin.getByRole('button', { name: '规则', exact: true }).click();
    await plugin.getByRole('button', { name: '新建规则', exact: true }).click();
    const row = plugin.locator('[data-rule-row]');
    await row.getByRole('button', { name: '删除条件', exact: true }).click();
    await expect(plugin.getByText(/没有匹配条件/)).toBeVisible();
    await expect(
      row.getByRole('button', { name: '添加条件', exact: true }),
    ).toBeEnabled();

    const before = await readArbiter(dsh);
    const [save] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/arbiter/config/save',
      ),
      plugin.getByRole('button', { name: '保存并应用', exact: true }).click(),
    ]);
    expect(save.status()).toBe(422);
    await expect(plugin.getByText(/配置校验失败，未保存/)).toContainText(
      '每条规则至少需要一个匹配条件',
    );
    await expect(
      plugin.locator('[data-arbiter-save-status="failed"]'),
    ).toBeVisible();
    // Neither the file nor the effective configuration changed.
    const after = await readArbiter(dsh);
    expect(after.rules).toEqual(before.rules);
    expect(after.configFormat).toBe(before.configFormat);
  });

  test('the expanded editor has no automatically detected accessibility violations', async ({
    dshPage: page,
  }, testInfo) => {
    await openArbiterConfiguration(page);
    const plugin = page.locator('[data-arbiter-root]');
    await plugin.getByRole('button', { name: '规则', exact: true }).click();
    await plugin.getByRole('button', { name: '新建规则', exact: true }).click();
    const row = plugin.locator('[data-rule-row]');
    await expect(row.getByRole('region', { name: '匹配条件' })).toBeVisible();
    // Expand both optional areas, so the audited state is the real editor.
    await row.getByText('高级选项', { exact: true }).click();
    await row.getByText('更多', { exact: true }).click();

    const results = await new AxeBuilder({ page })
      .include('[data-arbiter-root]')
      .analyze();
    for (const incomplete of results.incomplete) {
      testInfo.annotations.push({
        type: 'axe-incomplete',
        description: `${incomplete.id}: ${String(incomplete.nodes.length)} nodes require manual review`,
      });
    }
    await testInfo.attach('arbiter-rule-editor-axe.json', {
      body: JSON.stringify(results, null, 2),
      contentType: 'application/json',
    });
    await testInfo.attach('arbiter-rule-editor.png', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
    expect(results.violations).toEqual([]);
  });
});
