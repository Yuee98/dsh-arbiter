import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Locator, Page } from '@playwright/test';

import { test, expect } from './fixtures.js';
import { openArbiterConfiguration } from './dsh/ui.js';

/**
 * The call log in the real host: paging, filtering, cleanup and reading position.
 *
 * The rows are seeded through the audit schema itself because the sample needs
 * fixed timestamps and a fixed size (60 records, three pages of 25). Everything
 * else — the list route, the decoders, the panel — is the shipped plugin, and
 * the assertions are on what an operator sees.
 *
 * No model request is made; this case never runs a tool.
 */

const TOTAL = 60;

interface SeedRow {
  readonly callId: string;
  readonly ts: number;
  readonly tool: string;
  readonly command: string;
  readonly result: string;
  readonly ruleId: string | null;
  readonly sessionKind: string;
}

/** The fixed sample: every third call is a subagent call, every other one denied. */
function sample(): readonly SeedRow[] {
  const base = Date.now() - 1_000;
  return Array.from({ length: TOTAL }, (_, index) => ({
    callId: `e2e-call-${String(index).padStart(3, '0')}`,
    ts: base - index * 1_000,
    tool: index % 3 === 0 ? 'write' : 'bash',
    command:
      index === 3
        ? 'gh pr view 42 --json title'
        : index === 7
          ? 'git push --force origin main'
          : `echo page-sample-${String(index)}`,
    result: index % 2 === 0 ? 'review-allow' : 'review-deny',
    ruleId: index % 2 === 0 ? null : 'deny-review',
    sessionKind: index % 5 === 0 ? 'subagent' : 'main',
  }));
}

function openAudit(home: string): DatabaseSync {
  const path = join(home, 'arbiter', 'arbiter.db');
  mkdirSync(dirname(path), { recursive: true });
  return new DatabaseSync(path);
}

/** Insert one row with every column the current schema requires. */
function insertRow(db: DatabaseSync, row: SeedRow): void {
  db.prepare(
    `INSERT INTO calls(call_id, ts, session_id, session_kind, parent_session, profile, workspace,
        tool, arguments, arguments_schema, cwd, fingerprint, config_revision, config_snapshot_id,
        approval_mode, execution_mode, result, reason, trace, effect, session_record_state,
        signals, policy_strategy, decision_rules, execution_status, record_format_version,
        execution_started_at, execution_finished_at)
     VALUES (?, ?, 'session-1', ?, NULL, 'e2e', '/workspace/app', ?, ?, NULL, '/workspace/app',
        'fp', 'rev-1', 'cfg-1', 'normal', 'trusted', ?, ?, ?, 'null', 'written', NULL, NULL,
        ?, 'pending', 2, NULL, NULL)`,
  ).run(
    row.callId,
    row.ts,
    row.sessionKind,
    row.tool,
    JSON.stringify({ command: row.command }),
    row.result,
    `decision for ${row.callId}`,
    JSON.stringify([
      {
        stage: 'review',
        result: row.result,
        decisionRules: row.ruleId === null ? [] : [row.ruleId],
        at: row.ts,
      },
    ]),
    row.ruleId === null ? '[]' : JSON.stringify([row.ruleId]),
  );
}

function seed(home: string): void {
  const db = openAudit(home);
  try {
    for (const row of sample()) insertRow(db, row);
  } finally {
    db.close();
  }
}

/** Open the plugin and switch to the log tab. */
async function openLogs(page: Page): Promise<Locator> {
  await openArbiterConfiguration(page);
  const plugin = page.locator('[data-arbiter-root]');
  await plugin.getByRole('button', { name: '日志与详情', exact: true }).click();
  await expect(
    plugin.getByRole('heading', { name: '调用记录', exact: true }),
  ).toBeVisible();
  return plugin;
}

