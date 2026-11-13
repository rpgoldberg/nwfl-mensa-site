// EDITOR E7a: the officers' editor on the REAL stack, not the stand-in: the built site, with sign-in on,
// in front of the real API over a throwaway Postgres (the redaction lane's e2e/redaction/stack.mjs, which
// seeds the President's and the Treasurer's offices, a series and one-offs), and the test identity
// provider (e2e/idp.mjs) over https issuing the API's JWTs. Before it:
//   sh ../api/scripts/test-db.sh start, and export what it prints;
//   npm run build here and in ../api.
// One browser, one worker: the round trip is one story, told in order. The client secret is made once
// here, in the main process, and handed to the workers in the environment: e2e/editor-real/api.ts signs
// in at the provider itself to call Approve and Publish, which have no screen yet (E4).
import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';
import { EDITOR_REAL } from './e2e/editor-real/servers';
import { type IdpCertificate, idpCertificate } from './e2e/redaction/idp-certificate';
import { ACCOUNTS } from './e2e/stand-in';

const main = process.env['TEST_WORKER_INDEX'] === undefined;
const tls: IdpCertificate = main ? idpCertificate() : { key: '', cert: '', caFile: '' };
if (main) process.env['E2E_EDITOR_REAL_CLIENT_SECRET'] ??= randomBytes(24).toString('base64url');
const client = { id: EDITOR_REAL.clientId, secret: String(process.env['E2E_EDITOR_REAL_CLIENT_SECRET']) };
const redirects = { REDIRECT_URI: `${EDITOR_REAL.siteUrl}/auth/callback`, POST_LOGOUT_REDIRECT_URI: `${EDITOR_REAL.siteUrl}/signed-out` };

export default defineConfig({
  testDir: 'e2e/editor-real',
  forbidOnly: !!process.env['CI'],
  retries: 0,
  workers: 1,
  timeout: 120_000,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: EDITOR_REAL.siteUrl, ignoreHTTPSErrors: true, trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'node e2e/idp.mjs',
      url: `${EDITOR_REAL.idpUrl}/.well-known/openid-configuration`,
      ignoreHTTPSErrors: true,
      env: { IDP_PORT: String(EDITOR_REAL.idpPort), IDP_TLS_KEY: tls.key, IDP_TLS_CERT: tls.cert, CLIENT_ID: client.id, CLIENT_SECRET: client.secret, ...redirects },
      reuseExistingServer: false,
    },
    {
      command: 'node e2e/redaction/stack.mjs',
      url: `${EDITOR_REAL.stackUrl}/fixture`,
      env: {
        API_PORT: String(EDITOR_REAL.apiPort),
        API_HEALTH_PORT: String(EDITOR_REAL.apiHealthPort),
        STACK_PORT: String(EDITOR_REAL.stackPort),
        SITE_OIDC_ISSUER: EDITOR_REAL.idpUrl,
        SITE_OIDC_JWKS_URL: `${EDITOR_REAL.idpUrl}/jwks`,
        IDP_CA_FILE: tls.caFile,
        // A member reads the members passage; the officers need no member account.
        MEMBER_SUBS: ACCOUNTS.member,
      },
      timeout: 180_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
      reuseExistingServer: false,
    },
    {
      command: 'node server/serve.mjs',
      url: `${EDITOR_REAL.backendUrl}/healthz`,
      env: {
        PORT: String(EDITOR_REAL.backendPort),
        HOST: '127.0.0.1',
        API_URL: EDITOR_REAL.apiUrl,
        OIDC_ISSUER: EDITOR_REAL.idpUrl,
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
      url: `${EDITOR_REAL.siteUrl}/healthz`,
      ignoreHTTPSErrors: true,
      env: { TLS_PORT: String(EDITOR_REAL.tlsPort), UPSTREAM: EDITOR_REAL.backendUrl },
      reuseExistingServer: false,
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
