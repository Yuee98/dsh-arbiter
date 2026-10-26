/**
 * Rule-tester / evaluator agreement, and what the tester does not do.
 *
 * The tester is only a caller of `evaluateCall`: this file proves the route's
 * answer equals a direct evaluation for the same tool and arguments, including
 * the cases whose explanation is easy to get wrong — a higher-priority unknown,
 * OR conditions, an empty multi-value selection and a partial allow.
 *
 * It also proves the tester has no side effects: no tool execution, no Reviewer
 * request, no audit row and no configuration change.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { AuditStore, resolveAuditPath } from '../../src/audit.js';
import { initializeHost } from '../../src/host/runtime.js';
import { registerRoutes } from '../../src/host/routes.js';
import { SessionAdmissions } from '../../src/host/session-admission.js';
import type {
  ConnectionLike,
  FetchRouteLike,
  HostEnvironment,
  HostServices,
} from '../../src/host/types.js';
import { evaluateCall } from '../../src/rules/match.js';
import type { CommandRule, RulePath } from '../../src/types.js';
import { createStubContext, stubEditor } from '../helpers/host-stub.js';

const FORMAT = 'arbiter-config-v2';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'arbiter-rule-test-route-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** One submitted sample, and the evaluation the gate would have made. */
interface Compared {
  readonly tool: string;
  readonly args: unknown;
  readonly rules: readonly CommandRule[];
}

function directPath(
  compared: Compared,
  identity: 'main' | 'subagent' = 'main',
  cwd = root,
): RulePath {
  return evaluateCall({
    rules: compared.rules,
    tool: compared.tool,
    arguments: compared.args,
    identity,
    workspaceRoot: cwd,
    cwd,
    parentAuthorizationPresent: null,
    historyTruncated: false,
    overlapsDeniedEffect: false,
  }).path;
}

interface Started {
  readonly routes: ReadonlyMap<string, FetchRouteLike>;
  readonly host: HostEnvironment;
  readonly modelCalls: () => number;
  readonly toolCalls: () => number;
  readonly auditRows: () => number;
  readonly auditPath: string;
}

/**
 * A host wired the way the plugin wires it.
 *
 * The Reviewer service is a tripwire, not a stub that could silently succeed: any
 * request through it is counted, so "the tester never asks the Reviewer" is
 * observable rather than assumed.
 */
async function startHost(
  services: Partial<HostServices> = {},
): Promise<Started> {
  const home = join(root, 'home');
  const profileDir = join(home, 'profiles', 'rule-test');
  const documentPath = join(profileDir, 'cordis.patch.yml');
  await mkdir(profileDir, { recursive: true });
  await writeFile(
    documentPath,
    `${JSON.stringify({ format: FORMAT })}\n`,
    'utf8',
  );

  const routes = new Map<string, FetchRouteLike>();
  const connection: ConnectionLike = {
    fetch: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  };
  let modelCalls = 0;
  let toolCalls = 0;
  const parts = createStubContext(
    {
      profileContext: { home, dir: profileDir, name: 'rule-test' },
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
      llm: {
        stream: () => {
          modelCalls += 1;
          throw new Error('the rule tester must not call the Reviewer');
        },
      },
    },
    {
      inject: (names, callback) => {
        if (names.every((name) => name === 'connection')) {
          callback(createStubContext({ connection }).ctx);
        }
        return undefined;
      },
      on: (event) => {
        // Any pre-execute *listener* would mean the tester routed through the
        // gate; the counter is a tripwire for that, not a count of tool runs.
        if (event === 'tools/pre-execute') toolCalls += 1;
        return () => undefined;
      },
    },
  );
  const host = initializeHost(parts.ctx, { format: FORMAT });
  registerRoutes(host, new SessionAdmissions(host));
  return {
    routes,
    host,
    modelCalls: () => modelCalls,
    toolCalls: () => toolCalls,
    auditRows: () => {
      const store = new AuditStore(
        resolveAuditPath(home),
        host.runtime.config.audit,
      );
      try {
        return store.listCalls({ limit: 100, offset: 0 }).total;
      } finally {
        store.close();
      }
    },
    auditPath: resolveAuditPath(home),
  };
}

