// The redaction leak test (REDACT R2b): the built site in front of the REAL
// API over a throwaway Postgres seeded with canaries (e2e/redaction/stack.mjs),
// behind the same TLS edge as the main suite. Before it:
//   sh ../api/scripts/test-db.sh start, and export what it prints;
//   npm run build here and in ../api.
// Its own ports, so it never meets the main suite's servers.
//
// A14: the test identity provider (e2e/idp.mjs) over https issues the API's
// JWT access tokens; the API verifies them (SITE_OIDC_*), and a second site,
// with sign-in on, forwards them on /news. The first site keeps sign-in off.
import { randomBytes } from 'node:crypto';
import { defineConfig } from '@playwright/test';
import { type IdpCertificate, idpCertificate } from './e2e/redaction/idp-certificate';
import { REDACTION } from './e2e/redaction/servers';
import { ACCOUNTS } from './e2e/stand-in';

// The servers start from Playwright's main process only; a worker loads this file too, and needs none of it.
const tls: IdpCertificate = process.env['TEST_WORKER_INDEX'] === undefined ? idpCertificate() : { key: '', cert: '', caFile: '' };
const client = { id: 'nwfl-site-redact', secret: randomBytes(24).toString('base64url') };
const redirects = { REDIRECT_URI: `${REDACTION.memberSiteUrl}/auth/callback`, POST_LOGOUT_REDIRECT_URI: `${REDACTION.memberSiteUrl}/signed-out` };

export default defineConfig({
  testDir: 'e2e/redaction',
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: REDACTION.siteUrl, ignoreHTTPSErrors: true },
  webServer: [
    {
      command: 'node e2e/idp.mjs',
      url: `${REDACTION.idpUrl}/.well-known/openid-configuration`,
      ignoreHTTPSErrors: true,
      env: { IDP_PORT: String(REDACTION.idpPort), IDP_TLS_KEY: tls.key, IDP_TLS_CERT: tls.cert, CLIENT_ID: client.id, CLIENT_SECRET: client.secret, ...redirects },
      reuseExistingServer: false,
    },
    {
      command: 'node e2e/redaction/stack.mjs',
      url: `${REDACTION.stackUrl}/fixture`,
      env: {
        API_PORT: String(REDACTION.apiPort),
        API_HEALTH_PORT: String(REDACTION.apiHealthPort),
        STACK_PORT: String(REDACTION.stackPort),
        SITE_OIDC_ISSUER: REDACTION.idpUrl,
        SITE_OIDC_JWKS_URL: `${REDACTION.idpUrl}/jwks`,
        IDP_CA_FILE: tls.caFile,
        // AC6 (b): standing in the API's records; the enrolees' claims hold nwfl-users alone (e2e/idp.mjs).
        MEMBER_SUBS: [ACCOUNTS.member, ACCOUNTS.enrolee].join(','),
        PENDING_SUBS: ACCOUNTS['enrolee-pending'],
      },
      timeout: 180_000,
      // Lets it stop the API and drop its database.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
      reuseExistingServer: false,
    },
    {
      command: 'node server/serve.mjs',
      url: `${REDACTION.backendUrl}/healthz`,
      env: { PORT: String(REDACTION.backendPort), HOST: '127.0.0.1', API_URL: REDACTION.apiUrl },
      reuseExistingServer: false,
    },
    {
      command: 'node e2e/tls-proxy.mjs',
      url: `${REDACTION.siteUrl}/healthz`,
      ignoreHTTPSErrors: true,
      env: { TLS_PORT: String(REDACTION.tlsPort), UPSTREAM: REDACTION.backendUrl },
      reuseExistingServer: false,
    },
    {
      command: 'node server/serve.mjs',
      url: `${REDACTION.memberBackendUrl}/healthz`,
      env: {
        PORT: String(REDACTION.memberBackendPort),
        HOST: '127.0.0.1',
        API_URL: REDACTION.apiUrl,
        OIDC_ISSUER: REDACTION.idpUrl,
        OIDC_CLIENT_ID: client.id,
        OIDC_CLIENT_SECRET: client.secret,
        OIDC_REDIRECT_URI: redirects.REDIRECT_URI,
        OIDC_POST_LOGOUT_REDIRECT_URI: redirects.POST_LOGOUT_REDIRECT_URI,
        SESSION_KEY: randomBytes(32).toString('base64'),
        NODE_EXTRA_CA_CERTS: tls.caFile,
      },
      reuseExistingServer: false,
    },
    {
      command: 'node e2e/tls-proxy.mjs',
      url: `${REDACTION.memberSiteUrl}/healthz`,
      ignoreHTTPSErrors: true,
      env: { TLS_PORT: String(REDACTION.memberTlsPort), UPSTREAM: REDACTION.memberBackendUrl },
      reuseExistingServer: false,
    },
  ],
  // Plain HTTP: every byte of every response, no browser needed.
  projects: [{ name: 'http', testMatch: /leak\.spec\.ts/ }],
});
