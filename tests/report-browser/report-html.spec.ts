import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { test, expect } from '@playwright/test';
import type { Page, BrowserContext } from '@playwright/test';
import { renderHtml } from '../../evals/src/report/html.js';
import { publicReport } from '../../evals/src/report/public-text.js';
import {
  ATTACK_TEXT,
  BODY_CANARY,
  reportBrowserFixture,
} from '../evals/helpers/report-browser.js';

async function globalText(page: Page) {
  return page.locator('body').evaluate((body) =>
    Array.from(body.children)
      .filter(
        (child) => child.id !== 'example-browser' && child.tagName !== 'SCRIPT',
      )
      .map((child) => child.textContent),
  );
}

function trackRequests(
  context: BrowserContext,
  page: Page,
  documentUrl: string,
) {
  const unexpected: string[] = [];
  context.on('request', (request) => {
    if (request.url() !== documentUrl) unexpected.push(request.url());
  });
  page.on('websocket', (socket) => unexpected.push(socket.url()));
  return unexpected;
}

test('local report filters only display, preserves all statuses, and expands differences with a keyboard', async ({
  page,
  context,
}) => {
  const fixture = await reportBrowserFixture();
  try {
    const url = pathToFileURL(fixture.htmlPath).href;
    const unexpected = trackRequests(context, page, url);
    await page.goto(url);
    await expect(page.locator('[data-controls]')).toBeVisible();
    const visible = page.locator('tr[data-example]:visible');
    await expect(visible).toHaveCount(8);
    const before = await globalText(page);
    await page.locator('#filter-business').selectOption(JSON.stringify('f01'));
    await expect(visible).toHaveCount(4);
    await page
      .locator('#filter-provenance')
      .selectOption(JSON.stringify('reconstructed'));
    await expect(visible).toHaveCount(0);
    await expect(page.locator('[data-empty]')).toBeVisible();
    await page.getByRole('button', { name: '清空筛选' }).click();
    await page
      .locator('#filter-dataset')
      .selectOption(JSON.stringify('workflow'));
    await page
      .locator('#filter-reference')
      .selectOption(JSON.stringify('human'));
    await expect(visible).toHaveCount(8);
    await page
      .locator('#filter-status')
      .selectOption(JSON.stringify('not-run'));
    await expect(visible).toHaveCount(2);
    const unrun = fixture.report.examples.find(
      (cell) => cell.status === 'not-run',
    );
    if (unrun === undefined) throw new Error('expected unrun fixture');
    await page
      .getByRole('searchbox', { name: '关键词' })
      .fill(unrun.cellId.toUpperCase());
    await expect(visible).toHaveCount(1);
    await expect(visible).toContainText('not-run');
    await page
      .getByRole('searchbox', { name: '关键词' })
      .fill('no matching material 132');
    await expect(visible).toHaveCount(0);
    await expect(page.locator('[data-count]')).toHaveText(
      '当前可见 0 / 全计划 8 格',
    );
    await page.getByRole('button', { name: '清空筛选' }).click();
    await expect(visible).toHaveCount(8);
    expect(await globalText(page)).toEqual(before);
    const difference = fixture.report.differences.find(
      (row) => row.cellId !== '',
    );
    if (difference === undefined) throw new Error('expected real difference');
    const row = page
      .locator('tr[data-example]')
      .filter({ has: page.getByText(difference.cellId, { exact: true }) });
    const outer = row.locator('td > details').first();
    const summary = outer.locator(':scope > summary');
    await summary.focus();
    await summary.press('Enter');
    await expect(outer).toHaveAttribute('open', '');
    await row
      .locator('summary')
      .filter({ hasText: /^本格差异/ })
      .click();
    await expect(row).toContainText(difference.observed);
    await expect(row).toContainText(difference.expected);
    await summary.press('Enter');
    await expect(outer).not.toHaveAttribute('open');
    expect(unexpected).toEqual([]);
  } finally {
    await fixture.remove();
  }
});

