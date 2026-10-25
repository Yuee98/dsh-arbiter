import js from '@eslint/js';
import vitest from '@vitest/eslint-plugin';
import prettier from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['lib/**', 'coverage/**', 'validation/**']),
  {
    files: ['**/*.{ts,mts,cts,js,mjs,cjs}'],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/no-deprecated': 'error',
      '@typescript-eslint/no-floating-promises': [
        'error',
        { ignoreVoid: false },
      ],
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-expect-error': true,
        },
      ],
    },
  },
  {
    // The browser API boundary converts trusted host JSON into the declared
    // response type. Parsing is the one place an untyped JSON value is assigned
    // to a generic; every caller-facing schema is defined at the call site.
    files: ['src/client/api.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
  {
    // A stub ContextLike answers a set of exact `get` overloads from one
    // services table; the structural mismatch is the test double's whole point.
    files: ['tests/unload.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-type-assertion': 'off',
    },
  },
  {
    files: ['tests/**/*.test.ts'],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      'vitest/no-focused-tests': ['error', { fixable: false }],
      'vitest/no-disabled-tests': 'error',
    },
  },
  prettier,
);
