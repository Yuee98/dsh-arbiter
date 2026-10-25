import { expect, type Page } from '@playwright/test';

/**
 * Dismiss the native getting-started prompt.
 *
 * A credential-free profile presents this prompt on initial load/reload, and the
 * default contract asserts it so a missing prompt is a real host change. A
 * profile that already offers a usable model route may skip the prompt
 * entirely; `optional` accepts that composition and still dismisses the prompt
 * through its own button when it does appear.
 */
export async function dismissGettingStarted(
  page: Page,
  options: { readonly optional?: boolean } = {},
): Promise<void> {
  const gettingStarted = page.getByRole('dialog', {
    name: /开始使用|Get started/i,
  });
  if (options.optional !== true) {
    await expect(gettingStarted).toBeVisible();
    await gettingStarted
      .getByRole('button', { name: /^(关闭|Close)$/ })
      .click();
    return;
  }
  // Either the prompt or the manager chrome settles first; whichever arrives
  // decides whether there is anything to dismiss.
  await expect(
    gettingStarted.or(page.getByRole('button', { name: /^(插件|Plugins)$/ })),
  ).toBeVisible();
  if (!(await gettingStarted.isVisible())) return;
  await gettingStarted.getByRole('button', { name: /^(关闭|Close)$/ }).click();
  await expect(gettingStarted).toBeHidden();
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
