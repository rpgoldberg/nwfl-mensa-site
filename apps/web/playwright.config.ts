import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env['E2E_PORT'] ?? 8087);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL, trace: 'retain-on-failure' },
  // The built server, behind the same wrapper the container runs, so every
  // test sees the shipped headers. Run `npm run build` first.
  webServer: {
    command: 'node server/serve.mjs',
    url: `${baseURL}/healthz`,
    env: { PORT: String(PORT), HOST: '127.0.0.1' },
    reuseExistingServer: false,
  },
  projects: [
    // Headers and cache rules: plain HTTP, no browser needed.
    { name: 'http', testMatch: /headers\.spec\.ts/ },
    { name: 'chromium-desktop', testIgnore: /headers\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'chromium-phone', testIgnore: /headers\.spec\.ts/, use: { ...devices['Pixel 7'] } },
    { name: 'webkit-iphone', testIgnore: /headers\.spec\.ts/, use: { ...devices['iPhone 17'] } },
  ],
});
