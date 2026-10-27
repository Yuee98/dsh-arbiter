import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { test, expect } from './fixtures.js';
import { openArbiterConfiguration } from './dsh/ui.js';

/**
 * Seed one valid, pending candidate in the isolated profile's audit database.
 *
 * This defeats a false positive: the removed prototype accept handler also
 * answered 404 for an unknown candidate id, so probing with a nonexistent id
 * would prove nothing. With a real candidate present, a still-registered
 * handler would accept it and add a rule, while the first release has no route
 * at all.
 */
function seedPendingCandidate(home: string): void {
  const path = join(home, 'arbiter', 'arbiter.db');
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS candidates (
      candidate_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      rule TEXT NOT NULL,
      stats TEXT NOT NULL,
      evidence TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      window_end INTEGER NOT NULL,
      note TEXT
    );`);
    db.prepare(
      `INSERT OR REPLACE INTO candidates(candidate_id, created_at, status, rule, stats, evidence, window_start, window_end, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'smoke-candidate',
      Date.now(),
      'pending',
      JSON.stringify({
        id: 'smoke-candidate-rule',
        match: { node: 'command', kind: 'regex', pattern: '^printf(?:\\s|$)' },
        verdict: 'allow',
      }),
      '{}',
      '{}',
      0,
      Date.now(),
      null,
    );
  } finally {
    db.close();
  }
}

