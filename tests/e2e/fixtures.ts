import { test as base, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { startDshHost, type DshHost } from './dsh/host.js';
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
}

export const test = base.extend<DshFixtures>({
  firstInstall: [false, { option: true }],
  dsh: async ({ browserName, firstInstall }, use, testInfo) => {
    const artifacts = testInfo.outputPath('dsh', browserName);
    try {
      const host = await startDshHost(
        fileURLToPath(new URL('../../', import.meta.url)),
        artifacts,
        firstInstall ? { arbiterConfig: 'unset' } : {},
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
  dshPage: async ({ page, dsh }, use) => {
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
    await dismissGettingStarted(page);
    await use(page);
  },
});

export { expect };
