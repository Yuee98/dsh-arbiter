import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { parseConfig } from '../../src/config.js';
import { isRecord } from '../../src/config/values.js';
import { ArbiterPage } from '../../src/client/index.js';
import { setupApiMock } from '../helpers/api-mock.js';
import { effectiveState } from '../helpers/client-state.js';
import { renderClient } from '../helpers/render-client.js';

const server = setupApiMock();

function configBoundary(target: number | undefined, hard = 10000) {
  const base = effectiveState();
  const { targetInputTokens: _target, ...context } = base.config.context;
  let config: unknown = {
    ...base.config,
    context: {
      ...context,
      maxInputTokens: hard,
      ...(target === undefined ? {} : { targetInputTokens: target }),
    },
  };
  const requests: {
    readonly kind: string;
    readonly body: unknown;
    readonly errors: readonly unknown[];
  }[] = [];
  let saves = 0;
  server.use(
    http.get('*/api/arbiter/state', () =>
      HttpResponse.json({ ...base, config }),
    ),
    http.post('*/api/arbiter/validate', async ({ request }) => {
      const body: unknown = await request.json();
      const parsed = parseConfig(isRecord(body) ? body['config'] : body);
      requests.push({ kind: 'validate', body, errors: parsed.errors });
      return HttpResponse.json({
        ok: parsed.errors.length === 0,
        errors: parsed.errors,
        warnings: parsed.warnings,
      });
    }),
    http.post('*/api/arbiter/config/save', async ({ request }) => {
      const body: unknown = await request.json();
      const parsed = parseConfig(isRecord(body) ? body['config'] : body);
      requests.push({ kind: 'save', body, errors: parsed.errors });
      if (parsed.errors.length > 0)
        return HttpResponse.json(
          {
            ok: false,
            code: 'config-invalid',
            errors: parsed.errors,
            warnings: parsed.warnings,
          },
          { status: 422 },
        );
      config = parsed.config;
      saves += 1;
      return HttpResponse.json({
        ok: true,
        saved: true,
        changed: true,
        effective: true,
        effectiveRevision: `effective-${String(saves + 1)}`,
        configSnapshotId: `snapshot-${String(saves + 1)}`,
        activationRecorded: true,
        configFormat: 'arbiter-config-v3',
        configFormatExplicit: false,
        auditError: null,
        warnings: parsed.warnings,
      });
    }),
  );
  return { requests };
}

test.each([
  { target: 6000, hard: 10000, edited: '5000', expected: 5000 },
  { target: 8000, hard: 10000, edited: '7500', expected: 7500 },
  { target: undefined, hard: 4000, edited: '2000', expected: 2000 },
  { target: 6000, hard: 10000, edited: '1', expected: 1 },
  { target: 6000, hard: 10000, edited: '6000', expected: 6000 },
  { target: 3000, hard: 10000, edited: '5000', expected: 3000 },
  { target: 6000, hard: 10000, edited: '20000', expected: 6000 },
])(
  'the existing H editor saves and reloads a valid pair for T=$target H=$edited',
  async ({ target, hard, edited, expected }) => {
    const boundary = configBoundary(target, hard);
    const { user } = renderClient(<ArbiterPage />);
    await user.click(await screen.findByRole('button', { name: '策略与高级' }));
    const input = screen.getByRole('spinbutton', { name: '最大输入 tokens' });
    await user.clear(input);
    await user.type(input, edited);
    // A real click commits the focused editor and submits through page.tsx.
    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    await waitFor(() => {
      expect(boundary.requests).toHaveLength(1);
    });
    expect(boundary.requests[0]).toMatchObject({
      kind: 'save',
      body: {
        config: {
          context: {
            targetInputTokens: expected,
            maxInputTokens: Number(edited),
          },
        },
      },
      errors: [],
    });
    expect(await screen.findByText('已保存并生效。')).toBeVisible();
    expect(
      screen.getByRole('spinbutton', { name: '最大输入 tokens' }),
    ).toHaveValue(Number(edited));
  },
);

test('validation and save use the final typed H, and a later increase preserves the saved target', async () => {
  const boundary = configBoundary(6000);
  const { user } = renderClient(<ArbiterPage />);
  await user.click(await screen.findByRole('button', { name: '策略与高级' }));
  const input = screen.getByRole('spinbutton', { name: '最大输入 tokens' });
  await user.clear(input);
  await user.type(input, '5000');
  await user.click(screen.getByRole('button', { name: '校验草稿' }));
  await waitFor(() => {
    expect(boundary.requests).toHaveLength(1);
  });
  expect(boundary.requests[0]).toMatchObject({
    kind: 'validate',
    body: {
      config: { context: { targetInputTokens: 5000, maxInputTokens: 5000 } },
    },
    errors: [],
  });
  await user.click(screen.getByRole('button', { name: '保存并应用' }));
  expect(await screen.findByText('已保存并生效。')).toBeVisible();
  await user.clear(input);
  await user.type(input, '8000');
  await user.click(screen.getByRole('button', { name: '保存并应用' }));
  await waitFor(() => {
    expect(boundary.requests).toHaveLength(3);
  });
  expect(boundary.requests[2]).toMatchObject({
    kind: 'save',
    body: {
      config: { context: { targetInputTokens: 5000, maxInputTokens: 8000 } },
    },
    errors: [],
  });
});

test.each(['0', '-2', '1.5', '9007199254740992'])(
  'invalid H=%s still reaches production validation and keeps the target intact',
  async (edited) => {
    const boundary = configBoundary(6000);
    const { user } = renderClient(<ArbiterPage />);
    await user.click(await screen.findByRole('button', { name: '策略与高级' }));
    const input = screen.getByRole('spinbutton', { name: '最大输入 tokens' });
    await user.clear(input);
    await user.type(input, edited);
    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    await waitFor(() => {
      expect(boundary.requests).toHaveLength(1);
    });
    expect(boundary.requests[0]?.body).toMatchObject({
      config: {
        context: { targetInputTokens: 6000, maxInputTokens: Number(edited) },
      },
    });
    expect(boundary.requests[0]?.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'context.maxInputTokens' }),
      ]),
    );
    expect(await screen.findByTestId('arbiter-save-status')).toHaveTextContent(
      '保存或应用失败；当前生效配置未改变。',
    );
  },
);
