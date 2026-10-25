// The redaction leak test (REDACT R2b): the built site in front of the REAL
// API over a throwaway Postgres seeded with canaries (e2e/redaction/stack.mjs),
// behind the same TLS edge as the main suite. Before it:
//   sh ../api/scripts/test-db.sh start, and export what it prints;
//   npm run build here and in ../api.
// Its own ports, so it never meets the main suite's servers.
import { defineConfig } from '@playwright/test';
import { REDACTION } from './e2e/redaction/servers';

export default defineConfig({
  testDir: 'e2e/redaction',
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: REDACTION.siteUrl, ignoreHTTPSErrors: true },
  webServer: [
    {
      command: 'node e2e/redaction/stack.mjs',
      url: `${REDACTION.stackUrl}/fixture`,
      env: { API_PORT: String(REDACTION.apiPort), API_HEALTH_PORT: String(REDACTION.apiHealthPort), STACK_PORT: String(REDACTION.stackPort) },
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
  ],
  // Plain HTTP: every byte of every response, no browser needed.
  projects: [{ name: 'http', testMatch: /leak\.spec\.ts/ }],
});