test(
  'pages, filters, survives cleanup and keeps a historical reading position',
  { tag: '@smoke' },
  async ({ dshPage: page, dsh }) => {
    seed(dsh.home);
    const plugin = await openLogs(page);

    // Page one is one page of a three-page result, and the total is the whole
    // seeded set rather than the rows one page carried.
    await expect(plugin.getByText('共 60 条', { exact: true })).toBeVisible();
    await expect(
      plugin.getByText('第 1 / 3 页', { exact: true }),
    ).toBeVisible();
    await expect(plugin.getByText('第 1–25 条', { exact: true })).toBeVisible();
    await expect(
      plugin.getByText('echo page-sample-0', { exact: false }),
    ).toBeVisible();

    // Walking forward keeps the reader inside the same traversal.
    await plugin.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(
      plugin.getByText('第 2 / 3 页', { exact: true }),
    ).toBeVisible();
    await expect(
      plugin.getByText('echo page-sample-25', { exact: false }),
    ).toBeVisible();

    // A call arrives while page two is on screen. Nothing polls, so the page
    // must not move; an explicit refresh reports the arrival and offers the jump.
    const db = openAudit(dsh.home);
    try {
      insertRow(db, {
        callId: 'e2e-arrived',
        ts: Date.now(),
        tool: 'bash',
        command: 'echo arrived-after-page-two',
        result: 'review-allow',
        ruleId: null,
        sessionKind: 'main',
      });
    } finally {
      db.close();
    }
    await expect(
      plugin.getByText('第 2 / 3 页', { exact: true }),
    ).toBeVisible();
    await expect(
      plugin.getByText('echo page-sample-25', { exact: false }),
    ).toBeVisible();
    await plugin.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(plugin.getByText(/有 1 条新记录/)).toBeVisible();
    await expect(
      plugin.getByText('第 2 / 3 页', { exact: true }),
    ).toBeVisible();
    await plugin
      .getByRole('button', { name: '回到最新一页', exact: true })
      .click();
    await expect(
      plugin.getByText('第 1 / 3 页', { exact: true }),
    ).toBeVisible();
    await expect(
      plugin.getByText('echo arrived-after-page-two', { exact: false }),
    ).toBeVisible();

    // Filtering restarts the window at page one and narrows the total.
    await plugin
      .getByLabel('结果', { exact: true })
      .selectOption('review-deny');
    await plugin.getByRole('button', { name: '应用筛选', exact: true }).click();
    await expect(plugin.getByText('共 30 条', { exact: true })).toBeVisible();
    await expect(
      plugin.getByText('第 1 / 2 页', { exact: true }),
    ).toBeVisible();
    await plugin
      .getByRole('textbox', { name: '工具', exact: true })
      .fill('write');
    await plugin.getByRole('button', { name: '应用筛选', exact: true }).click();
    // Denied calls are the odd indices, write calls every third index, so their
    // intersection is the ten odd multiples of three.
    await expect(plugin.getByText('共 10 条', { exact: true })).toBeVisible();
    await expect(
      plugin.getByText('第 1 / 1 页', { exact: true }),
    ).toBeVisible();
    await plugin.getByRole('button', { name: '清除筛选', exact: true }).click();
    await expect(plugin.getByText('共 61 条', { exact: true })).toBeVisible();

    // Cleanup removes the tail while the reader is on it; the panel lands on the
    // last page that still exists instead of showing an empty table.
    await plugin.getByRole('button', { name: '下一页', exact: true }).click();
    await plugin.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(
      plugin.getByText('第 3 / 3 页', { exact: true }),
    ).toBeVisible();
    const clearing = openAudit(dsh.home);
    try {
      clearing
        .prepare(
          "DELETE FROM calls WHERE call_id LIKE 'e2e-call-%' AND call_id >= 'e2e-call-040'",
        )
        .run();
    } finally {
      clearing.close();
    }
    await plugin.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(plugin.getByText('共 41 条', { exact: true })).toBeVisible();
    await expect(
      plugin.getByText('第 2 / 2 页', { exact: true }),
    ).toBeVisible();
    // The corrected page has real rows: the total is never shown above an empty
    // table, which is the failure the corrective read exists to prevent.
    await expect(
      plugin
        .getByRole('list', { name: '调用记录', exact: true })
        .getByRole('button'),
    ).toHaveCount(16);
    await expect(plugin.getByRole('status')).toHaveCount(0);
  },
);

test(
  'opens a call detail on demand and loads nothing else',
  { tag: '@smoke' },
  async ({ dshPage: page, dsh }) => {
    seed(dsh.home);
    const detailRequests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/arbiter/log') {
        detailRequests.push(url.searchParams.get('callId') ?? '');
      }
    });
    const plugin = await openLogs(page);
    await expect(plugin.getByText('共 60 条', { exact: true })).toBeVisible();
    // Browsing pages reads only the list route.
    await plugin.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(
      plugin.getByText('第 2 / 3 页', { exact: true }),
    ).toBeVisible();
    expect(detailRequests).toEqual([]);
    // A row on the page the reader is actually looking at opens the existing
    // detail entry, and only then is a detail read issued.
    await plugin.getByText('echo page-sample-30', { exact: false }).click();
    await expect(
      plugin.getByText('decision for e2e-call-030', { exact: true }),
    ).toBeVisible();
    expect(detailRequests).toEqual(['e2e-call-030']);
  },
);
