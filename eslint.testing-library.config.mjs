import testingLibrary from 'eslint-plugin-testing-library';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// These rules generate fixes by mutating AST nodes. A separate ESLint pass
// keeps that tree away from the type-aware rules in eslint.config.mjs.
export default defineConfig({
  files: ['tests/client/**/*.{ts,tsx}', 'tests/helpers/render-client.tsx'],
  extends: [testingLibrary.configs['flat/react']],
  languageOptions: {
    parser: tseslint.parser,
  },
  linterOptions: {
    noInlineConfig: true,
    reportUnusedDisableDirectives: 'error',
    reportUnusedInlineConfigs: 'error',
  },
  settings: {
    'testing-library/custom-renders': ['renderClient'],
  },
});
