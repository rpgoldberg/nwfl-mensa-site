// Where the redaction leak test's servers listen (playwright.redaction.config.ts).
const port = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

const backendPort = port('E2E_REDACT_PORT', 8097);
const tlsPort = port('E2E_REDACT_TLS_PORT', 8453);
const apiPort = port('E2E_REDACT_API_PORT', 9101);
const apiHealthPort = port('E2E_REDACT_API_HEALTH_PORT', 9102);
const stackPort = port('E2E_REDACT_STACK_PORT', 9103);

export const REDACTION = {
  backendPort,
  tlsPort,
  apiPort,
  apiHealthPort,
  stackPort,
  backendUrl: `http://127.0.0.1:${backendPort}`,
  siteUrl: `https://localhost:${tlsPort}`,
  apiUrl: `http://127.0.0.1:${apiPort}`,
  stackUrl: `http://127.0.0.1:${stackPort}`,
};
