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
//   LINKCHECK_OIDC_ISSUER, LINKCHECK_OIDC_AUDIENCE (nwfl-linkcheck),
//   LINKCHECK_OIDC_JWKS_URL, LINKCHECK_SCOPE (links.check),
//   LINKCHECK_SUBJECT (svc-nwfl-linkcheck): the link checker (L-ITEM)
//   Every client's audience must differ from every other's, or the service
//   refuses to start: one token must never be valid for two clients.
//   An audience, scope or subject of a configured client that is set but
//   empty or blank (nothing in it that a reader sees: spaces, zero-width
//   and other hidden characters) also refuses to start, by name: it would
//   switch that check off, not fall back to the default.
//   EDGE_CLIENT_IDS        the edge's mesh identities, comma-separated
//                          (default cloudflared in nwfl-edge). Each must be
//                          a full identity in the nwfl-edge namespace and
//                          not the web's or the API's; set but empty, or
//                          any entry that is not, refuses to start
//   SITE_GROUP_PREFIX      the chapter's Authentik group prefix (default
//                          nwfl-; e.g. mensa-nwfl-): <prefix>officers is read
//                          as the internal nwfl-officers (groups.ts). A bad
//                          one refuses to start
//   OFFICER_VERIFY         on or off (default off; unset or empty is off):
//                          on, an officer power needs member standing too
//                          (OFFICER-VERIFY, caller.ts). Any other value
//                          refuses to start; on also needs CHAPTER_GROUP_NAME
//   CHAPTER_GROUP_NAME     the chapter's own local group, exactly as the
//                          membership records name it (e.g. Northwest Florida
//                          Mensa; membership/local-groups.ts). Unset: no one is
//                          a chapter member. Any other name refuses to start
//
// The scope and subject defaults follow the plan's names; the real values come
// from the Authentik blueprint (I4) and are set here when they differ.
// ============================================================================
import { type JWTVerifyGetKey, createRemoteJWKSet } from 'jose';
import { LOCAL_GROUPS, NO_GROUP } from '../membership/local-groups.js';
import { type ClientKind, DEFAULT_EDGE_CLIENT_IDS, type TokenVerifier, rejectAllTokens } from './caller.js';
import { parseGroupPrefix } from './groups.js';
import { type ClientConfig, createJwtVerifier } from './jwt.js';
import { seenText } from '../platform/seen.js';

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
  /** SITE_GROUP_PREFIX (groups.ts). */
  groupPrefix: string;
  /** OFFICER_VERIFY: whether an officer power needs member standing too (caller.ts establish). */
  officerVerify: boolean;
  /** CHAPTER_GROUP_NAME: the chapter's own local group (membership/local-groups.ts); null when unset. */
  chapterGroup: string | null;
}

