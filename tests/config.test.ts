import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

import { DEFAULT_CONFIG, parseConfig, parseDocument } from '../src/config.js';
import type { LocaleTree } from '../src/client/i18n/catalog.js';
import { flattenCatalog } from '../src/client/i18n/catalog.js';
import { issueKey } from '../src/client/view-issues.js';
import { PRODUCTION_PACKAGE } from '../src/reviewer/package.js';
import { PRODUCTION_VARIANT } from '../src/reviewer/variant.js';

describe('configuration', () => {
  test('defaults are complete and valid', () => {
    const parsed = parseConfig({});
    expect(parsed.errors).toEqual([]);
    expect(parsed.config.modes).toEqual({ main: 'ask', subagent: 'no-ask' });
    expect(parsed.config.reviewer.chat.provider).toBe('session');
    expect(parsed.config.audit.retentionDays).toBe(30);
    expect(parsed.config.audit.retentionBytes).toBe(1024 * 1024 * 1024);
  });

  test('accepts a whole-value regex without requiring an anchor', () => {
    // The old model required a leading `^` because it searched the text. The
    // canonical model matches the whole value, so an unanchored expression is a
    // legal and deliberately narrower pattern.
    const parsed = parseConfig({
      format: 'arbiter-config-v3',
      enabled: false,
      rules: [
        {
          id: 'whole',
          conditions: [{ target: 'command', kind: 'regex', pattern: 'gh pr' }],
          verdict: 'allow',
        },
      ],
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.config.enabled).toBe(false);
    expect(parsed.config.rules).toHaveLength(1);
  });

  test('rejects an invalid regex without dropping the rest of the configuration', () => {
    const parsed = parseConfig({
      format: 'arbiter-config-v3',
      enabled: false,
      rules: [
        {
          id: 'bad',
          conditions: [{ target: 'command', kind: 'regex', pattern: '(' }],
          verdict: 'allow',
        },
        {
          id: 'ok',
          conditions: [{ target: 'command', kind: 'regex', pattern: 'gh pr' }],
          verdict: 'allow',
        },
      ],
    });
    expect(parsed.errors).toEqual([
      expect.objectContaining({ path: 'rules[0]', code: 'rule.regex-syntax' }),
    ]);
    expect(parsed.config.enabled).toBe(false);
    // Both drafts are retained for editing, but the invalid one can never match.
    expect(parsed.config.rules.map((rule) => rule.id)).toEqual(['bad', 'ok']);
  });

  test('rejects unknown modes and an unknown reviewer type', () => {
    const parsed = parseConfig({
      modes: { main: 'yolo', subagent: 'nope' },
      reviewer: { type: 'magic' },
    });
    expect(parsed.errors.map((error) => error.path)).toEqual(
      expect.arrayContaining(['modes.main', 'modes.subagent', 'reviewer.type']),
    );
    // Absent/invalid values fall back to the confirmed defaults.
    expect(parsed.config.modes.main).toBe('ask');
    expect(parsed.config.modes.subagent).toBe('no-ask');
  });

  test('names the retired modes instead of converting them', () => {
    // A stored document from the previous build is not silently reinterpreted:
    // `progress` widened the matrix, and `normal`/`strict` were one engine plus a
    // channel switch. Both are refused with the replacement named, so an
    // operator learns the setting changed meaning rather than losing it.
    const parsed = parseConfig({
      modes: { main: 'progress', subagent: 'strict' },
    });
    const retired = parsed.errors.filter(
      (error) => error.code === 'modes.retired',
    );
    expect(retired.map((error) => error.path)).toEqual([
      'modes.main',
      'modes.subagent',
    ]);
    // Nothing is converted: the fallback defaults apply, not a mapped value.
    expect(parsed.config.modes).toEqual({ main: 'ask', subagent: 'no-ask' });
  });

  test('refuses the retired threshold and probe sections', () => {
    // A document that still tunes `tauRisk` or `probeMode` is an error, not a
    // silently ignored section: the operator must not believe a setting applies.
    const parsed = parseConfig({
      policy: { normal: { tauRisk: 0.6 }, probeMode: 'override' },
    });
    expect(parsed.errors.map((error) => error.path)).toEqual(
      expect.arrayContaining(['policy.normal', 'policy.probeMode']),
    );
    expect(parsed.config.policy).toEqual({ version: 'arbiter-policy-v3' });
  });

  test('requires a URL and credential reference for the decision backend', () => {
    const parsed = parseConfig({
      reviewer: { type: 'decision', decision: { url: '', apiKeyRef: '' } },
    });
    expect(parsed.errors.map((error) => error.path)).toEqual(
      expect.arrayContaining([
        'reviewer.decision.url',
        'reviewer.decision.apiKeyRef',
      ]),
    );
  });

  test.each([
    ['reviewer.model-required', ''],
    ['reviewer.model-mismatch', 'clef-flash'],
  ])('%s has a localized message in both catalogs', async (code, model) => {
    // The key comes from the same function the UI uses, and the catalog is
    // flattened the same way the loader flattens it, so this asserts what the
    // renderer would actually find rather than a second invented mapping.
    const key = `config.issue.${issueKey(code)}`;
    for (const locale of ['zh', 'en'] as const) {
      // The file is the shipped catalog; reading it as text keeps the test
      // independent of the resource module's literal import type.
      const tree = await readLocaleTree(locale);
      const catalog = flattenCatalog({ config: tree });
      const template = catalog[key];
      expect(template, `${locale} ${key}`).toBeDefined();
      expect(template?.length ?? 0).toBeGreaterThan(0);
    }
    // The code the test names must be the one the parser actually emits.
    const parsed = parseConfig({
      reviewer: {
        type: 'decision',
        decision: {
          url: 'https://api.cloudflare.com/client/v4/accounts/a/ai/run/@cf/cloudflare/clef',
          apiKeyRef: 'K',
          model,
        },
      },
    });
    expect(parsed.errors.map((error) => error.code)).toContain(code);
  });

  test('rejects a URL that cannot be parsed, not just one without a scheme', () => {
    // `https://` satisfies the scheme pattern and then throws when the adapter
    // reads its pathname; a configuration error is the place to say so.
    const parsed = parseConfig({
      reviewer: {
        type: 'decision',
        decision: { url: 'https://', apiKeyRef: 'K', model: 'clef' },
      },
    });
    expect(parsed.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'reviewer.decision.url',
          code: 'reviewer.url-scheme',
        }),
      ]),
    );
  });

  test.each([
    ['https://api.cloudflare.com/client/v4/accounts/a/ai/run'],
    ['https://api.typesafe.ai/v1/systemone'],
  ])('requires a model for %s', (url) => {
    // `asString` accepts an explicit empty string, so presence is this check's
    // job rather than the field parser's.
    const parsed = parseConfig({
      reviewer: {
        type: 'decision',
        decision: { url, apiKeyRef: 'K', model: '' },
      },
    });
    expect(parsed.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'reviewer.decision.model',
          code: 'reviewer.model-required',
        }),
      ]),
    );
  });

  test('rejects a model the Cloudflare model-specific path does not serve', () => {
    const parsed = parseConfig({
      reviewer: {
        type: 'decision',
        decision: {
          url: 'https://api.cloudflare.com/client/v4/accounts/a/ai/run/@cf/cloudflare/clef',
          apiKeyRef: 'K',
          model: 'clef-flash',
        },
      },
    });
    expect(parsed.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'reviewer.decision.model',
          code: 'reviewer.model-mismatch',
        }),
      ]),
    );
  });

  test('does not impose model equality on an unrecognized custom path', () => {
    // The narrow recognizer matters here: a broader `<vendor>/<model>` rule
    // would reject this endpoint even though it is a valid custom service.
    const parsed = parseConfig({
      reviewer: {
        type: 'decision',
        decision: {
          url: 'https://example.test/ai/run/acme/review',
          apiKeyRef: 'K',
          model: 'custom',
        },
      },
    });
    expect(
      parsed.errors.filter((error) => error.code === 'reviewer.model-mismatch'),
    ).toEqual([]);
  });

  test('warns about a broad allow shadowed by force-review', () => {
    const parsed = parseConfig({
      format: 'arbiter-config-v3',
      rules: [
        {
          id: 'relay-trust',
          conditions: [
            { target: 'command', kind: 'regex', pattern: 'gpt-relay' },
          ],
          verdict: 'allow',
        },
        {
          id: 'relay-prod',
          conditions: [
            { target: 'command', kind: 'regex', pattern: 'gpt-relay send' },
          ],
          verdict: 'force-review',
        },
      ],
    });
    expect(
      parsed.warnings.some((warning) =>
        warning.message.includes('relay-trust'),
      ),
    ).toBe(true);
    // A warning never blocks saving.
    expect(parsed.errors).toEqual([]);
  });

  test('a tool condition matches the tool name itself', () => {
    const parsed = parseConfig({
      format: 'arbiter-config-v3',
      rules: [
        {
          id: 'any',
          conditions: [{ target: 'tool', kind: 'exact', pattern: 'read' }],
          verdict: 'allow',
        },
      ],
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.config.rules[0]?.conditions[0]?.target).toBe('tool');
  });

  test('enforces the custom rules character limit', () => {
    const parsed = parseConfig({ context: { customRules: 'x'.repeat(2001) } });
    expect(
      parsed.errors.some((error) => error.path === 'context.customRules'),
    ).toBe(true);
  });

  test('default configuration remains the fallback shape', () => {
    expect(DEFAULT_CONFIG.policy.version).toBe('arbiter-policy-v3');
    expect(DEFAULT_CONFIG.rules).toEqual([]);
  });

  test('the confirmed defaults are the frozen candidate, not a reading of them', () => {
    // RQ-16 applies the decided candidate by *not* adding a knob: the prompt axis has no
    // configuration member at all, so there is nothing a user could set to a variant and
    // nothing for a default to drift to. These assertions pin that the default is the
    // decided package rather than a look-alike.
    expect(DEFAULT_CONFIG.modes).toEqual({ main: 'ask', subagent: 'no-ask' });
    expect(DEFAULT_CONFIG.reviewer.type).toBe('chat');
    expect(DEFAULT_CONFIG.reviewer.chat.model).toBe('');
    expect(DEFAULT_CONFIG.reviewer.chat.temperature).toBe(0);
    // The matrix is not a configuration value: both modes apply the shared one, so no
    // default threshold exists to regress and no user-tunable quantile was added.
    expect(DEFAULT_CONFIG).not.toHaveProperty('thresholds');
    expect(DEFAULT_CONFIG).not.toHaveProperty('quantiles');
    expect(PRODUCTION_VARIANT.prompt).toBe('no-probe');
    expect(PRODUCTION_PACKAGE.asksProbe).toBe(false);
  });
});

