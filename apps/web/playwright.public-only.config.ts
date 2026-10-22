// The public-only canary build: `npm run build:public-only`, then this config.
// Same servers and TLS edge as the main suite; only the canary checks run.
import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

// No test identity provider, and no sign-in settings for the server: a
// public-only deployment is never given any (the server would ignore them).
const servers = (Array.isArray(base.webServer) ? base.webServer : [])
  .filter((server) => !server.command.includes('idp.mjs'))
  .map((server) => ({ ...server, env: Object.fromEntries(Object.entries(server.env ?? {}).filter(([name]) => !/^(OIDC_|SESSION_KEY$)/.test(name))) }));

export default defineConfig({
  ...base,
  webServer: servers,
  testDir: 'e2e/public-only',
  testIgnore: [],
  projects: [
    { name: 'http', testMatch: /canary\.spec\.ts/, grep: /\(\d\) / },
    { name: 'chromium-phone', testMatch: /canary\.spec\.ts/, grepInvert: /\(\d\) /, use: { ...devices['Pixel 7'] } },
    { name: 'webkit-iphone', testMatch: /canary\.spec\.ts/, grepInvert: /\(\d\) /, use: { ...devices['iPhone 17'] } },
  ],
});
