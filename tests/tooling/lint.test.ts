import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { forbiddenImport } from '../../tooling/lint/boundaries.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const eslint = new ESLint({ cwd: root });
const tsx = 'src/client/i18n-provider.tsx';

// Construct the typed project outside individual assertions. Cold CI runners
// need a larger initialization budget; behavior tests keep the default timeout.
beforeAll(async () => {
  await eslint.lintText('export {};', { filePath: tsx });
}, 30_000);

async function rules(
  source: string,
  filePath = tsx,
): Promise<readonly string[]> {
  const results = await eslint.lintText(source, { filePath });
  return results.flatMap((result) =>
    result.messages.map((message) => message.ruleId ?? 'fatal'),
  );
}

describe('engineering lint actually checks TSX', () => {
  it('accepts typed, named, accessible UI without authored literals', async () => {
    await expect(
      rules(`export function View(props: { readonly label: string }) {
      return <button type="button">{props.label}</button>;
    }`),
    ).resolves.toEqual([]);
  });

  it('uses the type-aware Promise rule in TSX', async () => {
    await expect(
      rules('export function run() { Promise.resolve(1); }'),
    ).resolves.toContain('@typescript-eslint/no-floating-promises');
  });

  it('enforces Hook invocation and dependency correctness', async () => {
    await expect(
      rules(`import { useEffect } from 'react';
      export function View(props: { readonly ready: boolean; readonly run: () => void }) {
        if (props.ready) useEffect(() => { props.run(); }, []);
        return null;
      }`),
    ).resolves.toEqual(
      expect.arrayContaining([
        'react-hooks/rules-of-hooks',
        'react-hooks/exhaustive-deps',
      ]),
    );
  });

  it('enforces keys, DOM properties and image alternatives', async () => {
    await expect(
      rules(`export function View(props: { readonly values: readonly string[] }) {
      return <div class="bad">{props.values.map((value) => <img src={value} />)}</div>;
    }`),
    ).resolves.toEqual(
      expect.arrayContaining([
        '@eslint-react/no-missing-key',
        '@eslint-react/dom-no-unknown-property',
        'jsx-a11y-x/alt-text',
      ]),
    );
  });

  it('requires keyboard support for clickable non-native controls', async () => {
    await expect(
      rules(`export function View(props: { readonly run: () => void; readonly label: string }) {
      return <div onClick={props.run}>{props.label}</div>;
    }`),
    ).resolves.toEqual(
      expect.arrayContaining([
        'jsx-a11y-x/click-events-have-key-events',
        'jsx-a11y-x/no-static-element-interactions',
      ]),
    );
  });

  it('rejects newly authored copy and permits catalog lookups', async () => {
    await expect(
      rules(
        'export const view = <input placeholder="输入条件" title={"规则"} />;',
      ),
    ).resolves.toContain('engineering/no-ui-literals');
    await expect(
      rules(`export function View(props: { readonly t: (key: string) => string }) {
      return <button type="button">{props.t('config.save')}</button>;
    }`),
    ).resolves.toEqual([]);
  });

  it('checks rendered templates and branches, but preserves protocol values and conditions', async () => {
    await expect(
      rules('export const view = <button type="button">{`Save`}</button>;'),
    ).resolves.toContain('engineering/no-ui-literals');
    await expect(
      rules(
        'export function View(props: {readonly busy: boolean}) { return <button type="button">{props.busy ? "Saving" : "Save"}</button>; }',
      ),
    ).resolves.toContain('engineering/no-ui-literals');
    await expect(
      rules(
        'export function View(props: {readonly busy: boolean}) { return <button type="button">{props.busy && "Saving"}</button>; }',
      ),
    ).resolves.toContain('engineering/no-ui-literals');
    await expect(
      rules(
        'export function View(props: {readonly kind: string; readonly label: string}) { return <button type={"button"}>{props.kind === "save" && props.label}</button>; }',
      ),
    ).resolves.toEqual([]);
  });

  it('does not apply production line limits to tests', async () => {
    const config: unknown = await eslint.calculateConfigForFile(
      'tests/ui/config-actions.test.tsx',
    );
    expect(config).toHaveProperty('rules.react-hooks/rules-of-hooks', [2]);
    expect(config).toHaveProperty('rules.jsx-a11y-x/alt-text.0', 2);
    expect(config).not.toHaveProperty('rules.max-lines');
    expect(config).not.toHaveProperty('rules.max-lines-per-function');
  });

  it('ignores generated outputs and historical validation artifacts', async () => {
    await expect(
      eslint.isPathIgnored('.local/issue-graph-20261024/publish.ts'),
    ).resolves.toBe(true);
    await expect(
      eslint.isPathIgnored('validation/permission-ui/old/probe.ts'),
    ).resolves.toBe(true);
    await expect(eslint.isPathIgnored('test-results/trace.js')).resolves.toBe(
      true,
    );
  });
});

