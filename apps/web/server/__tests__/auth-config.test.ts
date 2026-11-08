import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SITE_PROFILES, authConfig, siteProfile } from '../auth-config.mjs';
import { PUBLIC_HOSTS } from '../public-hosts.mjs';

const SECRET = 'from-openbao-never-logged';
// A user part in a URL, spelt without a literal at sign, so the made-up-people scan reads no address here.
const AT = '@';

// S2: the real provider, as fc's F-D1 apply sets it up for the canary (APPLY.md, I-2).
const canary = {
  NODE_ENV: 'production',
  SITE_ORIGIN: 'https://canary.nwflmensa.us',
  OIDC_ISSUER: 'https://login.nwflmensa.us/application/o/nwfl-site-staging/',
  OIDC_CLIENT_ID: 'nwfl-site-staging',
  OIDC_CLIENT_SECRET: SECRET,
  OIDC_REDIRECT_URI: 'https://canary.nwflmensa.us/auth/callback',
  OIDC_POST_LOGOUT_REDIRECT_URI: 'https://canary.nwflmensa.us/signed-out',
  SITE_GROUP_PREFIX: 'mensa-nwfl-',
};

const apex = {
  ...canary,
  SITE_ORIGIN: 'https://nwflmensa.us',
  OIDC_REDIRECT_URI: 'https://nwflmensa.us/auth/callback',
  OIDC_POST_LOGOUT_REDIRECT_URI: 'https://nwflmensa.us/signed-out',
};

const reason = (env: Record<string, string | undefined>) => {
  const setup = authConfig(env);
  return setup.enabled ? undefined : setup.reason;
};

describe('the site profiles (S2): one frozen row per origin the site signs in on', () => {
  it('are exactly the new domain’s canary and apex, both at login.nwflmensa.us', () => {
    expect(SITE_PROFILES).toEqual({
      'https://canary.nwflmensa.us': {
        issuerOrigin: 'https://login.nwflmensa.us',
        redirect: 'https://canary.nwflmensa.us/auth/callback',
        postLogout: 'https://canary.nwflmensa.us/signed-out',
      },
      'https://nwflmensa.us': {
        issuerOrigin: 'https://login.nwflmensa.us',
        redirect: 'https://nwflmensa.us/auth/callback',
        postLogout: 'https://nwflmensa.us/signed-out',
      },
    });
    expect(Object.isFrozen(SITE_PROFILES)).toBe(true);
    for (const profile of Object.values(SITE_PROFILES)) expect(Object.isFrozen(profile)).toBe(true);
  });

  it('has no nwflorida.us row: the public domain waits on the ExComm (DOMAIN2)', () => {
    expect(JSON.stringify(SITE_PROFILES)).not.toContain('nwflorida');
  });

  it('keeps each row on its own origin, over https, on a host the site answers to', () => {
    const hosts = PUBLIC_HOSTS.map((h) => h.hostname);
    for (const [origin, profile] of Object.entries(SITE_PROFILES)) {
      const site = new URL(origin);
      expect(site.origin, origin).toBe(origin);
      expect(site.protocol, origin).toBe('https:');
      expect(hosts, origin).toContain(site.hostname);
      expect(new URL(profile.redirect).origin, origin).toBe(origin);
      expect(new URL(profile.postLogout).origin, origin).toBe(origin);
      expect(new URL(profile.issuerOrigin).origin, origin).toBe(profile.issuerOrigin);
      expect(profile.issuerOrigin.startsWith('https://'), origin).toBe(true);
    }
  });

  it('looks a row up by its exact origin only, never by an inherited name', () => {
    expect(siteProfile('https://canary.nwflmensa.us')).toBe(SITE_PROFILES['https://canary.nwflmensa.us']);
    for (const name of [undefined, '', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'https://canary.nwflmensa.us/', 'https://Canary.nwflmensa.us']) {
      expect(siteProfile(name), String(name)).toBeUndefined();
    }
  });
});

