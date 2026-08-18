import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end browser tests.
 *
 * These run against a real server with Test Mode on and the mock integrations
 * configured, so no external vendor is contacted. The database must be
 * migrated and seeded first; see docs/testing.md.
 */
/**
 * Settings shared with the server this run starts, so a test can set up state
 * that server will actually see rather than the two guessing at each other's
 * database, directory and signing secret.
 *
 * Resolved once, here, and handed to the workers through `metadata`. Importing
 * these constants into a spec would not be safe: the Prisma client loads `.env`
 * when a worker imports it, so a worker can end up resolving `process.env`
 * differently from the process that launched the server — which is a silent
 * mismatch, not a loud one.
 */
export interface E2EEnvironment {
  storageDirectory: string;
  databaseUrl: string;
  sessionSecret: string;
}

const e2eEnvironment: E2EEnvironment = {
  storageDirectory: process.env.DOCUMENT_STORAGE_DIRECTORY ?? '/tmp/element-engagements-e2e/storage',
  databaseUrl:
    process.env.TEST_DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5432/element_engagements_test?schema=public',
  sessionSecret: '1'.repeat(64),
};

export default defineConfig({
  metadata: { e2eEnvironment },
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
        /*
          The production build under CI, a development server locally.

          CI has just built the application, so starting that build costs
          seconds where `dev` costs a compile per route — and, more to the point,
          it is the artefact that actually ships. A browser suite that only ever
          drove a development server would not have exercised the built output at
          all. Locally the trade runs the other way: rebuilding before every run
          is a good way to stop running them.
        */
        command: process.env.CI
          ? 'pnpm --filter @element/web start'
          : 'pnpm --filter @element/web dev',
        url: 'http://localhost:3000/api/health',
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        env: {
          APP_ENV: 'test',
          TEST_MODE: 'true',
          ALLOW_PRODUCTION_SENDING: 'false',
          DEV_LOGIN_ENABLED: 'true',
          DATABASE_URL: e2eEnvironment.databaseUrl,
          ENCRYPTION_KEY: '0'.repeat(64),
          SESSION_SECRET: e2eEnvironment.sessionSecret,
          // Pinned so a test can put a working copy where the server will look
          // for it, and sign a link the server will accept.
          DOCUMENT_STORAGE_DIRECTORY: e2eEnvironment.storageDirectory,
          // Not real, and never used to reach Microsoft: they exist so the
          // sign-in button is enabled and a test can prove the Content Security
          // Policy lets the submission through. It did not, and the browser
          // said nothing a user would see.
          ENTRA_TENANT_ID: '11111111-2222-3333-4444-555555555555',
          ENTRA_CLIENT_ID: '66666666-7777-8888-9999-000000000000',
          ENTRA_CLIENT_SECRET: 'not-a-real-secret',
          // One address that exists among the seeded users, one that does not,
          // and one that is instruction text pasted in place of a value — the
          // three states the Users screen has to tell apart. The third is not
          // hypothetical: it is what was actually deployed, and it read as
          // "nobody has signed in with this address", sending the reader off to
          // check sign-ins for a value that could never have matched anyone.
          BOOTSTRAP_ADMIN_EMAILS:
            'admin@example.test, nobody-signed-in@example.test, <your full name@firm.ca address>',
        },
      },
});
