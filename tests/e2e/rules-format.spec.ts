import { test, expect } from './fixtures.js';
import type { DshHost } from './dsh/host.js';

/**
 * The current rule format through the real, pinned DSH host.
 *
 * Two things are proven here, without a model request:
 *
 *  1. a profile document that declares `arbiter-config-v3` loads, and the plugin
 *     exposes its tool-argument rule through the real `/api/arbiter/state` route;
 *  2. the real rule tester answers the same tool call the same way the plugin's
 *     rule layer does. The decision itself is produced by the shared evaluator, so
 *     this checks the wiring the issue is about rather than a second matcher.
 */

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

/** The profile config the fixture would seed for this case. */
const CONFIG = { format: 'arbiter-config-v3', rules: [PRODUCTION_RULE] };

interface ToolTestResult {
  readonly path: string;
  readonly tool: string;
  readonly rules: readonly { readonly id: string; readonly outcome: string }[];
}

interface ToolTestResponse {
  readonly ok: boolean;
  readonly results: readonly ToolTestResult[];
}

function cookieHeader(dsh: DshHost): { cookie: string } {
  return { cookie: `${dsh.cookie.name}=${dsh.cookie.value}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asToolTest(value: unknown): ToolTestResponse {
  if (!isRecord(value) || typeof value['ok'] !== 'boolean')
    throw new TypeError('test response must be an object with ok');
  const results: unknown = value['results'];
  if (!Array.isArray(results)) throw new TypeError('results must be an array');
  return {
    ok: value['ok'],
    results: results.map((entry) => {
      if (!isRecord(entry)) throw new TypeError('result must be an object');
      if (
        typeof entry['path'] !== 'string' ||
        typeof entry['tool'] !== 'string'
      )
        throw new TypeError('result must carry path and tool');
      const rules: unknown = entry['rules'];
      if (!Array.isArray(rules)) throw new TypeError('rules must be an array');
      return {
        path: entry['path'],
        tool: entry['tool'],
        rules: rules.map((rule) => {
          if (
            !isRecord(rule) ||
            typeof rule['id'] !== 'string' ||
            typeof rule['outcome'] !== 'string'
          )
            throw new TypeError('rule must carry id and outcome');
          return { id: rule['id'], outcome: rule['outcome'] };
        }),
      };
    }),
  };
}

/** One rule-tester call against the live plugin. */
async function runToolTest(
  dsh: DshHost,
  tool: string,
  args: unknown,
): Promise<ToolTestResult> {
  const response = await fetch(`${dsh.origin}/api/arbiter/test`, {
    method: 'POST',
    headers: { ...cookieHeader(dsh), 'content-type': 'application/json' },
    body: JSON.stringify({
      inputs: [JSON.stringify({ tool, args })],
      rules: [PRODUCTION_RULE],
    }),
  });
  expect(response.status).toBe(200);
  const body = asToolTest(await response.json());
  expect(body.ok).toBe(true);
  const result = body.results[0];
  if (result === undefined) throw new Error('no tester result was returned');
  return result;
}

test.describe('current rule format in the real host', () => {
  test.use({ arbiterConfig: CONFIG });

  test(
    'a declared tool-argument rule loads and the tester agrees on both values',
    { tag: '@smoke' },
    async ({ dshPage, dsh }) => {
      const pageErrors: string[] = [];
      dshPage.on('pageerror', (error) => pageErrors.push(error.message));

      const state = await fetch(`${dsh.origin}/api/arbiter/state`, {
        headers: cookieHeader(dsh),
      });
      expect(state.status).toBe(200);
      const payload: unknown = await state.json();
      expect(payload).toMatchObject({
        configFormat: 'arbiter-config-v3',
        configFormatExplicit: true,
        invalidConfigError: null,
      });

      const production = await runToolTest(dsh, 'deploy', {
        environment: 'production',
      });
      expect(production.tool).toBe('deploy');
      expect(production.path).toBe('deny');
      expect(production.rules).toEqual([
        { id: PRODUCTION_RULE.id, outcome: 'match' },
      ]);

      const staging = await runToolTest(dsh, 'deploy', {
        environment: 'staging',
      });
      expect(staging.path).toBe('review(default)');
      expect(staging.rules).toEqual([
        { id: PRODUCTION_RULE.id, outcome: 'no-match' },
      ]);

      expect(pageErrors).toEqual([]);
    },
  );
});
