import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_ISSUER_ORIGIN, PRODUCTION_REDIRECTS, authConfig } from '../auth-config.mjs';

const production = {
  NODE_ENV: 'production',
  OIDC_ISSUER: 'https://login.nwflorida.us/application/o/nwfl-site/',
  OIDC_CLIENT_ID: 'nwfl-site',
  OIDC_CLIENT_SECRET: 'from-openbao',
  OIDC_REDIRECT_URI: 'https://nwflorida.us/auth/callback',
  OIDC_POST_LOGOUT_REDIRECT_URI: 'https://nwflorida.us/signed-out',
};

describe('authConfig (MT-03): sign-in only at login.nwflorida.us', () => {
  it('takes a production configuration on the club’s own hosts', () => {
    const setup = authConfig(production);
    expect(setup.enabled).toBe(true);
    if (!setup.enabled) return;
    expect(setup.config.issuer.href).toBe('https://login.nwflorida.us/application/o/nwfl-site/');
    expect(setup.config).toMatchObject({ clientId: 'nwfl-site', scope: 'openid profile', allowInsecure: false });
    expect(PRODUCTION_ISSUER_ORIGIN).toBe('https://login.nwflorida.us');
    expect(PRODUCTION_REDIRECTS).toEqual({ redirect: 'https://nwflorida.us/auth/callback', postLogout: 'https://nwflorida.us/signed-out' });
  });

  it('reads the chapter\'s group prefix, nwfl- by default, and turns sign-in off on a bad one (CF-ISO-0)', () => {
    const setup = authConfig(production);
    expect(setup.enabled && setup.config.groupPrefix).toBe('nwfl-');
    const chapter = authConfig({ ...production, SITE_GROUP_PREFIX: 'mensa-nwfl-' });
    expect(chapter.enabled && chapter.config.groupPrefix).toBe('mensa-nwfl-');
    for (const bad of ['', 'nwfl', 'nwfl-office-']) {
      const off = authConfig({ ...production, SITE_GROUP_PREFIX: bad });
      expect(off.enabled, bad).toBe(false);
      expect(!off.enabled && off.reason).toMatch(/^SITE_GROUP_PREFIX/);
    }
  });

  it('has no default: with any setting missing, sign-in is off and says which', () => {
    for (const name of Object.keys(production).filter((k) => k !== 'NODE_ENV')) {
      const setup = authConfig({ ...production, [name]: undefined });
      expect(setup, name).toEqual({ enabled: false, reason: `${name} is not set` });
    }
  });

  it('in production, refuses any issuer that is not https://login.nwflorida.us', () => {
    for (const issuer of [
      'https://auth.example.com/application/o/nwfl-site/',
      'https://nwfl-login.example.com/',
      'http://login.nwflorida.us/application/o/nwfl-site/',
      'https://login.nwflorida.us.evil.example/',
      'https://login.nwflorida.us:8443/',
      'http://localhost:9090',
      'not a url',
    ]) {
      const setup = authConfig({ ...production, OIDC_ISSUER: issuer });
      expect(setup.enabled, issuer).toBe(false);
    }
  });

  it('in production, refuses a redirect to anywhere but the site’s own callback and signed-out page', () => {
    for (const [name, value] of [
      ['OIDC_REDIRECT_URI', 'https://localhost:8443/auth/callback'],
      ['OIDC_REDIRECT_URI', 'https://canary.nwflorida.us/auth/callback'],
      ['OIDC_REDIRECT_URI', 'http://nwflorida.us/auth/callback'],
      ['OIDC_POST_LOGOUT_REDIRECT_URI', 'http://127.0.0.1/signed-out'],
      ['OIDC_POST_LOGOUT_REDIRECT_URI', 'https://nwflorida.us/'],
    ] as const) {
      expect(authConfig({ ...production, [name]: value }).enabled, `${name}=${value}`).toBe(false);
    }
  });

  it('allows a plain-http local issuer outside production only, for the test identity provider', () => {
    const local = { ...production, NODE_ENV: undefined, OIDC_ISSUER: 'http://localhost:9090', OIDC_REDIRECT_URI: 'https://localhost:8443/auth/callback', OIDC_POST_LOGOUT_REDIRECT_URI: 'https://localhost:8443/signed-out' };
    const setup = authConfig(local);
    expect(setup.enabled && setup.config.allowInsecure).toBe(true);
    expect(authConfig({ ...local, NODE_ENV: 'production' }).enabled).toBe(false);
    expect(authConfig({ ...local, OIDC_ISSUER: 'http://idp.example.org' }).enabled).toBe(false);
  });

  it('asks for openid, and takes another scope from config', () => {
    const setup = authConfig({ ...production, OIDC_SCOPE: 'openid profile email' });
    expect(setup.enabled && setup.config.scope).toBe('openid profile email');
    expect(authConfig({ ...production, OIDC_SCOPE: 'profile' }).enabled).toBe(false);
  });
});

describe('the sign-in code', () => {
  it('names no host of the old identity domain anywhere', () => {
    const files = [...readdirSync('src/lib/auth').map((f) => `src/lib/auth/${f}`), 'server/session.mjs', 'server/account.mjs', 'server/auth-config.mjs'];
    for (const file of files.filter((f) => !f.endsWith('.test.ts'))) expect(readFileSync(file, 'utf8'), file).not.toMatch(/mindsignals\d/);
  });
});
