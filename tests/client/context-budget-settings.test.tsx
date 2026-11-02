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
  return { requests, current: () => parseConfig(config).config.context };
}

const TARGET = '常态输入目标 T（估算 tokens）';
const HARD = '输入硬上限 H（估算 tokens）';

async function openBudget(target?: number, hard = 10000) {
  const boundary = configBoundary(target, hard);
  const { user } = renderClient(<ArbiterPage />);
  await user.click(await screen.findByRole('button', { name: '策略与高级' }));
  return { boundary, user };
}

test.each([
  { target: 6000, hard: 10000 },
  { target: 2500, hard: 7000 },
  { target: undefined, hard: 4000 },
])('reads explicit and legacy T=$target H=$hard', async ({ target, hard }) => {
  await openBudget(target, hard);
  expect(screen.getByRole('spinbutton', { name: TARGET })).toHaveValue(
    target ?? Math.min(6000, hard),
  );
  expect(screen.getByRole('spinbutton', { name: HARD })).toHaveValue(hard);
});

test.each(['target-first', 'hard-first'])(
  'saves and reloads explicit T/H in %s edit order',
  async (order) => {
    const { boundary, user } = await openBudget();
    const target = screen.getByRole('spinbutton', { name: TARGET });
    const hard = screen.getByRole('spinbutton', { name: HARD });
    for (const input of order === 'target-first'
      ? [target, hard]
      : [hard, target]) {
      await user.clear(input);
      await user.type(input, '4000');
    }
    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    expect(await screen.findByText('已保存并生效。')).toBeVisible();
    expect(boundary.requests[0]).toMatchObject({
      kind: 'save',
      body: {
        config: { context: { targetInputTokens: 4000, maxInputTokens: 4000 } },
      },
      errors: [],
    });
    await user.click(screen.getByRole('button', { name: '重新读取' }));
    await waitFor(() => {
      expect(screen.getByRole('spinbutton', { name: TARGET })).toHaveValue(
        4000,
      );
    });
    expect(screen.getByRole('spinbutton', { name: HARD })).toHaveValue(4000);
  },
);

test.each([TARGET, HARD])(
  'rejects illegal values in %s and recovers',
  async (label) => {
    const { boundary, user } = await openBudget();
    const input = screen.getByRole('spinbutton', { name: label });
    const key = label === TARGET ? 'targetInputTokens' : 'maxInputTokens';
    for (const edited of ['', '0', '-2', '1.5', '9007199254740992']) {
      await user.clear(input);
      if (edited !== '') await user.type(input, edited);
      await user.click(screen.getByRole('button', { name: '校验草稿' }));
      await waitFor(() => {
        expect(boundary.requests.at(-1)).toMatchObject({
          kind: 'validate',
          body: { config: { context: { [key]: Number(edited) } } },
        });
        expect(boundary.requests.at(-1)?.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: `context.${key}` }),
          ]),
        );
      });
      await user.click(screen.getByRole('button', { name: '保存并应用' }));
      expect(
        await screen.findByTestId('arbiter-save-status'),
      ).toHaveTextContent('保存或应用失败；当前生效配置未改变。');
      expect(boundary.current()).toMatchObject({
        targetInputTokens: 6000,
        maxInputTokens: 10000,
      });
    }
    await user.clear(input);
    await user.type(input, label === TARGET ? '5000' : '8000');
    await user.click(screen.getByRole('button', { name: '保存并应用' }));
    expect(await screen.findByText('已保存并生效。')).toBeVisible();
    expect(boundary.current()[key]).toBe(label === TARGET ? 5000 : 8000);
  },
);

test('explicit T above H survives unrelated blur and fails validate/save without expanding H', async () => {
  const { boundary, user } = await openBudget(5000, 5000);
  const target = screen.getByRole('spinbutton', { name: TARGET });
  const hard = screen.getByRole('spinbutton', { name: HARD });
  await user.clear(target);
  await user.type(target, '6000');
  await user.click(hard);
  await user.click(screen.getByRole('button', { name: '校验草稿' }));
  expect(target).toHaveValue(6000);
  expect(hard).toHaveValue(5000);
  expect(
    await screen.findByText(/常态目标不得超过 context.maxInputTokens/u),
  ).toBeVisible();
  await user.click(screen.getByRole('button', { name: '保存并应用' }));
  expect(await screen.findByTestId('arbiter-save-status')).toHaveTextContent(
    '保存或应用失败',
  );
  expect(boundary.current()).toMatchObject({
    targetInputTokens: 5000,
    maxInputTokens: 5000,
  });
  expect(boundary.requests).toHaveLength(2);
  for (const request of boundary.requests) {
    expect(request.body).toMatchObject({
      config: { context: { targetInputTokens: 6000, maxInputTokens: 5000 } },
    });
    expect(request.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'relation.targetInputTokens' }),
      ]),
    );
  }
});

test.each([
  {
    locale: 'zh',
    tab: '策略与高级',
    target: TARGET,
    hard: HARD,
    validate: '校验草稿',
    save: '保存并应用',
    error: '常态目标不得超过 context.maxInputTokens。',
    help: /与 Reviewer 的输出额度 maxTokens 分开/u,
  },
  {
    locale: 'en',
    tab: 'Policy and advanced',
    target: 'Normal input target T (estimated tokens)',
    hard: 'Hard input limit H (estimated tokens)',
    validate: 'Validate draft',
    save: 'Save and apply',
    error: 'The normal target must not exceed context.maxInputTokens.',
    help: /separately from the Reviewer output allowance maxTokens/u,
  },
])('provides $locale budget guidance and localized errors', async (copy) => {
  configBoundary(6000);
  const { user } = renderClient(<ArbiterPage />, { locale: copy.locale });
  await user.click(await screen.findByRole('button', { name: copy.tab }));
  expect(screen.getByText(copy.help)).toBeVisible();
  expect(screen.getByText(/20\/5\/40/u)).toBeVisible();
  expect(screen.queryByText(/2000/u)).not.toBeInTheDocument();
  const hard = screen.getByRole('spinbutton', { name: copy.hard });
  await user.clear(hard);
  await user.type(hard, '5000');
  await user.click(screen.getByRole('button', { name: copy.validate }));
  expect(await screen.findByText(new RegExp(copy.error, 'u'))).toBeVisible();
  await user.click(screen.getByRole('button', { name: copy.save }));
  expect(await screen.findByTestId('arbiter-save-status')).toHaveTextContent(
    copy.locale === 'en' ? 'Saving or applying failed' : '保存或应用失败',
  );
  expect(screen.getByRole('spinbutton', { name: copy.target })).toHaveValue(
    6000,
  );
});
