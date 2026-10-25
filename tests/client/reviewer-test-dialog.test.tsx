import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, test } from 'vitest';

import { ArbiterPage } from '../../src/client/index.js';
import { setupApiMock } from '../helpers/api-mock.js';
import { effectiveState } from '../helpers/client-state.js';
import { renderClient } from '../helpers/render-client.js';

const server = setupApiMock();

const VALID_CHAT = JSON.stringify({
  risk: 1,
  authorized: 8,
  secrets: false,
  destructive: false,
  egress: false,
  bulk: false,
});

interface ProbeAttemptPayload {
  readonly attempt: number;
  readonly backend: string;
  readonly protocol: string;
  readonly durationMs: number;
  readonly request?: unknown;
  readonly responseText: string | null;
  readonly parsed: unknown;
  readonly error: string | null;
}

function attempt(overrides: Partial<ProbeAttemptPayload> = {}) {
  return {
    attempt: 1,
    backend: 'chat',
    protocol: 'arbiter-chat-json-v1',
    durationMs: 42,
    request: { provider: 'p', model: 'm', system: 'REVIEW_POLICY' },
    responseText: VALID_CHAT,
    parsed: { risk: 1 },
    error: null,
    ...overrides,
  };
}

function passedPayload(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    ok: true,
    probe: {
      status: 'passed',
      backend: 'chat',
      model: { provider: 'p', model: 'm' },
      protocol: 'arbiter-chat-json-v1',
      durationMs: 42,
      repairs: 0,
      signals: {},
      attempts: [attempt()],
      ...overrides,
    },
  };
}

function stateWithProvider(provider: string, model: string) {
  const state = effectiveState();
  return {
    ...state,
    config: {
      ...state.config,
      reviewer: {
        ...state.config.reviewer,
        chat: { ...state.config.reviewer.chat, provider, model },
      },
    },
  };
}

const CATALOG = {
  ok: true,
  supported: true,
  groups: [
    {
      id: 'p',
      name: 'Provider P',
      models: [{ id: 'm', name: 'Model M' }],
    },
  ],
  failures: [],
};

function baseHandlers(): void {
  server.use(
    http.get('*/api/arbiter/state', () =>
      HttpResponse.json(stateWithProvider('p', 'm')),
    ),
    http.get('*/api/arbiter/credentials', () =>
      HttpResponse.json({
        ok: true,
        state: 'unconfigured',
        ref: 'CLOUDFLARE_API_TOKEN',
        configured: false,
        source: null,
        supported: true,
      }),
    ),
    http.get('*/api/arbiter/models', () => HttpResponse.json(CATALOG)),
  );
}

async function openReviewer() {
  const view = renderClient(<ArbiterPage />);
  await view.user.click(
    await screen.findByRole('button', { name: 'Reviewer' }),
  );
  await screen.findByRole('heading', { name: 'Reviewer 类型' });
  return view.user;
}

function dialog(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Reviewer 连接测试' });
}

async function openTestDialog(
  user: ReturnType<typeof renderClient>['user'],
): Promise<void> {
  // The button opens the dialog; the run itself is a separate action so the
  // operator can read the cost notice first.
  await user.click(screen.getByRole('button', { name: '测试 Reviewer' }));
}

describe('reviewer connection test entry', () => {
  test('following the session disables the test with an explanation', async () => {
    const state = effectiveState();
    server.use(
      http.get('*/api/arbiter/state', () => HttpResponse.json(state)),
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
      http.get('*/api/arbiter/models', () => HttpResponse.json(CATALOG)),
    );
    await openReviewer();
    const button = screen.getByRole('button', { name: '测试 Reviewer' });
    expect(button).toBeDisabled();
    expect(
      screen.getByText('测试需要指定模型，请选择具体模型后测试。'),
    ).toBeInTheDocument();
  });

  test('a concrete model enables the test and shows the cost notice', async () => {
    baseHandlers();
    await openReviewer();
    const button = screen.getByRole('button', { name: '测试 Reviewer' });
    expect(button).toBeEnabled();
    expect(
      screen.getByText('测试会发送模型请求，可能产生费用。'),
    ).toBeInTheDocument();
  });
});

