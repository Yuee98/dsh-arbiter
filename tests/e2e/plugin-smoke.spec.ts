import { test, expect } from './fixtures.js';
import { openArbiterConfiguration } from './dsh/ui.js';

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
      plugin.getByRole('heading', { name: '规则表', exact: true }),
    ).toBeVisible();
    const [ruleTest] = await Promise.all([
      page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/arbiter/test',
      ),
      plugin.getByRole('button', { name: '运行测试', exact: true }).click(),
    ]);
    expect(ruleTest.status()).toBe(200);
    await expect(
      plugin.getByRole('cell', { name: 'gh pr view 42', exact: true }),
    ).toBeVisible();
    await expect(plugin.getByRole('status')).toHaveCount(0);

    const [credentials] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/arbiter/credentials',
      ),
      plugin.getByRole('button', { name: 'Reviewer', exact: true }).click(),
    ]);
    expect(credentials.status()).toBe(200);
    await expect(
      plugin.getByRole('heading', { name: 'Reviewer 类型', exact: true }),
    ).toBeVisible();
    await plugin
      .getByRole('radio', { name: 'decision（分布 + 四探针）', exact: true })
      .check();
    await expect(
      plugin.getByText(
        /^(未设置|已设置.*|当前 composition 没有 credentials 服务)$/,
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

    const rulesBeforeBody: unknown = await (
      await page.request.get(`${dsh.origin}/api/arbiter/state`)
    ).json();
    if (
      rulesBeforeBody === null ||
      typeof rulesBeforeBody !== 'object' ||
      !('config' in rulesBeforeBody)
    ) {
      throw new Error('DSH state did not supply an effective configuration.');
    }
    const rulesBefore = rulesBeforeBody.config;
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
          ? { method, data: { candidateId: 'none', action: 'accept' } }
          : { method },
      );
      expect(response.status(), path).toBe(404);
    }
    // The attempted acceptance changed nothing in the effective configuration.
    const rulesAfter: unknown = await (
      await page.request.get(`${dsh.origin}/api/arbiter/state`)
    ).json();
    expect(rulesAfter).toMatchObject({ config: rulesBefore });

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
