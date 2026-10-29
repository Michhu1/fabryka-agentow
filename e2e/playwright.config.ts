import { defineConfig, devices } from '@playwright/test';
import { EDITOR_URL, SERVER_PORT, VIEWPORT } from './helpers/env';

/**
 * End-to-end tests of the whole app in a real browser: `pnpm test:e2e`.
 *
 * Needs the local infrastructure (`pnpm infra:up`: PostgreSQL and Mailpit). Playwright itself starts the
 * server (port 5680) on its own database `moj_n8n_e2e`, emptied before every run, and the editor (Vite,
 * port 5681). Ports 5680 and 5681 must be free — stop `pnpm dev` first.
 */
/** Server settings for the run; the dev `.env` is not read, so the run never touches the dev data. */
const serverEnv: Record<string, string> = {
  NODE_ENV: 'development',
  PORT: String(SERVER_PORT),
  ENCRYPTION_KEY: 'e2e-only-not-secret-e2e-only-not-secret',
  EXECUTIONS_MODE: 'regular',
  DB_POSTGRESDB_HOST: 'localhost',
  DB_POSTGRESDB_PORT: '5433',
  DB_POSTGRESDB_DATABASE: 'moj_n8n_e2e',
  DB_POSTGRESDB_USER: 'moj_n8n',
  DB_POSTGRESDB_PASSWORD: 'moj_n8n',
  DB_POSTGRESDB_SSL: 'false',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  // Links in mails must open the editor that this run starts.
  EDITOR_BASE_URL: EDITOR_URL,
  SIGNUP_ENABLED: 'true',
  TEAM_PROJECTS_LIMIT: '3',
  PROXY_HOPS: '0',
};

/**
 * A Chromium other than Playwright's own (e.g. a preinstalled one whose version does not match this
 * Playwright). Unset = the browser from `pnpm exec playwright install chromium`.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results',
  globalSetup: './global-setup.ts',
  // One shared database and mailbox: the scenario runs step by step in one worker.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: EDITOR_URL,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: VIEWPORT,
        launchOptions: { executablePath },
      },
    },
  ],
  webServer: [
    {
      // Empties and migrates `moj_n8n_e2e`, then starts the server without watch mode.
      command:
        'pnpm --filter @app/server exec tsx src/test/prepare-e2e.ts && pnpm --filter @app/server exec tsx src/main.ts',
      cwd: '..',
      url: `http://localhost:${SERVER_PORT}/healthz/readiness`,
      env: serverEnv,
      // Never reuse a running server: it could be on another database (e.g. `pnpm dev` on `moj_n8n`).
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'pnpm --filter @app/editor dev',
      cwd: '..',
      url: EDITOR_URL,
      env: { VITE_DEV_PROXY_TARGET: `http://localhost:${SERVER_PORT}` },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