function routeOf(routes: ReadonlyMap<string, FetchRouteLike>): FetchRouteLike {
  const found = routes.get('/api/arbiter/test');
  if (found === undefined) throw new Error('test route was not registered');
  return found;
}

interface Answer {
  readonly ok: boolean;
  readonly results: readonly {
    readonly input: string;
    readonly tool: string;
    readonly path: string;
    /** Compared against a direct evaluation; a missing one must fail. */
    readonly pathDetail: unknown;
    /** The directory the evaluation actually used. */
    readonly cwd?: string;
    readonly rules: readonly {
      readonly id: string;
      readonly outcome: string;
    }[];
    readonly rule: { readonly id: string } | null;
  }[];
  readonly code?: string;
  readonly errors?: readonly {
    readonly path: string;
    readonly code?: string;
  }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read the answer with the fields these cases assert.
 *
 * `pathDetail` and the per-rule outcomes are compared against a direct
 * evaluation, so a missing one must fail here rather than be read as undefined.
 */
function asAnswer(value: unknown): Answer {
  if (!isRecord(value) || typeof value['ok'] !== 'boolean')
    throw new TypeError('test answer must carry ok');
  const rawResults = value['results'];
  const results = Array.isArray(rawResults)
    ? rawResults.map((entry) => {
        if (!isRecord(entry)) throw new TypeError('result must be an object');
        const pathDetail: unknown = entry['pathDetail'];
        if (!isRecord(pathDetail))
          throw new TypeError('result must carry pathDetail');
        const rawRules = entry['rules'];
        const rules = Array.isArray(rawRules)
          ? rawRules.map((rule) => {
              if (!isRecord(rule))
                throw new TypeError('rule must be an object');
              const id = rule['id'];
              const outcome = rule['outcome'];
              if (typeof id !== 'string' || typeof outcome !== 'string')
                throw new TypeError('rule must carry id and outcome');
              return { id, outcome };
            })
          : [];
        const rule = entry['rule'];
        return {
          input: String(entry['input']),
          tool: String(entry['tool']),
          path: String(entry['path']),
          pathDetail,
          ...(typeof entry['cwd'] === 'string' ? { cwd: entry['cwd'] } : {}),
          rules,
          rule: isRecord(rule) ? { id: String(rule['id']) } : null,
        };
      })
    : [];
  const rawErrors = value['errors'];
  const errors = Array.isArray(rawErrors)
    ? rawErrors.map((entry) => {
        if (!isRecord(entry)) throw new TypeError('error must be an object');
        return {
          path: String(entry['path']),
          ...(typeof entry['code'] === 'string' ? { code: entry['code'] } : {}),
        };
      })
    : undefined;
  return {
    ok: value['ok'],
    results,
    ...(typeof value['code'] === 'string' ? { code: value['code'] } : {}),
    ...(errors === undefined ? {} : { errors }),
  };
}

/** The rule/outcome pairs, which is what "the same answer" means here. */
function outcomesOf(answer: Answer): readonly (readonly [string, string])[] {
  return (answer.results[0]?.rules ?? []).map(
    (rule) => [rule.id, rule.outcome] as const,
  );
}

async function post(
  routes: ReadonlyMap<string, FetchRouteLike>,
  body: unknown,
): Promise<{ readonly status: number; readonly answer: Answer }> {
  const response = await routeOf(routes).fetch(
    new Request('http://fixture/api/arbiter/test', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, answer: asAnswer(await response.json()) };
}

const DENY_PRODUCTION: CommandRule = {
  id: 'deny-production',
  scope: { tools: ['deploy'] },
  conditions: [
    {
      target: 'argument',
      path: '$.environments[*]',
      multi: 'any',
      kind: 'exact',
      pattern: 'production',
    },
  ],
  verdict: 'deny',
};

const ALLOW_TEST: CommandRule = {
  id: 'allow-test',
  scope: { tools: ['deploy'] },
  conditions: [
    {
      target: 'argument',
      path: '$.environments[*]',
      multi: 'all',
      kind: 'exact',
      pattern: 'test',
    },
  ],
  verdict: 'allow',
};

const DENY_REDIRECT: CommandRule = {
  id: 'deny-redirect',
  conditions: [
    { target: 'file_redirect', kind: 'glob', pattern: '/workspace/**' },
  ],
  verdict: 'deny',
};

const ALLOW_CAT: CommandRule = {
  id: 'allow-cat',
  conditions: [{ target: 'command', kind: 'exact', pattern: 'cat notes.txt' }],
  verdict: 'allow',
};

describe('rule test route with the shared evaluator', () => {
  test('a matching deny rule agrees with a direct evaluation', async () => {
    const harness = await startHost();
    const rules = [DENY_PRODUCTION];
    const { status, answer } = await post(harness.routes, {
      samples: [
        {
          tool: 'deploy',
          args: { environments: ['test', 'production'] },
        },
      ],
      rules,
    });
    expect(status).toBe(200);
    const result = answer.results[0];
    expect(result?.path).toBe('deny');
    expect(result?.pathDetail).toEqual(
      expect.objectContaining({ kind: 'rule', verdict: 'deny' }),
    );
    expect(outcomesOf(answer)).toEqual([['deny-production', 'match']]);
    expect(result?.pathDetail).toEqual(
      directPath({
        tool: 'deploy',
        args: { environments: ['test', 'production'] },
        rules,
      }),
    );
  });

  test('a higher-priority unknown blocks an allow in both paths', async () => {
    const harness = await startHost();
    // `$TARGET` cannot be resolved statically, so the deny's redirect
    // condition is unknown rather than a mismatch. The allow covers only
    // `echo a`; the unknown deny must keep it from deciding the call.
    const rules = [
      {
        id: 'deny-redirect',
        conditions: [
          { target: 'file_redirect', kind: 'glob', pattern: '/srv/**' },
        ],
        verdict: 'deny',
      } satisfies CommandRule,
      {
        id: 'allow-echo',
        conditions: [{ target: 'command', kind: 'regex', pattern: 'echo .*' }],
        verdict: 'allow',
      } satisfies CommandRule,
    ];
    const args = { command: 'echo a > $TARGET' };
    const { answer } = await post(harness.routes, {
      samples: [{ tool: 'bash', args }],
      rules,
    });
    const result = answer.results[0];
    expect(outcomesOf(answer)).toEqual([
      ['deny-redirect', 'unknown'],
      ['allow-echo', 'match'],
    ]);
    expect(result?.path).toBe('review(default)');
    expect(result?.pathDetail).toEqual({
      kind: 'review-default',
      reason: 'unresolved',
    });
    expect(result?.pathDetail).toEqual(
      directPath({ tool: 'bash', args, rules }),
    );
  });

  test('OR conditions and an empty multi-value selection agree', async () => {
    const harness = await startHost();
    const rules = [
      {
        id: 'or-rule',
        conditions: [
          { target: 'tool', kind: 'exact', pattern: 'deploy' },
          {
            target: 'argument',
            path: '$.environments[*]',
            multi: 'any',
            kind: 'exact',
            pattern: 'production',
          },
        ],
        verdict: 'force-review',
      } satisfies CommandRule,
    ];
    // A deploy call with no `environments` field: the tool alternative matches,
    // the argument alternative selects nothing. OR must still decide the rule.
    const args = { dryRun: true };
    const { answer } = await post(harness.routes, {
      samples: [{ tool: 'deploy', args }],
      rules,
    });
    const result = answer.results[0];
    expect(outcomesOf(answer)).toEqual([['or-rule', 'match']]);
    expect(result?.path).toBe('force-review');
    expect(result?.pathDetail).toEqual(
      directPath({ tool: 'deploy', args, rules }),
    );
  });

  test('an empty all selection never matches in either path', async () => {
    const harness = await startHost();
    const args = { environments: [] };
    const { answer } = await post(harness.routes, {
      samples: [{ tool: 'deploy', args }],
      rules: [ALLOW_TEST],
    });
    const result = answer.results[0];
    expect(outcomesOf(answer)).toEqual([['allow-test', 'no-match']]);
    expect(result?.path).toBe('review(default)');
    expect(result?.pathDetail).toEqual({
      kind: 'review-default',
      reason: 'no-match',
    });
    expect(result?.pathDetail).toEqual(
      directPath({ tool: 'deploy', args, rules: [ALLOW_TEST] }),
    );
  });

  test('a partial allow keeps going to review in both paths', async () => {
    const harness = await startHost();
    // Two commands; the allow covers one of them, so it cannot admit the call.
    const args = { command: 'cat notes.txt && cat /etc/passwd' };
    const rules = [ALLOW_CAT];
    const { answer } = await post(harness.routes, {
      samples: [{ tool: 'bash', args }],
      rules,
    });
    const result = answer.results[0];
    expect(outcomesOf(answer)).toEqual([['allow-cat', 'match']]);
    expect(result?.path).toBe('review(default)');
    expect(result?.pathDetail).toEqual({
      kind: 'review-default',
      reason: 'partial-allow',
    });
    expect(result?.pathDetail).toEqual(
      directPath({ tool: 'bash', args, rules }),
    );
  });

  test('the legacy one-line input still resolves through the same evaluator', async () => {
    const harness = await startHost();
    const { answer } = await post(harness.routes, {
      inputs: ['cat notes.txt'],
      rules: [ALLOW_CAT],
    });
    const result = answer.results[0];
    expect(result?.path).toBe('allow');
    expect(result?.rule?.id).toBe('allow-cat');
  });

  test('an invalid draft is reported with the condition that owns it', async () => {
    const harness = await startHost();
    const { status, answer } = await post(harness.routes, {
      samples: [{ tool: 'deploy', args: {} }],
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
    expect(status).toBe(400);
    expect(answer.code).toBe('invalid-rule');
    expect(answer.results).toEqual([]);
  });

  test('a duplicate rule id rejects the whole draft, not just the later rule', async () => {
    const harness = await startHost();
    // Per-rule validation would accept both and silently drop the second at
    // compile time, reporting `allow` for a draft the editor would refuse to
    // save. Cross-rule validation is what makes the tester agree with saving.
    const { status, answer } = await post(harness.routes, {
      samples: [{ tool: 'deploy', args: {} }],
      rules: [
        {
          id: 'same',
          conditions: [{ target: 'tool', kind: 'exact', pattern: 'deploy' }],
          verdict: 'allow',
        },
        {
          id: 'same',
          conditions: [{ target: 'tool', kind: 'exact', pattern: 'deploy' }],
          verdict: 'deny',
        },
      ],
    });
    expect(status).toBe(400);
    expect(answer.code).toBe('invalid-rule');
    expect(answer.results).toEqual([]);
  });

  test('a selector error keeps the rule index it actually came from', async () => {
    const harness = await startHost();
    const { status, answer } = await post(harness.routes, {
      samples: [{ tool: 'deploy', args: {} }],
      rules: [
        {
          id: 'fine',
          conditions: [{ target: 'tool', kind: 'exact', pattern: 'deploy' }],
          verdict: 'allow',
        },
        {
          id: 'broken',
          conditions: [
            { target: 'argument', path: '$.', kind: 'exact', pattern: 'x' },
          ],
          verdict: 'deny',
        },
      ],
    });
    expect(status).toBe(400);
    const issue = answer.errors?.[0];
    // The rule is at index 1, so parsing each rule as `rules[0]` would point at
    // the wrong condition.
    expect(issue?.path).toBe('rules[1].conditions[0].path');
    expect(issue?.code).toBe('rule.path-invalid');
  });

  test('a supplied non-array rules field is rejected rather than ignored', async () => {
    const harness = await startHost();
    const { status, answer } = await post(harness.routes, {
      samples: [{ tool: 'deploy', args: {} }],
      rules: {},
    });
    expect(status).toBe(400);
    expect(answer.code).toBe('invalid-rule');
  });

  test('the sample cwd decides where a relative redirect resolves', async () => {
    const harness = await startHost();
    // The same command and rule, evaluated under two working directories: the
    // target is `/workspace/secret.txt` only in the first, so a tester that
    // used its own process cwd would answer another question.
    const rules: CommandRule[] = [DENY_REDIRECT];
    const sample = { tool: 'bash', args: { command: 'echo x > secret.txt' } };
    const inside = await post(harness.routes, {
      samples: [{ ...sample, cwd: '/workspace' }],
      rules,
    });
    const outside = await post(harness.routes, {
      samples: [{ ...sample, cwd: '/tmp/elsewhere' }],
      rules,
    });
    expect(inside.answer.results[0]?.path).toBe('deny');
    expect(outside.answer.results[0]?.path).toBe('review(default)');
    expect(inside.answer.results[0]?.pathDetail).toEqual(
      directPath(
        { tool: 'bash', args: sample.args, rules },
        'main',
        '/workspace',
      ),
    );
    expect(outside.answer.results[0]?.pathDetail).toEqual(
      directPath(
        { tool: 'bash', args: sample.args, rules },
        'main',
        '/tmp/elsewhere',
      ),
    );
  });

  test('the answer reports the directory the evaluation actually used', async () => {
    const harness = await startHost();
    // Without this field a relative-path answer is not reproducible: the caller
    // cannot tell which directory produced it.
    const withCwd = await post(harness.routes, {
      samples: [{ tool: 'bash', args: { command: 'pwd' }, cwd: '/workspace' }],
      rules: [],
    });
    expect(withCwd.answer.results[0]).toMatchObject({ cwd: '/workspace' });
    const fallback = await post(harness.routes, {
      samples: [{ tool: 'bash', args: { command: 'pwd' } }],
      rules: [],
    });
    expect(fallback.answer.results[0]?.cwd).toBe(process.cwd());
  });

  test('a sample without a tool is rejected instead of evaluated', async () => {
    const harness = await startHost();
    const { status, answer } = await post(harness.routes, {
      samples: [{ args: {} }],
    });
    expect(status).toBe(400);
    expect(answer.code).toBe('bad-request');
  });

  test('the tester runs no tool, asks no Reviewer and writes no audit row', async () => {
    const harness = await startHost();
    const before = harness.auditRows();
    const entriesBefore = await readdir(join(root, 'home'), {
      recursive: true,
    });

    const { status } = await post(harness.routes, {
      samples: [
        { tool: 'deploy', args: { environments: ['production'] } },
        { tool: 'bash', args: { command: 'rm -rf /tmp/build' } },
      ],
      rules: [DENY_PRODUCTION],
    });
    expect(status).toBe(200);
    // A denial is only a path: nothing ran, so no tool listener fired and the
    // Reviewer service was never entered.
    expect(harness.toolCalls()).toBe(0);
    expect(harness.modelCalls()).toBe(0);
    // No approval audit row, and no new file appeared under the profile home.
    expect(harness.auditRows()).toBe(before);
    expect(await readdir(join(root, 'home'), { recursive: true })).toEqual(
      entriesBefore,
    );
    // The draft is not applied: the effective revision did not change.
    expect(harness.host.runtime.config.rules).toEqual([]);
  });
});
