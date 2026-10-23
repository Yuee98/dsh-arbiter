import { describe, expect, test } from 'vitest';

import { DEFAULT_CONFIG, parseConfig } from '../src/config.js';

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
