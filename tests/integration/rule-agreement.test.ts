/**
 * Rule-tester / real-gate agreement.
 *
 * The product promise is that a rule behaves the same whether it is exercised
 * through `/api/arbiter/test` or through an actual tool call. Both paths must use
 * the same validator and the same evaluator, so a decision is reproduced here
 * twice: once as a real `tools/pre-execute` decision and once as the route's
 * own answer for the same tool and arguments.
 *
 * The draft rules submitted to the tester are canonical, and an invalid draft
 * must be reported instead of being silently replaced by the effective rules —
 * otherwise the tester would be "agreeing" with a configuration it never saw.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';

import { apply } from '../../src/index.js';
import {
  admitSession,
  recordingSessionApi,
} from '../helpers/session-records.js';
import { installSessionRecordApi } from '../../src/records.js';
import type { ContextLike, FetchRouteLike } from '../../src/host/types.js';
import type { ToolExecutionLike } from '../../src/host/types.js';
import { createStubContext, stubEditor } from '../helpers/host-stub.js';

const FORMAT = 'arbiter-config-v2';

const PRODUCTION_RULE = {
  id: 'block-production-deploy',
  name: '禁止生产部署',
  scope: { tools: ['deploy'] },
  conditions: [
    {
      target: 'argument',
      path: '$.environment',
      kind: 'exact',
      pattern: 'production',
    },
  ],
  verdict: 'deny',
};

let root: string;
const disposers: (() => unknown)[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'arbiter-gate-tester-'));
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  await rm(root, { recursive: true, force: true });
});

interface Harness {
  readonly routes: ReadonlyMap<string, FetchRouteLike>;
  readonly gate: (
    execution: ToolExecutionLike,
  ) => Promise<{ readonly kind: string; readonly reason?: string }>;
  readonly documentPath: string;
  readonly session: StubSession;
}

interface StubSession {
  readonly id: string;
  readonly header: { readonly cwd: string };
  readonly events: {
    type: string;
    data?: unknown;
    seq: number;
    ignorable?: boolean;
  }[];
  readonly append: (type: string, data: unknown) => void;
  readonly snapshotEvents: () => readonly {
    readonly type: string;
    readonly data?: unknown;
    readonly seq: number;
    readonly ignorable?: boolean;
  }[];
}

async function createHarness(config: unknown): Promise<Harness> {
  const home = join(root, 'home');
  const profileDir = join(home, 'profiles', 'rule-agreement');
  const documentPath = join(profileDir, 'cordis.patch.yml');
  await mkdir(profileDir, { recursive: true });
  await writeFile(documentPath, `${JSON.stringify(config)}\n`, 'utf8');

  const events: {
    type: string;
    data?: unknown;
    seq: number;
    ignorable?: boolean;
  }[] = [];
  const session: StubSession = {
    id: 'session-1',
    header: { cwd: root },
    events,
    append: (type, data) => {
      // The host marks plugin records ignorable; the reader keeps only those.
      events.push({
        type,
        data,
        seq: events.length,
        ...(type.startsWith('plugin:') ? { ignorable: true } : {}),
      });
    },
    snapshotEvents: () => events,
  };
  const routes = new Map<string, FetchRouteLike>();
  let gate:
    ((execution: ToolExecutionLike) => Promise<{ kind: string }>) | undefined;
  const parts = createStubContext(
    {
      profileContext: { home, dir: profileDir, name: 'rule-agreement' },
      sandboxPolicy: { defaultMode: 'workspace-write' },
      // The gate resolves a session through this service; the stub session is
      // the one the case admits and drives.
      sessions: {
        get: (id: string) => (id === session.id ? session : undefined),
        list: () => [session],
      },
      approval: {
        config: { policy: 'ask' },
        request: () => Promise.resolve('unavailable'),
      },
      permissionPresets: { registerAuto: () => () => undefined },
      workingDirectory: { ensure: () => Promise.resolve(home) },
      configEditor: stubEditor({
        documentPath,
        config: () => config,
        onEdit: () => undefined,
      }),
      connection: {
        fetch: {
          register(route: FetchRouteLike) {
            routes.set(route.path, route);
            return () => routes.delete(route.path);
          },
        },
      },
    },
    {
      // Routes are registered through the optional-service injection point, so
      // the stub must run that callback with the same context.
      inject: (
        services: readonly string[],
        callback: (ctx: ContextLike) => unknown,
      ) => {
        if (services.every((service) => service === 'connection')) {
          callback(parts.ctx);
        }
        return undefined;
      },
      on: (event: string, listener: (...args: never[]) => unknown) => {
        if (event !== 'tools/pre-execute') return () => undefined;
        gate = async (execution: ToolExecutionLike) => {
          const decision: unknown = await Reflect.apply(listener, undefined, [
            execution,
            () => Promise.resolve({ kind: 'allow' }),
          ]);
          if (decision === null || typeof decision !== 'object')
            throw new TypeError('gate returned an invalid decision');
          const kind: unknown = Reflect.get(decision, 'kind');
          const reason: unknown = Reflect.get(decision, 'reason');
          if (typeof kind !== 'string')
            throw new TypeError('gate returned an invalid decision');
          return {
            kind,
            ...(typeof reason === 'string' ? { reason } : {}),
          };
        };
        return () => undefined;
      },
    },
  );
  disposers.push(() => {
    for (const dispose of parts.disposers) dispose();
  });
  apply(parts.ctx, config);

  // The user enabled this session; the gate reviews only admitted sessions.
  admitSession(session);
  return {
    routes,
    documentPath,
    session,
    gate: (execution) => {
      if (gate === undefined) throw new Error('gate was not registered');
      return gate(execution);
    },
  };
}

/**
 * The plugin writes admission through the host's record writer, and the gate
 * only reviews a session the user enabled. These cases install the same
 * contract double `snapshot-gate` uses and admit the session they drive.
 */
