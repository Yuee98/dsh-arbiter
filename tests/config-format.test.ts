/**
 * Format declarations, retired shapes and the save round trip.
 *
 * One format exists. These cases pin what replaces the removed compatibility layer:
 * a retired or unknown declaration is refused before anything else is read, a rule
 * still written in the retired `match` shape is refused by name, and a declared
 * document keeps its declaration through a save.
 */

import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

import { DEFAULT_CONFIG, parseConfig, parseDocument } from '../src/config.js';
import type { LocaleTree } from '../src/client/i18n/catalog.js';
import { flattenCatalog } from '../src/client/i18n/catalog.js';
import { issueKey } from '../src/client/view-issues.js';
import { evaluateCall } from '../src/rules/match.js';

const CURRENT = 'arbiter-config-v3';

describe('format declarations', () => {
  test('an undeclared document is read as the current format', () => {
    const parsed = parseConfig({
      rules: [
        {
          id: 'echo',
          conditions: [
            { target: 'command', kind: 'exact', pattern: 'echo hi' },
          ],
          verdict: 'allow',
        },
      ],
    });
    expect(parsed.errors).toEqual([]);
    // Absence describes the writer's habit; it does not select a second reading.
    expect(parsed.config.format).toBeUndefined();
    expect(parsed.config.rules).toHaveLength(1);
  });

  test('a document declaring the current format is read and keeps the declaration', () => {
    const parsed = parseConfig({
      format: CURRENT,
      enabled: false,
      rules: [
        {
          id: 'echo',
          conditions: [
            { target: 'command', kind: 'exact', pattern: 'echo hi' },
          ],
          verdict: 'allow',
        },
      ],
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.config.enabled).toBe(false);
    expect(parsed.config.format).toBe(CURRENT);
  });

  test.each(['arbiter-config-v1', 'arbiter-config-v2'])(
    'a document declaring the retired format %s is refused by name',
    (format) => {
      const parsed = parseConfig({
        format,
        rules: [
          {
            id: 'keep-me',
            conditions: [
              { target: 'command', kind: 'regex', pattern: '^gh pr view$' },
            ],
            verdict: 'allow',
          },
        ],
      });
      // The declaration is judged before the rules: the operator has to learn that
      // the whole format was removed, not read a list of findings from a reader
      // that was never meant to see this file.
      expect(parsed.errors).toEqual([
        {
          path: 'format',
          message: `configuration format "${format}" was retired; this build reads only "${CURRENT}" and does not convert old rules`,
          code: 'config.format-retired',
          params: { format, current: CURRENT },
        },
      ]);
      // Nothing is converted and nothing silently loads.
      expect(parsed.config).toBe(DEFAULT_CONFIG);
    },
  );

  test('an unknown or malformed declaration is refused, not reinterpreted', () => {
    const unknown = parseConfig({ format: 'arbiter-config-v9' });
    expect(unknown.errors).toEqual([
      {
        path: 'format',
        message: `unknown configuration format "arbiter-config-v9"; supported: ${CURRENT}`,
        code: 'config.format-unknown',
      },
    ]);
    expect(unknown.config).toBe(DEFAULT_CONFIG);

    const malformed = parseConfig({ format: '' });
    expect(malformed.errors).toEqual([
      expect.objectContaining({
        path: 'format',
        code: 'config.format-declaration',
      }),
    ]);
  });

  test('the retired declaration is localized in both catalogs', async () => {
    const parsed = parseConfig({ format: 'arbiter-config-v2' });
    const code = parsed.errors[0]?.code ?? '';
    const key = `config.issue.${issueKey(code)}`;
    for (const locale of ['zh', 'en'] as const) {
      const catalog = flattenCatalog({ config: await readLocaleTree(locale) });
      expect(catalog[key], `${locale} ${key}`).toBeDefined();
      expect(catalog[key]?.length ?? 0).toBeGreaterThan(0);
      // The placeholders the parser interpolates must exist in both catalogs.
      expect(catalog[key]).toContain('{format}');
      expect(catalog[key]).toContain('{current}');
    }
  });
});

describe('the retired rule shape', () => {
  test('a rule written with `match` is refused by name', () => {
    const parsed = parseConfig({
      rules: [
        {
          id: 'relay-trust',
          match: { node: 'command', kind: 'regex', pattern: 'gpt-relay' },
          verdict: 'allow',
        },
      ],
    });
    expect(parsed.errors).toEqual([
      {
        path: 'rules[0]',
        message:
          '"match" belongs to a retired rule format; rewrite the rule with "conditions"',
        code: 'rule.format-retired',
        params: { field: 'match' },
      },
    ]);
    // The rule is dropped rather than reinterpreted, so no allow survives.
    expect(parsed.config.rules).toEqual([]);
  });

  test('a retired rule is refused even when it also carries conditions', () => {
    // Keeping both shapes is not a migration path: the old body is what the
    // operator wrote, and silently preferring `conditions` would change the rule.
    const parsed = parseConfig({
      rules: [
        {
          id: 'both',
          match: { node: 'command', kind: 'exact', pattern: 'rm -rf /' },
          conditions: [{ target: 'command', kind: 'exact', pattern: 'ls' }],
          verdict: 'deny',
        },
      ],
    });
    expect(parsed.errors).toEqual([
      expect.objectContaining({
        path: 'rules[0]',
        code: 'rule.format-retired',
      }),
    ]);
    expect(parsed.config.rules).toEqual([]);
  });

  test('the retired rule shape is localized in both catalogs', async () => {
    const parsed = parseConfig({
      rules: [
        {
          id: 'old',
          match: { node: 'command', kind: 'exact', pattern: 'pwd' },
          verdict: 'allow',
        },
      ],
    });
    const code = parsed.errors[0]?.code ?? '';
    const key = `config.issue.${issueKey(code)}`;
    for (const locale of ['zh', 'en'] as const) {
      const catalog = flattenCatalog({ config: await readLocaleTree(locale) });
      expect(catalog[key], `${locale} ${key}`).toBeDefined();
      expect(catalog[key]).toContain('{field}');
    }
  });
});

describe('the current rule model is unchanged', () => {
  test('a whole-value regex needs no anchor', () => {
    const parsed = parseConfig({
      rules: [
        {
          id: 'whole',
          conditions: [{ target: 'command', kind: 'regex', pattern: 'gh pr' }],
          verdict: 'allow',
        },
      ],
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.config.rules).toHaveLength(1);
  });

  test('combine all requires every condition and combine any needs one', () => {
    const conjunctive = parseConfig({
      rules: [
        {
          id: 'push-dev',
          combine: 'all',
          conditions: [
            { target: 'command', kind: 'exact', pattern: 'git push' },
            {
              target: 'argument',
              path: '$.environment',
              kind: 'exact',
              pattern: 'dev',
            },
          ],
          verdict: 'allow',
        },
      ],
    });
    expect(conjunctive.errors).toEqual([]);
    expect(conjunctive.config.rules[0]?.combine).toBe('all');
    const both = evaluateCall({
      rules: conjunctive.config.rules,
      tool: 'bash',
      arguments: { command: 'git push', environment: 'dev' },
      identity: 'main',
      workspaceRoot: '/workspace',
      cwd: '/workspace',
      parentAuthorizationPresent: null,
      historyTruncated: false,
      overlapsDeniedEffect: false,
    });
    expect(both.path).toMatchObject({ kind: 'rule', verdict: 'allow' });

    // Only one half holds, so the conjunction is not satisfied.
    const half = evaluateCall({
      rules: conjunctive.config.rules,
      tool: 'bash',
      arguments: { command: 'git push', environment: 'production' },
      identity: 'main',
      workspaceRoot: '/workspace',
      cwd: '/workspace',
      parentAuthorizationPresent: null,
      historyTruncated: false,
      overlapsDeniedEffect: false,
    });
    expect(half.path).not.toMatchObject({ verdict: 'allow' });

    const alternative = parseConfig({
      rules: [
        {
          id: 'either',
          combine: 'any',
          conditions: [
            { target: 'command', kind: 'exact', pattern: 'a' },
            { target: 'command', kind: 'exact', pattern: 'b' },
          ],
          verdict: 'deny',
        },
      ],
    });
    expect(alternative.errors).toEqual([]);
    expect(alternative.config.rules[0]?.combine).toBe('any');
  });

  test('several conditions without combine are an error, never a guess', () => {
    const parsed = parseConfig({
      rules: [
        {
          id: 'ambiguous',
          conditions: [
            { target: 'command', kind: 'exact', pattern: 'a' },
            { target: 'command', kind: 'exact', pattern: 'b' },
          ],
          verdict: 'allow',
        },
      ],
    });
    expect(parsed.errors).toEqual([
      expect.objectContaining({
        path: 'rules[0].combine',
        code: 'rule.combine-required',
      }),
    ]);
  });

  test('scope, selectors and hints keep working', () => {
    const parsed = parseConfig({
      rules: [
        {
          id: 'scoped',
          name: '限定范围',
          comment: '只在主会话生效',
          hint: '确认目标环境',
          scope: { tools: ['deploy'], agents: ['main'] },
          combine: 'any',
          conditions: [
            {
              target: 'argument',
              path: '$.environments[*]',
              multi: 'all',
              kind: 'exact',
              pattern: 'production',
            },
          ],
          verdict: 'force-review',
        },
      ],
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.config.rules[0]).toMatchObject({
      id: 'scoped',
      name: '限定范围',
      hint: '确认目标环境',
      scope: { tools: ['deploy'], agents: ['main'] },
      combine: 'any',
      verdict: 'force-review',
    });
    expect(parsed.config.rules[0]?.conditions[0]).toMatchObject({
      target: 'argument',
      path: '$.environments[*]',
      multi: 'all',
      kind: 'exact',
      pattern: 'production',
    });
  });

  test('an unknown key in a rule or condition is an error, not a warning', () => {
    const parsed = parseConfig({
      rules: [
        {
          id: 'typo',
          combines: 'all',
          conditions: [
            { target: 'command', kind: 'exact', pattern: 'ls', combined: true },
          ],
          verdict: 'allow',
        },
      ],
    });
    expect(parsed.warnings).toEqual([]);
    expect(parsed.errors.map((error) => [error.path, error.code])).toEqual(
      expect.arrayContaining([
        ['rules[0].combines', 'rule.unknown-field'],
        ['rules[0].conditions[0].combined', 'rule.unknown-field'],
      ]),
    );
  });
});

describe('format round-trip through a save payload', () => {
  test('a declared format survives normalization and content identity', () => {
    const declared = parseConfig({ format: CURRENT, enabled: false });
    const undeclared = parseConfig({ enabled: false });
    expect(declared.config.format).toBe(CURRENT);
    expect(undeclared.config.format).toBeUndefined();
    // The declaration is part of the content, so the two documents differ.
    expect(JSON.stringify(declared.config)).not.toBe(
      JSON.stringify(undeclared.config),
    );
    // Re-parsing the saved normalized content keeps the declaration.
    const roundTripped = parseConfig(declared.config);
    expect(roundTripped.config.format).toBe(CURRENT);
    expect(roundTripped.errors).toEqual([]);
  });

  test('a saved retired document is still refused on the way back in', () => {
    // Writing the effective configuration back never adds a retired declaration,
    // so an old file stays unusable until it is rewritten or replaced.
    const stored = parseDocument({ format: 'arbiter-config-v1' });
    expect(stored.errors.map((error) => error.code)).toEqual([
      'config.format-retired',
    ]);
  });
});

/**
 * Read one shipped locale file as a nested tree.
 *
 * The shipped catalogs are plain JSON objects whose leaves are strings; the value
 * is walked rather than asserted so a malformed file fails here instead of
 * producing a misleading "missing key" further down.
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
