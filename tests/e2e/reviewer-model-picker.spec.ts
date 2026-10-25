import { test, expect } from './fixtures.js';
import type { DshHost } from './dsh/host.js';
import { openArbiterConfiguration } from './dsh/ui.js';

/**
 * Two hand-declared provider routes that share one model id.
 *
 * pi-ai resolves these models from the profile's own catalog, so the real host
 * directory is populated without a credential and without any model request.
 * The shared id is what a flat list would merge: the select must keep both
 * routes addressable.
 */
const MODEL_GROUPS = [
  {
    provider: 'alpha',
    displayName: 'Alpha provider',
    models: [
      { id: 'alpha-model', name: 'Alpha Model' },
      { id: 'shared-model', name: 'Shared Model' },
    ],
  },
  {
    provider: 'beta',
    displayName: 'Beta provider',
    models: [{ id: 'shared-model', name: 'Shared Model' }],
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

/** Validate only what this spec asserts instead of trusting the API shape. */
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

test.describe('reviewer model directory in the real host', () => {
  test.use({ modelCatalog: { groups: MODEL_GROUPS } });

  test(
    'lists the real provider catalog, keeps same-named models apart and saves the route',
    { tag: '@smoke' },
    async ({ dshPage: page, dsh }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      const before = await readReviewerState(dsh);
      expect(before.config.reviewer.chat.provider).toBe('session');

      // The directory is the host's own read: it must answer for real.
      const catalogResponse = await page.request.get(
        `${dsh.origin}/api/arbiter/models`,
      );
      expect(catalogResponse.status()).toBe(200);
      const catalog: unknown = await catalogResponse.json();
      const groups = record(catalog, 'catalog')['groups'];
      expect(Array.isArray(groups)).toBe(true);
      if (!Array.isArray(groups)) throw new TypeError('groups must be a list');
      const providerIds = groups.map(
        (group) => record(group, 'catalog.groups[]')['id'],
      );
      expect(providerIds).toEqual(expect.arrayContaining(['alpha', 'beta']));

      await openArbiterConfiguration(page);
      const plugin = page.locator('[data-arbiter-root]');
      await plugin
        .getByRole('button', { name: 'Reviewer', exact: true })
        .click();
      await expect(
        plugin.getByRole('heading', { name: 'Reviewer 类型', exact: true }),
      ).toBeVisible();

      const select = plugin.getByRole('combobox', {
        name: '模型',
        exact: true,
      });
      await expect(
        select.getByRole('option', { name: '跟随会话模型', exact: true }),
      ).toBeAttached();
      await expect(select).toHaveValue('session');
      await expect(
        select.getByRole('option', {
          name: 'Alpha provider / alpha-model（Alpha Model）',
          exact: true,
        }),
      ).toBeAttached();
      // The two providers that share one model id remain two options.
      await expect(
        select.getByRole('option', {
          name: 'Alpha provider / shared-model（Shared Model）',
          exact: true,
        }),
      ).toBeAttached();
      await expect(
        select.getByRole('option', {
          name: 'Beta provider / shared-model（Shared Model）',
          exact: true,
        }),
      ).toBeAttached();
      expect(
        await select
          .locator('optgroup')
          .evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute('label')),
          ),
      ).toEqual(expect.arrayContaining(['Alpha provider', 'Beta provider']));

      // Search narrows the real list instead of a hardcoded copy.
      const search = plugin.getByRole('searchbox', {
        name: '搜索模型',
        exact: true,
      });
      await search.fill('beta');
      await expect(
        select.getByRole('option', {
          name: 'Alpha provider / alpha-model（Alpha Model）',
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        select.getByRole('option', {
          name: 'Beta provider / shared-model（Shared Model）',
          exact: true,
        }),
      ).toBeAttached();
      await search.fill('');

      // Choose the beta route (the second provider with the shared model id).
      await select.selectOption({
        label: 'Beta provider / shared-model（Shared Model）',
      });
      await expect(plugin.locator('[data-arbiter-save-status]')).toHaveText(
        '草稿未保存；当前生效配置未改变。',
      );
      // Selecting a model alone issues no model request and applies nothing.
      expect((await readReviewerState(dsh)).effectiveRevision).toBe(
        before.effectiveRevision,
      );

      const [save] = await Promise.all([
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/arbiter/config/save',
        ),
        plugin.getByRole('button', { name: '保存并应用', exact: true }).click(),
      ]);
      expect(save.status()).toBe(200);
      expect(await save.json()).toMatchObject({ ok: true, effective: true });

      // The persisted route is the second provider, not the first one that
      // happens to advertise the same model id.
      await expect
        .poll(async () => (await readReviewerState(dsh)).config.reviewer)
        .toMatchObject({
          type: 'chat',
          chat: { provider: 'beta', model: 'shared-model' },
        });

      await page.reload();
      await openArbiterConfiguration(page);
      const reloaded = page.locator('[data-arbiter-root]');
      await reloaded
        .getByRole('button', { name: 'Reviewer', exact: true })
        .click();
      const reloadedSelect = reloaded.getByRole('combobox', {
        name: '模型',
        exact: true,
      });
      await expect(reloadedSelect).toHaveValue(
        JSON.stringify(['beta', 'shared-model']),
      );
      await expect(
        reloadedSelect.getByRole('option', {
          name: 'Beta provider / shared-model（Shared Model）',
          exact: true,
        }),
      ).toBeAttached();

      // The saved document holds a route, never a credential value.
      const state = await readReviewerState(dsh);
      expect(JSON.stringify(state)).not.toMatch(/apiKey|secret|sk-/u);
      expect(pageErrors).toEqual([]);
    },
  );
});

test.describe('reviewer directory without configured models', () => {
  test(
    'keeps following the session when the host advertises no models',
    { tag: '@smoke' },
    async ({ dshPage: page }) => {
      await openArbiterConfiguration(page);
      const plugin = page.locator('[data-arbiter-root]');
      await plugin
        .getByRole('button', { name: 'Reviewer', exact: true })
        .click();
      const select = plugin.getByRole('combobox', {
        name: '模型',
        exact: true,
      });
      await expect(select).toHaveValue('session');
      // An empty directory explains itself; it does not render a fake option or
      // an empty provider group the user could pick.
      await expect(
        plugin.getByText('宿主尚未配置任何模型；可保留「跟随会话模型」。'),
      ).toBeVisible();
      await expect(select.locator('optgroup')).toHaveCount(0);
      await expect(select).toHaveValue('session');
    },
  );
});
