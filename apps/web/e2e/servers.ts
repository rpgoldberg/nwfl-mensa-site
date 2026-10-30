// Where the e2e suite reaches the site. The browsers and the API client go
// through the test TLS edge (e2e/tls-proxy.mjs), as readers go through
// Cloudflare; a test that plays cloudflared itself talks to the server directly.
// The site reads the stand-in API (e2e/api.mjs) over gRPC; a second server,
// reached directly, has an API that never answers; a third, behind its own TLS
// edge, has an API with no issue of the newsletter published yet.
// The local test identity provider (e2e/idp.mjs) stands in for the club's own,
// on 127.0.0.1: WebKit applies the site's HSTS to "localhost", whatever the
// port, and an IP address is never an HSTS host.
export const BACKEND_PORT = Number(process.env['E2E_PORT'] ?? 8087);
export const TLS_PORT = Number(process.env['E2E_TLS_PORT'] ?? 8443);
export const IDP_PORT = Number(process.env['E2E_IDP_PORT'] ?? 9090);
export const API_PORT = Number(process.env['E2E_API_PORT'] ?? 9091);
export const SILENT_API_PORT = Number(process.env['E2E_SILENT_API_PORT'] ?? 9092);
export const DOWN_PORT = Number(process.env['E2E_DOWN_PORT'] ?? 8088);
export const NO_ISSUES_API_PORT = Number(process.env['E2E_NO_ISSUES_API_PORT'] ?? 9093);
export const NO_ISSUES_PORT = Number(process.env['E2E_NO_ISSUES_PORT'] ?? 8089);
export const NO_ISSUES_TLS_PORT = Number(process.env['E2E_NO_ISSUES_TLS_PORT'] ?? 8444);
export const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
export const SITE_URL = `https://localhost:${TLS_PORT}`;
export const IDP_ORIGIN = `http://127.0.0.1:${IDP_PORT}`;
export const API_URL = `http://127.0.0.1:${API_PORT}`;
/** The site whose API accepts connections and never answers. */
export const DOWN_URL = `http://127.0.0.1:${DOWN_PORT}`;
/** The site whose API has published no issue of the newsletter: /news keeps its sample. */
export const NO_ISSUES_BACKEND_URL = `http://127.0.0.1:${NO_ISSUES_PORT}`;
export const NO_ISSUES_SITE_URL = `https://localhost:${NO_ISSUES_TLS_PORT}`;