describe('first install defaults', () => {
  test('a missing document yields the confirmed first-release defaults', () => {
    for (const raw of [undefined, null]) {
      const parsed = parseDocument(raw);
      expect(parsed.errors).toEqual([]);
      expect(parsed.warnings).toEqual([]);
      expect(parsed.config).toMatchObject({
        enabled: true,
        modes: { main: 'ask', subagent: 'no-ask' },
        rules: [],
        reviewer: { type: 'chat', chat: { provider: 'session' } },
        audit: {
          enabled: true,
          retentionDays: 30,
          retentionBytes: 1024 * 1024 * 1024,
        },
      });
      expect(parsed.config.format).toBeUndefined();
    }
  });

  test('an existing document keeps its values instead of being overwritten by defaults', () => {
    const parsed = parseConfig({
      enabled: false,
      boundary: 'trusted',
      modes: { main: 'no-ask' },
      audit: { retentionDays: 7, retentionBytes: 1024 * 1024 },
      reviewer: {
        type: 'decision',
        decision: { url: 'https://example.test/review', apiKeyRef: 'TEST_KEY' },
      },
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.config.enabled).toBe(false);
    expect(parsed.config.boundary).toBe('trusted');
    expect(parsed.config.modes).toEqual({
      main: 'no-ask',
      subagent: 'no-ask',
    });
    expect(parsed.config.audit).toMatchObject({
      retentionDays: 7,
      retentionBytes: 1024 * 1024,
    });
    expect(parsed.config.reviewer.type).toBe('decision');
  });

  test('refuses a subagent mode of ask instead of converting it', () => {
    // A subagent has no approval channel, so `ask` never opened a question; the
    // setting stopped being a choice. It is reported by its own code rather than
    // silently rewritten, so an operator learns why instead of finding a value
    // changed on the next save.
    const parsed = parseConfig({ modes: { subagent: 'ask' } });
    expect(parsed.errors).toEqual([
      {
        path: 'modes.subagent',
        message:
          'a subagent has no approval channel, so "ask" never opened a question; subagents are fixed to "no-ask" and the setting accepts nothing else',
        code: 'modes.subagent-fixed',
        params: { value: 'ask' },
      },
    ]);
    // The fallback keeps the only accepted value; nothing is mapped onto `ask`.
    expect(parsed.config.modes.subagent).toBe('no-ask');
  });

  test('accepts the only subagent mode and omitting the field', () => {
    for (const modes of [{}, { subagent: 'no-ask' }]) {
      const parsed = parseConfig({ modes });
      expect(parsed.errors).toEqual([]);
      expect(parsed.config.modes.subagent).toBe('no-ask');
    }
  });

  test('a save or malformed body without an object config is an error', () => {
    for (const raw of ['[]', null, undefined, 7]) {
      const parsed = parseConfig(raw);
      expect(parsed.errors).toEqual([
        {
          path: '',
          message: 'configuration must be an object',
          code: 'config.not-object',
        },
      ]);
      expect(parsed.config).toBe(DEFAULT_CONFIG);
    }
  });
});

describe('strict validation of supplied fields', () => {
  test('a wrong-typed security field is an error, never a permissive default', () => {
    const parsed = parseConfig({
      format: 'arbiter-config-v3',
      enabled: 'false',
      rules: [
        {
          id: 'narrow',
          enabled: 'false',
          scope: { agents: 'main' },
          conditions: [
            { target: 'command', kind: 'regex', pattern: '^gh pr view' },
          ],
          verdict: 'allow',
        },
      ],
    });
    expect(parsed.errors.map((error) => error.path)).toEqual(
      expect.arrayContaining([
        'enabled',
        'rules[0].enabled',
        'rules[0].scope.agents',
      ]),
    );
    expect(parsed.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(['type.boolean', 'type.agent-scope']),
    );
  });

  test('the PROJECT_RULES owner keeps its documented file fallback', () => {
    // #32 owns this whitelist: an empty selection still reads the two
    // documented workspace-root files, and only those may supply guidance.
    const empty = parseConfig({ context: { projectRules: { files: [] } } });
    expect(empty.errors).toEqual([]);
    expect(empty.config.context.projectRules.files).toEqual([
      '.dsh/arbiter.md',
      '.arbiter.md',
    ]);

    const outside = parseConfig({
      context: { projectRules: { files: ['../outside.md'] } },
    });
    expect(outside.errors).toEqual([
      expect.objectContaining({
        path: 'context.projectRules.files',
        code: 'context.project-files',
      }),
    ]);
    expect(outside.config.context.projectRules.files).toEqual([
      '.dsh/arbiter.md',
      '.arbiter.md',
    ]);
  });

  test('a non-array project file list is reported, not replaced silently', () => {
    const parsed = parseConfig({
      context: { projectRules: { files: '.arbiter.md' } },
    });
    expect(parsed.errors).toEqual([
      expect.objectContaining({ path: 'context.projectRules.files' }),
    ]);
  });

  test('a malformed rule cannot turn into an active or broader allow', () => {
    const parsed = parseConfig({
      format: 'arbiter-config-v3',
      rules: [
        {
          id: 'bad-scope',
          scope: { agents: ['main', 7] },
          conditions: [{ target: 'command', kind: 'regex', pattern: '^rm' }],
          verdict: 'allow',
        },
      ],
    });
    expect(
      parsed.errors.some((error) => error.path === 'rules[0].scope.agents'),
    ).toBe(true);
    // The rule is retained for editing but nothing about it may be applied.
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  test('an unknown verdict is an error, never a permissive allow', () => {
    const parsed = parseConfig({
      format: 'arbiter-config-v3',
      rules: [
        {
          id: 'typo',
          conditions: [
            { target: 'command', kind: 'exact', pattern: 'echo hi' },
          ],
          verdict: 'alow',
        },
      ],
    });
    expect(parsed.errors).toEqual([
      expect.objectContaining({ path: 'rules[0].verdict', code: 'enum.value' }),
    ]);
  });

  test('a disabled rule is still validated', () => {
    const parsed = parseConfig({
      format: 'arbiter-config-v3',
      rules: [
        {
          id: 'disabled',
          enabled: false,
          conditions: [{ target: 'command', kind: 'regex', pattern: '(' }],
          verdict: 'allow',
        },
      ],
    });
    expect(parsed.errors).toEqual([
      expect.objectContaining({ code: 'rule.regex-syntax' }),
    ]);
  });

  test('a dropped rule does not shift the paths of later errors', () => {
    const parsed = parseConfig({
      format: 'arbiter-config-v3',
      rules: [
        // Dropped during parsing: no conditions at all.
        { id: 'dropped', verdict: 'allow' },
        {
          id: 'broken-regex',
          conditions: [{ target: 'command', kind: 'regex', pattern: '(' }],
          verdict: 'allow',
        },
      ],
    });
    expect(parsed.errors.map((error) => [error.path, error.code])).toEqual([
      ['rules[0].conditions', 'rule.conditions-empty'],
      ['rules[1]', 'rule.regex-syntax'],
    ]);
    expect(parsed.errors[1]?.params?.['id']).toBe('broken-regex');
  });

  test('an exact null pattern is preserved instead of becoming an empty string', () => {
    const parsed = parseConfig({
      format: 'arbiter-config-v3',
      rules: [
        {
          id: 'null-value',
          conditions: [
            {
              target: 'argument',
              path: '$.value',
              kind: 'exact',
              pattern: null,
            },
          ],
          verdict: 'deny',
        },
      ],
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.config.rules[0]?.conditions[0]?.pattern).toBeNull();
  });

  test('duplicate rule ids are rejected', () => {
    const parsed = parseConfig({
      format: 'arbiter-config-v3',
      rules: [
        {
          id: 'twice',
          conditions: [{ target: 'command', kind: 'exact', pattern: 'a' }],
          verdict: 'allow',
        },
        {
          id: 'twice',
          conditions: [{ target: 'command', kind: 'exact', pattern: 'b' }],
          verdict: 'deny',
        },
      ],
    });
    expect(parsed.errors).toEqual([
      expect.objectContaining({ code: 'rule.duplicateId' }),
    ]);
  });

  test('supplied issue codes localize without changing the developer message', () => {
    const parsed = parseConfig({ enabled: 'yes' });
    const issue = parsed.errors[0];
    expect(issue?.code).toBe('type.boolean');
    expect(issue?.message).toBe('must be a boolean');
    expect(issue?.path).toBe('enabled');
  });
});

describe('malformed parent objects', () => {
  test('a supplied non-object parent is an error instead of reverting silently', () => {
    const parsed = parseConfig({
      modes: 'ask',
      reviewer: null,
      policy: 7,
      context: [],
      audit: 'off',
      breaker: false,
    });
    expect(parsed.errors.map((error) => error.path)).toEqual(
      expect.arrayContaining([
        'modes',
        'reviewer',
        'policy',
        'context',
        'audit',
        'breaker',
      ]),
    );
    expect(parsed.errors.every((error) => error.code === 'type.object')).toBe(
      true,
    );
    // The normalized value still carries defaults, but the document is invalid,
    // so the caller keeps the configuration that is already in effect.
    expect(parsed.config.modes.main).toBe('ask');
  });

  test('absent parents still use defaults without errors', () => {
    const parsed = parseConfig({ enabled: false });
    expect(parsed.errors).toEqual([]);
    expect(parsed.config.modes).toEqual({
      main: 'ask',
      subagent: 'no-ask',
    });
  });

  test('a malformed nested reviewer section is reported at its own path', () => {
    const parsed = parseConfig({ reviewer: { type: 'chat', chat: 'session' } });
    expect(parsed.errors).toEqual([
      expect.objectContaining({
        path: 'reviewer.chat',
        code: 'type.object',
      }),
    ]);
  });
});

describe('rule compiler issues carry localized parameters', () => {
  test('a retired rule shape reports a stable reason code', () => {
    const parsed = parseConfig({
      rules: [
        {
          id: 'unanchored',
          match: { node: 'command', kind: 'regex', pattern: 'gh pr' },
          verdict: 'allow',
        },
      ],
    });
    const issue = parsed.errors.find((error) => error.path === 'rules[0]');
    expect(issue?.code).toBe('rule.format-retired');
    expect(issue?.params).toMatchObject({ field: 'match' });
    // The developer sentence stays available for logs and unknown reasons.
    expect(issue?.message).toContain('retired rule format');
  });

  test('an invalid regex reports its own stable code', () => {
    const parsed = parseConfig({
      format: 'arbiter-config-v3',
      rules: [
        {
          id: 'broken',
          conditions: [{ target: 'command', kind: 'regex', pattern: '(' }],
          verdict: 'allow',
        },
      ],
    });
    const issue = parsed.errors.find((error) => error.path === 'rules[0]');
    expect(issue?.code).toBe('rule.regex-syntax');
    expect(issue?.params).toMatchObject({ id: 'broken' });
  });

  test('a duplicate id reports the duplicated identifier', () => {
    const parsed = parseConfig({
      format: 'arbiter-config-v3',
      rules: [
        {
          id: 'same',
          conditions: [{ target: 'command', kind: 'exact', pattern: 'pwd' }],
          verdict: 'allow',
        },
        {
          id: 'same',
          conditions: [{ target: 'command', kind: 'exact', pattern: 'ls' }],
          verdict: 'allow',
        },
      ],
    });
    const issue = parsed.errors.find(
      (error) => error.code === 'rule.duplicateId',
    );
    expect(issue?.params).toMatchObject({ id: 'same' });
  });

  test('a shadowing warning is localizable by code', () => {
    const parsed = parseConfig({
      format: 'arbiter-config-v3',
      rules: [
        {
          id: 'relay-trust',
          conditions: [
            { target: 'command', kind: 'regex', pattern: 'gpt-relay' },
          ],
          verdict: 'allow',
        },
        {
          id: 'relay-prod',
          conditions: [
            { target: 'command', kind: 'regex', pattern: 'gpt-relay send' },
          ],
          verdict: 'force-review',
        },
      ],
    });
    const warning = parsed.warnings.find(
      (item) => item.code === 'rule.shadowed',
    );
    expect(warning?.params).toEqual({
      allow: 'relay-trust',
      review: 'relay-prod',
    });
  });
});

/**
 * Read one shipped locale file as a nested tree.
 *
 * The shipped catalogs are plain JSON objects whose leaves are strings; the
 * value is walked rather than asserted so a malformed file fails here instead
 * of producing a misleading "missing key" further down.
 */
async function readLocaleTree(locale: string): Promise<LocaleTree> {
  const text = await readFile(
    new URL(`../locale/${locale}/config.json`, import.meta.url),
    'utf8',
  );
  const parsed: unknown = JSON.parse(text);
  const tree = nestedTree(parsed);
  if (tree === null) {
    throw new Error(`locale/${locale}/config.json must be a nested object`);
  }
  return tree;
}

function nestedTree(value: unknown): LocaleTree | null {
  if (value === null || typeof value !== 'object') return null;
  const out: Record<string, string | LocaleTree> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') {
      out[key] = item;
      continue;
    }
    const nested = nestedTree(item);
    if (nested === null) return null;
    out[key] = nested;
  }
  return out;
}
