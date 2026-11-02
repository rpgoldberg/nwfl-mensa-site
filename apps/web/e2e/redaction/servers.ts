// Where the redaction leak test's servers listen (playwright.redaction.config.ts).
const port = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

const backendPort = port('E2E_REDACT_PORT', 8097);
const tlsPort = port('E2E_REDACT_TLS_PORT', 8453);
const apiPort = port('E2E_REDACT_API_PORT', 9101);
const apiHealthPort = port('E2E_REDACT_API_HEALTH_PORT', 9102);
const stackPort = port('E2E_REDACT_STACK_PORT', 9103);
// A14: the test identity provider over https (the API takes an https issuer only), and a second site
// with sign-in on, behind its own TLS edge; the first keeps sign-in off, as the canary runs today.
const idpPort = port('E2E_REDACT_IDP_PORT', 9104);
const memberBackendPort = port('E2E_REDACT_MEMBER_PORT', 8098);
const memberTlsPort = port('E2E_REDACT_MEMBER_TLS_PORT', 8454);

export const REDACTION = {
  backendPort,
  tlsPort,
  apiPort,
  apiHealthPort,
  stackPort,
  idpPort,
  memberBackendPort,
  memberTlsPort,
  backendUrl: `http://127.0.0.1:${backendPort}`,
  siteUrl: `https://localhost:${tlsPort}`,
  apiUrl: `http://127.0.0.1:${apiPort}`,
  stackUrl: `http://127.0.0.1:${stackPort}`,
  idpUrl: `https://127.0.0.1:${idpPort}`,
  memberBackendUrl: `http://127.0.0.1:${memberBackendPort}`,
  memberSiteUrl: `https://localhost:${memberTlsPort}`,
};
