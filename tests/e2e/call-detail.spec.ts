import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

import { test, expect } from './fixtures.js';
import { openArbiterConfiguration } from './dsh/ui.js';

/**
 * The real log entry opens the shared call detail by `callId`.
 *
 * The row is seeded into the isolated profile's own audit database, so the run
 * exercises the shipped route, decoder and components against real SQLite. The
 * seeded decision deliberately stored no review snapshot and no model attempt,
 * which is what a rule-decided call looks like; the detail must then name those
 * gaps instead of presenting empty layers as if they were evidence.
 */
const CALL_ID = 'e2e-detail-call-1';

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
      process.cwd(),
      'bash',
      JSON.stringify({ command: 'echo e2e-detail' }),
      null,
      process.cwd(),
      'bash:e2e-detail',
      'rev-e2e',
      'cfg-e2e',
      'normal',
      'guarded',
      'deny',
      'Arbiter: a deny rule covered this call.',
      JSON.stringify([
        { stage: 'rule', result: 'deny', at: Date.now() - 60_000 },
      ]),
      'null',
      'written',
      null,
      'normal',
      JSON.stringify([]),
      'not-started',
      2,
      null,
      null,
    );
    db.prepare(
      `INSERT INTO stages(call_id, seq, stage, result, reason, rule_id, rule_name,
         decision_rules, config_revision, config_snapshot_id, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      CALL_ID,
      0,
      'rule',
      'deny',
      'matched the deny rule',
      'no-e2e',
      'E2E deny rule',
      JSON.stringify([]),
      'rev-e2e',
      'cfg-e2e',
      Date.now() - 60_000,
    );
  } finally {
    db.close();
  }
}

test(
  'opens the shared detail from the log entry and reports missing material',
  { tag: '@smoke' },
  async ({ dshPage: page, dsh }) => {
    await openArbiterConfiguration(page);
    const plugin = page.locator('[data-arbiter-root]');

    seedCall(dsh.home);

    await plugin
      .getByRole('button', { name: '日志与详情', exact: true })
      .click();
    await expect(
      plugin.getByRole('heading', { name: '调用记录', exact: true }),
    ).toBeVisible();
    await plugin.getByRole('button', { name: '刷新', exact: true }).click();

    const row = plugin.getByRole('row', { name: /echo e2e-detail/u });
    await expect(row).toBeVisible();

    const [detailResponse] = await Promise.all([
      page.waitForResponse((response) => {
        if (new URL(response.url()).pathname !== '/api/arbiter/log')
          return false;
        return new URL(response.url()).searchParams.get('callId') === CALL_ID;
      }),
      row.getByRole('button', { name: '查看详情', exact: true }).click(),
    ]);
    expect(detailResponse.status()).toBe(200);

    // The shared view is opened by call id and shows the stored verdict first.
    await expect(
      plugin.getByRole('heading', {
        name: `调用详情 · ${CALL_ID}`,
        exact: true,
      }),
    ).toBeVisible();
    const verdict = plugin.getByRole('region', { name: '最终裁决' });
    await expect(verdict).toContainText('拒绝（规则）');
    await expect(verdict).toContainText(
      'Arbiter: a deny rule covered this call.',
    );

    // The historical rule name comes from the stored stage row. The list row
    // also names the rule, so this is scoped to the detail's basis layer.
    const basis = plugin.getByRole('group', { name: '判定依据' });
    await expect(basis).toContainText('E2E deny rule');
    await expect(basis).toContainText('no-e2e');

    // A rule short-circuit never asked the model, so the basis says so instead
    // of listing review material as missing; the named configuration snapshot
    // has no row here, which is a genuine gap and is labelled as one.
    await expect(
      plugin.getByText('这次调用由规则直接决定，没有进入模型审查。', {
        exact: true,
      }),
    ).toBeVisible();
    const missing = plugin.getByRole('group', { name: '材料缺失' });
    await expect(missing).toContainText('没有保存当时的配置快照');
    await expect(missing).not.toContainText('没有保存审查快照');

    // Raw material stays collapsed until requested.
    const raw = plugin.getByRole('button', {
      name: '原始材料（默认折叠）',
      exact: true,
    });
    await expect(raw).toHaveAttribute('aria-expanded', 'false');
    await expect(plugin.getByText('工具输入', { exact: true })).toHaveCount(0);
    await raw.click();
    await expect(
      plugin.getByRole('button', { name: '工具输入', exact: true }),
    ).toBeVisible();
    await expect(
      plugin.getByRole('button', { name: '工具输入 schema', exact: true }),
    ).toBeVisible();
  },
);
