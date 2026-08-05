import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end browser tests.
 *
 * These run against a real server with Test Mode on and the mock integrations
 * configured, so no external vendor is contacted. The database must be
 * migrated and seeded first; see docs/testing.md.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Some environments provide a preinstalled Chromium instead of letting
        // Playwright download one. Point at it when PLAYWRIGHT_CHROMIUM_PATH is
        // set; otherwise use Playwright's own managed browser.
        ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
          : {}),
      },
    },
  ],

  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'pnpm --filter @element/web dev',
        url: 'http://localhost:3000/api/health',
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        env: {
          APP_ENV: 'test',
          TEST_MODE: 'true',
          ALLOW_PRODUCTION_SENDING: 'false',
          DEV_LOGIN_ENABLED: 'true',
          DATABASE_URL:
            process.env.TEST_DATABASE_URL ??
            'postgresql://postgres:postgres@localhost:5432/element_engagements_test?schema=public',
          ENCRYPTION_KEY: '0'.repeat(64),
          SESSION_SECRET: '1'.repeat(64),
        },
      },
});
