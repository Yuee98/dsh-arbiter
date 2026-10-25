import { test, expect } from './fixtures.js';
import type { DshHost } from './dsh/host.js';
import { startHoldingProvider } from './dsh/holding-provider.js';
import type { HoldingProvider } from './dsh/holding-provider.js';
import type { SeededModelGroup } from './dsh/profile.js';
import { openArbiterConfiguration } from './dsh/ui.js';

/**
 * The real host wiring of the one-shot Reviewer test.
 *
 * The seeded provider points at a closed local port, so the probe is expected to
 * report a request failure. That is the point: this verifies the button reaches
 * the real route, the real route reaches the real adapter, and the failure comes
 * back with material — without sending a paid request or needing a credential.
 */
const MODEL_GROUPS = [
  {
    provider: 'probe',
    displayName: 'Probe provider',
    models: [{ id: 'probe-model', name: 'Probe Model' }],
  },
] as const;

interface ReviewerState {
  readonly config: {
    readonly reviewer: {
      readonly type: string;
      readonly chat: { readonly provider: string; readonly model: string };
    };
  };
  readonly effectiveRevision: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string')
    throw new TypeError(`${path} must be a string`);
  return value;
}

function asReviewerState(value: unknown): ReviewerState {
  const root = record(value, 'state');
  const config = record(root['config'], 'config');
  const reviewer = record(config['reviewer'], 'config.reviewer');
  const chat = record(reviewer['chat'], 'config.reviewer.chat');
  return {
    config: {
      reviewer: {
        type: text(reviewer['type'], 'reviewer.type'),
        chat: {
          provider: text(chat['provider'], 'reviewer.chat.provider'),
          model: text(chat['model'], 'reviewer.chat.model'),
        },
      },
    },
    effectiveRevision: text(root['effectiveRevision'], 'effectiveRevision'),
  };
}

async function readReviewerState(dsh: DshHost): Promise<ReviewerState> {
  const response = await fetch(`${dsh.origin}/api/arbiter/state`, {
    headers: { cookie: `${dsh.cookie.name}=${dsh.cookie.value}` },
  });
  expect(response.status).toBe(200);
  return asReviewerState(await response.json());
}

test.describe('reviewer connection test in the real host', () => {
  test.use({ modelCatalog: { groups: MODEL_GROUPS } });

  test(
    'runs, reports the failure material, and forgets the result when closed',
    { tag: '@smoke' },
    async ({ dshPage: page, dsh }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      const before = await readReviewerState(dsh);

      await openArbiterConfiguration(page);
      const plugin = page.locator('[data-arbiter-root]');
      await plugin
        .getByRole('button', { name: 'Reviewer', exact: true })
        .click();
      const select = plugin.getByRole('combobox', {
        name: '模型',
        exact: true,
      });
      await select.selectOption({
        label: 'Probe provider / probe-model（Probe Model）',
      });

      // The click-time draft names a concrete route, so the entry is enabled.
      const openButton = plugin.getByRole('button', {
        name: '测试 Reviewer',
        exact: true,
      });
      await expect(openButton).toBeEnabled();
      await openButton.click();

      const dialog = plugin.getByRole('dialog', {
        name: 'Reviewer 连接测试',
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByText('测试会发送模型请求，可能产生费用。'),
      ).toBeVisible();

      const [probeResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/arbiter/reviewer-test',
        ),
        dialog.getByRole('button', { name: '开始测试', exact: true }).click(),
      ]);
      expect(probeResponse.status()).toBe(200);
      await expect(dialog.locator('[data-arbiter-probe-status]')).toBeVisible();
      // The seeded route declares no credential reference, and the
      // OpenAI-compatible protocol refuses to dispatch without one, so the
      // classified stage is the credential — not a fabricated pass and not a
      // crash. Asserting the stable code ties this spec to the stage rather
      // than to one sentence.
      await expect(
        dialog.locator('[data-arbiter-probe-status="failed"]'),
      ).toBeVisible();
      await expect(
        dialog.locator('[data-arbiter-probe-failure="credential-missing"]'),
      ).toBeVisible();
      await expect(
        dialog.getByText('未通过：凭据未配置或无法解析'),
      ).toBeVisible();
      await expect(dialog.getByText('probe / probe-model')).toBeVisible();
      // The dialog keeps the material for diagnosis.
      await dialog.getByText('查看输入、各次返回与错误').click();
      await expect(dialog.getByText('第 1 次请求')).toBeVisible();

      // Nothing was applied: the effective revision is unchanged.
      const afterProbe = await readReviewerState(dsh);
      expect(afterProbe.effectiveRevision).toBe(before.effectiveRevision);
      expect(afterProbe.config.reviewer.chat.provider).toBe('session');

      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      await expect(dialog).toBeHidden();
      // Closing ends the diagnosis: no remembered result on the panel.
      await expect(plugin.getByText(/已通过|未通过/)).toHaveCount(0);
      await openButton.click();
      const reopened = plugin.getByRole('dialog', {
        name: 'Reviewer 连接测试',
        exact: true,
      });
      await expect(reopened.getByText(/尚未运行/)).toBeVisible();
      await expect(reopened.locator('[data-arbiter-probe-status]')).toHaveCount(
        0,
      );
      await reopened.getByRole('button', { name: '关闭', exact: true }).click();

      expect(pageErrors).toEqual([]);
    },
  );
});

