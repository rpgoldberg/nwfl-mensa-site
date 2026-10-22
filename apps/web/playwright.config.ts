import { defineConfig, devices } from '@playwright/test';
import { BACKEND_PORT, BACKEND_URL, SITE_URL, TLS_PORT } from './e2e/servers';

export default defineConfig({
  testDir: 'e2e',
  // The canary checks need the public-only build: playwright.public-only.config.ts.
  testIgnore: /public-only\//,
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  // Over https, as readers arrive: the site's cookies are __Host- and Secure.
  use: { baseURL: SITE_URL, ignoreHTTPSErrors: true, trace: 'retain-on-failure' },
  // The built server, behind the same wrapper the container runs, so every
  // test sees the shipped headers, and in front of it the test TLS edge.
  // Run `npm run build` first.
  webServer: [
    {
      command: 'node server/serve.mjs',
      url: `${BACKEND_URL}/healthz`,
      env: { PORT: String(BACKEND_PORT), HOST: '127.0.0.1' },
      reuseExistingServer: false,
    },
    {
      command: 'node e2e/tls-proxy.mjs',
      url: `${SITE_URL}/healthz`,
      ignoreHTTPSErrors: true,
      env: { TLS_PORT: String(TLS_PORT), UPSTREAM: BACKEND_URL },
      reuseExistingServer: false,
    },
  ],
  projects: [
    // Headers and cache rules: plain HTTP, no browser needed.
    { name: 'http', testMatch: /headers\.spec\.ts/ },
    { name: 'chromium-desktop', testIgnore: [/headers\.spec\.ts/, /public-only\//], use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'chromium-phone', testIgnore: [/headers\.spec\.ts/, /public-only\//], use: { ...devices['Pixel 7'] } },
    { name: 'webkit-iphone', testIgnore: [/headers\.spec\.ts/, /public-only\//], use: { ...devices['iPhone 17'] } },
  ],
});
