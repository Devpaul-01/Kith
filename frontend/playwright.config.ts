import { defineConfig, devices } from '@playwright/test';

// Some CI/sandboxed environments can't reach Playwright's own browser CDN.
// If PLAYWRIGHT_CHROMIUM_PATH is set, we launch that binary instead of the
// one Playwright would normally download (e.g. a binary obtained via
// @sparticuz/chromium, which ships over the npm registry rather than a
// browser-specific CDN). Leave it unset to use Playwright's own managed
// browser as normal.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // tests share one seeded backend/db; avoid cross-test interference
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['html', { open: 'never' }], ['list']],

  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Video capture needs an ffmpeg binary Playwright downloads separately;
    // unavailable in network-restricted environments. Re-enable
    // ('retain-on-failure') where that download is reachable.
    video: 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: executablePath
          ? { executablePath, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
          : {},
      },
    },
  ],

  // Assumes the backend (port 3000) and frontend (port 5173) are already
  // running — see docs/e2e-local-setup.md. We don't use Playwright's
  // webServer option because this project's full stack (API + Postgres +
  // Redis + queue workers) isn't a single process Playwright can launch.
});
