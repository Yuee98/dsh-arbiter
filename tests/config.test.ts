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

  test('rejects an unanchored regex rule without dropping the rest of the configuration', () => {
    const parsed = parseConfig({
      enabled: false,
      rules: [
        {
          id: 'bad',
          match: { node: 'command', kind: 'regex', pattern: 'gh pr' },
          verdict: 'allow',
        },
        {
          id: 'ok',
          match: { node: 'command', kind: 'regex', pattern: '^gh pr' },
          verdict: 'allow',
        },
      ],
    });
    expect(
      parsed.errors.some((error) => error.message.includes('anchored')),
    ).toBe(true);
    expect(parsed.config.enabled).toBe(false);
    expect(parsed.config.rules).toHaveLength(2);
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
      rules: [
        {
          id: 'relay-trust',
          match: { node: 'command', kind: 'regex', pattern: '^gpt-relay' },
          verdict: 'allow',
        },
        {
          id: 'relay-prod',
          match: { node: 'command', kind: 'regex', pattern: '^gpt-relay send' },
          verdict: 'force-review',
        },
      ],
    });
    expect(
      parsed.warnings.some((warning) =>
        warning.message.includes('relay-trust'),
      ),
    ).toBe(true);
  });

  test('rejects a tool rule without an explicit tool name', () => {
    const parsed = parseConfig({
      rules: [
        {
          id: 'any',
          match: { node: 'tool', kind: 'exact', pattern: 'read' },
          verdict: 'allow',
        },
      ],
    });
    expect(
      parsed.errors.some((error) =>
        error.message.includes('explicit tool name'),
      ),
    ).toBe(true);
  });

  test('enforces the custom rules character limit', () => {
    const parsed = parseConfig({ context: { customRules: 'x'.repeat(2001) } });
    expect(
      parsed.errors.some((error) => error.path === 'context.customRules'),
    ).toBe(true);
  });

  test('default configuration remains the fallback shape', () => {
    expect(DEFAULT_CONFIG.policy.version).toBe('arbiter-policy-v1');
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
          match: { node: 'command', kind: 'regex', pattern: '^gh pr view' },
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
    const unknown = parseConfig({ format: 'arbiter-config-v2' });
    expect(unknown.errors).toEqual([
      {
        path: 'format',
        message:
          'unknown configuration format "arbiter-config-v2"; supported: arbiter-config-v1',
        code: 'config.format-unknown',
      },
    ]);
    expect(unknown.config).toBe(DEFAULT_CONFIG);

    const malformed = parseConfig({ format: '' });
    expect(malformed.errors.map((error) => error.path)).toEqual(['format']);
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

  test('legacy prefix rules keep their current behavior', () => {
    const parsed = parseConfig({
      rules: [
        {
          id: 'prefix',
          match: { node: 'command', kind: 'regex', pattern: '^gh pr view' },
          verdict: 'allow',
        },
      ],
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.config.rules).toHaveLength(1);
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
});

describe('strict validation of supplied fields', () => {
  test('a wrong-typed security field is an error, never a permissive default', () => {
    const parsed = parseConfig({
      enabled: 'false',
      rules: [
        {
          id: 'narrow',
          enabled: 'false',
          match: {
            node: 'command',
            kind: 'regex',
            pattern: '^gh pr view',
            agents: 'main',
          },
          verdict: 'allow',
        },
      ],
    });
    expect(parsed.errors.map((error) => error.path)).toEqual(
      expect.arrayContaining([
        'enabled',
        'rules[0].enabled',
        'rules[0].match.agents',
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
      rules: [
        {
          id: 'bad-scope',
          match: {
            node: 'command',
            kind: 'regex',
            pattern: '^rm',
            agents: ['main', 7],
          },
          verdict: 'allow',
        },
      ],
    });
    expect(
      parsed.errors.some((error) => error.path === 'rules[0].match.agents'),
    ).toBe(true);
    // The rule is retained for editing but nothing about it may be applied.
    expect(parsed.errors.length).toBeGreaterThan(0);
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
  test('an unanchored regex reports a stable reason code', () => {
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
    expect(issue?.code).toBe('rule.regex-anchor');
    expect(issue?.params).toMatchObject({ id: 'unanchored' });
    // The developer sentence stays available for logs and unknown reasons.
    expect(issue?.message).toBe(
      'regex patterns must be anchored with "^" or "(?:^" (rule "unanchored")',
    );
  });

  test('a duplicate id reports the duplicated identifier', () => {
    const parsed = parseConfig({
      rules: [
        {
          id: 'same',
          match: { node: 'command', kind: 'exact', pattern: 'pwd' },
          verdict: 'allow',
        },
        {
          id: 'same',
          match: { node: 'command', kind: 'exact', pattern: 'ls' },
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
      rules: [
        {
          id: 'relay-trust',
          match: { node: 'command', kind: 'regex', pattern: '^gpt-relay' },
          verdict: 'allow',
        },
        {
          id: 'relay-prod',
          match: { node: 'command', kind: 'regex', pattern: '^gpt-relay send' },
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
