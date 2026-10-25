import { test, expect } from './fixtures.js';
import { dismissGettingStarted, openArbiterConfiguration } from './dsh/ui.js';
import config from '../../locale/zh/config.json' with { type: 'json' };

test(
  'switches the real host language and restores localized configuration after refresh',
  { tag: '@smoke' },
  async ({ dshPage: page, dsh }) => {
    await page.getByRole('button', { name: '账号菜单', exact: true }).click();
    await page.getByText('设置', { exact: true }).click();
    await page.getByRole('button', { name: '中文', exact: true }).click();
    await page.getByText('English', { exact: true }).click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', /^en/);
    await openArbiterConfiguration(page);

    // English has only common messages: the whole missing config module falls back.
    const actionsLabel = config.actions.label;
    const validateLabel = config.validate;
    const revisionTemplate = config.revision;
    const state = await page.request.get(`${dsh.origin}/api/arbiter/state`);
    const body: unknown = await state.json();
    if (
      body === null ||
      typeof body !== 'object' ||
      !('effectiveRevision' in body) ||
      typeof body.effectiveRevision !== 'string'
    ) {
      throw new Error('DSH state did not supply a configuration revision.');
    }
    await expect(
      page.getByRole('group', { name: actionsLabel, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: validateLabel, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        revisionTemplate.replace('{revision}', body.effectiveRevision),
      ),
    ).toBeVisible();

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', /^en/);
    await dismissGettingStarted(page);
    await openArbiterConfiguration(page);
    await expect(
      page.getByRole('group', { name: actionsLabel, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: validateLabel, exact: true }),
    ).toBeVisible();
  },
);
