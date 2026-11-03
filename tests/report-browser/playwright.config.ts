import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const output = (path: string) =>
  fileURLToPath(
    new URL(`../../.local/report-browser/${path}`, import.meta.url),
  );

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: output('results'),
  reporter: [
    ['list'],
    ['html', { outputFolder: output('report'), open: 'never' }],
    ['json', { outputFile: output('results.json') }],
  ],
  use: {
    browserName: 'chromium',
    headless: true,
    offline: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    locale: 'zh-CN',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
