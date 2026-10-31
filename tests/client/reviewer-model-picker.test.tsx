import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, test } from 'vitest';

import { ArbiterPage } from '../../src/client/index.js';
import { createLocaleCatalogs } from '../../src/client/i18n/catalog.js';
import { setupApiMock } from '../helpers/api-mock.js';
import { effectiveState } from '../helpers/client-state.js';
import { renderClient } from '../helpers/render-client.js';

const server = setupApiMock();

interface CatalogModel {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

interface CatalogGroup {
  readonly id: string;
  readonly name: string;
  readonly models: readonly CatalogModel[];
}

/**
 * Two routes that look alike on purpose.
 *
 * `shared-model` appears under both providers with the same display name, which
 * is the case a single flat list would silently merge.
 */
const CATALOG: readonly CatalogGroup[] = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    ],
  },
  {
    id: 'gateway',
    name: 'Internal gateway',
    models: [{ id: 'shared-model', name: 'Same display name' }],
  },
  {
    id: 'mirror',
    name: 'Mirror gateway',
    models: [{ id: 'shared-model', name: 'Same display name' }],
  },
];

const MODEL_REQUESTS = ['/api/arbiter/test', '/api/arbiter/review'];

function catalogHandler(groups: readonly CatalogGroup[] = CATALOG) {
  return http.get('*/api/arbiter/models', () =>
    HttpResponse.json({
      ok: true,
      supported: true,
      groups,
      failures: [],
    }),
  );
}

function credentialsHandler(configured = false) {
  return http.get('*/api/arbiter/credentials', () =>
    HttpResponse.json({
      ok: true,
      state: configured ? 'configured' : 'unconfigured',
      ref: 'CLOUDFLARE_API_TOKEN',
      configured,
      source: configured ? 'file' : null,
      supported: true,
    }),
  );
}

function modelRequests(requests: readonly string[]): readonly string[] {
  return requests.filter((path) => MODEL_REQUESTS.includes(path));
}

/**
 * Open the Reviewer tab under one host language.
 *
 * `en` is a declared catalog since #23, so the heading is English there; an
 * undeclared language keeps the Chinese fallback. The host's own tab label is
 * `Reviewer` in both, which is why the helper can wait for it either way.
 */
async function openReviewer(locale?: string) {
  const view = renderClient(<ArbiterPage />, {
    ...(locale === undefined ? {} : { locale }),
  });
  await view.user.click(
    await screen.findByRole('button', { name: 'Reviewer' }),
  );
  await screen.findByRole('heading', {
    name: locale === 'en' ? 'Reviewer type' : 'Reviewer 类型',
  });
  return Object.assign(view.user, { i18n: view.i18n, locale: view.locale });
}

function modelSelect(): HTMLElement {
  return screen.getByRole('combobox', { name: '模型' });
}

