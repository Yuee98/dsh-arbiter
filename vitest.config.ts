import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    allowOnly: false,
    passWithNoTests: false,
    retry: 0,
  },
});
