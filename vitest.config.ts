import { defineConfig } from 'vitest/config';

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
