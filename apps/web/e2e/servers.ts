// Where the e2e suite reaches the site. The browsers and the API client go
// through the test TLS edge (e2e/tls-proxy.mjs), as readers go through
// Cloudflare; a test that plays cloudflared itself talks to the server directly.
// The local test identity provider (e2e/idp.mjs) stands in for the club's own,
// on 127.0.0.1: WebKit applies the site's HSTS to "localhost", whatever the
// port, and an IP address is never an HSTS host.
export const BACKEND_PORT = Number(process.env['E2E_PORT'] ?? 8087);
export const TLS_PORT = Number(process.env['E2E_TLS_PORT'] ?? 8443);
export const IDP_PORT = Number(process.env['E2E_IDP_PORT'] ?? 9090);
export const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
export const SITE_URL = `https://localhost:${TLS_PORT}`;
export const IDP_ORIGIN = `http://127.0.0.1:${IDP_PORT}`;