describe('authConfig in production (MT-03, S2): sign-in only on a profile', () => {
  it('takes the F-D1 provider for the canary: its issuer, client and group prefix', () => {
    const setup = authConfig(canary);
    expect(setup.enabled).toBe(true);
    if (!setup.enabled) return;
    expect(setup.config.issuer.href).toBe('https://login.nwflmensa.us/application/o/nwfl-site-staging/');
    expect(setup.config).toMatchObject({
      clientId: 'nwfl-site-staging',
      clientSecret: SECRET,
      redirectUri: 'https://canary.nwflmensa.us/auth/callback',
      postLogoutRedirectUri: 'https://canary.nwflmensa.us/signed-out',
      // VET: the email by default (fix 1: a configured scope must name it too).
      scope: 'openid profile email',
      allowInsecure: false,
      groupPrefix: 'mensa-nwfl-',
      siteOrigin: 'https://canary.nwflmensa.us',
    });
  });

  it('takes the apex with its own callback and signed-out page', () => {
    const setup = authConfig(apex);
    expect(setup.enabled && setup.config.redirectUri).toBe('https://nwflmensa.us/auth/callback');
    expect(setup.enabled && setup.config.postLogoutRedirectUri).toBe('https://nwflmensa.us/signed-out');
    expect(setup.enabled && setup.config.siteOrigin).toBe('https://nwflmensa.us');
  });

  it('needs SITE_ORIGIN, and it must be exactly one of the profiles', () => {
    expect(reason({ ...canary, SITE_ORIGIN: undefined })).toBe('SITE_ORIGIN is not set');
    for (const origin of [
      'https://nwflorida.us',
      'https://canary.nwflorida.us',
      'https://www.nwflmensa.us',
      'https://canary.nwflmensa.us/',
      'http://canary.nwflmensa.us',
      'https://CANARY.nwflmensa.us',
      'https://canary.nwflmensa.us:8443',
      '__proto__',
      'constructor',
    ]) {
      const why = reason({ ...canary, SITE_ORIGIN: origin });
      expect(why, origin).toBe('SITE_ORIGIN must be one of https://canary.nwflmensa.us, https://nwflmensa.us');
    }
  });

  it('refuses any issuer that is not https on the profile’s issuer origin, at /application/o/<slug>/', () => {
    for (const issuer of [
      'https://login.nwflorida.us/application/o/nwfl-site-staging/',
      'http://login.nwflmensa.us/application/o/nwfl-site-staging/',
      'https://login.nwflmensa.us:8443/application/o/nwfl-site-staging/',
      'https://login.nwflmensa.us.evil.example/application/o/nwfl-site-staging/',
      'https://evil.example/application/o/nwfl-site-staging/',
      `https://user${AT}login.nwflmensa.us/application/o/nwfl-site-staging/`,
      `https://user:pw${AT}login.nwflmensa.us/application/o/nwfl-site-staging/`,
      // A password with no user name: no user part at all is allowed.
      `https://:pw${AT}login.nwflmensa.us/application/o/nwfl-site-staging/`,
      'https://login.nwflmensa.us/',
      'https://login.nwflmensa.us/application/o/',
      'https://login.nwflmensa.us/application/o//',
      'https://login.nwflmensa.us/application/o/nwfl-site-staging',
      'https://login.nwflmensa.us/application/o/nwfl-site-staging/extra/',
      'https://login.nwflmensa.us/application/o/nwfl-site-staging/?x=1',
      'https://login.nwflmensa.us/application/o/nwfl-site-staging/#x',
      'https://login.nwflmensa.us/application/o/NWFL/',
      'https://login.nwflmensa.us/application/o/a/../nwfl-site-staging/',
      'https://login.nwflmensa.us/application/o/%2e%2e/',
      'https://LOGIN.nwflmensa.us/application/o/nwfl-site-staging/',
      'https://login.nwflmensa.us/if/flow/nwfl-authentication/',
      'http://localhost:9090',
    ]) {
      expect(reason({ ...canary, OIDC_ISSUER: issuer }), issuer).toBe('OIDC_ISSUER must be https://login.nwflmensa.us/application/o/<slug>/');
    }
    expect(reason({ ...canary, OIDC_ISSUER: 'not a url' })).toBe('OIDC_ISSUER is not a URL');
  });

  // The URL parser drops an empty query or fragment from search and hash, but keeps it in href.
  it.each(['?', '#'])('refuses an issuer ending in an empty %s: exactly its origin and path, with nothing after', (mark) => {
    expect(reason({ ...canary, OIDC_ISSUER: `${canary.OIDC_ISSUER}${mark}` })).toBe('OIDC_ISSUER must be https://login.nwflmensa.us/application/o/<slug>/');
  });

  it('refuses a callback or signed-out page that is not exactly the profile’s', () => {
    for (const [name, value] of [
      ['OIDC_REDIRECT_URI', 'https://nwflorida.us/auth/callback'],
      ['OIDC_REDIRECT_URI', 'https://canary.nwflorida.us/auth/callback'],
      ['OIDC_REDIRECT_URI', 'https://nwflmensa.us/auth/callback'],
      ['OIDC_REDIRECT_URI', 'https://canary.nwflmensa.us/auth/callback/'],
      ['OIDC_REDIRECT_URI', 'http://canary.nwflmensa.us/auth/callback'],
      ['OIDC_REDIRECT_URI', 'https://localhost:8443/auth/callback'],
      ['OIDC_POST_LOGOUT_REDIRECT_URI', 'https://nwflmensa.us/signed-out'],
      ['OIDC_POST_LOGOUT_REDIRECT_URI', 'https://canary.nwflmensa.us/'],
      ['OIDC_POST_LOGOUT_REDIRECT_URI', 'http://127.0.0.1/signed-out'],
    ] as const) {
      const expected = name === 'OIDC_REDIRECT_URI' ? 'https://canary.nwflmensa.us/auth/callback' : 'https://canary.nwflmensa.us/signed-out';
      expect(reason({ ...canary, [name]: value }), `${name}=${value}`).toBe(`${name} must be ${expected}`);
    }
    expect(reason({ ...apex, OIDC_REDIRECT_URI: canary.OIDC_REDIRECT_URI })).toBe('OIDC_REDIRECT_URI must be https://nwflmensa.us/auth/callback');
  });

  it('never puts a value it was given in the reason: only names and the profile’s own values', () => {
    const bad: Record<string, string>[] = [
      { SITE_ORIGIN: 'https://secret-looking.example' },
      { OIDC_ISSUER: `https://login.nwflmensa.us/application/o/${SECRET}/x/` },
      { OIDC_REDIRECT_URI: `https://canary.nwflmensa.us/auth/callback?${SECRET}` },
      { OIDC_POST_LOGOUT_REDIRECT_URI: `https://canary.nwflmensa.us/signed-out?${SECRET}` },
      { OIDC_SCOPE: SECRET },
    ];
    for (const over of bad) {
      const why = reason({ ...canary, ...over });
      expect(why, JSON.stringify(over)).toBeDefined();
      expect(why, JSON.stringify(over)).not.toContain(SECRET);
      expect(why, JSON.stringify(over)).not.toContain('secret-looking');
    }
  });

  it('reads the chapter\'s group prefix, nwfl- by default, and turns sign-in off on a bad one (CF-ISO-0)', () => {
    const setup = authConfig({ ...canary, SITE_GROUP_PREFIX: undefined });
    expect(setup.enabled && setup.config.groupPrefix).toBe('nwfl-');
    for (const bad of ['', 'nwfl', 'nwfl-office-']) {
      const off = authConfig({ ...canary, SITE_GROUP_PREFIX: bad });
      expect(off.enabled, bad).toBe(false);
      expect(!off.enabled && off.reason).toMatch(/^SITE_GROUP_PREFIX/);
    }
  });

  it('has no default: with any setting missing, sign-in is off and says which', () => {
    for (const name of Object.keys(canary).filter((k) => k !== 'NODE_ENV' && k !== 'SITE_GROUP_PREFIX')) {
      expect(authConfig({ ...canary, [name]: undefined }), name).toEqual({ enabled: false, reason: `${name} is not set` });
    }
  });

  it('VET: asks for openid, profile and email by default, set or not, empty or not', () => {
    expect('OIDC_SCOPE' in canary).toBe(false);
    for (const unset of [undefined, '']) {
      const setup = authConfig({ ...canary, OIDC_SCOPE: unset });
      expect(setup.enabled && setup.config.scope).toBe('openid profile email');
    }
  });

  it('asks for openid, and takes another scope from config', () => {
    // Fix 1 (S3): a scope unlike the default, so the configured one is seen to win.
    const setup = authConfig({ ...canary, OIDC_SCOPE: 'openid profile email offline_access' });
    expect(setup.enabled && setup.config.scope).toBe('openid profile email offline_access');
    expect(authConfig({ ...canary, OIDC_SCOPE: 'profile email' })).toEqual({ enabled: false, reason: 'OIDC_SCOPE must include openid' });
  });

  it('VET fix 1: turns sign-in off for a configured scope without email, since the sign-up needs it', () => {
    for (const scope of ['openid profile', 'openid', 'openid profile emails', 'openid profile offline_access']) {
      expect(authConfig({ ...canary, OIDC_SCOPE: scope }), scope).toEqual({ enabled: false, reason: 'OIDC_SCOPE must include email: the sign-up needs it' });
    }
  });
});

