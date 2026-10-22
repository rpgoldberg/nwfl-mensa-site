// Where the e2e suite reaches the site. The browsers and the API client go
// through the test TLS edge (e2e/tls-proxy.mjs), as readers go through
// Cloudflare; a test that plays cloudflared itself talks to the server directly.
export const BACKEND_PORT = Number(process.env['E2E_PORT'] ?? 8087);
export const TLS_PORT = Number(process.env['E2E_TLS_PORT'] ?? 8443);
export const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
export const SITE_URL = `https://localhost:${TLS_PORT}`;
