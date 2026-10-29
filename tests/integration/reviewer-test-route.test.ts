import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { initializeHost } from '../../src/host/runtime.js';
import { SessionAdmissions } from '../../src/host/session-admission.js';
import { registerRoutes } from '../../src/host/routes.js';
import type {
  ConnectionLike,
  CredentialsLike,
  FetchRouteLike,
  HostEnvironment,
  HostServices,
} from '../../src/host/types.js';
import type { LlmLike } from '../../src/reviewer.js';
import { createStubContext, stubEditor } from '../helpers/host-stub.js';

/**
 * The one-shot Reviewer test route.
 *
 * What is pinned here:
 *   - the draft on screen is tested, not the effective configuration;
 *   - the response never carries the credential that authenticated the call;
 *   - a completed probe is HTTP 200 even when it failed, because the failure is
 *     the answer;
 *   - the route applies nothing: no config edit, no audit row, no review count,
 *     no breaker update.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'arbiter-reviewer-test-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Started {
  readonly routes: ReadonlyMap<string, FetchRouteLike>;
  readonly host: HostEnvironment;
  readonly edits: () => number;
}

const VALID_CHAT = JSON.stringify({ risk: 1, authorization: 8 });

function streamOf(
  chunks: readonly Record<string, unknown>[],
): AsyncIterable<Record<string, unknown>> {
  return (async function* () {
    for (const chunk of chunks) {
      await Promise.resolve();
      yield chunk;
    }
  })();
}

function chatLlm(text = VALID_CHAT): LlmLike {
  return {
    stream: () =>
      streamOf([
        { type: 'text-delta', text },
        { type: 'finish', reason: { kind: 'stop' } },
      ]),
  };
}

async function startHost(
  services: Partial<HostServices> = {},
): Promise<Started> {
  const home = join(root, 'home');
  const profileDir = join(home, 'profiles', 'reviewer-test');
  const documentPath = join(profileDir, 'cordis.patch.yml');
  await mkdir(profileDir, { recursive: true });
  await writeFile(documentPath, '[]\n', 'utf8');

  const routes = new Map<string, FetchRouteLike>();
  let edits = 0;
  const connection: ConnectionLike = {
    fetch: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  };
  const registered: Readonly<Record<string, unknown>> = {
    profileContext: { home, dir: profileDir, name: 'reviewer-test' },
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
      onEdit: () => {
        edits += 1;
      },
    }),
    ...services,
  };
  const parts = createStubContext(registered, {
    inject: (_names, callback) => callback(createStubContext(registered).ctx),
  });
  const host = initializeHost(parts.ctx, {});
  // The reviewer route is what this case inspects; admission state is empty.
  registerRoutes(host, new SessionAdmissions(host));
  return { routes, host, edits: () => edits };
}

function routeOf(
  routes: ReadonlyMap<string, FetchRouteLike>,
  path: string,
): FetchRouteLike {
  const found = routes.get(path);
  if (found === undefined) throw new Error(`${path} was not registered`);
  return found;
}

function chatDraft(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    reviewer: {
      type: 'chat',
      chat: {
        provider: 'probe-provider',
        model: 'probe-model',
        temperature: 0,
        maxTokens: 400,
        timeoutMs: 1_000,
        maxRepairRetries: 1,
        ...overrides,
      },
    },
    policy: {},
  };
}

function postReviewerTest(
  route: FetchRouteLike,
  body: unknown,
): Promise<Response> {
  return route.fetch(
    new Request('http://fixture/api/arbiter/reviewer-test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

function credentials(value: string | undefined): CredentialsLike {
  return {
    resolve: () => Promise.resolve(value === undefined ? undefined : { value }),
    describe: () =>
      Promise.resolve({ configured: value !== undefined, source: 'file' }),
  };
}

describe('reviewer test route', () => {
  test('runs the draft route and reports the real model', async () => {
    const { routes } = await startHost({ llm: chatLlm() });
    const response = await postReviewerTest(
      routeOf(routes, '/api/arbiter/reviewer-test'),
      {
        draft: chatDraft({ provider: 'draft-provider', model: 'draft-model' }),
      },
    );
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      ok: true,
      probe: {
        status: 'passed',
        backend: 'chat',
        model: { provider: 'draft-provider', model: 'draft-model' },
        protocol: 'arbiter-chat-json-v2',
        repairs: 0,
      },
    });
  });

  test('tests the submitted draft rather than the effective configuration', async () => {
    const { routes } = await startHost({ llm: chatLlm() });
    // The effective configuration still follows the session; the draft names a
    // concrete route, and that is what must be exercised.
    const body: unknown = await (
      await postReviewerTest(routeOf(routes, '/api/arbiter/reviewer-test'), {
        draft: chatDraft(),
      })
    ).json();
    expect(body).toMatchObject({
      probe: { model: { provider: 'probe-provider', model: 'probe-model' } },
    });
  });

  test('a failed probe is still a successful read', async () => {
    const { routes } = await startHost({
      llm: {
        stream: () =>
          streamOf([
            {
              type: 'finish',
              reason: {
                kind: 'failure',
                failure: { code: 'AUTH', message: 'invalid api key' },
              },
            },
          ]),
      },
    });
    const response = await postReviewerTest(
      routeOf(routes, '/api/arbiter/reviewer-test'),
      { draft: chatDraft() },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      // The provider named AUTH, so the stage is authentication rather than a
      // generic transport failure.
      probe: { status: 'failed', failure: 'unauthorized' },
    });
  });

  test('a malformed draft is rejected without touching any service', async () => {
    const { routes, edits } = await startHost({ llm: chatLlm() });
    const route = routeOf(routes, '/api/arbiter/reviewer-test');
    expect((await postReviewerTest(route, {})).status).toBe(400);
    // A supplied but wrong-typed section is a real draft error; absent fields
    // keep their defaults, so `{}` alone is not one.
    const invalid = await postReviewerTest(route, {
      draft: { reviewer: { type: 'magic' }, policy: {} },
    });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({
      ok: false,
      code: 'draft-invalid',
    });
    expect(edits()).toBe(0);
  });

  test('a decision probe never returns the resolved credential', async () => {
    const secret = 'sk-probe-credential-must-not-escape';
    const { routes } = await startHost({
      credentials: credentials(secret),
    });
    const response = await postReviewerTest(
      routeOf(routes, '/api/arbiter/reviewer-test'),
      {
        draft: {
          reviewer: {
            type: 'decision',
            decision: {
              url: 'http://127.0.0.1:9/review',
              model: 'probe-model',
              apiKeyRef: 'PROBE_KEY',
              timeoutMs: 1_000,
              costTier: 'free',
            },
          },
          policy: {},
        },
      },
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(secret);
    // The unreachable port is a real transport failure, not an output verdict.
    expect(JSON.parse(text)).toMatchObject({
      ok: true,
      probe: { status: 'failed', backend: 'decision' },
    });
    // The unreachable port never accepted the connection, so the stage is the
    // transport, not the output contract.
    expect(JSON.parse(text)).toMatchObject({
      probe: { failure: 'network' },
    });
  });

  test('the probe leaves no runtime side effect', async () => {
    const { routes, host, edits } = await startHost({ llm: chatLlm() });
    const beforeReviewCounts = host.runtime.reviewCounts.size;
    const beforeBreakers = host.runtime.breakers.size;
    const beforeRevision = host.runtime.effectiveRevision;
    const beforeAudit = host.audit;

    await postReviewerTest(routeOf(routes, '/api/arbiter/reviewer-test'), {
      draft: chatDraft(),
    });

    // No config application, no review count, no breaker entry, no audit write,
    // and nothing recorded in the approval/decision history.
    expect(edits()).toBe(0);
    expect(host.runtime.reviewCounts.size).toBe(beforeReviewCounts);
    expect(host.runtime.breakers.size).toBe(beforeBreakers);
    expect(host.runtime.effectiveRevision).toBe(beforeRevision);
    expect(host.runtime.priorVerdicts.size).toBe(0);
    expect(host.audit).toBe(beforeAudit);
    const rows = beforeAudit?.listCalls({ limit: 10, offset: 0 }).total ?? 0;
    expect(rows).toBe(0);
  });

  test('aborting the request cancels the in-flight probe', async () => {
    let observed: AbortSignal | undefined;
    const { routes } = await startHost({
      llm: {
        stream: (options) => {
          observed = options.signal;
          // Hold the stream open until the caller aborts, so the abort is what
          // ends this probe rather than an immediate provider answer.
          return (async function* () {
            await new Promise<void>((resolve) => {
              options.signal?.addEventListener('abort', () => {
                resolve();
              });
              // Also settle if the signal was already aborted.
              if (options.signal?.aborted === true) resolve();
            });
            yield { type: 'text-delta', text: 'aborted' };
            throw new DOMException('aborted', 'AbortError');
          })();
        },
      },
    });
    const abort = new AbortController();
    const route = routeOf(routes, '/api/arbiter/reviewer-test');
    const pending = route.fetch(
      new Request('http://fixture/api/arbiter/reviewer-test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draft: chatDraft() }),
        signal: abort.signal,
      }),
    );
    await expect.poll(() => observed !== undefined).toBe(true);
    abort.abort();
    const body: unknown = await (await pending).json();
    expect(observed?.aborted).toBe(true);
    expect(body).toMatchObject({
      probe: { status: 'cancelled' },
    });
  });
});