test.describe('reviewer connection test without a concrete model', () => {
  test(
    'following the session disables the entry in the real host',
    { tag: '@smoke' },
    async ({ dshPage: page }) => {
      await openArbiterConfiguration(page);
      const plugin = page.locator('[data-arbiter-root]');
      await plugin
        .getByRole('button', { name: 'Reviewer', exact: true })
        .click();
      // The first-release default follows the session.
      await expect(
        plugin.getByRole('combobox', { name: '模型', exact: true }),
      ).toHaveValue('session');
      await expect(
        plugin.getByRole('button', { name: '测试 Reviewer', exact: true }),
      ).toBeDisabled();
      await expect(
        plugin.getByText('测试需要指定模型，请选择具体模型后测试。'),
      ).toBeVisible();
      // The dialog never opened, so no probe request was made.
      await expect(page.locator('[data-arbiter-reviewer-test]')).toHaveCount(0);
    },
  );
});

/**
 * The cancellation case needs an endpoint that stays open, and the host profile
 * must know its URL before it starts. A derived fixture starts the provider
 * first and then declares the seeded route, which keeps the ordering explicit.
 */
const cancellationTest = test.extend<{
  readonly holdingProvider: HoldingProvider;
  readonly modelCatalog: { readonly groups: readonly SeededModelGroup[] };
}>({
  // Playwright requires the fixture-parameter slot. `browserName` is the
  // cheapest available dependency and keeps this override self-describing.
  holdingProvider: async ({ browserName }, use) => {
    expect(typeof browserName).toBe('string');
    const provider = await startHoldingProvider({ hold: true });
    try {
      await use(provider);
    } finally {
      await provider.stop();
    }
  },
  modelCatalog: async ({ holdingProvider }, use) => {
    await use({
      groups: [
        {
          provider: 'slow',
          displayName: 'Slow provider',
          baseURL: `${holdingProvider.origin}/v1`,
          // The local server accepts any value; this is a routing header in the
          // profile, not a stored credential.
          headers: { authorization: 'Bearer isolated-e2e-probe' },
          models: [{ id: 'slow-model', name: 'Slow Model' }],
        },
      ],
    });
  },
});

cancellationTest.describe('reviewer connection test cancellation', () => {
  cancellationTest(
    'closing the dialog while a request is in flight aborts it',
    { tag: '@smoke' },
    async ({ dshPage: page, holdingProvider }) => {
      await openArbiterConfiguration(page);
      const plugin = page.locator('[data-arbiter-root]');
      await plugin
        .getByRole('button', { name: 'Reviewer', exact: true })
        .click();
      await plugin
        .getByRole('combobox', { name: '模型', exact: true })
        .selectOption({
          label: 'Slow provider / slow-model（Slow Model）',
        });
      await plugin
        .getByRole('button', { name: '测试 Reviewer', exact: true })
        .click();
      const dialog = plugin.getByRole('dialog', {
        name: 'Reviewer 连接测试',
        exact: true,
      });
      await dialog
        .getByRole('button', { name: '开始测试', exact: true })
        .click();
      // The provider sees the request, which is the in-flight state.
      await expect
        .poll(() => holdingProvider.calls.length, { timeout: 20_000 })
        .toBeGreaterThan(0);
      await expect(dialog.getByText(/正在请求/)).toBeVisible();

      // Closing (not cancelling) must still abort the model request.
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect
        .poll(
          async () => {
            const call = holdingProvider.calls[0];
            return call === undefined ? false : await call.aborted;
          },
          { timeout: 20_000 },
        )
        .toBe(true);
      // Only the profile's static test header travelled; no stored credential
      // was read, and no secret value appears anywhere.
      expect(holdingProvider.calls[0]?.authorization).toBe(
        'Bearer isolated-e2e-probe',
      );
    },
  );
});
