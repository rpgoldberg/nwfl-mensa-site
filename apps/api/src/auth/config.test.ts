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
    [{ LINKCHECK_OIDC_ISSUER: 'http://login.nwflorida.us/' }, /LINKCHECK_OIDC_ISSUER must be an https URL/],
    [{ LINKCHECK_OIDC_ISSUER: ISS, LINKCHECK_OIDC_JWKS_URL: 'http://keys/' }, /LINKCHECK_OIDC_JWKS_URL must be an https URL/],
  ])('refuses %j', (env, message) => {
    expect(() => readAuthConfig(env)).toThrow(message);
  });

  // L-ITEM: the link checker's client, on by LINKCHECK_OIDC_ISSUER (links SPEC section 6).
  const LINKCHECK_ISS = 'https://login.nwflorida.us/application/o/nwfl-linkcheck/';

  it('turns the link checker on by its issuer: audience nwfl-linkcheck, scope links.check, subject svc-nwfl-linkcheck', () => {
    expect(readAuthConfig({ LINKCHECK_OIDC_ISSUER: LINKCHECK_ISS }).clients).toEqual([
      { kind: 'linkcheck', issuer: LINKCHECK_ISS, audience: 'nwfl-linkcheck', jwksUrl: `${LINKCHECK_ISS}jwks/`, scope: 'links.check', subject: 'svc-nwfl-linkcheck' },
    ]);
    expect(
      readAuthConfig({
        LINKCHECK_OIDC_ISSUER: LINKCHECK_ISS,
        LINKCHECK_OIDC_AUDIENCE: 'ghi789',
        LINKCHECK_OIDC_JWKS_URL: 'https://keys.example.org/linkcheck.json',
        LINKCHECK_SCOPE: 'links:check',
        LINKCHECK_SUBJECT: 'ak-linkcheck',
      }).clients,
    ).toEqual([{ kind: 'linkcheck', issuer: LINKCHECK_ISS, audience: 'ghi789', jwksUrl: 'https://keys.example.org/linkcheck.json', scope: 'links:check', subject: 'ak-linkcheck' }]);
  });

  it.each([
    ['the site', { SITE_OIDC_ISSUER: ISS, LINKCHECK_OIDC_AUDIENCE: 'nwfl-site' }],
    ['the agent', { AGENT_OIDC_ISSUER: ISS, LINKCHECK_OIDC_AUDIENCE: 'nwfl-agent' }],
    ['the verifier', { VERIFIER_OIDC_ISSUER: ISS, LINKCHECK_OIDC_AUDIENCE: 'nwfl-verifier' }],
    ['the verifier (its audience set to the checker one)', { VERIFIER_OIDC_ISSUER: ISS, VERIFIER_OIDC_AUDIENCE: 'nwfl-linkcheck' }],
  ])('refuses to start when the link checker audience is that of %s', (_label, env) => {
    expect(() => readAuthConfig({ LINKCHECK_OIDC_ISSUER: LINKCHECK_ISS, ...env })).toThrow(/audiences must differ/);
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
  // Fix round 1 (F3): an audience, scope or subject set to nothing would switch that check off (a token is
  // matched to a client by audience; an empty scope or subject is one no token is asked for). Refused at start, by name.
  describe('refuses to start on an empty or blank audience, scope or subject of a configured client', () => {
    const LC = 'https://login.nwflorida.us/application/o/nwfl-linkcheck/';
    it.each([
      ['site', 'SITE_OIDC_AUDIENCE', { SITE_OIDC_ISSUER: ISS }],
      ['agent', 'AGENT_OIDC_AUDIENCE', { AGENT_OIDC_ISSUER: ISS }],
      ['agent', 'AGENT_SCOPE', { AGENT_OIDC_ISSUER: ISS }],
      ['agent', 'AGENT_SUBJECT', { AGENT_OIDC_ISSUER: ISS }],
      ['verifier', 'VERIFIER_OIDC_AUDIENCE', { VERIFIER_OIDC_ISSUER: ISS }],
      ['verifier', 'VERIFIER_SCOPE', { VERIFIER_OIDC_ISSUER: ISS }],
      ['verifier', 'VERIFIER_SUBJECT', { VERIFIER_OIDC_ISSUER: ISS }],
      ['linkcheck', 'LINKCHECK_OIDC_AUDIENCE', { LINKCHECK_OIDC_ISSUER: LC }],
      ['linkcheck', 'LINKCHECK_SCOPE', { LINKCHECK_OIDC_ISSUER: LC }],
      ['linkcheck', 'LINKCHECK_SUBJECT', { LINKCHECK_OIDC_ISSUER: LC }],
    ])('the %s client: %s', (_kind, name, env) => {
      for (const value of ['', ' ', '\t\n', ' ']) {
        expect(() => readAuthConfig({ ...env, [name]: value }), JSON.stringify(value)).toThrow(new Error(`${name} must not be empty (unset it for the default)`));
      }
    });

    // Fix round 2 (R1-N3): a value made only of characters nobody sees (the ones a reviewer's note sheds:
    // links/urls.ts CONTROLS, then format, ignorable and blank characters) is blank too. Written as escapes.
    const UNSEEN: [string, string][] = [
      ['a zero-width space', '\u200b'],
      ['a byte order mark', '\ufeff'],
      ['a right-to-left override', '\u202e'],
      ['an escape and a NUL', '\u001b\u0000'],
      ['a soft hyphen and a word joiner', '\u00ad\u2060'],
      ['an ideographic space and a line separator', '\u3000\u2028'],
      ['a Hangul filler and a blank braille cell', '\u3164\u2800'],
      ['a variation selector and a combining mark', '\ufe0f\u0301'],
      ['an object replacement character and a null notehead', '\ufffc\u{1d159}'],
      ['all of them among spaces', ' \u200b\u202e\ufeff\u00a0\u2066\u2069\u061c\t\u00ad\u3164\ufffc '],
    ];
    it.each([
      ['site', ['SITE_OIDC_AUDIENCE'], { SITE_OIDC_ISSUER: ISS }],
      ['agent', ['AGENT_OIDC_AUDIENCE', 'AGENT_SCOPE', 'AGENT_SUBJECT'], { AGENT_OIDC_ISSUER: ISS }],
      ['verifier', ['VERIFIER_OIDC_AUDIENCE', 'VERIFIER_SCOPE', 'VERIFIER_SUBJECT'], { VERIFIER_OIDC_ISSUER: ISS }],
      ['linkcheck', ['LINKCHECK_OIDC_AUDIENCE', 'LINKCHECK_SCOPE', 'LINKCHECK_SUBJECT'], { LINKCHECK_OIDC_ISSUER: LC }],
    ])('the %s client: a value made only of characters nobody sees is refused by name', (_kind, names, env) => {
      for (const name of names) {
        for (const [label, value] of UNSEEN) {
          expect(() => readAuthConfig({ ...env, [name]: value }), `${name}: ${label}`).toThrow(new Error(`${name} must not be empty (unset it for the default)`));
        }
      }
    });

    it('takes a value with something to see as it is, hidden characters and all: it then matches no token', () => {
      expect(readAuthConfig({ SITE_OIDC_ISSUER: ISS, SITE_OIDC_AUDIENCE: 'nwfl\u200b-site' }).clients[0]).toMatchObject({ audience: 'nwfl\u200b-site' });
      expect(readAuthConfig({ AGENT_OIDC_ISSUER: ISS, AGENT_SCOPE: '\u{1f44d}' }).clients[0]).toMatchObject({ scope: '\u{1f44d}' });
    });

    it('leaves a client that is off alone, and takes a set value as it is', () => {
      expect(readAuthConfig({ LINKCHECK_OIDC_AUDIENCE: '', AGENT_SCOPE: ' ' }).clients).toEqual([]);
      expect(readAuthConfig({ LINKCHECK_OIDC_ISSUER: LC, LINKCHECK_OIDC_AUDIENCE: 'abc', LINKCHECK_SCOPE: 'links.check', LINKCHECK_SUBJECT: 'svc' }).clients[0]).toMatchObject({ audience: 'abc', scope: 'links.check', subject: 'svc' });
    });
  });
});