describe('reviewer chat model selection', () => {
  test('offers the session route plus provider-grouped host models', async () => {
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      credentialsHandler(),
      catalogHandler(),
    );
    await openReviewer();
    const select = modelSelect();
    await waitFor(() => {
      expect(
        within(select).getByRole('option', { name: '跟随会话模型' }),
      ).toBeInTheDocument();
    });
    expect(select).toHaveValue('session');
    const groupsInSelect = within(select).getAllByRole('group');
    expect(groupsInSelect.map((group) => group.getAttribute('label'))).toEqual([
      'DeepSeek',
      'Internal gateway',
      'Mirror gateway',
    ]);
    expect(
      within(select).getByRole('option', {
        name: 'DeepSeek / deepseek-flash（DeepSeek-V4.1-Flash）',
      }),
    ).toBeInTheDocument();
  });

  test('selecting a concrete model writes provider and model into the draft', async () => {
    const saved: unknown[] = [];
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      credentialsHandler(),
      catalogHandler(),
      http.post('*/api/arbiter/config/save', async ({ request }) => {
        saved.push(await request.json());
        return HttpResponse.json({
          ok: true,
          saved: true,
          changed: true,
          effective: true,
          effectiveRevision: 'effective-2',
          configSnapshotId: 'snapshot-2',
          activationRecorded: true,
          configFormat: 'arbiter-config-v3',
          configFormatExplicit: false,
          auditError: null,
          warnings: [],
        });
      }),
    );
    const user = await openReviewer();
    const select = modelSelect();
    await within(select).findByRole('option', {
      name: 'DeepSeek / deepseek-v4-pro（DeepSeek-V4-Pro）',
    });
    await user.selectOptions(select, '["deepseek-official","deepseek-v4-pro"]');
    expect(select).toHaveValue('["deepseek-official","deepseek-v4-pro"]');
    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]).toMatchObject({
      config: {
        reviewer: {
          type: 'chat',
          chat: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
        },
      },
    });
  });

  test('the same model id under two providers stays distinguishable', async () => {
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      credentialsHandler(),
      catalogHandler(),
    );
    const user = await openReviewer();
    const select = modelSelect();
    const gatewayOption = await within(select).findByRole('option', {
      name: 'Internal gateway / shared-model（Same display name）',
    });
    const mirrorOption = within(select).getByRole('option', {
      name: 'Mirror gateway / shared-model（Same display name）',
    });
    expect(gatewayOption).not.toBe(mirrorOption);
    await user.selectOptions(select, '["mirror","shared-model"]');
    expect(select).toHaveValue('["mirror","shared-model"]');
    // The other provider's identical name is not what got selected.
    expect(select).not.toHaveValue('["gateway","shared-model"]');
  });

  test('search filters the catalog and clearing it restores every route', async () => {
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      credentialsHandler(),
      catalogHandler(),
    );
    const user = await openReviewer();
    const select = modelSelect();
    await within(select).findByRole('option', {
      name: 'Internal gateway / shared-model（Same display name）',
    });
    const search = screen.getByRole('searchbox', { name: '搜索模型' });
    await user.type(search, 'mirror');
    expect(
      within(select)
        .getAllByRole('group')
        .map((group) => group.getAttribute('label')),
    ).toEqual(['Mirror gateway']);
    await user.clear(search);
    await user.type(search, 'v4-pro');
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      '跟随会话模型',
      'DeepSeek / deepseek-v4-pro（DeepSeek-V4-Pro）',
    ]);
    await user.clear(search);
    expect(within(select).getAllByRole('group')).toHaveLength(3);
  });

  test('a search that hides the draft route keeps it selected and unchanged', async () => {
    const saved: unknown[] = [];
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      credentialsHandler(),
      catalogHandler(),
      http.post('*/api/arbiter/config/save', async ({ request }) => {
        saved.push(await request.json());
        return HttpResponse.json({
          ok: true,
          saved: true,
          changed: true,
          effective: true,
          effectiveRevision: 'effective-2',
          configSnapshotId: 'snapshot-2',
          activationRecorded: true,
          configFormat: 'arbiter-config-v3',
          configFormatExplicit: false,
          auditError: null,
          warnings: [],
        });
      }),
    );
    const user = await openReviewer();
    const select = modelSelect();
    await within(select).findByRole('option', {
      name: 'DeepSeek / deepseek-flash（DeepSeek-V4.1-Flash）',
    });
    await user.selectOptions(select, '["deepseek-official","deepseek-flash"]');
    const search = screen.getByRole('searchbox', { name: '搜索模型' });
    // This query matches only providers that do not own the draft route.
    await user.type(search, 'mirror');
    expect(select).toHaveValue('["deepseek-official","deepseek-flash"]');
    expect(
      screen.getByText(
        '当前选择被搜索条件隐藏，仍保持原 provider / model 不变。',
      ),
    ).toBeInTheDocument();
    expect(within(select).getAllByRole('group')).toHaveLength(1);
    expect(
      within(select).getByRole('option', {
        name: 'DeepSeek / deepseek-flash（DeepSeek-V4.1-Flash）',
      }),
    ).toBeInTheDocument();
    // Clearing the search restores the groups without touching the draft.
    await user.clear(search);
    expect(within(select).getAllByRole('group')).toHaveLength(3);
    expect(select).toHaveValue('["deepseek-official","deepseek-flash"]');
    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    // The saved route is the one the user picked before searching, not the
    // first option the filtered control happened to render.
    expect(saved[0]).toMatchObject({
      config: {
        reviewer: {
          chat: { provider: 'deepseek-official', model: 'deepseek-flash' },
        },
      },
    });
  });

  test('an empty but successful catalog keeps a configured concrete route', async () => {
    const state = effectiveState();
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json({
          ...state,
          config: {
            ...state.config,
            reviewer: {
              ...state.config.reviewer,
              chat: {
                ...state.config.reviewer.chat,
                provider: 'gateway',
                model: 'shared-model',
              },
            },
          },
        }),
      ),
      credentialsHandler(),
      http.get('*/api/arbiter/models', () =>
        HttpResponse.json({
          ok: true,
          supported: true,
          groups: [],
          failures: [],
        }),
      ),
    );
    await openReviewer();
    await waitFor(() => {
      expect(
        screen.getByText('宿主尚未配置任何模型；可保留「跟随会话模型」。'),
      ).toBeInTheDocument();
    });
    const select = modelSelect();
    expect(select).toHaveValue('["gateway","shared-model"]');
    expect(
      within(select).getByRole('option', {
        name: 'gateway / shared-model（不在当前目录）',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        '当前选择不在宿主目录中，仍按已保存的 provider / model 使用。',
      ),
    ).toBeInTheDocument();
  });

  test('switching from a concrete model back to the session route persists it', async () => {
    const saved: unknown[] = [];
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      credentialsHandler(),
      catalogHandler(),
      http.post('*/api/arbiter/config/save', async ({ request }) => {
        saved.push(await request.json());
        return HttpResponse.json({
          ok: true,
          saved: true,
          changed: true,
          effective: true,
          effectiveRevision: 'effective-2',
          configSnapshotId: 'snapshot-2',
          activationRecorded: true,
          configFormat: 'arbiter-config-v3',
          configFormatExplicit: false,
          auditError: null,
          warnings: [],
        });
      }),
    );
    const user = await openReviewer();
    const select = modelSelect();
    await within(select).findByRole('option', {
      name: 'DeepSeek / deepseek-flash（DeepSeek-V4.1-Flash）',
    });
    await user.selectOptions(select, '["deepseek-official","deepseek-flash"]');
    expect(select).toHaveValue('["deepseek-official","deepseek-flash"]');
    // The session route is not a catalog entry; choosing it must still reach
    // the draft instead of being silently ignored.
    await user.selectOptions(select, 'session');
    expect(select).toHaveValue('session');
    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]).toMatchObject({
      config: {
        reviewer: {
          type: 'chat',
          chat: { provider: 'session', model: '' },
        },
      },
    });
  });

  test('two providers with the same display name are told apart by id', async () => {
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      credentialsHandler(),
      catalogHandler([
        {
          id: 'alpha',
          name: 'DeepSeek',
          models: [{ id: 'shared-model', name: 'Shared Model' }],
        },
        {
          id: 'beta',
          name: 'DeepSeek',
          models: [{ id: 'shared-model', name: 'Shared Model' }],
        },
      ]),
    );
    const user = await openReviewer();
    const select = modelSelect();
    const alpha = await within(select).findByRole('option', {
      name: 'DeepSeek（alpha） / shared-model（Shared Model）',
    });
    const beta = within(select).getByRole('option', {
      name: 'DeepSeek（beta） / shared-model（Shared Model）',
    });
    expect(alpha).not.toBe(beta);
    expect(
      within(select)
        .getAllByRole('group')
        .map((group) => group.getAttribute('label')),
    ).toEqual(['DeepSeek（alpha）', 'DeepSeek（beta）']);
    await user.selectOptions(select, '["beta","shared-model"]');
    expect(select).toHaveValue('["beta","shared-model"]');
  });

  test('a whole-directory failure over HTTP 200 reads as a failed load', async () => {
    const state = effectiveState();
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json({
          ...state,
          config: {
            ...state.config,
            reviewer: {
              ...state.config.reviewer,
              chat: {
                ...state.config.reviewer.chat,
                provider: 'gateway',
                model: 'shared-model',
              },
            },
          },
        }),
      ),
      credentialsHandler(),
      // The production shape for a whole-directory failure: HTTP 200, ok:false.
      http.get('*/api/arbiter/models', () =>
        HttpResponse.json({
          ok: false,
          code: 'catalog-unavailable',
          supported: true,
          groups: [],
          failures: [],
        }),
      ),
    );
    await openReviewer();
    expect(
      await screen.findByText(
        '模型目录读取失败，保留当前已保存的选择；保存不受影响。',
      ),
    ).toBeInTheDocument();
    // A whole-directory failure must not read as "no models configured".
    expect(
      screen.queryByText('宿主尚未配置任何模型；可保留「跟随会话模型」。'),
    ).toBeNull();
    const select = modelSelect();
    expect(select).toHaveValue('["gateway","shared-model"]');
    expect(within(select).getAllByRole('option')).toHaveLength(2);
  });

  test('a failed catalog keeps the configured route and fabricates no options', async () => {
    const state = effectiveState();
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json({
          ...state,
          config: {
            ...state.config,
            reviewer: {
              ...state.config.reviewer,
              chat: {
                ...state.config.reviewer.chat,
                provider: 'deepseek-official',
                model: 'deepseek-v4-pro',
              },
            },
          },
        }),
      ),
      credentialsHandler(),
      http.get('*/api/arbiter/models', () =>
        HttpResponse.json(
          { ok: false, code: 'catalog-unavailable', message: 'boom' },
          { status: 500 },
        ),
      ),
    );
    await openReviewer();
    expect(
      await screen.findByText(
        '模型目录读取失败，保留当前已保存的选择；保存不受影响。',
      ),
    ).toBeInTheDocument();
    const select = modelSelect();
    // The saved route is still the selected value, not the session default and
    // not a fabricated catalog entry.
    expect(select).toHaveValue('["deepseek-official","deepseek-v4-pro"]');
    expect(
      within(select).getByRole('option', {
        name: 'deepseek-official / deepseek-v4-pro（不在当前目录）',
      }),
    ).toBeInTheDocument();
    expect(within(select).getAllByRole('option')).toHaveLength(2);
  });

  test('an empty catalog explains itself and keeps the session route usable', async () => {
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      credentialsHandler(),
      http.get('*/api/arbiter/models', () =>
        HttpResponse.json({
          ok: true,
          supported: true,
          groups: [],
          failures: [
            {
              id: 'deepseek-official',
              name: 'DeepSeek',
              code: 'provider-catalog-failed',
            },
          ],
        }),
      ),
    );
    await openReviewer();
    await waitFor(() => {
      expect(
        screen.getByText('宿主尚未配置任何模型；可保留「跟随会话模型」。'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText('DeepSeek 的模型列表读取失败。'),
    ).toBeInTheDocument();
    expect(modelSelect()).toHaveValue('session');
  });

  test('a missing LLM service is reported instead of looking like an empty list', async () => {
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      credentialsHandler(),
      http.get('*/api/arbiter/models', () =>
        HttpResponse.json({
          ok: true,
          supported: false,
          groups: [],
          failures: [],
        }),
      ),
    );
    await openReviewer();
    expect(
      await screen.findByText(
        '当前 composition 没有 LLM 服务，无法列出宿主模型。',
      ),
    ).toBeInTheDocument();
  });
});

