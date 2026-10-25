import { expect, type Page } from '@playwright/test';

/** A credential-free profile shows this native prompt on initial load/reload. */
export async function dismissGettingStarted(page: Page): Promise<void> {
  const gettingStarted = page.getByRole('dialog', {
    name: /开始使用|Get started/i,
  });
  await expect(gettingStarted).toBeVisible();
  await gettingStarted.getByRole('button', { name: /^(关闭|Close)$/ }).click();
}

/** Native manager navigation, shared by fresh loads and browser refresh cases. */
export async function openArbiterConfiguration(page: Page): Promise<void> {
  const pluginManager = page.getByRole('button', { name: /^(插件|Plugins)$/ });
  await expect(pluginManager).toBeVisible();
  await pluginManager.click();
  const pluginDetail = page.getByRole('button', {
    name: /^(查看|View) dsh-arbiter$/,
  });
  await expect(pluginDetail).toBeVisible();
  await pluginDetail.click();
}