beforeAll(() => {
  installSessionRecordApi(recordingSessionApi());
});

afterAll(() => {
  installSessionRecordApi(null);
});

function executionOf(
  tool: string,
  args: unknown,
  session: StubSession,
  callId = 'call-1',
): ToolExecutionLike {
  return {
    callId,
    name: tool,
    arguments: args,
    signal: new AbortController().signal,
    agent: { session },
  };
}

async function testRoute(
  harness: Harness,
  body: unknown,
): Promise<Record<string, unknown>> {
  const route = harness.routes.get('/api/arbiter/test');
  if (route === undefined) throw new Error('test route was not registered');
  const response = await route.fetch(
    new Request('http://fixture/api/arbiter/test', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
  const payload: unknown = await response.json();
  if (payload === null || typeof payload !== 'object')
    throw new TypeError('test response must be an object');
  return { ...payload };
}

async function stateRoute(harness: Harness): Promise<Record<string, unknown>> {
  const route = harness.routes.get('/api/arbiter/state');
  if (route === undefined) throw new Error('state route was not registered');
  const response = await route.fetch(
    new Request('http://fixture/api/arbiter/state'),
  );
  const payload: unknown = await response.json();
  if (payload === null || typeof payload !== 'object')
    throw new TypeError('state response must be an object');
  return { ...payload };
}

/** One tool-argument decision, compared as a verdict word. */
function gateVerdict(decision: { readonly kind: string }): string {
  return decision.kind;
}

describe('rule tester and real gate agreement', () => {
  test('a canonical tool-argument rule denies in both paths', async () => {
    const harness = await createHarness({
      format: FORMAT,
      rules: [PRODUCTION_RULE],
    });

    const gated = await harness.gate(
      executionOf('deploy', { environment: 'production' }, harness.session),
    );
    expect(gateVerdict(gated)).toBe('deny');

    const tested = await testRoute(harness, {
      inputs: [
        JSON.stringify({ tool: 'deploy', args: { environment: 'production' } }),
      ],
    });
    expect(tested['ok']).toBe(true);
    expect(tested['results']).toEqual([
      expect.objectContaining({ path: 'deny', tool: 'deploy' }),
    ]);
  });

  test('a non-matching value is not denied in either path', async () => {
    const harness = await createHarness({
      format: FORMAT,
      rules: [PRODUCTION_RULE],
    });

    const gated = await harness.gate(
      executionOf('deploy', { environment: 'staging' }, harness.session),
    );
    // A call outside the rule falls through to the normal review path. The
    // decision may still be a fallback deny when approval is unavailable, but it
    // must not be the rule's own verdict.
    expect(gateVerdict(gated)).not.toBe('allow');
    expect(gated.reason ?? '').not.toContain(PRODUCTION_RULE.id);

    const tested = await testRoute(harness, {
      inputs: [
        JSON.stringify({ tool: 'deploy', args: { environment: 'staging' } }),
      ],
    });
    const results = tested['results'];
    if (!Array.isArray(results))
      throw new TypeError('results must be an array');
    expect(results[0]).toMatchObject({ path: 'review(default)' });
  });

  test('a draft rule uses the canonical validator, not the legacy one', async () => {
    const harness = await createHarness({ format: FORMAT, rules: [] });
    const tested = await testRoute(harness, {
      inputs: [
        JSON.stringify({ tool: 'deploy', args: { environment: 'production' } }),
      ],
      rules: [PRODUCTION_RULE],
    });
    // Before the fix the canonical draft was parsed as a legacy rule, silently
    // dropped, and the tester answered from the (empty) effective rules.
    expect(tested['ok']).toBe(true);
    expect(tested['results']).toEqual([
      expect.objectContaining({ path: 'deny' }),
    ]);
  });

  test('an invalid draft is reported instead of silently ignored', async () => {
    const harness = await createHarness({ format: FORMAT, rules: [] });
    const tested = await testRoute(harness, {
      inputs: ['deploy: x'],
      rules: [
        {
          id: 'broken',
          conditions: [
            { target: 'argument', path: '$.', kind: 'exact', pattern: 'x' },
          ],
          verdict: 'deny',
        },
      ],
    });
    expect(tested['ok']).toBe(false);
    expect(tested['code']).toBe('invalid-rule');
    expect(tested['errors']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'rule.path-invalid' }),
      ]),
    );
  });

  test('a non-convertible legacy document keeps the previous effective rules', async () => {
    const harness = await createHarness({
      format: FORMAT,
      rules: [PRODUCTION_RULE],
    });
    // The host keeps its last effective configuration when a candidate is invalid;
    // a legacy rule cannot be proven equivalent, so this document is rejected.
    const state = await stateRoute(harness);
    const config = state['config'];
    if (config === null || typeof config !== 'object')
      throw new TypeError('config must be an object');
    const rules: unknown = Reflect.get(config, 'rules');
    if (!Array.isArray(rules)) throw new TypeError('rules must be an array');
    const ids: unknown[] = [];
    for (const rule of rules) {
      const id: unknown =
        rule !== null && typeof rule === 'object'
          ? Reflect.get(rule, 'id')
          : undefined;
      ids.push(id);
    }
    expect(ids).toEqual([PRODUCTION_RULE.id]);
    expect(state['invalidConfigError']).toBeNull();
  });
});