describe('reviewer draft and save semantics', () => {
  test('the chosen model survives a tab round trip and is the value that is saved', async () => {
    const saved: unknown[] = [];
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      credentialsHandler(),
      catalogHandler(),
      http.post('*/api/arbiter/config/save', async ({ request }) => {
        saved.push(await request.json());
        return HttpResponse.json({
          ok: true,
          saved: true,
          changed: true,
          effective: true,
          effectiveRevision: 'effective-2',
          configSnapshotId: 'snapshot-2',
          activationRecorded: true,
          configFormat: 'arbiter-config-v3',
          configFormatExplicit: false,
          auditError: null,
          warnings: [],
        });
      }),
    );
    const user = await openReviewer();
    const select = modelSelect();
    await within(select).findByRole('option', {
      name: 'DeepSeek / deepseek-flash（DeepSeek-V4.1-Flash）',
    });
    await user.selectOptions(select, '["deepseek-official","deepseek-flash"]');
    await user.click(screen.getByRole('button', { name: '状态与模式' }));
    await screen.findByRole('heading', { name: '启用与审批模式' });
    await user.click(screen.getByRole('button', { name: 'Reviewer' }));
    expect(modelSelect()).toHaveValue('["deepseek-official","deepseek-flash"]');
    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]).toMatchObject({
      config: {
        reviewer: {
          chat: { provider: 'deepseek-official', model: 'deepseek-flash' },
        },
      },
    });
  });

  test('saving never issues a model or connection-test request', async () => {
    const requests: string[] = [];
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      credentialsHandler(),
      catalogHandler(),
      http.post('*/api/arbiter/config/save', async ({ request }) => {
        requests.push('/api/arbiter/config/save');
        await request.json();
        return HttpResponse.json({
          ok: true,
          saved: true,
          changed: true,
          effective: true,
          effectiveRevision: 'effective-2',
          configSnapshotId: 'snapshot-2',
          activationRecorded: true,
          configFormat: 'arbiter-config-v3',
          configFormatExplicit: false,
          auditError: null,
          warnings: [],
        });
      }),
      // Any model or test request would be recorded here instead of failing the
      // unhandled-frame guard, so the assertion names the real culprit.
      http.post('*/api/arbiter/test', () => {
        requests.push('/api/arbiter/test');
        return HttpResponse.json({ ok: true, results: [] });
      }),
      http.post('*/api/arbiter/review', () => {
        requests.push('/api/arbiter/review');
        return HttpResponse.json({ ok: true });
      }),
    );
    const user = await openReviewer();
    const select = modelSelect();
    await within(select).findByRole('option', {
      name: 'DeepSeek / deepseek-v4-pro（DeepSeek-V4-Pro）',
    });
    await user.selectOptions(select, '["deepseek-official","deepseek-v4-pro"]');
    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    await waitFor(() => {
      expect(requests).toContain('/api/arbiter/config/save');
    });
    expect(modelRequests(requests)).toEqual([]);
  });

  test('editing the draft alone changes nothing that is already effective', async () => {
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      credentialsHandler(),
      catalogHandler(),
    );
    const user = await openReviewer();
    const select = modelSelect();
    await within(select).findByRole('option', {
      name: 'DeepSeek / deepseek-v4-pro（DeepSeek-V4-Pro）',
    });
    await user.selectOptions(select, '["deepseek-official","deepseek-v4-pro"]');
    expect(screen.getByTestId('arbiter-save-status')).toHaveTextContent(
      '草稿未保存；当前生效配置未改变。',
    );
  });
});

