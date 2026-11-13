// Where the officers' editor real-stack check (EDITOR E7a) listens: playwright.editor-real.config.ts.
// Ports of its own, so it never meets the main suite's or the redaction lane's servers.
const port = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

const apiPort = port('E2E_EDITOR_REAL_API_PORT', 26101);
const apiHealthPort = port('E2E_EDITOR_REAL_API_HEALTH_PORT', 26102);
const stackPort = port('E2E_EDITOR_REAL_STACK_PORT', 26103);
const idpPort = port('E2E_EDITOR_REAL_IDP_PORT', 26104);
const backendPort = port('E2E_EDITOR_REAL_PORT', 26098);
const tlsPort = port('E2E_EDITOR_REAL_TLS_PORT', 26454);

export const EDITOR_REAL = {
  apiPort,
  apiHealthPort,
  stackPort,
  idpPort,
  backendPort,
  tlsPort,
  apiUrl: `http://127.0.0.1:${apiPort}`,
  stackUrl: `http://127.0.0.1:${stackPort}`,
  idpUrl: `https://127.0.0.1:${idpPort}`,
  backendUrl: `http://127.0.0.1:${backendPort}`,
  siteUrl: `https://localhost:${tlsPort}`,
  clientId: 'nwfl-site-editor-real',
};