test('hostile tool/model text and attributes stay inert in file HTML, including without JavaScript', async ({
  page,
  context,
  browser,
}) => {
  const fixture = await reportBrowserFixture('unsafe');
  try {
    // Exercise a historical caller's hostile free-text facet as well as actual stored output.
    const report = {
      ...fixture.report,
      examples: fixture.report.examples.map((cell) =>
        cell.source?.kind === 'workflow'
          ? {
              ...cell,
              source: {
                ...cell.source,
                group: `" autofocus onfocus="${ATTACK_TEXT}`,
              },
            }
          : cell,
      ),
    };
    const file = `${fixture.prefix}.hostile.html`;
    // renderHtml only receives the already projected report when used by production.
    // Preserve the real generated public bodies rather than the pre-projection fixture.
    const generated = await fixture.text('html');
    const facetHtml = renderHtml(publicReport({ ...report, evidence: [] }));
    await writeFile(file, facetHtml);
    const facetUrl = pathToFileURL(file).href;
    const facetRequests = trackRequests(context, page, facetUrl);
    await page.goto(facetUrl);
    await expect(page.locator('[data-controls]')).toBeVisible();
    await expect(
      page.locator(
        '#example-browser [autofocus], #example-browser [onfocus], #example-browser img, #example-browser svg',
      ),
    ).toHaveCount(0);
    expect(facetRequests).toEqual([]);
    // Use a fresh context so the request proof is scoped to the generated artifact itself.
    const safeContext = await browser.newContext({ offline: true });
    try {
      const safePage = await safeContext.newPage();
      const url = pathToFileURL(fixture.htmlPath).href;
      const unexpected = trackRequests(safeContext, safePage, url);
      await safePage.goto(url);
      const first = safePage.locator('tr[data-example]').first();
      await first.getByText('差异与材料', { exact: true }).click();
      await first
        .locator('summary')
        .filter({ hasText: /^尝试 1/ })
        .click();
      await first
        .locator('summary')
        .filter({ hasText: /^保存的模型响应$/ })
        .click();
      await expect(
        first.locator('pre[aria-label="保存的模型响应"]'),
      ).toContainText(ATTACK_TEXT);
      await expect(
        safePage.locator(
          '#example-browser script, #example-browser img, #example-browser svg, #example-browser iframe',
        ),
      ).toHaveCount(0);
      expect(
        await safePage.evaluate(() => Reflect.has(globalThis, 'reportAttack')),
      ).toBe(false);
      expect(generated).not.toContain(BODY_CANARY);
      expect(unexpected).toEqual([]);
    } finally {
      await safeContext.close();
    }
    const plainContext = await browser.newContext({
      javaScriptEnabled: false,
      offline: true,
    });
    try {
      const plain = await plainContext.newPage();
      const url = pathToFileURL(fixture.htmlPath).href;
      const unexpected = trackRequests(plainContext, plain, url);
      await plain.goto(url);
      await expect(plain.locator('[data-controls]')).toBeHidden();
      await expect(plain.locator('tr[data-example]:visible')).toHaveCount(2);
      await plain
        .locator('tr[data-example]')
        .first()
        .getByText('差异与材料', { exact: true })
        .click();
      await plain
        .locator('tr[data-example]')
        .first()
        .locator('summary')
        .filter({ hasText: /^尝试 1/ })
        .click();
      await plain
        .locator('tr[data-example]')
        .first()
        .locator('summary')
        .filter({ hasText: /^保存的模型响应$/ })
        .click();
      await expect(
        plain
          .locator('tr[data-example]')
          .first()
          .locator('pre[aria-label="保存的模型响应"]'),
      ).toContainText(ATTACK_TEXT);
      expect(unexpected).toEqual([]);
    } finally {
      await plainContext.close();
    }
  } finally {
    await fixture.remove();
  }
});

test('a multi-MiB report opens with every row and remains searchable before any material is expanded', async ({
  page,
  context,
}, info) => {
  const fixture = await reportBrowserFixture('large');
  try {
    const html = await fixture.text('html');
    expect(Buffer.byteLength(html)).toBeGreaterThan(6_000_000);
    expect(fixture.report.examples).toHaveLength(200);
    expect(
      fixture.report.evidence?.every((cell) => cell.status === 'published'),
    ).toBe(true);
    const url = pathToFileURL(fixture.htmlPath).href;
    const unexpected = trackRequests(context, page, url);
    const start = Date.now();
    await page.goto(url);
    await expect(page.locator('[data-controls]')).toBeVisible();
    const loadMs = Date.now() - start;
    const visible = page.locator('tr[data-example]:visible');
    await expect(visible).toHaveCount(200);
    await expect(page.locator('tr[data-example] details[open]')).toHaveCount(0);
    const before = await globalText(page);
    const cell = fixture.report.examples[0];
    if (cell === undefined) throw new Error('large fixture empty');
    const end = `END_${cell.cellId}__END`;
    const searchStart = Date.now();
    await page.getByRole('searchbox', { name: '关键词' }).fill(end);
    await expect(visible).toHaveCount(1);
    const searchMs = Date.now() - searchStart;
    await visible.getByText('差异与材料', { exact: true }).click();
    await visible
      .locator('summary')
      .filter({ hasText: /^尝试 1/ })
      .click();
    await visible
      .locator('summary')
      .filter({ hasText: /^保存的模型响应$/ })
      .click();
    const text = visible.locator('pre[aria-label="保存的模型响应"]');
    await text.focus();
    await text.press('ArrowDown');
    await expect
      .poll(() => text.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    const atEnd = await text.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return (
        element.scrollTop + element.clientHeight >= element.scrollHeight - 1
      );
    });
    expect(atEnd).toBe(true);
    await expect(text).toContainText(end);
    await page.getByRole('button', { name: '清空筛选' }).click();
    await expect(visible).toHaveCount(200);
    await page.locator('#filter-business').selectOption(JSON.stringify('f02'));
    await expect(visible).toHaveCount(100);
    await page
      .getByRole('searchbox', { name: '关键词' })
      .fill('no such public body');
    await expect(visible).toHaveCount(0);
    await page.getByRole('button', { name: '清空筛选' }).click();
    await expect(visible).toHaveCount(200);
    expect(await globalText(page)).toEqual(before);
    expect(unexpected).toEqual([]);
    await info.attach('large-report-proof', {
      body: Buffer.from(
        JSON.stringify({
          plannedCells: 200,
          htmlBytes: Buffer.byteLength(html),
          loadMs,
          searchMs,
          externalRequests: unexpected,
        }),
      ),
      contentType: 'application/json',
    });
  } finally {
    await fixture.remove();
  }
});