describe('reviewer connection test dialog', () => {
  test('runs the click-time draft and shows model, duration and attempts', async () => {
    baseHandlers();
    const bodies: unknown[] = [];
    server.use(
      http.post('*/api/arbiter/reviewer-test', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(passedPayload());
      }),
    );
    const user = await openReviewer();
    await openTestDialog(user);
    const panel = dialog();
    expect(within(panel).getByText(/尚未运行/)).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: '开始测试' }));
    expect(
      await within(panel).findByText('已通过：首次返回即符合输出契约。'),
    ).toBeInTheDocument();
    expect(within(panel).getByText('p / m')).toBeInTheDocument();
    expect(within(panel).getByText('42 ms')).toBeInTheDocument();
    expect(within(panel).getByText('arbiter-chat-json-v1')).toBeInTheDocument();
    // The dialog sends the draft, not an effective-config request.
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      draft: {
        reviewer: { type: 'chat', chat: { provider: 'p', model: 'm' } },
      },
    });
    // Model output is verbatim material, not translated copy.
    expect(within(panel).getByText(VALID_CHAT)).toBeInTheDocument();
  });

  test('a repaired pass reports both attempts and the repair count', async () => {
    baseHandlers();
    server.use(
      http.post('*/api/arbiter/reviewer-test', () =>
        HttpResponse.json(
          passedPayload({
            repairs: 1,
            attempts: [
              attempt({
                attempt: 1,
                responseText: 'not json',
                parsed: null,
                error: 'reviewer output is not valid JSON',
              }),
              attempt({ attempt: 2 }),
            ],
          }),
        ),
      ),
    );
    const user = await openReviewer();
    await openTestDialog(user);
    const panel = dialog();
    await user.click(within(panel).getByRole('button', { name: '开始测试' }));
    expect(
      await within(panel).findByText(
        '已通过：经过 1 次格式修复后符合输出契约。',
      ),
    ).toBeInTheDocument();
    expect(within(panel).getByText('第 1 次请求')).toBeInTheDocument();
    expect(within(panel).getByText('第 2 次请求')).toBeInTheDocument();
    expect(within(panel).getByText('not json')).toBeInTheDocument();
    expect(
      within(panel).getByText('reviewer output is not valid JSON'),
    ).toBeInTheDocument();
  });

  test('a failed probe shows the localized cause instead of approving', async () => {
    baseHandlers();
    server.use(
      http.post('*/api/arbiter/reviewer-test', () =>
        HttpResponse.json({
          ok: true,
          probe: {
            status: 'failed',
            backend: 'decision',
            model: { provider: 'decision', model: 'clef-flash' },
            protocol: 'arbiter-decision-v1',
            durationMs: 12,
            failure: 'unauthorized',
            attempts: [
              attempt({
                backend: 'decision',
                responseText: '',
                parsed: null,
                error: 'HTTP 401',
              }),
            ],
          },
        }),
      ),
    );
    const user = await openReviewer();
    await openTestDialog(user);
    const panel = dialog();
    await user.click(within(panel).getByRole('button', { name: '开始测试' }));
    expect(
      await within(panel).findByText('未通过：认证被拒绝（401／403）'),
    ).toBeInTheDocument();
    expect(within(panel).getByText('HTTP 401')).toBeInTheDocument();
    expect(within(panel).queryByText(/已通过/)).toBeNull();
  });

  test('a decoded failure code maps to its own sentence, not a generic one', async () => {
    baseHandlers();
    server.use(
      http.post('*/api/arbiter/reviewer-test', () =>
        HttpResponse.json({
          ok: true,
          probe: {
            status: 'failed',
            backend: 'chat',
            model: { provider: 'p', model: 'm' },
            protocol: 'arbiter-chat-json-v1',
            durationMs: 5,
            failure: 'rate-limited',
            attempts: [],
          },
        }),
      ),
    );
    const user = await openReviewer();
    await openTestDialog(user);
    const panel = dialog();
    await user.click(within(panel).getByRole('button', { name: '开始测试' }));
    expect(
      await within(panel).findByText('未通过：配额或限流（429）'),
    ).toBeInTheDocument();
    expect(document.body.textContent.includes('reviewer.')).toBe(false);
  });

  test('cancelling aborts the request and reports cancelled, not refused', async () => {
    baseHandlers();
    let aborted = false;
    server.use(
      http.post('*/api/arbiter/reviewer-test', async ({ request }) => {
        await new Promise<void>((resolve) => {
          request.signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        });
        return HttpResponse.json({
          ok: true,
          probe: {
            status: 'cancelled',
            backend: 'chat',
            model: { provider: 'p', model: 'm' },
            protocol: 'arbiter-chat-json-v1',
            durationMs: 3,
            failure: 'cancelled',
            attempts: [],
          },
        });
      }),
    );
    const user = await openReviewer();
    await openTestDialog(user);
    const panel = dialog();
    await user.click(within(panel).getByRole('button', { name: '开始测试' }));
    await within(panel).findByText(/正在请求/);
    await user.click(within(panel).getByRole('button', { name: '取消' }));
    await waitFor(() => {
      expect(aborted).toBe(true);
    });
    expect(within(panel).getByText('已取消。')).toBeInTheDocument();
  });

  test('closing discards the result and reopening starts idle', async () => {
    baseHandlers();
    server.use(
      http.post('*/api/arbiter/reviewer-test', () =>
        HttpResponse.json(passedPayload()),
      ),
    );
    const user = await openReviewer();
    await openTestDialog(user);
    let panel = dialog();
    await user.click(within(panel).getByRole('button', { name: '开始测试' }));
    await within(panel).findByText('已通过：首次返回即符合输出契约。');
    await user.click(within(panel).getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // No summary survives on the panel itself.
    expect(screen.queryByText(/已通过：首次/)).toBeNull();
    await openTestDialog(user);
    panel = dialog();
    expect(within(panel).getByText(/尚未运行/)).toBeInTheDocument();
  });

  test('a transport error is reported without any result material', async () => {
    baseHandlers();
    server.use(
      http.post('*/api/arbiter/reviewer-test', () =>
        HttpResponse.json(
          { ok: false, code: 'draft-invalid' },
          { status: 422 },
        ),
      ),
    );
    const user = await openReviewer();
    await openTestDialog(user);
    const panel = dialog();
    await user.click(within(panel).getByRole('button', { name: '开始测试' }));
    expect(await within(panel).findByText(/请求失败：/)).toBeInTheDocument();
    expect(within(panel).queryByText(/已通过/)).toBeNull();
  });
});

