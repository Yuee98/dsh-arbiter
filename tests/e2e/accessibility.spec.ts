import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import AxeBuilder from '@axe-core/playwright';

import { test, expect } from './fixtures.js';
import { openArbiterConfiguration } from './dsh/ui.js';

const CALL_ID = 'e2e-axe-call-1';

function seedCall(home: string): void {
  const db = new DatabaseSync(join(home, 'arbiter', 'arbiter.db'));
  try {
    db.prepare(
      `INSERT OR REPLACE INTO calls(
         call_id, ts, session_id, session_kind, parent_session, profile, workspace,
         tool, arguments, arguments_schema, cwd, fingerprint, config_revision,
         config_snapshot_id, approval_mode, execution_mode, result, reason, trace,
         effect, session_record_state, scores, review_stage, usage, decision_rules,
         execution_status, record_format_version, execution_started_at,
         execution_finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      CALL_ID,
      Date.now() - 60_000,
      'e2e-session',
      'main',
      null,
      'arbiter-e2e',
      process.cwd(),
      'bash',
      JSON.stringify({ command: 'echo e2e-axe' }),
      null,
      process.cwd(),
      'bash:e2e-axe',
      'rev-e2e',
      'cfg-e2e',
      'ask',
      'guarded',
      'deny',
      'Arbiter: a deny rule covered this call.',
      JSON.stringify([
        { stage: 'rule', result: 'deny', at: Date.now() - 60_000 },
      ]),
      'null',
      'written',
      null,
      null,
      null,
      JSON.stringify([]),
      'not-started',
      2,
      null,
      null,
    );
  } finally {
    db.close();
  }
}

test(
  'the real plugin configuration has no automatically detected accessibility violations',
  { tag: '@smoke' },
  async ({ dshPage: page, dsh }, testInfo) => {
    seedCall(dsh.home);
    await openArbiterConfiguration(page);
    const plugin = page.locator('[data-arbiter-root]');
    await expect(plugin).toBeVisible();
    await expect(
      plugin.getByRole('checkbox', { name: '启用 dsh-arbiter', exact: true }),
    ).toBeVisible();

    // 1. Initial configuration surface audit
    const baseResults = await new AxeBuilder({ page })
      .include('[data-arbiter-root]')
      .analyze();
    expect(baseResults.violations).toEqual([]);

    // 2. Switch to Rules tab and open Rule Tester Dialog for audit
    await plugin.getByRole('button', { name: '规则', exact: true }).click();
    await expect(
      plugin.getByRole('heading', { name: '规则', exact: true }),
    ).toBeVisible();

    await plugin.getByRole('button', { name: '规则测试', exact: true }).click();
    const testerDialog = page.getByRole('dialog', { name: '规则测试' });
    await expect(testerDialog).toBeVisible();

    const dialogResults = await new AxeBuilder({ page })
      .include('[data-arbiter-surface="rule-test-dialog"]')
      .analyze();
    expect(dialogResults.violations).toEqual([]);

    // 3. Open Import Popover and audit
    await testerDialog
      .getByRole('button', { name: '从调用记录带入', exact: true })
      .click();
    const popoverContent = page.locator('[data-rule-test-import-content]');
    await expect(popoverContent).toBeVisible();

    const popoverResults = await new AxeBuilder({ page })
      .include('[data-rule-test-import-content]')
      .analyze();
    expect(popoverResults.violations).toEqual([]);

    // Close Rule Tester Dialog
    await testerDialog
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await expect(testerDialog).toBeHidden();

    // 4. Armed delete confirmation audit
    await plugin.getByRole('button', { name: '新建规则', exact: true }).click();
    const firstRow = plugin.locator('[data-rule-row]').first();
    await expect(firstRow).toBeVisible();
    await firstRow.getByRole('button', { name: /^删除规则/ }).click();
    const confirmButton = firstRow.locator('[data-confirming="true"]');
    await expect(confirmButton).toBeVisible();

    const armedResults = await new AxeBuilder({ page })
      .include('[data-arbiter-root]')
      .analyze();
    expect(armedResults.violations).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(confirmButton).toBeHidden();

    // 5. Open Call Detail Dialog from Logs and audit
    await plugin
      .getByRole('button', { name: '日志与详情', exact: true })
      .click();
    await expect(
      plugin.getByRole('heading', { name: '调用记录', exact: true }),
    ).toBeVisible();
    await plugin.getByRole('button', { name: '刷新', exact: true }).click();
    const logRow = plugin.getByRole('button', { name: /echo e2e-axe/u });
    await expect(logRow).toBeVisible();
    await logRow.click();

    const callDetailDialog = page.locator('[data-call-detail-panel]');
    await expect(callDetailDialog).toBeVisible();

    const detailResults = await new AxeBuilder({ page })
      .include('[data-call-detail-panel]')
      .analyze();
    expect(detailResults.violations).toEqual([]);

    // Close Call Detail Dialog
    await callDetailDialog
      .getByRole('button', { name: '关闭详情', exact: true })
      .click();
    await expect(callDetailDialog).toBeHidden();

    // Attach screenshots and results to testInfo
    await testInfo.attach('arbiter-configuration-axe.json', {
      body: JSON.stringify(baseResults, null, 2),
      contentType: 'application/json',
    });
    await testInfo.attach('arbiter-configuration.png', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  },
);
