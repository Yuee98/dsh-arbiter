import { test, expect } from './fixtures.js';
import { dismissGettingStarted, openArbiterConfiguration } from './dsh/ui.js';
import zhConfig from '../../locale/zh/config.json' with { type: 'json' };
import enConfig from '../../locale/en/config.json' with { type: 'json' };

/**
 * The released Chinese/English switch in the real host.
 *
 * Since #23 `locale/en/` is a declared translation of every plugin module, so
 * the assertion is no longer "the Chinese fallback shows through". It is now
 * the released contract: each language renders its own catalog, the switch
 * keeps working across a refresh, and no surface shows a raw key.
 */

/** Read one field of the real state payload the page renders. */
async function effectiveRevision(
  page: Parameters<typeof openArbiterConfiguration>[0],
  origin: string,
): Promise<string> {
  const state = await page.request.get(`${origin}/api/arbiter/state`);
  const body: unknown = await state.json();
  if (
    body === null ||
    typeof body !== 'object' ||
    !('effectiveRevision' in body) ||
    typeof body.effectiveRevision !== 'string'
  ) {
    throw new Error('DSH state did not supply a configuration revision.');
  }
  return body.effectiveRevision;
}

/** The host's own language switch, driven through its settings dialog. */
async function switchLanguage(
  page: Parameters<typeof openArbiterConfiguration>[0],
  target: '中文' | 'English',
): Promise<void> {
  await page
    .getByRole('button', { name: /账号菜单|Account menu/u })
    .first()
    .click();
  await page.getByText(/^(设置|Settings)$/u).click();
  // The picker's own trigger is the current language's own label.
  await page
    .getByRole('button', { name: /^(中文|English)$/u })
    .first()
    .click();
  await page.getByText(target, { exact: true }).click();
  await page.getByRole('button', { name: /^(Close|关闭)$/u }).click();
}

test(
  'switches the real host language between the released Chinese and English catalogs',
  { tag: '@smoke' },
  async ({ dshPage: page, dsh }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const revision = await effectiveRevision(page, dsh.origin);

    // --- English: the plugin renders its own English catalog ----------------
    await switchLanguage(page, 'English');
    await expect(page.locator('html')).toHaveAttribute('lang', /^en/);
    await openArbiterConfiguration(page);
    const english = page.locator('[data-arbiter-root]');
    await expect(
      english.getByRole('group', { name: enConfig.actions.label, exact: true }),
    ).toBeVisible();
    await expect(
      english.getByRole('button', { name: enConfig.validate, exact: true }),
    ).toBeVisible();
    await expect(
      english.getByText(
        enConfig.effectiveRevision.replace('{revision}', revision),
      ),
    ).toBeVisible();
    // The whole page is English: no other module fell back, and no raw key or
    // interpolated placeholder leaked into the rendered text.
    const englishText = await english.innerText();
    expect(englishText).not.toMatch(/[\u4e00-\u9fff]/u);
    expect(englishText).not.toMatch(
      /config\.[A-Za-z]|page\.[A-Za-z]|\{\w+\}|undefined|\[object Object\]/u,
    );
    // The configuration document and its protocol values are not translated.
    await expect(english.locator('[data-arbiter-config-format]')).toContainText(
      'arbiter-config-',
    );
    await expect(english.locator('[data-arbiter-config-format]')).toContainText(
      enConfig.formatImplicit.trim(),
    );

    // A refresh keeps the host language and the same rendered catalog.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', /^en/);
    await dismissGettingStarted(page);
    await openArbiterConfiguration(page);
    await expect(
      page
        .locator('[data-arbiter-root]')
        .getByRole('group', { name: enConfig.actions.label, exact: true }),
    ).toBeVisible();

    // --- Chinese: switching back restores the source catalog ----------------
    await switchLanguage(page, '中文');
    await expect(page.locator('html')).toHaveAttribute('lang', /^zh/);
    await page.reload();
    await dismissGettingStarted(page);
    await openArbiterConfiguration(page);
    const chinese = page.locator('[data-arbiter-root]');
    await expect(
      chinese.getByRole('group', { name: zhConfig.actions.label, exact: true }),
    ).toBeVisible();
    await expect(
      chinese.getByRole('button', { name: zhConfig.validate, exact: true }),
    ).toBeVisible();
    await expect(
      chinese.getByText(
        zhConfig.effectiveRevision.replace('{revision}', revision),
      ),
    ).toBeVisible();
    expect(pageErrors).toEqual([]);
  },
);
