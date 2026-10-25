import js from '@eslint/js';
import react from '@eslint-react/eslint-plugin';
import vitest from '@vitest/eslint-plugin';
import prettier from 'eslint-config-prettier';
import a11y from 'eslint-plugin-jsx-a11y-x';
import hooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import engineering from './tooling/lint/index.mjs';

export default defineConfig(
  globalIgnores([
    'lib/**',
    'coverage/**',
    'validation/**',
    '.local/**',
    '.codex/**',
    '.agents/**',
    'artifacts/**',
    'test-results/**',
    'playwright-report/**',
  ]),
  {
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
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
    files: ['src/**/*.{ts,tsx}'],
    plugins: { engineering },
    rules: {
      'max-lines': [
        'error',
        { max: 600, skipBlankLines: true, skipComments: true },
      ],
      'max-lines-per-function': [
        'error',
        { max: 100, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],
      complexity: ['error', 15],
      'max-depth': ['error', 4],
      'engineering/module-boundaries': 'error',
    },
  },
  {
    files: ['src/**/*.tsx'],
    rules: {
      'max-lines-per-function': [
        'error',
        { max: 200, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { '@eslint-react': react },
    rules: {
      '@eslint-react/no-nested-component-definitions': 'error',
      '@eslint-react/web-api-no-leaked-event-listener': 'error',
      '@eslint-react/web-api-no-leaked-interval': 'error',
      '@eslint-react/web-api-no-leaked-timeout': 'error',
    },
  },
  {
    files: ['**/*.tsx'],
    plugins: {
      '@eslint-react': react,
      'react-hooks': { rules: hooks.rules },
      'jsx-a11y-x': a11y,
    },
    rules: {
      '@eslint-react/no-missing-key': 'error',
      '@eslint-react/no-duplicate-key': 'error',
      '@eslint-react/dom-no-unknown-property': 'error',
      '@eslint-react/dom-no-missing-button-type': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'jsx-a11y-x/alt-text': 'error',
      'jsx-a11y-x/anchor-has-content': 'error',
      'jsx-a11y-x/anchor-is-valid': 'error',
      'jsx-a11y-x/aria-props': 'error',
      'jsx-a11y-x/aria-proptypes': 'error',
      'jsx-a11y-x/aria-role': 'error',
      'jsx-a11y-x/aria-unsupported-elements': 'error',
      'jsx-a11y-x/click-events-have-key-events': 'error',
      'jsx-a11y-x/interactive-supports-focus': 'error',
      'jsx-a11y-x/label-has-associated-control': [
        'error',
        {
          assert: 'either',
          depth: 25,
          controlComponents: ['TextInput', 'NumberInput', 'SelectInput'],
        },
      ],
      'jsx-a11y-x/mouse-events-have-key-events': 'error',
      'jsx-a11y-x/no-static-element-interactions': 'error',
      'jsx-a11y-x/role-has-required-aria-props': 'error',
      'jsx-a11y-x/role-supports-aria-props': 'error',
      'jsx-a11y-x/tabindex-no-positive': 'error',
    },
  },
  {
    files: ['src/client/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': [
        'error',
        'process',
        'Buffer',
        '__dirname',
        '__filename',
      ],
    },
  },
  {
    files: ['src/client/**/*.tsx'],
    rules: { 'engineering/no-ui-literals': 'error' },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'scripts/**/*.ts', 'tooling/**/*.mjs'],
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
    files: ['tests/**/*.test.{ts,tsx}'],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      'vitest/no-focused-tests': ['error', { fixable: false }],
      'vitest/no-disabled-tests': 'error',
    },
  },
  {
    files: ['tests/e2e/**/*.spec.{ts,tsx}'],
    plugins: { vitest },
    rules: {
      // This assertion-presence rule also recognizes our exported Playwright
      // fixture `test`. Other Vitest-specific rules do not apply to E2E.
      'vitest/expect-expect': [
        'error',
        {
          assertFunctionNames: ['expect'],
          additionalTestBlockFunctions: ['test'],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'MemberExpression[property.name=/^(skip|fixme|fail|only)$/]',
          message:
            'Disabled, expected-failure or focused E2E tests must not pass the engineering baseline. Track pending scenarios in the issue instead.',
        },
        {
          selector:
            'MemberExpression[computed=true][property.value=/^(skip|fixme|fail|only)$/]',
          message:
            'Disabled, expected-failure or focused E2E tests must not pass the engineering baseline. Track pending scenarios in the issue instead.',
        },
      ],
    },
  },
  prettier,
);
