import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { initializeHost } from '../../src/host/runtime.js';
import { registerRoutes } from '../../src/host/routes.js';
import type {
  ConnectionLike,
  CredentialsLike,
  FetchRouteLike,
  HostEnvironment,
  HostServices,
} from '../../src/host/types.js';
import type {
  LlmLike,
  LlmModelLike,
  LlmProviderLike,
} from '../../src/reviewer.js';
import { createStubContext, stubEditor } from '../helpers/host-stub.js';

/**
 * The Reviewer model directory and credential status are read-only host reads.
 *
 * What is pinned here:
 *   - the directory groups every provider the LLM runtime advertises, and a
 *     provider that cannot be listed becomes a stable failure code instead of
 *     hiding the other groups or inventing options;
 *   - a composition without an LLM service reports `supported: false`;
 *   - no response body carries credential material, even when the credential
 *     provider throws a message that quotes the stored secret.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'arbiter-reviewer-routes-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Started {
  readonly routes: ReadonlyMap<string, FetchRouteLike>;
  readonly host: HostEnvironment;
}

interface Diagnostics {
  readonly messages: unknown[][];
}

async function startHost(
  services: Partial<HostServices> = {},
  diagnostics?: Diagnostics,
): Promise<Started> {
  const home = join(root, 'home');
  const profileDir = join(home, 'profiles', 'reviewer-routes');
  const documentPath = join(profileDir, 'cordis.patch.yml');
  await mkdir(profileDir, { recursive: true });
  await writeFile(documentPath, '[]\n', 'utf8');

  const routes = new Map<string, FetchRouteLike>();
  const connection: ConnectionLike = {
    fetch: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  };
  const registered: Readonly<Record<string, unknown>> = {
    profileContext: { home, dir: profileDir, name: 'reviewer-routes' },
    sandboxPolicy: { defaultMode: 'workspace-write' },
    sessions: { get: () => undefined },
    approval: {
      config: { policy: 'ask' },
      request: () => Promise.resolve('unavailable'),
    },
    permissionPresets: { registerAuto: () => () => undefined },
    workingDirectory: { ensure: () => Promise.resolve(home) },
    connection,
    configEditor: stubEditor({
      documentPath,
      config: () => ({}),
      onEdit: () => undefined,
    }),
    ...services,
  };
  // The production registrant waits for the connection service and then runs
  // its callback with the same context, which is what this stub reproduces.
  const parts = createStubContext(registered, {
    inject: (_names, callback) => callback(createStubContext(registered).ctx),
    ...(diagnostics === undefined
      ? {}
      : {
          logger: {
            info: (...args: unknown[]): void => {
              diagnostics.messages.push(args);
            },
            warn: (...args: unknown[]): void => {
              diagnostics.messages.push(args);
            },
            error: (...args: unknown[]): void => {
              diagnostics.messages.push(args);
            },
          },
        }),
  });
  const host = initializeHost(parts.ctx, {});
  registerRoutes(host);
  return { routes, host };
}

async function bodyOf(response: Response): Promise<string> {
  return response.text();
}

function route(
  routes: ReadonlyMap<string, FetchRouteLike>,
  path: string,
): FetchRouteLike {
  const found = routes.get(path);
  if (found === undefined) throw new Error(`${path} was not registered`);
  return found;
}

function llmOf(
  providers: readonly LlmProviderLike[],
  listModels: (provider: string) => Promise<readonly LlmModelLike[]>,
): LlmLike {
  return {
    stream: () => {
      throw new Error('the catalog must not request a model');
    },
    listProviders: () => providers,
    listModels,
  };
}

describe('model catalog route', () => {
  test('groups the advertised providers and their models', async () => {
    const { routes } = await startHost({
      llm: llmOf(
        [
          { id: 'deepseek-official', name: 'DeepSeek' },
          { id: 'gateway', name: 'Internal gateway' },
        ],
        (provider) =>
          Promise.resolve(
            provider === 'deepseek-official'
              ? [
                  {
                    provider,
                    id: 'deepseek-flash',
                    name: 'DeepSeek-V4.1-Flash',
                    description: 'fast',
                  },
                ]
              : [
                  { provider, id: 'shared', name: 'Shared' },
                  { provider, id: 'claude', name: 'Claude' },
                ],
          ),
      ),
    });
    const response = await route(routes, '/api/arbiter/models').fetch(
      new Request('http://fixture/api/arbiter/models'),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(await bodyOf(response))).toEqual({
      ok: true,
      supported: true,
      groups: [
        {
          id: 'deepseek-official',
          name: 'DeepSeek',
          models: [
            {
              id: 'deepseek-flash',
              name: 'DeepSeek-V4.1-Flash',
              description: 'fast',
            },
          ],
        },
        {
          id: 'gateway',
          name: 'Internal gateway',
          models: [
            { id: 'shared', name: 'Shared' },
            { id: 'claude', name: 'Claude' },
          ],
        },
      ],
      failures: [],
    });
  });

  test('one failing provider does not hide the others and leaks no message', async () => {
    const secret = 'sk-live-must-not-escape';
    const diagnostics: Diagnostics = { messages: [] };
    const { routes } = await startHost(
      {
        llm: llmOf(
          [
            { id: 'broken', name: 'Broken provider' },
            { id: 'healthy', name: 'Healthy provider' },
            { id: 'empty', name: 'Unconfigured provider' },
          ],
          (provider) => {
            if (provider === 'broken')
              return Promise.reject(
                new Error(`GET https://gateway.test/models refused ${secret}`),
              );
            if (provider === 'empty') return Promise.resolve([]);
            return Promise.resolve([
              { provider, id: 'model-1', name: 'Model 1' },
            ]);
          },
        ),
      },
      diagnostics,
    );
    const body = await bodyOf(
      await route(routes, '/api/arbiter/models').fetch(
        new Request('http://fixture/api/arbiter/models'),
      ),
    );
    expect(body).not.toContain(secret);
    expect(body).not.toContain('gateway.test');
    // The diagnostic boundary is separate from the HTTP body: the raw provider
    // exception must not reach plugin logs either.
    const logged = JSON.stringify(diagnostics.messages);
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain('gateway.test');
    expect(logged).toContain('provider-catalog-failed');
    expect(JSON.parse(body)).toEqual({
      ok: true,
      supported: true,
      groups: [
        {
          id: 'healthy',
          name: 'Healthy provider',
          models: [{ id: 'model-1', name: 'Model 1' }],
        },
      ],
      failures: [
        {
          id: 'broken',
          name: 'Broken provider',
          code: 'provider-catalog-failed',
        },
      ],
    });
  });

  test('a composition without an LLM service offers no options instead of failing', async () => {
    const { routes } = await startHost({ llm: undefined });
    expect(
      JSON.parse(
        await bodyOf(
          await route(routes, '/api/arbiter/models').fetch(
            new Request('http://fixture/api/arbiter/models'),
          ),
        ),
      ),
    ).toEqual({ ok: true, supported: false, groups: [], failures: [] });
  });

  test('a whole-directory failure is answered as not loaded, with no raw error logged', async () => {
    const secret = 'sk-whole-directory-must-not-escape';
    const diagnostics: Diagnostics = { messages: [] };
    const { routes } = await startHost(
      {
        llm: {
          stream: () => {
            throw new Error('unreachable');
          },
          listProviders: () => {
            throw new Error(`cannot enumerate providers: ${secret}`);
          },
          listModels: () => Promise.resolve([]),
        },
      },
      diagnostics,
    );
    const body = await bodyOf(
      await route(routes, '/api/arbiter/models').fetch(
        new Request('http://fixture/api/arbiter/models'),
      ),
    );
    expect(body).not.toContain(secret);
    expect(JSON.parse(body)).toEqual({
      ok: false,
      code: 'catalog-unavailable',
      supported: true,
      groups: [],
      failures: [],
    });
    const logged = JSON.stringify(diagnostics.messages);
    expect(logged).not.toContain(secret);
    expect(logged).toContain('catalog-unavailable');
  });

  test('the catalog read never streams a model request', async () => {
    let streamed = 0;
    const { routes } = await startHost({
      llm: {
        stream: () => {
          streamed += 1;
          throw new Error('unreachable');
        },
        listProviders: () => [{ id: 'gateway', name: 'Gateway' }],
        listModels: (provider) =>
          Promise.resolve([{ provider, id: 'model-1', name: 'Model 1' }]),
      },
    });
    await route(routes, '/api/arbiter/models').fetch(
      new Request('http://fixture/api/arbiter/models'),
    );
    expect(streamed).toBe(0);
  });
});

describe('credential status route', () => {
  function credentials(describe: CredentialsLike['describe']): CredentialsLike {
    return {
      resolve: () => Promise.resolve(undefined),
      ...(describe === undefined ? {} : { describe }),
    };
  }

  test('reports presence and source only, never the value', async () => {
    const { routes } = await startHost({
      credentials: credentials(() =>
        Promise.resolve({ configured: true, source: 'file' }),
      ),
    });
    const body = await bodyOf(
      await route(routes, '/api/arbiter/credentials').fetch(
        new Request('http://fixture/api/arbiter/credentials?ref=MY_KEY'),
      ),
    );
    expect(JSON.parse(body)).toEqual({
      ok: true,
      state: 'configured',
      ref: 'MY_KEY',
      configured: true,
      source: 'file',
      supported: true,
    });
    expect(body).not.toContain('sk-');
  });

  test('describes exactly the draft reference the Reviewer would resolve', async () => {
    const asked: string[] = [];
    const { routes } = await startHost({
      credentials: credentials((ref) => {
        asked.push(ref);
        return Promise.resolve({ configured: ref === ' MY_KEY ' });
      }),
    });
    const fetchCredentials = route(routes, '/api/arbiter/credentials');
    const answer = async (query: string): Promise<unknown> =>
      JSON.parse(
        await bodyOf(
          await fetchCredentials.fetch(
            new Request(`http://fixture/api/arbiter/credentials${query}`),
          ),
        ),
      );
    // Whitespace is part of the reference: the decision backend resolves the
    // stored string verbatim, so the status query must ask about that string.
    expect(await answer('?ref=%20MY_KEY%20')).toMatchObject({
      ref: ' MY_KEY ',
      state: 'configured',
    });
    expect(await answer('?ref=MY_KEY')).toMatchObject({
      ref: 'MY_KEY',
      state: 'unconfigured',
    });
    // An omitted query asks about the effective reference.
    expect(await answer('')).toMatchObject({
      ref: 'CLOUDFLARE_API_TOKEN',
      state: 'unconfigured',
    });
    // An empty reference is its own case, not the effective one.
    expect(await answer('?ref=')).toMatchObject({
      ref: '',
      state: 'unconfigured',
    });
    // An oversized reference is not described at all.
    const oversized = await answer(`?ref=${'x'.repeat(500)}`);
    expect(oversized).toMatchObject({ state: 'unavailable' });
    // Only the two usable references reached the provider; the oversized one
    // was rejected without asking any provider for its status.
    expect(asked).toEqual([' MY_KEY ', 'MY_KEY', 'CLOUDFLARE_API_TOKEN']);
  });

  test('a missing describe method is unsupported, not unconfigured', async () => {
    const { routes } = await startHost({ credentials: credentials(undefined) });
    expect(
      JSON.parse(
        await bodyOf(
          await route(routes, '/api/arbiter/credentials').fetch(
            new Request('http://fixture/api/arbiter/credentials?ref=MY_KEY'),
          ),
        ),
      ),
    ).toMatchObject({ state: 'unsupported', supported: false, ref: 'MY_KEY' });
  });

  test('a credential provider error is answered with a code, not its message', async () => {
    const secret = 'ghp_secret_value_must_not_escape';
    const { routes } = await startHost({
      credentials: credentials(() =>
        Promise.reject(new Error(`cannot read ${secret}`)),
      ),
    });
    const body = await bodyOf(
      await route(routes, '/api/arbiter/credentials').fetch(
        new Request('http://fixture/api/arbiter/credentials?ref=BROKEN_KEY'),
      ),
    );
    expect(body).not.toContain(secret);
    expect(JSON.parse(body)).toEqual({
      ok: false,
      state: 'unavailable',
      code: 'credentials-unavailable',
      ref: 'BROKEN_KEY',
      configured: false,
      source: null,
      supported: true,
    });
  });

  test('an absent credential service reports that it is unsupported', async () => {
    const { routes } = await startHost({ credentials: undefined });
    expect(
      JSON.parse(
        await bodyOf(
          await route(routes, '/api/arbiter/credentials').fetch(
            new Request('http://fixture/api/arbiter/credentials?ref=ANY'),
          ),
        ),
      ),
    ).toMatchObject({
      state: 'unsupported',
      ref: 'ANY',
      configured: false,
      supported: false,
    });
  });
});
