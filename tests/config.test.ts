import { describe, expect, test } from 'vitest';

import {
  DEFAULT_CONFIG,
  parseConfig,
  parseDocument,
  registerConfigFormat,
  registeredConfigFormats,
} from '../src/config.js';
import { evaluateCall } from '../src/rules/match.js';

describe('configuration', () => {
  test('defaults are complete and valid', () => {
    const parsed = parseConfig({});
    expect(parsed.errors).toEqual([]);
    expect(parsed.config.modes).toEqual({ main: 'normal', subagent: 'strict' });
    expect(parsed.config.reviewer.chat.provider).toBe('session');
    expect(parsed.config.audit.retentionDays).toBe(30);
    expect(parsed.config.audit.retentionBytes).toBe(1024 * 1024 * 1024);
  });

  test('accepts a whole-value regex without requiring an anchor', () => {
    // The old model required a leading `^` because it searched the text. The
    // canonical model matches the whole value, so an unanchored expression is a
    // legal and deliberately narrower pattern.
    const parsed = parseConfig({
      format: 'arbiter-config-v2',
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
      format: 'arbiter-config-v2',
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
      modes: { main: 'yolo', subagent: 'normal' },
      reviewer: { type: 'magic' },
    });
    expect(parsed.errors.map((error) => error.path)).toEqual(
      expect.arrayContaining(['modes.main', 'modes.subagent', 'reviewer.type']),
    );
    expect(parsed.config.modes.main).toBe('normal');
    expect(parsed.config.modes.subagent).toBe('strict');
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

  test('warns about a broad allow shadowed by force-review', () => {
    const parsed = parseConfig({
      format: 'arbiter-config-v2',
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
      format: 'arbiter-config-v2',
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
    expect(DEFAULT_CONFIG.policy.version).toBe('arbiter-policy-v2');
    expect(DEFAULT_CONFIG.rules).toEqual([]);
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
        modes: { main: 'normal', subagent: 'strict' },
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
      modes: { main: 'strict', subagent: 'progress' },
      audit: { retentionDays: 7, retentionBytes: 1024 * 1024 },
      reviewer: {
        type: 'decision',
        decision: { url: 'https://example.test/review', apiKeyRef: 'TEST_KEY' },
      },
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.config.enabled).toBe(false);
    expect(parsed.config.modes).toEqual({
      main: 'strict',
      subagent: 'progress',
    });
    expect(parsed.config.audit).toMatchObject({
      retentionDays: 7,
      retentionBytes: 1024 * 1024,
    });
    expect(parsed.config.reviewer.type).toBe('decision');
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

describe('configuration format identification', () => {
  test('an undeclared document keeps the legacy format and warns only when rules exist', () => {
    const empty = parseConfig({ enabled: false });
    expect(empty.config.format).toBeUndefined();
    expect(empty.warnings.some((warning) => warning.path === 'format')).toBe(
      false,
    );

    const withRules = parseConfig({
      rules: [
        {
          id: 'legacy-prefix',
          match: {
            node: 'command',
            kind: 'regex',
            pattern: '^gh pr view(?: .*)?$',
          },
          verdict: 'allow',
        },
      ],
    });
    expect(withRules.errors).toEqual([]);
    expect(withRules.config.format).toBeUndefined();
    expect(withRules.warnings.map((warning) => warning.path)).toContain(
      'format',
    );
    expect(
      withRules.warnings.some((warning) => warning.message.includes('legacy')),
    ).toBe(true);
  });

  test('a declared format is preserved in the normalized content', () => {
    const parsed = parseConfig({ format: 'arbiter-config-v1', enabled: false });
    expect(parsed.errors).toEqual([]);
    expect(parsed.config.format).toBe('arbiter-config-v1');
    expect(parsed.warnings).toEqual([]);
  });

  test('an unknown or malformed format is rejected instead of reinterpreted', () => {
    const unknown = parseConfig({ format: 'arbiter-config-v9' });
    expect(unknown.errors).toEqual([
      {
        path: 'format',
        message:
          'unknown configuration format "arbiter-config-v9"; supported: arbiter-config-v1, arbiter-config-v2, arbiter-config-v3',
        code: 'config.format-unknown',
      },
    ]);
    expect(unknown.config).toBe(DEFAULT_CONFIG);

    const malformed = parseConfig({ format: '' });
    expect(malformed.errors.map((error) => error.path)).toEqual(['format']);
  });

  test('every registered format is advertised and validated', () => {
    expect(registeredConfigFormats()).toEqual([
      'arbiter-config-v1',
      'arbiter-config-v2',
      'arbiter-config-v3',
    ]);
    const v2 = parseConfig({ format: 'arbiter-config-v2', enabled: false });
    expect(v2.errors).toEqual([]);
    expect(v2.config.format).toBe('arbiter-config-v2');
    expect(v2.config.enabled).toBe(false);
  });

  test('a canonical rule inside a v1 document is rejected, not reinterpreted', () => {
    // Accepting it would give an undeclared document the canonical semantics the
    // explicit format registry exists to prevent.
    const canonical = {
      id: 'mixed',
      conditions: [{ target: 'command', kind: 'exact', pattern: 'echo hi' }],
      verdict: 'allow',
    };
    for (const document of [
      { format: 'arbiter-config-v1', rules: [canonical] },
      { rules: [canonical] },
    ]) {
      const parsed = parseConfig(document);
      expect(parsed.errors).toEqual([
        expect.objectContaining({
          path: 'rules[0]',
          code: 'rule.format-mismatch',
        }),
      ]);
    }
  });

  test('a canonical-only key in a legacy rule is rejected, not dropped', () => {
    // Dropping `scope` would silently widen an allow to every tool.
    const scoped = parseConfig({
      rules: [
        {
          id: 'widened',
          match: { node: 'command', kind: 'exact', pattern: 'echo hi' },
          scope: { tools: ['bash'] },
          verdict: 'allow',
        },
      ],
    });
    expect(scoped.errors.map((error) => [error.path, error.code])).toEqual([
      ['rules[0]', 'rule.format-mismatch'],
    ]);
    expect(scoped.errors[0]?.params?.['field']).toBe('scope');
    expect(scoped.config.rules).toEqual([]);

    const conditional = parseConfig({
      rules: [
        {
          id: 'conditional',
          match: {
            node: 'command',
            kind: 'exact',
            pattern: 'echo hi',
            caseSensitive: false,
          },
          verdict: 'allow',
        },
      ],
    });
    expect(
      conditional.errors.map((error) => [error.code, error.params?.['field']]),
    ).toEqual([['rule.format-mismatch', 'match.caseSensitive']]);
  });

  test('a v2 document rejects a legacy match rule', () => {
    const parsed = parseConfig({
      format: 'arbiter-config-v2',
      rules: [
        {
          id: 'legacy',
          match: { node: 'command', kind: 'regex', pattern: '^gh pr view' },
          verdict: 'allow',
        },
      ],
    });
    expect(parsed.errors).toEqual([
      expect.objectContaining({
        path: 'rules[0].conditions',
        code: 'rule.conditions-empty',
      }),
    ]);
  });

  test('a later format can register its own parser and validation', () => {
    const unregister = registerConfigFormat({
      id: 'arbiter-config-test',
      parse: () => ({
        config: { ...DEFAULT_CONFIG, enabled: false },
        errors: [{ path: 'rules[0]', message: 'complete matching required' }],
        warnings: [],
      }),
    });
    try {
      expect(registeredConfigFormats()).toContain('arbiter-config-test');
      const parsed = parseConfig({ format: 'arbiter-config-test' });
      expect(parsed.errors).toEqual([
        { path: 'rules[0]', message: 'complete matching required' },
      ]);
      expect(parsed.config.enabled).toBe(false);
      // The registry is explicit: an unregistered id stays an error.
      expect(
        parseConfig({ format: 'arbiter-config-missing' }).errors,
      ).toHaveLength(1);
      expect(() =>
        registerConfigFormat({
          id: 'arbiter-config-test',
          parse: () => ({
            config: DEFAULT_CONFIG,
            errors: [],
            warnings: [],
          }),
        }),
      ).toThrow(/already registered/);
    } finally {
      unregister();
    }
    expect(registeredConfigFormats()).not.toContain('arbiter-config-test');
  });

  test('a provably equivalent legacy rule is converted', () => {
    const parsed = parseConfig({
      rules: [
        {
          id: 'prefix',
          match: {
            node: 'command',
            kind: 'regex',
            pattern: '^gh pr view(?: .*)?$',
          },
          verdict: 'allow',
        },
      ],
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.config.rules).toHaveLength(1);
    expect(parsed.config.rules[0]?.conditions).toEqual([
      { target: 'command', kind: 'regex', pattern: '^gh pr view(?: .*)?$' },
    ]);
    const evaluated = evaluateCall({
      rules: parsed.config.rules,
      tool: 'bash',
      arguments: { command: 'gh pr view 42 --comments' },
      identity: 'main',
      workspaceRoot: '/workspace',
      cwd: '/workspace',
      parentAuthorizationPresent: null,
      historyTruncated: false,
      overlapsDeniedEffect: false,
    });
    expect(evaluated.path).toMatchObject({ kind: 'rule', verdict: 'allow' });
  });

  test('an unanchored legacy regex is rejected, not reinterpreted', () => {
    // Prefix search under v1 is not whole-value matching under v2, and a deny
    // rule silently narrowed would lose its protection.
    const parsed = parseConfig({
      rules: [
        {
          id: 'prefix',
          match: { node: 'command', kind: 'regex', pattern: '^gh pr view' },
          verdict: 'deny',
        },
      ],
    });
    expect(parsed.errors).toEqual([
      expect.objectContaining({
        path: 'rules[0]',
        code: 'rule.not-convertible',
      }),
    ]);
  });

  test('a top-level alternation cannot be proven whole-value', () => {
    // `^safe|bad$` matched `dangerbad` under prefix search but not whole-value.
    const parsed = parseConfig({
      rules: [
        {
          id: 'alternation',
          match: { node: 'command', kind: 'regex', pattern: '^safe|bad$' },
          verdict: 'deny',
        },
      ],
    });
    expect(parsed.errors).toEqual([
      expect.objectContaining({ code: 'rule.not-convertible' }),
    ]);
  });

  test('a multiline legacy regex is rejected', () => {
    const parsed = parseConfig({
      rules: [
        {
          id: 'multiline',
          match: { node: 'command', kind: 'regex', pattern: '(?m)^a$' },
          verdict: 'deny',
        },
      ],
    });
    expect(parsed.errors).toEqual([
      expect.objectContaining({ code: 'rule.not-convertible' }),
    ]);
  });

  test('a legacy tool name keeps its literal-versus-glob meaning', () => {
    // v1 compiled `match.tool` as a glob only when it contained `*`; every other
    // value (including one with `?`) was a literal equality check.
    const literal = parseConfig({
      rules: [
        {
          id: 'literal-tool',
          match: {
            node: 'tool',
            kind: 'exact',
            pattern: 'read',
            tool: 'deploy?prod',
          },
          verdict: 'allow',
        },
      ],
    });
    expect(literal.errors).toEqual([]);
    expect(literal.config.rules[0]?.scope).toEqual({ tools: ['deploy?prod'] });

    const glob = parseConfig({
      rules: [
        {
          id: 'glob-tool',
          match: {
            node: 'tool',
            kind: 'exact',
            pattern: 'read',
            tool: 'mcp.*',
          },
          verdict: 'allow',
        },
      ],
    });
    expect(glob.errors).toEqual([]);
    expect(glob.config.rules[0]?.scope).toEqual({ tools: ['mcp.*'] });
  });

  test('a legacy negated tool scope is rejected', () => {
    // v1 left negation enabled, so `!prod` matched every tool except prod; the
    // canonical scope would read it literally, which is a different rule.
    const parsed = parseConfig({
      rules: [
        {
          id: 'negated-tool',
          match: {
            node: 'tool',
            kind: 'exact',
            pattern: 'read',
            tool: '!prod',
          },
          verdict: 'allow',
        },
      ],
    });
    expect(parsed.errors).toEqual([
      expect.objectContaining({ code: 'rule.not-convertible' }),
    ]);
  });

  test('an alternation inside a group stays convertible', () => {
    const parsed = parseConfig({
      rules: [
        {
          id: 'grouped',
          match: { node: 'command', kind: 'regex', pattern: '^(?:a|b)$' },
          verdict: 'allow',
        },
      ],
    });
    expect(parsed.errors).toEqual([]);
  });
});

describe('strict validation of supplied fields', () => {
  test('a wrong-typed security field is an error, never a permissive default', () => {
    const parsed = parseConfig({
      format: 'arbiter-config-v2',
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
      format: 'arbiter-config-v2',
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
      format: 'arbiter-config-v2',
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
      format: 'arbiter-config-v2',
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
      format: 'arbiter-config-v2',
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
      format: 'arbiter-config-v2',
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
      format: 'arbiter-config-v2',
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

describe('format round-trip through a save payload', () => {
  test('an explicit format survives normalization and content identity', () => {
    const declared = parseConfig({
      format: 'arbiter-config-v1',
      enabled: false,
    });
    const implicit = parseConfig({ enabled: false });
    expect(declared.config.format).toBe('arbiter-config-v1');
    expect(implicit.config.format).toBeUndefined();
    // The declaration is part of the content, so the two documents differ.
    expect(JSON.stringify(declared.config)).not.toBe(
      JSON.stringify(implicit.config),
    );
    // Re-parsing the saved normalized content keeps the declaration.
    const roundTripped = parseConfig(declared.config);
    expect(roundTripped.config.format).toBe('arbiter-config-v1');
    expect(roundTripped.errors).toEqual([]);
  });
});

describe('malformed parent objects', () => {
  test('a supplied non-object parent is an error instead of reverting silently', () => {
    const parsed = parseConfig({
      modes: 'strict',
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
    expect(parsed.config.modes.main).toBe('normal');
  });

  test('absent parents still use defaults without errors', () => {
    const parsed = parseConfig({ enabled: false });
    expect(parsed.errors).toEqual([]);
    expect(parsed.config.modes).toEqual({
      main: 'normal',
      subagent: 'strict',
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
  test('an unanchored legacy regex reports a stable reason code', () => {
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
    expect(issue?.code).toBe('rule.not-convertible');
    expect(issue?.params).toMatchObject({ id: 'unanchored' });
    // The developer sentence stays available for logs and unknown reasons.
    expect(issue?.message).toContain('cannot be converted');
  });

  test('an invalid regex reports its own stable code', () => {
    const parsed = parseConfig({
      format: 'arbiter-config-v2',
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
      format: 'arbiter-config-v2',
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
      format: 'arbiter-config-v2',
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