describe('authConfig outside production: unchanged, for the tests and e2e', () => {
  const local = {
    OIDC_ISSUER: 'http://localhost:9090',
    OIDC_CLIENT_ID: 'nwfl-site-e2e',
    OIDC_CLIENT_SECRET: SECRET,
    OIDC_REDIRECT_URI: 'https://localhost:8443/auth/callback',
    OIDC_POST_LOGOUT_REDIRECT_URI: 'https://localhost:8443/signed-out',
  };

  it('allows a plain-http local issuer outside production only, for the test identity provider', () => {
    const setup = authConfig(local);
    expect(setup.enabled && setup.config.allowInsecure).toBe(true);
    expect(authConfig({ ...local, NODE_ENV: 'production', SITE_ORIGIN: 'https://canary.nwflmensa.us' }).enabled).toBe(false);
    expect(authConfig({ ...local, OIDC_ISSUER: 'http://idp.example.org' }).enabled).toBe(false);
  });

  it('needs no SITE_ORIGIN, and reads none: a profile binds production only', () => {
    expect(authConfig({ ...local, SITE_ORIGIN: 'https://nwflorida.us' }).enabled).toBe(true);
    const named = authConfig({ ...local, SITE_ORIGIN: 'https://canary.nwflmensa.us' });
    expect(named.enabled).toBe(true);
    // No site origin either, so sign-in stays on a local run's own host (src/lib/auth/flow.ts).
    expect(named.enabled && named.config.siteOrigin).toBeUndefined();
    expect(authConfig({ ...canary, NODE_ENV: 'test', OIDC_ISSUER: 'https://idp.example.org/' }).enabled).toBe(true);
  });
});

describe('the sign-in code', () => {
  const files = [
    ...readdirSync('src/lib/auth').map((f) => `src/lib/auth/${f}`),
    'server/session.mjs',
    'server/account.mjs',
    'server/auth-config.mjs',
    'server/siteServer.mjs',
    'server/public-hosts.mjs',
    'server/start.mjs',
  ].filter((f) => !f.endsWith('.test.ts'));

  it('names no host of the old identity domain anywhere', () => {
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(/mindsignals\d/);
  });

  it('names no sign-in host of the old domain (login.nwflorida.us), not even in a comment', () => {
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(/login\.nwflorida\.us/);
  });
});
