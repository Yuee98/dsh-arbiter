import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, expect } from './fixtures.js';
import { resolveDshCommand } from './dsh/profile.js';
import type { ContextLike } from '../../src/host/types.js';

/**
 * The real host gate, not only the HTTP tester.
 *
 * The pinned host's own `ToolRuntime` is mounted inside a plugin scope and the
 * arbiter plugin registers on the same scope, so a tool call travels the actual
 * `tools/pre-execute` chain. The same tool call is then sent to the plugin's real
 * rule tester. Both answers must agree, which is the acceptance requirement this
 * issue adds: agreement is proven where the gate actually runs, not only where the
 * tester happens to answer.
 *
 * No model request is made and no tool body runs for the denied call; the fixture
 * tool only records whether it was reached.
 */

const FORMAT = 'arbiter-config-v2';

const PRODUCTION_RULE = {
  id: 'block-production-deploy',
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

const CONFIG = { format: FORMAT, rules: [PRODUCTION_RULE] };

interface GateDecision {
  readonly kind: string;
  readonly text: string;
  readonly reason?: string;
}

interface HostToolRuntime {
  register(definition: unknown): unknown;
  execute(input: unknown): Promise<{ readonly isError?: boolean }>;
}

interface ScopeMembers {
  provide(name: string, value: unknown): void;
  on(event: string, handler: (...args: never[]) => unknown): () => void;
  get(name: string): unknown;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * The construction surface this spec uses.
 *
 * A host class is called through `Reflect.construct`, so the export only has to
 * be callable as a constructor; the resulting instance is verified separately.
 */
interface HostConstructor {
  readonly construct: (args: readonly unknown[]) => unknown;
}

/** A resolved host export, or a named failure before any construction. */
function constructorOf(value: unknown, name: string): HostConstructor {
  if (typeof value !== 'function')
    throw new TypeError(`pinned host export ${name} is not a constructor`);
  return {
    // `Reflect.construct` accepts any callable target and returns `any`; the
    // caller verifies the instance before it is used.
    construct: (args) => Reflect.construct(value, args) as unknown,
  };
}

/**
 * Construct a host class and verify the instance before using it.
 *
 * The predicate is the type guard, so callers get a checked instance without an
 * assertion on the dynamically resolved export.
 */
function constructChecked<T>(
  value: HostConstructor,
  args: readonly unknown[],
  accepts: (candidate: unknown) => candidate is T,
): T {
  const created: unknown = value.construct(args);
  if (!accepts(created))
    throw new TypeError('constructed host object lacks the required members');
  return created;
}

function isContextInstance(value: unknown): value is ContextLike & {
  plugin(callback: (scope: unknown) => void): unknown;
} {
  return (
    isRecordValue(value) &&
    typeof value['plugin'] === 'function' &&
    typeof value['on'] === 'function' &&
    typeof value['get'] === 'function' &&
    typeof value['inject'] === 'function'
  );
}

function isToolRuntime(value: unknown): value is HostToolRuntime {
  return (
    isRecordValue(value) &&
    typeof value['register'] === 'function' &&
    typeof value['execute'] === 'function'
  );
}

function narrowFixture(value: unknown): (options: unknown) => unknown {
  if (typeof value !== 'function')
    throw new TypeError('pinned host is missing the tool fixture factory');
  return (options: unknown): unknown =>
    Reflect.apply(value, undefined, [options]);
}

function scopeMembers(value: unknown): ScopeMembers {
  if (!isRecordValue(value))
    throw new TypeError('plugin scope is not an object');
  const provide = value['provide'];
  const on = value['on'];
  const get = value['get'];
  if (
    typeof provide !== 'function' ||
    typeof on !== 'function' ||
    typeof get !== 'function'
  )
    throw new TypeError('plugin scope lacks provide/on/get');
  return {
    provide(name, provided) {
      Reflect.apply(provide, value, [name, provided]);
    },
    on(event, handler) {
      const disposer: unknown = Reflect.apply(on, value, [event, handler]);
      return typeof disposer === 'function'
        ? () => {
            Reflect.apply(disposer, undefined, []);
          }
        : () => undefined;
    },
    get(name) {
      return Reflect.get(value, name);
    },
  };
}

/**
 * Boot the pinned host's tool registry with the arbiter plugin attached.
 *
 * The plugin needs its own host services, so the session, approval and
 * working-directory providers below are minimal stand-ins that keep the gate on
 * the real code path without booting DSH's whole daemon.
 */
async function mountGate(options: { readonly readOnly: boolean }): Promise<{
  readonly execute: (name: string, args: unknown) => Promise<GateDecision>;
  readonly reached: string[];
  readonly received: { name: string; kind: string; reason?: string }[];
  readonly dispose: () => Promise<void>;
}> {
  const command = await resolveDshCommand();
  const entry = command.args[0];
  if (entry === undefined)
    throw new Error('DSH_E2E_CLI must point at the host entry for this test.');
  const hostRoot = entry.slice(0, entry.indexOf('/node_modules/@deepseek-ai/'));
  const requireFromHost = createRequire(join(hostRoot, 'package.json'));

  const load = async (name: string): Promise<Record<string, unknown>> => {
    const loaded: unknown = await import(requireFromHost.resolve(name));
    if (!isRecordValue(loaded))
      throw new TypeError(`${name} namespace is not an object`);
    return loaded;
  };
  const cordis = await load('@deepseek-ai/cordis');
  const systemPrompt = await load('@deepseek-ai/dsh-system-prompt');
  const tools = await load('@deepseek-ai/dsh-tools');

  const reached: string[] = [];
  const received: { name: string; kind: string; text: string }[] = [];
  const home = await mkdtemp(join(tmpdir(), 'arbiter-gate-e2e-'));
  const box: {
    runtime?: HostToolRuntime;
    decision?: (name: string) => GateDecision;
  } = {};
  const disposers: (() => unknown)[] = [];

  const Context = constructorOf(cordis['Context'], 'Context');
  const SystemPrompt = constructorOf(
    systemPrompt['SystemPrompt'],
    'SystemPrompt',
  );
  const ToolRuntime = constructorOf(tools['ToolRuntime'], 'ToolRuntime');
  const fixture = narrowFixture(tools['defineContentToolFixture']);

  const { apply } = await import('../../src/index.js');
  const context = constructChecked(Context, [], isContextInstance);
  const mountError: { message?: string } = {};
  context.plugin((scoped: unknown) => {
    if (mountError.message !== undefined) return;
    try {
      mountScope(scoped);
    } catch (error) {
      mountError.message =
        error instanceof Error ? error.message : String(error);
    }
  });
  function mountScope(scoped: unknown): void {
    const scope = scopeMembers(scoped);
    // The tool registry renders its prompt section through this service.
    constructChecked(SystemPrompt, [scoped, {}], isRecordValue);
    const session = {
      id: 'sr-gate',
      header: { id: 'sr-gate', cwd: options.readOnly ? tmpdir() : home },
      snapshotEvents: () => [],
      deriveMessages: () => [],
      append: () => undefined,
      requestHeader: () => ({ config: { provider: 'stub', model: 'stub' } }),
    };
    scope.provide('profileContext', {
      home,
      dir: join(home, 'profiles', 'gate'),
      name: 'gate',
    });
    scope.provide('sandboxPolicy', {
      defaultMode: 'workspace-write',
      resolve: () => ({ mode: 'workspace-write' }),
    });
    scope.provide('sessions', { get: () => session });
    scope.provide('approval', {
      config: { policy: 'ask' },
      request: () => Promise.resolve('unavailable'),
    });
    scope.provide('permissionPresets', { registerAuto: () => () => undefined });
    scope.provide('workingDirectory', {
      ensure: () => Promise.resolve(home),
    });
    scope.provide('connection', {
      fetch: { register: () => () => undefined },
    });

    const runtime = constructChecked(
      ToolRuntime,
      [scoped, { mode: 'native' }],
      isToolRuntime,
    );
    runtime.register(
      fixture({
        name: 'deploy',
        description: 'deploy to an environment',
        parameters: {
          environment: { type: 'string', required: true },
        },
        execute: (args: unknown) => {
          const environment =
            isRecordValue(args) && typeof args['environment'] === 'string'
              ? args['environment']
              : '';
          reached.push(environment);
          return Promise.resolve([
            { type: 'text', text: `deployed ${environment}` },
          ]);
        },
      }),
    );
    box.runtime = runtime;
  }

  // `apply` registers the gate on the same context; the plugin's own
  // `tools/pre-execute` listener is what decides the call.
  apply(context, CONFIG);
  // Wait for the plugin scope to mount instead of assuming a fixed delay.
  const deadline = Date.now() + 15_000;
  while (box.runtime === undefined) {
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const runtime = box.runtime;
  if (runtime === undefined)
    throw new Error(
      `tool runtime did not mount: ${mountError.message ?? 'no callback ran'}`,
    );

  return {
    reached,
    received,
    execute: async (name, args) => {
      const result: unknown = await runtime.execute({
        callId: `gate-${String(received.length + 1)}`,
        name,
        arguments: args,
        agent: {
          session: {
            id: 'sr-gate',
            header: { id: 'sr-gate', cwd: home },
            snapshotEvents: () => [],
            deriveMessages: () => [],
            append: () => undefined,
          },
        },
        signal: new AbortController().signal,
      });
      // The host materializes a denied pre-execute decision as an error result
      // whose content carries Arbiter's own denial text, so the source of the
      // denial is part of the observation rather than inferred from the tool
      // body not running.
      const content = isRecordValue(result) ? result['content'] : undefined;
      const text = Array.isArray(content)
        ? content
            .map((block) =>
              isRecordValue(block) && typeof block['text'] === 'string'
                ? block['text']
                : '',
            )
            .join('\n')
        : '';
      const decision: GateDecision = isRecordValue(result)
        ? {
            kind: result['isError'] === true ? 'error-denied' : 'ok',
            text,
            ...(typeof result['reason'] === 'string'
              ? { reason: result['reason'] }
              : {}),
          }
        : { kind: 'unknown', text: '' };
      received.push({ name, kind: decision.kind, text: decision.text });
      return decision;
    },
    dispose: async () => {
      for (const dispose of disposers.splice(0)) {
        try {
          Reflect.apply(dispose, undefined, []);
        } catch {
          /* best effort during teardown */
        }
      }
      await rm(home, { recursive: true, force: true });
    },
  };
}

test.describe('real host gate', () => {
  test(
    'the plugin gate and the tester agree on a tool-argument rule',
    { tag: '@smoke' },
    async ({ dsh }) => {
      const gate = await mountGate({ readOnly: true });
      let denied: GateDecision;
      try {
        // A denied call never reaches the tool body.
        denied = await gate.execute('deploy', { environment: 'production' });
        expect(gate.reached).toEqual([]);
      } finally {
        await gate.dispose();
      }

      // The denial is attributed to Arbiter's rule path: the host returns the
      // decision text Arbiter produced, not an unrelated tool or registry error.
      expect(denied).toMatchObject({ kind: 'error-denied' });
      expect(denied.text).toContain('[deny-rule]');

      // The tester answers the same call through the plugin's own HTTP route.
      const response = await fetch(`${dsh.origin}/api/arbiter/test`, {
        method: 'POST',
        headers: {
          cookie: `${dsh.cookie.name}=${dsh.cookie.value}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          inputs: [
            JSON.stringify({
              tool: 'deploy',
              args: { environment: 'production' },
            }),
          ],
          rules: [PRODUCTION_RULE],
        }),
      });
      expect(response.status).toBe(200);
      const payload: unknown = await response.json();
      expect(payload).toMatchObject({
        ok: true,
        results: [{ path: 'deny', tool: 'deploy' }],
      });
    },
  );
});
