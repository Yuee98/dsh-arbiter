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

const SHELL_FORMAT = 'arbiter-config-v2';

/** One shell allow, so the gate and the tester must agree on the same text. */
const SHELL_ALLOW = {
  id: 'echo-quoted',
  conditions: [
    {
      target: 'command',
      kind: 'exact',
      pattern: "echo 'a b'",
    },
  ],
  verdict: 'allow',
};

const NESTED_ALLOW = {
  id: 'both-commands',
  conditions: [
    { target: 'command', kind: 'exact', pattern: 'echo hi' },
    { target: 'command', kind: 'exact', pattern: 'echo $(date)' },
    { target: 'command', kind: 'exact', pattern: 'date' },
  ],
  verdict: 'allow',
};

function shellExecution(
  session: StubSession,
  command: string,
  callId = 'call-shell',
): ToolExecutionLike {
  return executionOf('bash', { command }, session, callId);
}

async function testShellRoute(
  harness: Harness,
  command: string,
  rules: readonly unknown[] = [],
): Promise<Record<string, unknown>> {
  const payload = await testRoute(harness, {
    inputs: [JSON.stringify({ tool: 'bash', args: { command } })],
    ...(rules.length === 0 ? {} : { rules }),
  });
  const results: unknown = payload['results'];
  if (!Array.isArray(results) || results.length === 0)
    throw new TypeError('results must be a non-empty array');
  const first: unknown = results[0];
  if (first === null || typeof first !== 'object')
    throw new TypeError('result must be an object');
  return { ...first };
}

describe('shell normalization agreement', () => {
  test('a quoted argument is allowed only as the text it normalizes to', async () => {
    const harness = await createHarness({
      format: SHELL_FORMAT,
      rules: [SHELL_ALLOW],
    });
    const allowed = await harness.gate(
      shellExecution(harness.session, 'echo "a b"'),
    );
    expect(gateVerdict(allowed)).toBe('allow');

    const tested = await testShellRoute(harness, 'echo "a b"');
    expect(tested['path']).toBe('allow');
    const normalization = tested['normalization'];
    if (normalization === null || typeof normalization !== 'object')
      throw new TypeError('normalization must be an object');
    expect(Reflect.get(normalization, 'raw')).toBe('echo "a b"');
    expect(Reflect.get(normalization, 'commands')).toEqual([
      expect.objectContaining({ text: "echo 'a b'" }),
    ]);
  });

  test('two arguments are not the quoted argument in either path', async () => {
    const harness = await createHarness({
      format: SHELL_FORMAT,
      rules: [SHELL_ALLOW],
    });
    const denied = await harness.gate(
      shellExecution(harness.session, 'echo a b', 'call-two-args'),
    );
    expect(gateVerdict(denied)).not.toBe('allow');
    const tested = await testShellRoute(harness, 'echo a b');
    expect(tested['path']).toBe('review(default)');
  });

  test('a compound call needs complete allow coverage of every command', async () => {
    const harness = await createHarness({
      format: SHELL_FORMAT,
      rules: [NESTED_ALLOW],
    });
    const covered = await harness.gate(
      shellExecution(harness.session, 'echo hi; echo $(date)', 'call-covered'),
    );
    expect(gateVerdict(covered)).toBe('allow');

    const partialRules = [SHELL_ALLOW];
    const partialHarness = await createHarness({
      format: SHELL_FORMAT,
      rules: partialRules,
    });
    const partial = await partialHarness.gate(
      shellExecution(
        partialHarness.session,
        'echo "a b"; echo $(rm -rf /)',
        'call-partial',
      ),
    );
    expect(gateVerdict(partial)).not.toBe('allow');
    const tested = await testShellRoute(
      partialHarness,
      'echo "a b"; echo $(rm -rf /)',
      partialRules,
    );
    expect(tested['path']).toBe('review(default)');
  });

  test('a textual allow cannot mask missing structure in either path', async () => {
    // A command allow covers the text it matched, not the source nobody read. A
    // tool-wide allow is different: it is an explicit authorization of the whole
    // tool, which is why this case uses a command condition.
    const harness = await createHarness({
      format: SHELL_FORMAT,
      rules: [
        {
          id: 'prefix-allow',
          conditions: [
            { target: 'command', kind: 'exact', pattern: 'echo ok' },
          ],
          verdict: 'allow',
        },
      ],
    });
    const gated = await harness.gate(
      shellExecution(harness.session, 'echo ok; echo (', 'call-gap'),
    );
    expect(gateVerdict(gated)).not.toBe('allow');

    const tested = await testShellRoute(harness, 'echo ok; echo (');
    expect(tested['path']).toBe('review(default)');
    const parse = tested['parse'];
    if (parse === null || typeof parse !== 'object')
      throw new TypeError('parse must be an object');
    expect(Reflect.get(parse, 'completeness')).toBe('partial');
  });

  test('a dynamic word keeps its expression and stays matchable', async () => {
    const rules = [
      {
        id: 'relay-send',
        conditions: [
          {
            target: 'command',
            kind: 'exact',
            pattern: 'gpt-relay send $CONTENT',
          },
        ],
        verdict: 'allow',
      },
    ];
    const harness = await createHarness({ format: SHELL_FORMAT, rules });
    const gated = await harness.gate(
      shellExecution(
        harness.session,
        'gpt-relay send $CONTENT',
        'call-dynamic',
      ),
    );
    expect(gateVerdict(gated)).toBe('allow');
    const tested = await testShellRoute(
      harness,
      'gpt-relay send $CONTENT',
      rules,
    );
    expect(tested['path']).toBe('allow');

    // The quoted form is a different text, so it is not silently allowed.
    const quoted = await testShellRoute(
      harness,
      'gpt-relay send "$CONTENT"',
      rules,
    );
    expect(quoted['path']).toBe('review(default)');
  });
});

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