describe('reviewer connection test localization', () => {
  test('an English host falls back to Chinese per key without bare keys', async () => {
    baseHandlers();
    server.use(
      http.post('*/api/arbiter/reviewer-test', () =>
        HttpResponse.json(passedPayload()),
      ),
    );
    const view = renderClient(<ArbiterPage />, { locale: 'en' });
    await view.user.click(
      await screen.findByRole('button', { name: 'Reviewer' }),
    );
    await screen.findByRole('heading', { name: 'Reviewer 类型' });
    expect(screen.getByRole('button', { name: '测试 Reviewer' })).toBeVisible();
    expect(
      screen.getByText('测试会发送模型请求，可能产生费用。'),
    ).toBeVisible();
    await openTestDialog(view.user);
    const panel = dialog();
    expect(within(panel).getByText('Reviewer 连接测试')).toBeVisible();
    expect(
      within(panel).getByRole('button', { name: '开始测试' }),
    ).toBeVisible();
    expect(within(panel).getByText(/尚未运行/)).toBeVisible();
    const text = document.body.textContent;
    expect(text).not.toContain('reviewer.');
    expect(text).not.toContain('undefined');
  });

  test('per-key fallback holds for interpolated status text', async () => {
    baseHandlers();
    const user = await openReviewer();
    // The running sentence interpolates the route; a missing translation must
    // still render a sentence with the parameter rather than a bare key.
    server.use(
      http.post('*/api/arbiter/reviewer-test', async () => {
        await Promise.resolve();
        return HttpResponse.json(passedPayload());
      }),
    );
    await openTestDialog(user);
    const panel = dialog();
    await user.click(within(panel).getByRole('button', { name: '开始测试' }));
    await waitFor(() => {
      expect(within(panel).queryByText(/reviewer\.test\./)).toBeNull();
    });
  });
});
