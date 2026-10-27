import { expect, test } from './fixtures.js';
import { openArbiterConfiguration } from './dsh/ui.js';

/**
 * The rule tester through the real plugin page.
 *
 * This is the wiring the issue is about: the rule list's test entry focuses the
 * tester, the tester submits the whole current draft to `/api/arbiter/test`, and
 * the page renders two separate conclusions — whether the focused rule matched,
 * and which path the whole draft selected. The decision itself comes from the
 * shared evaluator, so nothing here re-implements matching in the browser.
 */

/**
 * The focused rule allows a call whose every selected environment is `test`.
 *
 * A second rule asks for human approval on any `deploy`, and force-ask outranks
 * allow, so this pair is exactly the "this rule matched, but the whole draft
 * chose another path" case the two conclusions have to keep apart.
 */
const ALLOW_TEST = {
  id: 'allow-test-env',
  name: '测试环境免审',
  scope: { tools: ['deploy'] },
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

const ASK_DEPLOY = {
  id: 'ask-deploy',
  name: '部署需要人工审批',
  scope: { tools: ['deploy'] },
  conditions: [{ target: 'tool', kind: 'exact', pattern: 'deploy' }],
  verdict: 'force-ask',
};

/**
 * A second rule with two argument conditions.
 *
 * It exists so a rejected selector can name a condition that is neither the
 * first rule nor the first condition; the saved document stays valid because the
 * invalid value is only typed into the draft.
 */
const TWO_CONDITIONS = {
  id: 'two-conditions',
  name: '双条件',
  scope: { tools: ['deploy'] },
  conditions: [
    {
      target: 'argument',
      path: '$.environments[*]',
      multi: 'all',
      kind: 'exact',
      pattern: 'test',
    },
    {
      target: 'argument',
      path: '$.target.path',
      multi: 'any',
      kind: 'glob',
      pattern: '/srv/**',
    },
  ],
  verdict: 'force-review',
};

const CONFIG = {
  format: 'arbiter-config-v2',
  rules: [ALLOW_TEST, ASK_DEPLOY, TWO_CONDITIONS],
};

/** The position the tester reports for the rule with the invalid selector. */
const TWO_CONDITIONS_INDEX = 2;

test.describe('rule tester panel', () => {
  test.use({ arbiterConfig: CONFIG });

  test(
    'the editor entry focuses the tester and both conclusions are shown',
    { tag: '@smoke' },
    async ({ dshPage: page }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await openArbiterConfiguration(page);
      const plugin = page.locator('[data-arbiter-root]');

      await plugin.getByRole('button', { name: '规则', exact: true }).click();
      await expect(
        plugin.getByRole('heading', { name: '规则', exact: true }),
      ).toBeVisible();

      // The row's test action selects that rule and opens its tester; it does
      // not answer by itself, because the operator still chooses the sample.
      // The rule name is inside an editable text field, so the row is found by
      // its own accessible checkbox label rather than by visible text.
      const ruleRow = plugin
        .getByRole('list', { name: '规则' })
        .getByRole('listitem')
        .filter({
          has: page.getByRole('checkbox', { name: '启用规则「测试环境免审」' }),
        });
      await expect(plugin.getByTestId('rule-test-answer')).toHaveCount(0);
      await ruleRow.getByRole('button', { name: /^测试/ }).click();
      const tester = page.getByRole('dialog', { name: '规则测试' });
      await expect(tester).toBeVisible();
      // The row action opened the block and moved focus into it; assert both,
      // because an always-visible section would satisfy a visibility check
      // while leaving keyboard users where they were.
      const body = tester.getByTestId('rule-test-body');
      await expect(body).toBeVisible();
      await expect(body).toBeFocused();
      // The rule's own scope seeds the tool, and its argument condition starts
      // the sample in JSON mode.
      await expect(tester.getByLabel('工具', { exact: true })).toHaveValue(
        'deploy',
      );
      await expect(tester.getByLabel('输入方式', { exact: true })).toHaveValue(
        'arguments',
      );

      const args = tester.getByRole('textbox', { name: '工具参数' });
      await args.fill('{"environments":["test"]}');

      const [request, response] = await Promise.all([
        page.waitForRequest(
          (sent) =>
            new URL(sent.url()).pathname === '/api/arbiter/test' &&
            sent.method() === 'POST',
        ),
        page.waitForResponse(
          (received) =>
            new URL(received.url()).pathname === '/api/arbiter/test',
        ),
        tester.getByRole('button', { name: '运行测试', exact: true }).click(),
      ]);
      expect(response.status()).toBe(200);
      // The browser submits the whole draft, including the rule that outranks
      // the focused one, so the final path is decided over all of it.
      const sent: unknown = request.postDataJSON();
      expect(sent).toMatchObject({
        samples: [{ tool: 'deploy', args: { environments: ['test'] } }],
        rules: expect.arrayContaining([
          expect.objectContaining({ id: 'allow-test-env' }),
          expect.objectContaining({ id: 'ask-deploy' }),
        ]),
        identity: 'main',
      });

      // Two conclusions, deliberately separate: this rule matched, while the
      // whole draft selects the higher-priority force-ask.
      const ruleSection = plugin.getByTestId('rule-test-rule');
      await expect(ruleSection).toHaveAttribute(
        'data-arbiter-test-rule-state',
        'match',
      );
      await expect(ruleSection).toContainText('匹配');
      const pathSection = plugin.getByTestId('rule-test-path');
      await expect(pathSection).toHaveAttribute(
        'data-arbiter-test-path',
        'force-ask',
      );
      await expect(pathSection).toContainText('ask-deploy');

      // The expandable explanation names the JSONPath, the any/all choice and
      // the values the selector actually returned.
      await tester.getByText('查看详细解释').click();
      await expect(
        tester.getByText(/JSONPath：\$\.environments\[\*\]/),
      ).toBeVisible();
      await expect(tester.getByText(/多值匹配：全部/)).toBeVisible();
      await expect(tester.getByText('取得值（1）')).toBeVisible();
      // The focused rule is named once by the target line, and once more by its
      // own condition block in the explanation.
      await expect(tester.getByTestId('rule-test-target')).toContainText(
        '测试环境免审',
      );
      // The shadowed rule is named specifically, in its own list entry: a broad
      // match over the panel would also hit the winning rule's text.
      await expect(
        tester.getByText(/allow-test-env（免审放行）未生效/),
      ).toBeVisible();
      await expect(
        tester.getByText(/ask-deploy（必须人工）未生效/),
      ).toHaveCount(0);

      // The effective evaluation directory is shown with the result, so the
      // answer can be reproduced instead of implicitly depending on a hidden cwd.
      await expect(plugin.getByTestId('rule-test-cwd')).toContainText(
        '本次求值目录',
      );

      // Editing the sample marks the answer as stale without discarding it.
      await args.fill('{"environments":["test","production"]}');
      await expect(tester.getByText(/需要重新测试/)).toBeVisible();
      await expect(ruleSection).toBeVisible();

      expect(pageErrors).toEqual([]);
    },
  );

  test(
    'a rejected selector locates the condition that owns it',
    { tag: '@smoke' },
    async ({ dshPage: page }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await openArbiterConfiguration(page);
      const plugin = page.locator('[data-arbiter-root]');
      await plugin.getByRole('button', { name: '规则', exact: true }).click();
      await expect(
        plugin.getByRole('heading', { name: '规则', exact: true }),
      ).toBeVisible();

      // The saved document is valid, so the invalid selector is typed into the
      // draft — which is exactly the case the tester has to locate.
      const brokenRow = plugin
        .getByRole('list', { name: '规则' })
        .getByRole('listitem')
        .filter({
          has: page.getByRole('checkbox', { name: '启用规则「双条件」' }),
        });
      await brokenRow.getByRole('button', { name: /^编辑/ }).click();
      const pathFields = brokenRow.getByRole('textbox', { name: 'JSONPath' });
      await expect(pathFields).toHaveCount(2);
      await pathFields.nth(1).fill('$.');

      // Test the other rule: the rejection belongs to the second condition of
      // the second rule, so locating it has to expand and focus across rules.
      const otherRow = plugin
        .getByRole('list', { name: '规则' })
        .getByRole('listitem')
        .filter({
          has: page.getByRole('checkbox', { name: '启用规则「测试环境免审」' }),
        });
      await otherRow.getByRole('button', { name: /^测试/ }).click();
      const tester = page.getByRole('dialog', { name: '规则测试' });
      await tester
        .getByRole('button', { name: '运行测试', exact: true })
        .click();

      const locate = tester.getByRole('button', {
        // `TEST_RULE_INDEX` and `TWO_CONDITIONS_INDEX` pin the position the
        // backend reports; hardcoding the wrong one would pass on a wrong rule.
        name: new RegExp(
          `^定位到 rules\\[${String(TWO_CONDITIONS_INDEX)}\\]\\.conditions\\[1\\]\\.path$`,
        ),
      });
      await expect(locate).toBeVisible();
      await locate.click();

      // The owning rule is expanded and the exact condition's JSONPath field has
      // focus. `nth(1)` is the second condition: the first would mean the index
      // was lost, and the other rule's field would mean the rule was.
      await expect(pathFields).toHaveCount(2);
      await expect(pathFields.nth(1)).toBeFocused();
      // The focused rule stays collapsed: locating expands the owning rule only,
      // it does not open every row.
      await expect(
        otherRow.getByRole('textbox', { name: 'JSONPath' }),
      ).toHaveCount(0);
      expect(pageErrors).toEqual([]);
    },
  );
});
