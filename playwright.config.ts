import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: '.local/e2e/results',
  reporter: [
    ['list'],
    ['html', { outputFolder: '.local/e2e/report', open: 'never' }],
    ['json', { outputFile: '.local/e2e/results.json' }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
    locale: 'zh-CN',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'dsh-chromium' }],
});
