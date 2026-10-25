import AxeBuilder from '@axe-core/playwright';

import { test, expect } from './fixtures.js';
import { openArbiterConfiguration } from './dsh/ui.js';

test('the real plugin configuration has no automatically detected accessibility violations', async ({
  dshPage: page,
}, testInfo) => {
  await openArbiterConfiguration(page);
  const plugin = page.locator('[data-arbiter-root]');
  await expect(plugin).toBeVisible();
  await expect(
    plugin.getByRole('checkbox', { name: '启用 dsh-arbiter', exact: true }),
  ).toBeVisible();

  // The host owns the manager chrome. Audit the actual plugin's initial state
  // without disabling rules or treating hidden tabs as already checked.
  const results = await new AxeBuilder({ page })
    .include('[data-arbiter-root]')
    .analyze();
  for (const incomplete of results.incomplete) {
    testInfo.annotations.push({
      type: 'axe-incomplete',
      description: `${incomplete.id}: ${String(incomplete.nodes.length)} nodes require manual review`,
    });
  }
  await testInfo.attach('arbiter-configuration-axe.json', {
    body: JSON.stringify(results, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('arbiter-configuration.png', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  expect(results.violations).toEqual([]);
});