describe('production structural limits', () => {
  it('enforces 600 nonblank, noncomment lines per source file', async () => {
    const declarations = Array.from(
      { length: 601 },
      (_, index) => `export const value${String(index)} = ${String(index)};`,
    ).join('\n');
    await expect(rules(declarations)).resolves.toContain('max-lines');
    await expect(
      rules(`${'// comment\n\n'.repeat(601)}export const value = 1;`),
    ).resolves.toEqual([]);
  });

  it('enforces function limits of 100 TS lines and 200 TSX lines', async () => {
    const statements = 'value += 1;\n'.repeat(100);
    const code = `export function calculate() {\nlet value = 0;\n${statements}return value;\n}`;
    await expect(rules(code, 'src/policy.ts')).resolves.toContain(
      'max-lines-per-function',
    );
    await expect(rules(code)).resolves.not.toContain('max-lines-per-function');
    await expect(
      rules(code.replace(statements, statements.repeat(2))),
    ).resolves.toContain('max-lines-per-function');
  });

  it('enforces branch complexity and nesting depth independently', async () => {
    const branches = Array.from(
      { length: 15 },
      (_, index) => `if (value === ${String(index)}) return ${String(index)};`,
    ).join('\n');
    await expect(
      rules(
        `export function calculate(value: number) { ${branches} return -1; }`,
      ),
    ).resolves.toContain('complexity');
    await expect(
      rules(
        `export function calculate(value: boolean) { ${'if (value) {'.repeat(5)} return 1; ${'}'.repeat(5)} return 0; }`,
      ),
    ).resolves.toContain('max-depth');
  });
});

describe('E2E tests cannot silently pass as placeholders', () => {
  const spec = 'tests/e2e/plugin-smoke.spec.ts';

  it.each(['skip', 'fixme', 'fail', 'only'])(
    'rejects test.%s and computed spellings',
    async (modifier) => {
      await expect(
        rules(
          `import { test } from './fixtures.js'; test.${modifier}('pending', async () => {});`,
          spec,
        ),
      ).resolves.toContain('no-restricted-syntax');
      await expect(
        rules(
          `import { test } from './fixtures.js'; test[${JSON.stringify(modifier)}]('pending', async () => {});`,
          spec,
        ),
      ).resolves.toContain('no-restricted-syntax');
    },
  );

  it('rejects disabled suites and runtime expected-failure annotations', async () => {
    await expect(
      rules(
        "import {test} from './fixtures.js'; test.describe.skip('pending suite', () => {});",
        spec,
      ),
    ).resolves.toContain('no-restricted-syntax');
    await expect(
      rules(
        "import {test, expect} from './fixtures.js'; test('pending', () => { test.fail(); expect(true).toBe(false); });",
        spec,
      ),
    ).resolves.toContain('no-restricted-syntax');
  });

  it('rejects empty and navigation-only fixture tests without assertions', async () => {
    await expect(
      rules(
        "import {test} from './fixtures.js'; test('pending', async () => {});",
        spec,
      ),
    ).resolves.toContain('vitest/expect-expect');
    await expect(
      rules(
        "import {test} from './fixtures.js'; test('pending', async ({page}) => { await page.goto('http://localhost'); });",
        spec,
      ),
    ).resolves.toContain('vitest/expect-expect');
  });

  it('accepts real Playwright assertions through the shared fixture', async () => {
    await expect(
      rules(
        "import {test, expect} from './fixtures.js'; test('real', async ({page}) => { await expect(page.getByRole('button')).toBeVisible(); });",
        spec,
      ),
    ).resolves.toEqual([]);
  });
});

describe('module import boundaries', () => {
  it.each([
    ['src/client/components/card.tsx', 'node:fs'],
    ['src/client/components/card.tsx', 'fs/promises'],
    ['src/client/components/card.tsx', '../../audit.js'],
    ['src/client/i18n/resources.ts', '../../../locale/schema.json'],
    ['src/client/i18n/resources.ts', '../../../locale/zh/config.ts'],
    ['src/client/components/card.tsx', 'better-sqlite3'],
    ['src/rules/match.ts', 'react'],
    ['src/domain/value.ts', '@deepseek-ai/dsh-session'],
    ['src/shared/types.ts', '../client/api.js'],
  ])('rejects %s importing %s', (file, source) => {
    expect(forbiddenImport(file, source)).not.toBeNull();
  });

  it.each([
    ['src/client/components/card.tsx', '../../types.js'],
    ['src/client/i18n/resources.ts', '../../../locale/zh/config.json'],
    ['src/client/i18n/resources.ts', '../../../locale/fr-CA/config.json'],
    ['src/rules/match.ts', '../shell/parse.js'],
    ['src/rules/match.ts', 'picomatch'],
    ['src/policy.ts', './types.js'],
    ['src/index.ts', 'node:fs'],
  ])('permits %s importing %s', (file, source) => {
    expect(forbiddenImport(file, source)).toBeNull();
  });

  it('applies boundaries to imports, re-exports and dynamic imports in the real config', async () => {
    await expect(
      rules("export { readFile } from 'node:fs';"),
    ).resolves.toContain('engineering/module-boundaries');
    await expect(
      rules("export const load = () => import('node:fs');"),
    ).resolves.toContain('engineering/module-boundaries');
    await expect(
      rules("import { readFile } from 'node:fs'; export { readFile };"),
    ).resolves.toContain('engineering/module-boundaries');
    await expect(
      rules("import fs = require('node:fs'); export { fs };"),
    ).resolves.toContain('engineering/module-boundaries');
  });
});
