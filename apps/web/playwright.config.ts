import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';
import { BACKEND_PORT, BACKEND_URL, IDP_ORIGIN, IDP_PORT, SITE_URL, TLS_PORT } from './e2e/servers';

// Made fresh for each run: the test provider's client secret and the session key.
const client = { id: 'nwfl-site-e2e', secret: randomBytes(24).toString('base64url') };
const redirects = { REDIRECT_URI: `${SITE_URL}/auth/callback`, POST_LOGOUT_REDIRECT_URI: `${SITE_URL}/signed-out` };

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
      command: 'node e2e/idp.mjs',
      url: `${IDP_ORIGIN}/.well-known/openid-configuration`,
      env: { IDP_PORT: String(IDP_PORT), CLIENT_ID: client.id, CLIENT_SECRET: client.secret, ...redirects },
      reuseExistingServer: false,
    },
    {
      command: 'node server/serve.mjs',
      url: `${BACKEND_URL}/healthz`,
      env: {
        PORT: String(BACKEND_PORT),
        HOST: '127.0.0.1',
        OIDC_ISSUER: IDP_ORIGIN,
        OIDC_CLIENT_ID: client.id,
        OIDC_CLIENT_SECRET: client.secret,
        OIDC_REDIRECT_URI: redirects.REDIRECT_URI,
        OIDC_POST_LOGOUT_REDIRECT_URI: redirects.POST_LOGOUT_REDIRECT_URI,
        SESSION_KEY: randomBytes(32).toString('base64'),
      },
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
    { name: 'http', testMatch: /(headers|redirects)\.spec\.ts/ },
    { name: 'chromium-desktop', testIgnore: [/(headers|redirects)\.spec\.ts/, /public-only\//], use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'chromium-phone', testIgnore: [/(headers|redirects)\.spec\.ts/, /public-only\//], use: { ...devices['Pixel 7'] } },
    { name: 'webkit-iphone', testIgnore: [/(headers|redirects)\.spec\.ts/, /public-only\//], use: { ...devices['iPhone 17'] } },
  ],
});
