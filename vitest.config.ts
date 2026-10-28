import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The host publishes its browser primitives through the web shell's module
 * table, not as an installed package, so Vite cannot resolve the specifier the
 * permission selector imports. The `ui` project therefore aliases it to a local
 * fixture; node projects never load client code and keep the real resolution.
 */
const primitivesFixture = fileURLToPath(
  new URL('./tests/helpers/primitives-fixture.tsx', import.meta.url),
);

export default defineConfig({
  test: {
    allowOnly: false,
    passWithNoTests: false,
    retry: 0,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text-summary', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      reportOnFailure: true,
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/**/*.test.{ts,tsx}'],
          exclude: [
            'tests/audit.test.ts',
            'tests/suggestions.test.ts',
            'tests/repair.test.ts',
            'tests/unload.test.ts',
            'tests/integration/**',
            'tests/client/**',
            'tests/e2e/**',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: [
            'tests/audit.test.ts',
            'tests/suggestions.test.ts',
            'tests/repair.test.ts',
            'tests/unload.test.ts',
            'tests/integration/**/*.test.{ts,tsx}',
          ],
        },
      },
      {
        extends: true,
        resolve: {
          alias: [
            {
              find: /^@deepseek-ai\/dsh-client-ui-primitives$/u,
              replacement: primitivesFixture,
            },
          ],
        },
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: ['tests/client/**/*.test.{ts,tsx}'],
          setupFiles: ['tests/helpers/client-setup.ts'],
          restoreMocks: true,
        },
      },
    ],
  },
});