const DEFAULTS: Record<ClientKind, { prefix: string; audience: string; scope?: string; subject?: string }> = {
  site: { prefix: 'SITE', audience: 'nwfl-site' },
  agent: { prefix: 'AGENT', audience: 'nwfl-agent', scope: 'newsletter.read', subject: 'svc-nwfl-newsletter' },
  verifier: { prefix: 'VERIFIER', audience: 'nwfl-verifier', scope: 'membership.verify', subject: 'svc-nwfl-verifier' },
  linkcheck: { prefix: 'LINKCHECK', audience: 'nwfl-linkcheck', scope: 'links.check', subject: 'svc-nwfl-linkcheck' },
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

/** A client's audience, scope or subject: the variable's value, or the default when it is unset. Set but empty or blank refuses to start. */
function claim(env: Env, name: string, fallback: string): string {
  const value = env[name];
  if (value === undefined) return fallback;
  // Blank as a reviewer's note is blank (platform/seen.ts): nothing in it that a reader sees.
  if (seenText(value) === null) throw new Error(`${name} must not be empty (unset it for the default)`);
  return value;
}

// A Linkerd identity of a service account in the edge namespace: <sa>.nwfl-edge.serviceaccount.identity.linkerd.<trust domain>.
const LABEL = '[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?';
const EDGE_IDENTITY = new RegExp(`^(${LABEL})\\.nwfl-edge\\.serviceaccount\\.identity\\.linkerd\\.${LABEL}(?:\\.${LABEL})*$`);
// The site's own workloads, never the edge.
const NOT_EDGE_ACCOUNTS = new Set(['nwfl-web', 'nwfl-api']);

export function readAuthConfig(env: Env): AuthConfig {
  const clients: ClientSpec[] = [];
  for (const kind of ['site', 'agent', 'verifier', 'linkcheck'] as const) {
    const { prefix, audience, scope, subject } = DEFAULTS[kind];
    const issuer = env[`${prefix}_OIDC_ISSUER`];
    if (issuer === undefined || issuer === '') continue;
    https(`${prefix}_OIDC_ISSUER`, issuer);
    const jwksUrl = https(`${prefix}_OIDC_JWKS_URL`, env[`${prefix}_OIDC_JWKS_URL`] ?? `${issuer.replace(/\/?$/, '/')}jwks/`);
    clients.push({
      kind,
      issuer,
      audience: claim(env, `${prefix}_OIDC_AUDIENCE`, audience),
      jwksUrl,
      ...(scope !== undefined ? { scope: claim(env, `${prefix}_SCOPE`, scope) } : {}),
      ...(subject !== undefined ? { subject: claim(env, `${prefix}_SUBJECT`, subject) } : {}),
    });
  }
  if (new Set(clients.map((client) => client.audience)).size !== clients.length) {
    throw new Error('the clients audiences must differ: one token must never be valid for two clients');
  }
  const edge = env['EDGE_CLIENT_IDS'];
  const edgeClientIds = edge === undefined ? DEFAULT_EDGE_CLIENT_IDS : edge.split(',').map((id) => id.trim()).filter((id) => id !== '');
  // Set but empty would switch the edge narrowing and the edge budget off.
  if (edgeClientIds.length === 0) throw new Error('EDGE_CLIENT_IDS must name at least one identity (unset it for the default)');
  // A typo, or the web's or the API's own identity, would leave the real edge unnarrowed.
  for (const id of edgeClientIds) {
    const account = EDGE_IDENTITY.exec(id)?.[1];
    if (account === undefined || NOT_EDGE_ACCOUNTS.has(account)) {
      throw new Error(`EDGE_CLIENT_IDS: ${id} is not an edge identity (<service account>.nwfl-edge.serviceaccount.identity.linkerd.<trust domain>)`);
    }
  }
  const officerVerify = officerVerifyOf(env['OFFICER_VERIFY']);
  const chapterGroup = chapterGroupOf(env['CHAPTER_GROUP_NAME']);
  // With the switch on, an officer power needs a chapter member's standing, which needs the chapter's name.
  if (officerVerify && chapterGroup === null) throw new Error('CHAPTER_GROUP_NAME must be set when OFFICER_VERIFY is on');
  return { clients, edgeClientIds, groupPrefix: parseGroupPrefix(env['SITE_GROUP_PREFIX']), officerVerify, chapterGroup };
}

/**
 * CHAPTER_GROUP_NAME: the chapter's own local group, trimmed, which must be one of the known local groups
 * (and not "No group assigned"): a typo would make every member a guest. Unset: none, so no one is a
 * chapter member and nothing is approved by the membership check alone.
 */
function chapterGroupOf(value: string | undefined): string | null {
  if (value === undefined) return null;
  const name = value.trim();
  if (!LOCAL_GROUPS.has(name) || name === NO_GROUP) throw new Error('CHAPTER_GROUP_NAME must be one of the local group names (membership/local-groups.ts), e.g. Northwest Florida Mensa');
  return name;
}

/**
 * OFFICER_VERIFY, read once at startup: on, or off (unset and empty are off, the default, so the change
 * rolls dark). Any other value refuses to start: a typo must never leave an operator believing it is on.
 */
function officerVerifyOf(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === 'off') return false;
  if (value === 'on') return true;
  throw new Error('OFFICER_VERIFY must be on or off (unset is off)');
}

/** A remote, cached key set per client (jose's defaults: 5 s timeout, 10 min cache, 30 s cooldown). */
export function toClientConfigs(specs: ClientSpec[], keySet: (url: URL) => JWTVerifyGetKey = (url) => createRemoteJWKSet(url)): ClientConfig[] {
  return specs.map(({ jwksUrl, ...client }) => ({ ...client, jwks: keySet(new URL(jwksUrl)) }));
}

/** The verifier for a configuration: jose against each client's JWKS, or, with no client, refuse every token. */
export function verifierFrom(config: AuthConfig, keySet?: (url: URL) => JWTVerifyGetKey): TokenVerifier {
  return config.clients.length === 0 ? rejectAllTokens : createJwtVerifier(toClientConfigs(config.clients, keySet));
}
