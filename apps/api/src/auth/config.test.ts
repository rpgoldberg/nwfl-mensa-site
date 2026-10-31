// Which token clients the service accepts, read from the environment: each
// client is on only when its issuer is set; issuer and JWKS must be https.
import { describe, expect, it } from 'vitest';
import { DEFAULT_EDGE_CLIENT_IDS, rejectAllTokens } from './caller.js';
import { readAuthConfig, toClientConfigs, verifierFrom } from './config.js';

const ISS = 'https://login.nwflorida.us/application/o/nwfl-site/';

describe('readAuthConfig', () => {
  it('accepts no client at all when nothing is set: every token is then refused', () => {
    expect(readAuthConfig({})).toEqual({ clients: [], edgeClientIds: DEFAULT_EDGE_CLIENT_IDS, groupPrefix: 'nwfl-' });
  });

  it('reads the chapter\'s group prefix from SITE_GROUP_PREFIX (CF-ISO-0), and refuses to start on a bad one', () => {
    expect(readAuthConfig({ SITE_GROUP_PREFIX: 'mensa-nwfl-' }).groupPrefix).toBe('mensa-nwfl-');
    expect(() => readAuthConfig({ SITE_GROUP_PREFIX: '' })).toThrow(/SITE_GROUP_PREFIX/);
    expect(() => readAuthConfig({ SITE_GROUP_PREFIX: 'nwfl-office-' })).toThrow(/SITE_GROUP_PREFIX/);
  });

  it('turns a client on by its issuer, with defaults for audience, JWKS, scope and subject', () => {
    const config = readAuthConfig({
      SITE_OIDC_ISSUER: ISS,
      AGENT_OIDC_ISSUER: 'https://login.nwflorida.us/application/o/nwfl-agent/',
      VERIFIER_OIDC_ISSUER: 'https://login.nwflorida.us/application/o/nwfl-verifier/',
    });
    expect(config.clients).toEqual([
      { kind: 'site', issuer: ISS, audience: 'nwfl-site', jwksUrl: `${ISS}jwks/` },
      {
        kind: 'agent',
        issuer: 'https://login.nwflorida.us/application/o/nwfl-agent/',
        audience: 'nwfl-agent',
        jwksUrl: 'https://login.nwflorida.us/application/o/nwfl-agent/jwks/',
        scope: 'newsletter.read',
        subject: 'svc-nwfl-newsletter',
      },
      {
        kind: 'verifier',
        issuer: 'https://login.nwflorida.us/application/o/nwfl-verifier/',
        audience: 'nwfl-verifier',
        jwksUrl: 'https://login.nwflorida.us/application/o/nwfl-verifier/jwks/',
        scope: 'membership.verify',
        subject: 'svc-nwfl-verifier',
      },
    ]);
  });

  it('reads every override', () => {
    const config = readAuthConfig({
      SITE_OIDC_ISSUER: ISS,
      SITE_OIDC_AUDIENCE: 'abc123',
      SITE_OIDC_JWKS_URL: 'https://keys.example.org/site.json',
      AGENT_OIDC_ISSUER: ISS,
      AGENT_OIDC_AUDIENCE: 'def456',
      AGENT_SCOPE: 'newsletter:read',
      AGENT_SUBJECT: 'ak-agent',
      EDGE_CLIENT_IDS: 'a.nwfl-edge.serviceaccount.identity.linkerd.cluster.local, b.nwfl-edge.serviceaccount.identity.linkerd.mesh.example.org',
    });
    expect(config.clients[0]).toEqual({ kind: 'site', issuer: ISS, audience: 'abc123', jwksUrl: 'https://keys.example.org/site.json' });
    expect(config.clients[1]).toMatchObject({ audience: 'def456', scope: 'newsletter:read', subject: 'ak-agent' });
    expect(config.edgeClientIds).toEqual(['a.nwfl-edge.serviceaccount.identity.linkerd.cluster.local', 'b.nwfl-edge.serviceaccount.identity.linkerd.mesh.example.org']);
  });

  it.each([
    ['a short name', 'cloudflared'],
    ['another namespace', 'cloudflared.nwfl.serviceaccount.identity.linkerd.cluster.local'],
    ['the web identity', 'nwfl-web.nwfl.serviceaccount.identity.linkerd.cluster.local'],
    ['the web service account in the edge namespace', 'nwfl-web.nwfl-edge.serviceaccount.identity.linkerd.cluster.local'],
    ['the API service account in the edge namespace', 'nwfl-api.nwfl-edge.serviceaccount.identity.linkerd.cluster.local'],
    ['a capital letter', 'Cloudflared.nwfl-edge.serviceaccount.identity.linkerd.cluster.local'],
    ['no trust domain', 'cloudflared.nwfl-edge.serviceaccount.identity.linkerd'],
    ['one good and one typo', 'cloudflared.nwfl-edge.serviceaccount.identity.linkerd.cluster.local,cloudflare'],
  ])('refuses to start with EDGE_CLIENT_IDS naming %s', (_label, value) => {
    expect(() => readAuthConfig({ EDGE_CLIENT_IDS: value })).toThrow(/is not an edge identity/);
  });

  it.each(['', ' ', ', ,'])('refuses to start with EDGE_CLIENT_IDS set but naming no identity (%j): the edge would go unnarrowed', (value) => {
    expect(() => readAuthConfig({ EDGE_CLIENT_IDS: value })).toThrow(/EDGE_CLIENT_IDS must name at least one identity/);
  });

  it.each([
    [{ SITE_OIDC_ISSUER: 'http://login.nwflorida.us/' }, /SITE_OIDC_ISSUER must be an https URL/],
    [{ SITE_OIDC_ISSUER: ISS, SITE_OIDC_JWKS_URL: 'http://keys/' }, /SITE_OIDC_JWKS_URL must be an https URL/],
    [{ AGENT_OIDC_ISSUER: 'not a url' }, /AGENT_OIDC_ISSUER must be an https URL/],
    [{ SITE_OIDC_ISSUER: ISS, AGENT_OIDC_ISSUER: ISS, AGENT_OIDC_AUDIENCE: 'nwfl-site' }, /audiences must differ/],
  ])('refuses %j', (env, message) => {
    expect(() => readAuthConfig(env)).toThrow(message);
  });
});

describe('toClientConfigs', () => {
  it('gives each client a remote key set for its JWKS URL', () => {
    const urls: string[] = [];
    const configs = toClientConfigs(readAuthConfig({ SITE_OIDC_ISSUER: ISS }).clients, (url) => {
      urls.push(url.toString());
      return () => Promise.reject(new Error('unused'));
    });
    expect(configs.map((c) => [c.kind, c.issuer, c.audience])).toEqual([['site', ISS, 'nwfl-site']]);
    expect(urls).toEqual([`${ISS}jwks/`]);
  });

  it('uses a remote, cached key set by default', () => {
    const [site] = toClientConfigs(readAuthConfig({ SITE_OIDC_ISSUER: ISS }).clients);
    expect(typeof site?.jwks).toBe('function');
  });
});

describe('verifierFrom', () => {
  it('refuses every token when no client is on', () => {
    expect(verifierFrom(readAuthConfig({}))).toBe(rejectAllTokens);
  });

  it('verifies against the configured clients when one is on', async () => {
    const verifier = verifierFrom(readAuthConfig({ SITE_OIDC_ISSUER: ISS }), () => () => Promise.reject(new Error('no keys')));
    expect(verifier).not.toBe(rejectAllTokens);
    await expect(verifier.verify('not.a.jwt')).rejects.toThrow();
  });
});
