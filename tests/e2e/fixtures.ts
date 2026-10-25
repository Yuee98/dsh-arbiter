import { test as base, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { startDshHost, type DshHost } from './dsh/host.js';
import type { SeededModelGroup } from './dsh/profile.js';
import { dismissGettingStarted } from './dsh/ui.js';

interface DshFixtures {
  readonly dsh: DshHost;
  readonly dshPage: Page;
  /**
   * `true` omits the `arbiter` config row so the plugin must apply the
   * first-install defaults. The default keeps the explicit empty object that
   * the existing smoke cases assume.
   */
  readonly firstInstall: boolean;
  /**
   * A profile configuration written verbatim, for cases that need a specific
   * document (for example a declared canonical format) in the real host.
   */
  readonly arbiterConfig: Readonly<Record<string, unknown>> | null;
  /**
   * Hand-declared model routes for the host catalog.
   *
   * The holder is an object, not a list: Playwright reads a two-element array
   * fixture value as a `[value, options]` tuple. The default declares none, so
   * the existing smoke cases keep the credential-free composition they assert.
   */
  readonly modelCatalog: { readonly groups: readonly SeededModelGroup[] };
}

export const test = base.extend<DshFixtures>({
  firstInstall: [false, { option: true }],
  arbiterConfig: [null, { option: true }],
  modelCatalog: [{ groups: [] }, { option: true }],
  dsh: async (
    { browserName, firstInstall, arbiterConfig, modelCatalog },
    use,
    testInfo,
  ) => {
    const artifacts = testInfo.outputPath('dsh', browserName);
    const seed =
      arbiterConfig !== null
        ? { arbiterConfig }
        : firstInstall
          ? { arbiterConfig: 'unset' as const }
          : {};
    try {
      const host = await startDshHost(
        fileURLToPath(new URL('../../', import.meta.url)),
        artifacts,
        {
          ...seed,
          ...(modelCatalog.groups.length === 0
            ? {}
            : { modelGroups: modelCatalog.groups }),
        },
      );
      try {
        await use(host);
      } finally {
        await host.stop();
      }
    } finally {
      for (const name of [
        'environment.json',
        'cleanup.json',
        'host.stdout.log',
        'host.stderr.log',
      ]) {
        await testInfo
          .attach(name, { path: join(artifacts, name) })
          .catch(() => undefined);
      }
    }
  },
  dshPage: async ({ page, dsh, modelCatalog }, use) => {
    await page
      .context()
      .addCookies([{ ...dsh.cookie, url: dsh.origin, httpOnly: true }]);
    await page.goto(dsh.origin);
    // DSH 0.2 fresh profiles present a native preview notice. Use its public
    // button rather than hiding overlays or modifying the host DOM.
    const previewNotice = page.getByRole('dialog', {
      name: /预览版说明|Preview/i,
    });
    await expect(previewNotice).toBeVisible();
    await previewNotice
      .getByRole('button', { name: /^(继续|Continue)$/ })
      .click();
    // A profile that already offers a model route has nothing to set up, so the
    // getting-started prompt is optional there and required elsewhere.
    await dismissGettingStarted(
      page,
      modelCatalog.groups.length === 0 ? {} : { optional: true },
    );
    await use(page);
  },
});

export { expect };