describe('reviewer decision fields', () => {
  test('decision keeps manual URL, model and reference with status-only credentials', async () => {
    const asked: string[] = [];
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      catalogHandler(),
      http.get('*/api/arbiter/credentials', ({ request }) => {
        const ref = new URL(request.url).searchParams.get('ref') ?? '';
        asked.push(ref);
        return HttpResponse.json({
          ok: true,
          state: ref === 'MY_GATEWAY_KEY' ? 'configured' : 'unconfigured',
          ref,
          configured: ref === 'MY_GATEWAY_KEY',
          source: ref === 'MY_GATEWAY_KEY' ? 'file' : null,
          supported: true,
        });
      }),
    );
    const user = await openReviewer();
    await user.click(screen.getByRole('radio', { name: 'decision（分布）' }));
    const url = screen.getByLabelText('URL');
    await user.clear(url);
    await user.type(url, 'https://review.example.test/v1');
    const model = screen.getByLabelText('model');
    await user.clear(model);
    await user.type(model, 'custom-model');
    const reference = screen.getByLabelText('凭据引用 (apiKeyRef)', {
      exact: false,
    });
    await user.clear(reference);
    await user.type(reference, 'MY_GATEWAY_KEY');
    // The status follows the draft reference without a save.
    await waitFor(() => {
      expect(asked).toContain('MY_GATEWAY_KEY');
    });
    expect(await screen.findByText('已设置（来源 file）')).toBeInTheDocument();
    expect(
      screen.getByText('这里只存引用名，不存密钥值。'),
    ).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/sk-/)).toBeNull();
  });

  test('advanced parameters are behind one disclosure', async () => {
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      credentialsHandler(),
      catalogHandler(),
    );
    await openReviewer();
    expect(screen.getByText('高级参数')).toBeInTheDocument();
    expect(screen.getByLabelText('temperature')).toBeInTheDocument();
    expect(screen.getByLabelText('maxTokens')).toBeInTheDocument();
    expect(
      screen.getByLabelText('修复重试次数', { exact: false }),
    ).toBeInTheDocument();
  });

  test('the token control accepts the parser range, not the old ceiling', async () => {
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      credentialsHandler(),
      catalogHandler(),
    );
    await openReviewer();
    // Thinking and the answer share one output budget, so the shipped default
    // is 10,000. A control capped at 4,000 would reject its own default.
    const maxTokens = screen.getByLabelText('maxTokens');
    expect(maxTokens).toHaveAttribute('max', '32000');
    expect(maxTokens).toHaveAttribute('min', '16');
  });
});

