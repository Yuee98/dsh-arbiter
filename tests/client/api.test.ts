import { http, HttpResponse } from 'msw';
import { describe, expect, test } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { effectiveState } from '../helpers/client-state.js';
import { logsResponse } from '../../src/client/decoders/logs.js';
import {
  stateResponse,
  validationResponse,
} from '../../src/client/decoders/state.js';

import { ApiError, getJson, postJson } from '../../src/client/api.js';
import { setupApiMock } from '../helpers/api-mock.js';

const server = setupApiMock();

describe('browser API over real intercepted fetch', () => {
  test('posts JSON to the plugin route with JSON headers and reads the response', async () => {
    const draft = { revision: 'r1', config: { rules: [] } };
    server.use(
      http.post('*/api/arbiter/config/save', async ({ request }) => {
        expect(request.headers.get('accept')).toBe('application/json');
        expect(request.headers.get('content-type')).toBe('application/json');
        expect(await request.json()).toEqual(draft);
        return HttpResponse.json({ ok: true, revision: 'r2' });
      }),
    );

    await expect(postJson('/config/save', draft)).resolves.toEqual({
      ok: true,
      revision: 'r2',
    });
  });

  test.each([
    {
      status: 409,
      code: 'revision-conflict',
      message: '配置已被其他窗口更新',
      details: { currentRevision: 'r3' },
    },
    {
      status: 422,
      code: 'config-invalid',
      message: '配置校验失败',
      details: {
        errors: [{ path: 'rules[0].match.pattern', message: '无效' }],
      },
    },
  ])('preserves structured $status failures as ApiError', async (failure) => {
    const payload = {
      code: failure.code,
      message: failure.message,
      ...failure.details,
    };
    server.use(
      http.post('*/api/arbiter/config/save', () =>
        HttpResponse.json(payload, { status: failure.status }),
      ),
    );

    const error: unknown = await postJson('/config/save', {}).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: failure.status,
      code: failure.code,
      message: failure.message,
      payload,
    });
  });

  test('preserves a plain-text service failure without disguising it as a JSON parsing error', async () => {
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.text('reviewer temporarily unavailable', { status: 503 }),
      ),
    );

    await expect(getJson('/state')).rejects.toMatchObject({
      name: 'ApiError',
      status: 503,
      code: 'request-failed',
      message: 'reviewer temporarily unavailable',
      payload: { message: 'reviewer temporarily unavailable' },
    });
  });

  test('does not accept malformed JSON from a successful endpoint', async () => {
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.text('{"revision":', {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(getJson('/state')).rejects.toBeInstanceOf(SyntaxError);
  });

  test('keeps network failures distinct from HTTP ApiError responses', async () => {
    server.use(http.get('*/api/arbiter/state', () => HttpResponse.error()));

    const error: unknown = await getJson('/state').catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(ApiError);
  });
});

describe('typed browser response boundaries', () => {
  test('accepts a valid effective state while retaining opaque evidence and tolerating future metadata', async () => {
    const sourceConfig = { note: 'user-authored configuration stays opaque' };
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json({
          ...effectiveState(),
          sourceConfig,
          futureHostField: true,
        }),
      ),
    );

    const state = await getJson('/state', stateResponse);
    expect(state.config).toEqual(DEFAULT_CONFIG);
    expect(state.sourceConfig).toEqual(sourceConfig);
    expect(state.audit.health.state).toBe('ok');
    expect(state.sessionRecordErrors).toEqual([
      ['session-1', 'disk unavailable'],
    ]);
  });

  test.each([
    {
      config: {
        ...DEFAULT_CONFIG,
        modes: { main: 'unknown', subagent: 'no-ask' },
      },
      field: 'main',
    },
    {
      config: {
        ...DEFAULT_CONFIG,
        context: { ...DEFAULT_CONFIG.context, maxInputTokens: '10000' },
      },
      field: 'maxInputTokens',
    },
    {
      config: {
        ...DEFAULT_CONFIG,
        rules: [
          {
            id: 'r1',
            verdict: 'allow',
            enabled: 'false',
            match: { node: 'command', kind: 'exact', pattern: 'pwd' },
          },
        ],
      },
      field: 'enabled',
    },
  ])(
    'rejects invalid $field before the UI consumes typed configuration',
    async ({ config, field }) => {
      server.use(
        http.get('*/api/arbiter/state', () =>
          HttpResponse.json({ ...effectiveState(), config }),
        ),
      );

      await expect(getJson('/state', stateResponse)).rejects.toThrow(field);
    },
  );

  test('rejects a malformed log list without presenting it as empty history', async () => {
    server.use(
      http.get('*/api/arbiter/logs', () =>
        HttpResponse.json({ ok: true, rows: 'not-an-array', total: 0 }),
      ),
    );

    await expect(getJson('/logs', logsResponse)).rejects.toThrow(
      'rows: expected an array',
    );
  });

  test('validates structured POST results while accepting an explicitly unavailable audit store', async () => {
    server.use(
      http.post('*/api/arbiter/validate', () =>
        HttpResponse.json({
          ok: false,
          errors: [{ path: 'rules[0]', message: 'invalid' }],
          warnings: [],
        }),
      ),
      http.get('*/api/arbiter/logs', () =>
        HttpResponse.json({
          ok: false,
          code: 'audit-unavailable',
          rows: [],
          total: 0,
        }),
      ),
    );

    await expect(
      postJson('/validate', {}, validationResponse),
    ).resolves.toMatchObject({
      ok: false,
      errors: [{ path: 'rules[0]', message: 'invalid' }],
    });
    // An unavailable store decodes as a failed page, not as a successful one
    // that happens to be empty; the panel distinguishes the two.
    await expect(getJson('/logs', logsResponse)).resolves.toMatchObject({
      ok: false,
      code: 'audit-unavailable',
      rows: [],
      total: 0,
    });
  });
});
