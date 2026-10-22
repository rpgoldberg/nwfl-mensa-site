// The public-only canary build: `npm run build:public-only`, then this config.
// Same servers and TLS edge as the main suite; only the canary checks run.
import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testDir: 'e2e/public-only',
  testIgnore: [],
  projects: [
    { name: 'http', testMatch: /canary\.spec\.ts/, grep: /\(\d\) / },
    { name: 'chromium-phone', testMatch: /canary\.spec\.ts/, grepInvert: /\(\d\) /, use: { ...devices['Pixel 7'] } },
    { name: 'webkit-iphone', testMatch: /canary\.spec\.ts/, grepInvert: /\(\d\) /, use: { ...devices['iPhone 17'] } },
  ],
});