describe('reviewer credential status outcomes', () => {
  async function openDecision() {
    const user = await openReviewer();
    await user.click(screen.getByRole('radio', { name: 'decision（分布）' }));
    return user;
  }

  test('an unavailable status is never rendered as unset', async () => {
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      catalogHandler(),
      http.get('*/api/arbiter/credentials', () =>
        HttpResponse.json({
          ok: false,
          state: 'unavailable',
          code: 'credentials-unavailable',
          ref: 'CLOUDFLARE_API_TOKEN',
          configured: false,
          source: null,
          supported: true,
        }),
      ),
    );
    await openDecision();
    expect(await screen.findByText('无法读取凭据状态')).toBeInTheDocument();
    expect(screen.queryByText('未设置')).toBeNull();
  });

  test('an unsupported composition says so instead of reporting unset', async () => {
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      catalogHandler(),
      http.get('*/api/arbiter/credentials', () =>
        HttpResponse.json({
          ok: true,
          state: 'unsupported',
          ref: 'CLOUDFLARE_API_TOKEN',
          configured: false,
          source: null,
          supported: false,
        }),
      ),
    );
    await openDecision();
    expect(
      await screen.findByText('当前 composition 没有 credentials 服务'),
    ).toBeInTheDocument();
    expect(screen.queryByText('未设置')).toBeNull();
  });

  test('a failed query reports unknown rather than unset', async () => {
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      catalogHandler(),
      http.get('*/api/arbiter/credentials', () =>
        HttpResponse.json({ ok: false, message: 'boom' }, { status: 500 }),
      ),
    );
    await openDecision();
    expect(await screen.findByText('无法读取凭据状态')).toBeInTheDocument();
    expect(screen.queryByText('未设置')).toBeNull();
  });

  test('a stale response for a previous reference never replaces the current status', async () => {
    const pending: { ref: string; release: () => void }[] = [];
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      catalogHandler(),
      http.get('*/api/arbiter/credentials', async ({ request }) => {
        const ref = new URL(request.url).searchParams.get('ref') ?? '';
        await new Promise<void>((resolve) => {
          pending.push({ ref, release: resolve });
        });
        return HttpResponse.json({
          ok: true,
          state: ref === 'SECOND_KEY' ? 'configured' : 'unconfigured',
          ref,
          configured: ref === 'SECOND_KEY',
          source: ref === 'SECOND_KEY' ? 'file' : null,
          supported: true,
        });
      }),
    );
    const user = await openDecision();
    const reference = screen.getByLabelText('凭据引用 (apiKeyRef)', {
      exact: false,
    });
    await waitFor(() => {
      expect(pending.length).toBeGreaterThan(0);
    });
    await user.clear(reference);
    await user.type(reference, 'SECOND_KEY');
    await waitFor(() => {
      expect(pending.some((entry) => entry.ref === 'SECOND_KEY')).toBe(true);
    });
    // Answer the newest query first, then the stale one.
    for (const entry of [...pending].reverse()) entry.release();
    await waitFor(() => {
      expect(screen.getByText('已设置（来源 file）')).toBeInTheDocument();
    });
    expect(screen.queryByText('未设置')).toBeNull();
  });
});

