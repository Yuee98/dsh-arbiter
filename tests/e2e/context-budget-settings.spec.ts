import type { Page } from '@playwright/test';
import { isRecord } from '../../src/config/values.js';
import { test, expect } from './fixtures.js';
import { dismissGettingStarted, openArbiterConfiguration } from './dsh/ui.js';
import type { DshHost } from './dsh/host.js';

async function budgetState(page: Page, dsh: DshHost) {
  const response = await page.request.get(`${dsh.origin}/api/arbiter/state`);
  expect(response.status()).toBe(200);
  const state: unknown = await response.json();
  const config = isRecord(state) ? state['config'] : null;
  const context = isRecord(config) ? config['context'] : null;
  const revision = isRecord(state) ? state['fileRevision'] : null;
  if (!isRecord(config) || !isRecord(context) || typeof revision !== 'string')
    throw new Error('missing actual configuration state');
  const target = context['targetInputTokens'];
  const hard = context['maxInputTokens'];
  if (typeof target !== 'number' || typeof hard !== 'number')
    throw new Error('missing actual input budgets');
  return {
    config,
    context: { ...context, targetInputTokens: target, maxInputTokens: hard },
    revision,
  };
}

async function saveBudget(page: Page): Promise<void> {
  const [response] = await Promise.all([
    page.waitForResponse(
      (entry) =>
        new URL(entry.url()).pathname === '/api/arbiter/config/save' &&
        entry.request().method() === 'POST',
    ),
    page
      .locator('[data-arbiter-root]')
      .getByRole('button', { name: '保存并应用' })
      .click(),
  ]);
  expect(response.status()).toBe(200);
  await expect(page.locator('[data-arbiter-save-status="saved"]')).toHaveText(
    '已保存并生效。',
  );
}

test('the existing hard-limit editor saves below its hidden target and preserves the pair after refresh', async ({
  dshPage: page,
  dsh,
}) => {
  const before = await budgetState(page, dsh);
  expect(before.context).toMatchObject({
    targetInputTokens: 6000,
    maxInputTokens: 10000,
  });
  await openArbiterConfiguration(page);
  const plugin = page.locator('[data-arbiter-root]');
  await plugin.getByRole('button', { name: '策略与高级' }).click();
  const input = plugin.getByRole('spinbutton', { name: '最大输入 tokens' });
  await input.fill('5000');
  await saveBudget(page);
  const lowered = await budgetState(page, dsh);
  expect(lowered.context).toMatchObject({
    targetInputTokens: 5000,
    maxInputTokens: 5000,
  });
  expect(lowered.revision).not.toBe(before.revision);

  await page.reload();
  await dismissGettingStarted(page);
  await openArbiterConfiguration(page);
  await plugin.getByRole('button', { name: '策略与高级' }).click();
  await expect(input).toHaveValue('5000');
  expect((await budgetState(page, dsh)).context).toEqual(lowered.context);
  await input.fill('8000');
  await saveBudget(page);
  const increased = await budgetState(page, dsh);
  expect(increased.context).toMatchObject({
    targetInputTokens: 5000,
    maxInputTokens: 8000,
  });

  // Only the H editor coordinates its hidden T; explicit invalid API input stays invalid.
  const rejected = await page.request.post(
    `${dsh.origin}/api/arbiter/config/save`,
    {
      data: {
        revision: increased.revision,
        config: {
          ...increased.config,
          context: { ...increased.context, targetInputTokens: 9000 },
        },
      },
    },
  );
  expect(rejected.status()).toBe(422);
  expect(await rejected.json()).toMatchObject({
    code: 'config-invalid',
    errors: expect.arrayContaining([
      expect.objectContaining({
        path: 'context.targetInputTokens',
        code: 'relation.targetInputTokens',
      }),
    ]),
  });
  expect((await budgetState(page, dsh)).context).toEqual(increased.context);
});
