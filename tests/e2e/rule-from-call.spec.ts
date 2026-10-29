import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

import AxeBuilder from '@axe-core/playwright';

import { test, expect } from './fixtures.js';
import type { DshHost } from './dsh/host.js';
import { openArbiterConfiguration } from './dsh/ui.js';

/**
 * Drafting a rule from a real recorded call in the real host.
 *
 * The call is seeded into the isolated profile's own audit database, so the run
 * exercises the shipped `/log` route, the shared detail decoder, the draft dialog
 * and the tester against real SQLite and the real evaluator. The recorded
 * arguments deliberately carry a nested object and a boolean: a string-only
 * import would silently drop exactly those, and the pinned conditions are read
 * back from the saved configuration to prove they did not.
 */
const CALL_ID = 'e2e-rule-from-call-1';

const ARGUMENTS = {
  environments: ['test'],
  dryRun: true,
  target: { path: '/srv/app' },
};

function seedCall(home: string): void {
  const db = new DatabaseSync(join(home, 'arbiter', 'arbiter.db'));
  try {
    db.prepare(
      `INSERT OR REPLACE INTO calls(
         call_id, ts, session_id, session_kind, parent_session, profile, workspace,
         tool, arguments, arguments_schema, cwd, fingerprint, config_revision,
         config_snapshot_id, approval_mode, execution_mode, result, reason, trace,
         effect, session_record_state, signals, policy_strategy, decision_rules,
         execution_status, record_format_version, execution_started_at,
         execution_finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      CALL_ID,
      Date.now() - 60_000,
      'e2e-session',
      'main',
      null,
      'arbiter-e2e',
      '/srv/app',
      'deploy',
      JSON.stringify(ARGUMENTS),
      null,
      '/srv/app',
      'deploy:e2e',
      'rev-e2e',
      'cfg-e2e',
      'normal',
      'guarded',
      'review-allow',
      'Arbiter: the review allowed this call.',
      JSON.stringify([
        { stage: 'review', result: 'review-allow', at: Date.now() - 60_000 },
      ]),
      'null',
      'written',
      null,
      'normal',
      JSON.stringify([]),
      'succeeded',
      2,
      null,
      null,
    );
  } finally {
    db.close();
  }
}

/** The saved rules, read from the real state route after save-and-apply. */
async function readRules(dsh: DshHost): Promise<readonly unknown[]> {
  const response = await fetch(`${dsh.origin}/api/arbiter/state`, {
    headers: { cookie: `${dsh.cookie.name}=${dsh.cookie.value}` },
  });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (body === null || typeof body !== 'object') return [];
  const config: unknown = Reflect.get(body, 'config');
  if (config === null || typeof config !== 'object') return [];
  const rules: unknown = Reflect.get(config, 'rules');
  if (!Array.isArray(rules)) return [];
  const entries: readonly unknown[] = rules;
  return entries;
}

test(
  'turns a recorded call into a testable rule draft and saves it',
  { tag: '@smoke' },
  async ({ dshPage: page, dsh }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    seedCall(dsh.home);
    await openArbiterConfiguration(page);
    const plugin = page.locator('[data-arbiter-root]');

    // Open the real call detail from the log list.
    await plugin
      .getByRole('button', { name: '日志与详情', exact: true })
      .click();
    await plugin.getByRole('button', { name: '刷新', exact: true }).click();
    const row = plugin.getByRole('button', { name: /deploy/u });
    await expect(row).toBeVisible();
    await row.click();
    await expect(
      plugin.getByRole('heading', { name: `调用详情 · ${CALL_ID}` }),
    ).toBeVisible();

    // The recorded input is what the draft is built from.
    await plugin
      .getByRole('button', { name: '从这次调用创建规则', exact: true })
      .click();
    const draftDialog = page.getByRole('dialog', {
      name: '从这次调用创建规则草稿',
    });
    await expect(draftDialog).toBeVisible();
    await expect(draftDialog).toContainText(`来源调用：${CALL_ID}`);
    await expect(draftDialog).toContainText('"dryRun": true');
    // Every pinnable value starts checked; the array cannot be pinned by an
    // exact match, so it is named as left open instead of being dropped.
    // Three pinnable values: the tool name, `dryRun` and the nested
    // `target.path`; the array is the only part exact matching cannot express.
    await expect(draftDialog.getByRole('checkbox')).toHaveCount(3);
    await expect(draftDialog).toContainText('$.environments 是数组');

    // The new dialog is audited like the other surfaces: its checkboxes, field
    // groups and notes are ordinary authored UI, not evidence text.
    const audit = await new AxeBuilder({ page })
      .include('[data-arbiter-surface="rule-from-call-dialog"]')
      .analyze();
    expect(audit.violations).toEqual([]);

    // Narrow the rule: pin the tool and the boolean only.
    await draftDialog
      .getByRole('checkbox', { name: /^\$\.target\.path =/u })
      .uncheck();
    await expect(draftDialog).toContainText('未勾选：$.target.path');

    // Create and test in one step: the tester opens on the new rule with the
    // recorded call as its sample.
    await draftDialog
      .getByRole('button', { name: '生成草稿并测试', exact: true })
      .click();
    const tester = page.getByRole('dialog', { name: '规则测试' });
    await expect(tester).toBeVisible();
    await expect(tester).toContainText(
      `本次测试使用调用记录 ${CALL_ID} 的原始输入。`,
    );
    await expect(tester.getByLabel('工具', { exact: true })).toHaveValue(
      'deploy',
    );
    await expect(tester.getByLabel('工具参数', { exact: true })).toHaveValue(
      JSON.stringify(ARGUMENTS, null, 2),
    );

    // The real evaluator decides the draft, which is what "testable" means.
    await tester.getByRole('button', { name: '运行测试', exact: true }).click();
    await expect(
      tester.locator('[data-arbiter-test-rule-state="match"]'),
    ).toBeVisible();
    await tester.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(tester).toBeHidden();

    // Saving is the only step that makes the rule real.
    expect(await readRules(dsh)).toEqual([]);
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

    const saved = await readRules(dsh);
    expect(saved).toHaveLength(1);
    const rule = saved[0];
    if (rule === null || typeof rule !== 'object')
      throw new TypeError('a saved rule must be an object');
    expect(Reflect.get(rule, 'id')).toMatch(/^rule-\d+$/u);
    expect(Reflect.get(rule, 'verdict')).toBe('force-review');
    expect(Reflect.get(rule, 'enabled')).toBe(true);
    // The deselected field is genuinely absent, and the two selected ones are
    // pinned as exact conditions with their recorded JSON types.
    // The saved document carries the canonical `multi` default for a selected
    // value; the pinned value itself keeps its recorded JSON type.
    expect(Reflect.get(rule, 'conditions')).toEqual([
      { target: 'tool', kind: 'exact', pattern: 'deploy' },
      {
        target: 'argument',
        path: '$.dryRun',
        multi: 'any',
        kind: 'exact',
        pattern: true,
      },
    ]);
    // The source call is kept as an ordinary editable comment, not as a rule.
    expect(Reflect.get(rule, 'comment')).toBe(CALL_ID);
    expect(pageErrors).toEqual([]);
  },
);