describe('reviewer localization', () => {
  test('an English host renders the released translation without bare keys', async () => {
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
      credentialsHandler(),
      catalogHandler(),
    );
    const user = await openReviewer('en');
    // Since #23 reviewer is a declared English translation rather than a gap.
    expect(
      screen.getByRole('searchbox', { name: 'Search models' }),
    ).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeVisible();
    expect(screen.getByText('Advanced parameters')).toBeVisible();
    expect(screen.getByText('Follow the session model')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Choosing "follow the session model" uses the model of the session that made this call; the concrete model is still saved as provider / model.',
      ),
    ).toBeVisible();
    const text = document.body.textContent;
    expect(text).not.toContain('reviewer.');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('[object');
    expect(
      screen.getByRole('heading', { name: 'Reviewer type' }).textContent,
    ).toBe('Reviewer type');
    // An interpolated message keeps its parameter and never leaks the key.
    expect(
      user.i18n.translate('reviewer.model.providerFailed', { provider: 'X' }),
    ).toBe('Reading the model list for X failed.');

    // Switching back to Chinese retranslates the same mounted panel in place.
    act(() => {
      user.locale.setLocale('zh');
    });
    expect(screen.getByText('跟随会话模型')).toBeInTheDocument();
    expect(
      user.i18n.translate('reviewer.model.providerFailed', { provider: 'X' }),
    ).toBe('X 的模型列表读取失败。');
  });

  test('an incomplete catalog falls back per key, not per file', () => {
    // The per-key fallback is a catalog property, not a component one: a
    // partially translated module keeps its translated leaves and borrows the
    // rest from Chinese. Exercised directly so completing English cannot make
    // the rule untestable.
    const catalogs = createLocaleCatalogs({
      zh: {
        reviewer: {
          advanced: { title: '高级参数' },
          model: {
            session: '跟随会话模型',
            unlisted: '{provider} / {model}（不在当前目录）',
          },
        },
      },
      en: {
        reviewer: {
          advanced: { title: 'Advanced parameters' },
          model: { session: 'Follow the session model' },
        },
      },
    });
    expect(catalogs['en']).toEqual({
      'reviewer.advanced.title': 'Advanced parameters',
      'reviewer.model.session': 'Follow the session model',
      'reviewer.model.unlisted': '{provider} / {model}（不在当前目录）',
    });
  });
});
