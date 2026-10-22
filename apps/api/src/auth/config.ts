// ============================================================================
// The token clients the service accepts, from the environment. A client is on
// only when its issuer is set; with none set, every token is refused and the
// service is public-only.
//
//   SITE_OIDC_ISSUER       the nwfl-site provider's issuer (https)
//   SITE_OIDC_AUDIENCE     default nwfl-site (the provider's client id)
//   SITE_OIDC_JWKS_URL     default <issuer>jwks/ (Authentik's layout)
//   AGENT_OIDC_ISSUER, AGENT_OIDC_AUDIENCE (nwfl-agent), AGENT_OIDC_JWKS_URL,
//   AGENT_SCOPE (newsletter.read), AGENT_SUBJECT (svc-nwfl-newsletter)
//   VERIFIER_OIDC_ISSUER, VERIFIER_OIDC_AUDIENCE (nwfl-verifier),
//   VERIFIER_OIDC_JWKS_URL, VERIFIER_SCOPE (membership.verify),
//   VERIFIER_SUBJECT (svc-nwfl-verifier)
//   EDGE_CLIENT_IDS        the edge's mesh identities, comma-separated
//                          (default cloudflared in nwfl-edge; set but
//                          empty refuses to start)
//
// The scope and subject defaults follow the plan's names; the real values come
// from the Authentik blueprint (I4) and are set here when they differ.
// ============================================================================
import { type JWTVerifyGetKey, createRemoteJWKSet } from 'jose';
import { type ClientKind, DEFAULT_EDGE_CLIENT_IDS, type TokenVerifier, rejectAllTokens } from './caller.js';
import { type ClientConfig, createJwtVerifier } from './jwt.js';

type Env = Record<string, string | undefined>;

export interface ClientSpec {
  kind: ClientKind;
  issuer: string;
  audience: string;
  jwksUrl: string;
  scope?: string;
  subject?: string;
}

export interface AuthConfig {
  clients: ClientSpec[];
  edgeClientIds: readonly string[];
}

const DEFAULTS: Record<ClientKind, { prefix: string; audience: string; scope?: string; subject?: string }> = {
  site: { prefix: 'SITE', audience: 'nwfl-site' },
  agent: { prefix: 'AGENT', audience: 'nwfl-agent', scope: 'newsletter.read', subject: 'svc-nwfl-newsletter' },
  verifier: { prefix: 'VERIFIER', audience: 'nwfl-verifier', scope: 'membership.verify', subject: 'svc-nwfl-verifier' },
};

function https(name: string, value: string): string {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (url?.protocol !== 'https:') throw new Error(`${name} must be an https URL`);
  return value;
}

export function readAuthConfig(env: Env): AuthConfig {
  const clients: ClientSpec[] = [];
  for (const kind of ['site', 'agent', 'verifier'] as const) {
    const { prefix, audience, scope, subject } = DEFAULTS[kind];
    const issuer = env[`${prefix}_OIDC_ISSUER`];
    if (issuer === undefined || issuer === '') continue;
    https(`${prefix}_OIDC_ISSUER`, issuer);
    const jwksUrl = https(`${prefix}_OIDC_JWKS_URL`, env[`${prefix}_OIDC_JWKS_URL`] ?? `${issuer.replace(/\/?$/, '/')}jwks/`);
    clients.push({
      kind,
      issuer,
      audience: env[`${prefix}_OIDC_AUDIENCE`] ?? audience,
      jwksUrl,
      ...(scope !== undefined ? { scope: env[`${prefix}_SCOPE`] ?? scope } : {}),
      ...(subject !== undefined ? { subject: env[`${prefix}_SUBJECT`] ?? subject } : {}),
    });
  }
  if (new Set(clients.map((client) => client.audience)).size !== clients.length) {
    throw new Error('the clients audiences must differ: one token must never be valid for two clients');
  }
  const edge = env['EDGE_CLIENT_IDS'];
  const edgeClientIds = edge === undefined ? DEFAULT_EDGE_CLIENT_IDS : edge.split(',').map((id) => id.trim()).filter((id) => id !== '');
  // Set but empty would switch the edge narrowing and the edge budget off.
  if (edgeClientIds.length === 0) throw new Error('EDGE_CLIENT_IDS must name at least one identity (unset it for the default)');
  return { clients, edgeClientIds };
}

/** A remote, cached key set per client (jose's defaults: 5 s timeout, 10 min cache, 30 s cooldown). */
export function toClientConfigs(specs: ClientSpec[], keySet: (url: URL) => JWTVerifyGetKey = (url) => createRemoteJWKSet(url)): ClientConfig[] {
  return specs.map(({ jwksUrl, ...client }) => ({ ...client, jwks: keySet(new URL(jwksUrl)) }));
}

/** The verifier for a configuration: jose against each client's JWKS, or, with no client, refuse every token. */
export function verifierFrom(config: AuthConfig, keySet?: (url: URL) => JWTVerifyGetKey): TokenVerifier {
  return config.clients.length === 0 ? rejectAllTokens : createJwtVerifier(toClientConfigs(config.clients, keySet));
}
