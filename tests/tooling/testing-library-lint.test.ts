import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const filePath = 'tests/client/config-actions.test.tsx';
const typed = new ESLint({ cwd: root });
const libraryOptions = {
  cwd: root,
  overrideConfigFile: 'eslint.testing-library.config.mjs',
};
const library = new ESLint(libraryOptions);

beforeAll(async () => {
  await typed.lintText('export {};', { filePath });
}, 30_000);

async function rules(
  linter: ESLint,
  source: string,
): Promise<readonly string[]> {
  const results = await linter.lintText(source, { filePath });
  return results.flatMap((result) =>
    result.messages.map((message) => message.ruleId ?? 'fatal'),
  );
}

describe('independent Testing Library safeguards', () => {
  it.each([
    [
      'user-event',
      'events',
      "import { userEvent } from '@testing-library/user-event';",
      "const user = userEvent.setup(); user.click(screen.getByRole('button', { name: 'Save' }));",
    ],
    ['findBy', 'queries', '', "screen.findByText('Saved');"],
    [
      'waitFor',
      'utils',
      "import { waitFor } from '@testing-library/react';",
      "waitFor(() => { expect(screen.getByText('Saved')).toBeVisible(); });",
    ],
    [
      'async query wrapper',
      'queries',
      '',
      "const findSaved = () => screen.findByText('Saved'); findSaved();",
    ],
  ])(
    'reports an unhandled %s Promise in either callback form without crashing',
    async (_label, kind, imports, operation) => {
      for (const callback of ['()', 'async ()']) {
        const source = `import { screen } from '@testing-library/react';
          ${imports}
          import { test, expect } from 'vitest';
          test('saves', ${callback} => {
            ${operation}
            expect(screen.getByText('Saved')).toBeVisible();
          });`;
        await expect(rules(typed, source)).resolves.toContain(
          '@typescript-eslint/no-floating-promises',
        );
        await expect(rules(library, source)).resolves.toContain(
          `testing-library/await-async-${kind}`,
        );
      }
    },
  );

  it('keeps require-await active in the type-aware pass', async () => {
    await expect(
      rules(
        typed,
        `import { test, expect } from 'vitest';
        test('saves', async () => { expect(1).toBe(1); });`,
      ),
    ).resolves.toContain('@typescript-eslint/require-await');
  });

  it('rejects side effects in waitFor retry callbacks', async () => {
    await expect(
      rules(
        library,
        `import { fireEvent, screen, waitFor } from '@testing-library/react';
        import { test, expect } from 'vitest';
        test('saves', async () => {
          await waitFor(() => {
            fireEvent.click(screen.getByRole('button', { name: 'Save' }));
            expect(screen.getByText('Saved')).toBeVisible();
          });
        });`,
      ),
    ).resolves.toContain('testing-library/no-wait-for-side-effects');
  });

  it('accepts awaited actions, queries and utilities in both passes', async () => {
    const source = `import { screen, waitFor } from '@testing-library/react';
      import { userEvent } from '@testing-library/user-event';
      import { test, expect } from 'vitest';
      test('saves', async () => {
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(await screen.findByText('Saved')).toBeVisible();
        await waitFor(() => { expect(screen.getByText('Saved')).toBeVisible(); });
      });`;
    await expect(rules(typed, source)).resolves.toEqual([]);
    await expect(rules(library, source)).resolves.toEqual([]);
  });

  it('reparses generated fixes before the strict type-aware pass', async () => {
    const fixer = new ESLint({ ...libraryOptions, fix: true });
    const results = await fixer.lintText(
      `import { screen, waitFor } from '@testing-library/react';
      import { userEvent } from '@testing-library/user-event';
      import { test, expect } from 'vitest';
      test('saves', () => {
        const user = userEvent.setup();
        user.click(screen.getByRole('button', { name: 'Save' }));
        screen.findByText('Saved');
        waitFor(() => { expect(screen.getByText('Saved')).toBeVisible(); });
      });`,
      { filePath },
    );
    const fixed = results[0]?.output;
    expect(fixed).toBeDefined();
    if (fixed === undefined) throw new Error('No async fixes were generated');
    await expect(rules(typed, fixed)).resolves.toEqual([]);
    await expect(rules(library, fixed)).resolves.toEqual([]);
  });

  it.each([
    filePath,
    'tests/client/api.test.ts',
    'tests/helpers/render-client.tsx',
  ])(
    'uses separate rule sets and the shared render setting for %s',
    async (path) => {
      const typedConfig: unknown = await typed.calculateConfigForFile(path);
      const libraryConfig: unknown = await library.calculateConfigForFile(path);
      expect(typedConfig).toHaveProperty(
        'rules.@typescript-eslint/require-await',
        [2],
      );
      expect(typedConfig).toHaveProperty(
        'rules.@typescript-eslint/no-floating-promises',
        [2, { ignoreVoid: false }],
      );
      expect(typedConfig).not.toHaveProperty('plugins.testing-library');
      expect(libraryConfig).not.toHaveProperty('plugins.@typescript-eslint');
      for (const kind of ['events', 'queries', 'utils']) {
        expect(libraryConfig).toHaveProperty(
          `rules.testing-library/await-async-${kind}.0`,
          2,
        );
      }
      expect(libraryConfig).toHaveProperty(
        'settings.testing-library/custom-renders',
        ['renderClient'],
      );
      expect(libraryConfig).toHaveProperty(
        'linterOptions.noInlineConfig',
        true,
      );
    },
  );

  it.each([
    'src/client/page.tsx',
    'tests/unload.test.ts',
    'tests/tooling/react-lint.test.ts',
    'tests/helpers/client-setup.ts',
  ])('keeps Testing Library rules outside %s', async (path) => {
    await expect(library.calculateConfigForFile(path)).resolves.toBeUndefined();
  });
});