test(
  'loads the real DSH plugin and exercises every extracted configuration panel',
  { tag: '@smoke' },
  async ({ dshPage: page, dsh }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await openArbiterConfiguration(page);
    const plugin = page.locator('[data-arbiter-root]');

    await expect(
      plugin.getByRole('button', { name: '校验草稿', exact: true }),
    ).toBeVisible();
    await expect(
      plugin.getByRole('button', { name: '保存并应用', exact: true }),
    ).toBeVisible();
    await expect(
      plugin.getByRole('checkbox', { name: '启用 dsh-arbiter', exact: true }),
    ).toBeVisible();
    await expect(
      plugin.getByText('启用与审批模式', { exact: true }),
    ).toBeVisible();

    const state = await page.request.get(`${dsh.origin}/api/arbiter/state`);
    expect(state.status()).toBe(200);
    expect(await state.json()).toMatchObject({
      name: 'arbiter',
      invalidConfigError: null,
      loadErrors: [],
      sessionRecords: { ready: true },
    });

    const [validation] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/arbiter/validate' &&
          response.request().method() === 'POST',
      ),
      plugin.getByRole('button', { name: '校验草稿', exact: true }).click(),
    ]);
    expect(validation.status()).toBe(200);
    expect(await validation.json()).toMatchObject({ ok: true, errors: [] });

    // Exercise the real browser response decoders, not only tab labels. The
    // tester parses static inputs; no tool or model call is executed here.
    await plugin.getByRole('button', { name: '规则', exact: true }).click();
    await expect(
      plugin.getByRole('heading', { name: '规则', exact: true }),
    ).toBeVisible();
    await plugin
      .getByRole('button', { name: '展开测试区', exact: true })
      .click();
    const tester = page.getByRole('dialog', { name: '规则测试' });
    await expect(tester).toBeVisible();
    const [ruleTest] = await Promise.all([
      page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/arbiter/test',
      ),
      tester.getByRole('button', { name: '运行测试', exact: true }).click(),
    ]);
    expect(ruleTest.status()).toBe(200);
    // The decoded answer reaches the page: the two conclusions and the editable
    // sample are real client state, not a hardcoded paragraph.
    await expect(tester.getByTestId('rule-test-conclusion')).toBeVisible();
    await expect(tester.getByRole('textbox', { name: '命令' })).toHaveValue(
      'gh pr view 42',
    );
    await tester
      .getByRole('button', { name: '收起测试区', exact: true })
      .click();
    await expect(plugin.getByRole('status')).toHaveCount(0);

    await plugin.getByRole('button', { name: 'Reviewer', exact: true }).click();
    await expect(
      plugin.getByRole('heading', { name: 'Reviewer 类型', exact: true }),
    ).toBeVisible();
    // The decision backend is the one that holds a credential reference, so
    // the status query belongs to switching to it rather than to the tab.
    const [credentials] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/arbiter/credentials',
      ),
      plugin
        .getByRole('radio', { name: 'decision（分布 + 四探针）', exact: true })
        .check(),
    ]);
    expect(credentials.status()).toBe(200);
    await expect(
      plugin.getByText(
        /^(未设置|已设置.*|无法读取凭据状态|当前 composition 没有 credentials 服务)$/,
      ),
    ).toBeVisible();
    await expect(plugin.getByRole('status')).toHaveCount(0);

    await plugin
      .getByRole('button', { name: '策略与高级', exact: true })
      .click();
    await expect(
      plugin.getByRole('heading', { name: '审查策略', exact: true }),
    ).toBeVisible();
    await expect(
      plugin.getByLabel('项目规则文件', { exact: true }),
    ).toBeVisible();
    await expect(
      plugin.getByRole('heading', { name: '审计与熔断', exact: true }),
    ).toBeVisible();

    const [logs] = await Promise.all([
      page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/arbiter/logs',
      ),
      plugin.getByRole('button', { name: '日志与详情', exact: true }).click(),
    ]);
    expect(logs.status()).toBe(200);
    await expect(
      plugin.getByRole('heading', { name: '调用记录', exact: true }),
    ).toBeVisible();
    await expect(plugin.getByText('没有记录。', { exact: true })).toBeVisible();
    await expect(plugin.getByRole('status')).toHaveCount(0);

    // First release: offline rule suggestions are deferred. Their tab and the
    // analysis / accept actions must not be reachable from the real UI either.
    await expect(
      plugin.getByRole('button', { name: '离线建议', exact: true }),
    ).toHaveCount(0);

    // A real pending candidate exists, so a still-registered accept handler
    // would succeed instead of answering "candidate not found".
    seedPendingCandidate(dsh.home);
    const rulesBefore: unknown = (await (
      await page.request.get(`${dsh.origin}/api/arbiter/state`)
    ).json()) as unknown;
    const readConfig = (value: unknown): unknown =>
      typeof value === 'object' && value !== null && 'config' in value
        ? value.config
        : null;
    const configBefore = readConfig(rulesBefore);
    if (configBefore === null) {
      throw new Error('DSH state did not supply an effective configuration.');
    }

    for (const [path, method] of [
      ['/api/arbiter/analyze', 'POST'],
      ['/api/arbiter/suggestions', 'GET'],
      ['/api/arbiter/replay', 'GET'],
      ['/api/arbiter/suggestions/act', 'POST'],
    ] as const) {
      // A GET must not carry a body: the host rejects that before routing, so
      // the request would no longer prove the route itself is absent.
      const response = await page.request.fetch(
        `${dsh.origin}${path}`,
        method === 'POST'
          ? {
              method,
              data: { candidateId: 'smoke-candidate', action: 'accept' },
            }
          : { method },
      );
      expect(response.status(), path).toBe(404);
      // The host's unmatched-route answer is plain text; the prototype handler
      // answered JSON ({"ok":false,"code":"not-found"}). Asserting the shape
      // distinguishes "no route" from "route said not found".
      const body = await response.text();
      expect(body, path).toBe('not found');
      expect(body, path).not.toContain('"code"');
    }

    // Neither the attempted acceptance nor analysis changed the live config,
    // and the seeded candidate is still pending rather than accepted.
    const configAfter = readConfig(
      await (await page.request.get(`${dsh.origin}/api/arbiter/state`)).json(),
    );
    expect(configAfter).toEqual(configBefore);

    await plugin
      .getByRole('button', { name: '覆盖与试用', exact: true })
      .click();
    await expect(
      plugin.getByRole('heading', { name: '试用步骤', exact: true }),
    ).toBeVisible();
    await expect(
      plugin.getByRole('heading', { name: '已验证边界', exact: true }),
    ).toBeVisible();
    await plugin
      .getByRole('button', { name: '状态与模式', exact: true })
      .click();
    await expect(
      plugin.getByRole('heading', { name: '启用与审批模式', exact: true }),
    ).toBeVisible();
    expect(pageErrors).toEqual([]);
  },
);
