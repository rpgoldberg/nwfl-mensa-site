import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SIZE_COOKIE, THEME_COOKIE } from '../../../server/prefs.mjs';
import { AUTH_COOKIE, OUT_COOKIE, SESSION_COOKIE, TRANSACTION_SECONDS, newSession, readSession, sealValue, sessionSetCookie } from '../../../server/session.mjs';
import type { AuthConfig, AuthSetup } from '../../../server/auth-config.mjs';
import { ConsumedStates, REFUSALS, TokenStore, beginSignIn, completeSignIn, depsFromEnv, landSignedOut, signOut, type Deps } from './flow';

const key = randomBytes(32);
const NOW = 1_800_000_000;
const cfg: AuthConfig = {
  issuer: new URL('https://login.nwflorida.us/application/o/nwfl-site/'),
  clientId: 'nwfl-site',
  clientSecret: 'x',
  redirectUri: 'https://nwflorida.us/auth/callback',
  postLogoutRedirectUri: 'https://nwflorida.us/signed-out',
  scope: 'openid profile',
  allowInsecure: false,
};

function deps(over: Partial<Deps> = {}): Deps & { lines: string[] } {
  const lines: string[] = [];
  let n = 0;
  return {
    setup: { enabled: true, config: cfg },
    key,
    now: () => NOW,
    oidc: {
      startSignIn: vi.fn(async () => {
        n++;
        return { location: new URL(`https://login.nwflorida.us/auth?n=${n}`), state: `state-${n}`, nonce: `nonce-${n}`, verifier: `verifier-${n}` };
      }),
      finishSignIn: vi.fn(async () => ({
        claims: { sub: 'user-1', name: 'Alex Sample', groups: ['nwfl-members', 'nwfl-officers'] },
        tokens: { access_token: 'access-1', id_token: 'id-1' },
      })),
      endSessionUrl: vi.fn(async (_cfg, { state }) => new URL(`https://login.nwflorida.us/end?state=${state}`)),
    },
    tokens: new TokenStore(),
    consumed: new ConsumedStates(),
    log: (line: string) => lines.push(line),
    lines,
    ...over,
  };
}

/** The Cookie header a browser sends back for the Set-Cookie values it was given. */
const jar = (setCookies: string[]) => setCookies.map((c) => c.split(';')[0]).filter((c) => !c!.endsWith('=')).join('; ');

async function started(d: Deps, back = '/about') {
  const begun = await beginSignIn(d, { cookieHeader: undefined, back });
  if (begun.kind !== 'redirect') throw new Error(begun.kind);
  return { cookieHeader: jar(begun.cookies), state: new URL(begun.location).searchParams.get('n') ? `state-${new URL(begun.location).searchParams.get('n')}` : '' };
}

describe('beginSignIn', () => {
  it('sends the reader to the provider, with the transaction in a host-only cookie', async () => {
    const d = deps();
    const out = await beginSignIn(d, { cookieHeader: undefined, back: '/about' });
    expect(out).toMatchObject({ kind: 'redirect', location: 'https://login.nwflorida.us/auth?n=1' });
    expect(out.kind === 'redirect' && out.cookies[0]).toMatch(new RegExp(`^${AUTH_COOKIE}=v1\\.`));
  });

  it('sends someone already signed in straight back, with no new sign-in', async () => {
    const d = deps();
    const header = sessionSetCookie(newSession({ sub: 'u' }, NOW), key, NOW).split(';')[0];
    expect(await beginSignIn(d, { cookieHeader: header, back: '/calendar' })).toEqual({ kind: 'redirect', location: '/calendar', cookies: [] });
    expect(d.oidc.startSignIn).not.toHaveBeenCalled();
  });

  it('is unavailable, and says why in the log, when sign-in is not set up or the provider cannot be reached', async () => {
    const off = deps({ setup: { enabled: false, reason: 'OIDC_ISSUER is not set' } as AuthSetup });
    expect(await beginSignIn(off, { cookieHeader: undefined, back: '/' })).toEqual({ kind: 'unavailable' });
    expect(off.lines.join()).toContain('OIDC_ISSUER is not set');
    expect(await beginSignIn(deps({ key: undefined }), { cookieHeader: undefined, back: '/' })).toEqual({ kind: 'unavailable' });
    const down = deps();
    vi.mocked(down.oidc.startSignIn).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await beginSignIn(down, { cookieHeader: undefined, back: '/' })).toEqual({ kind: 'unavailable' });
    expect(down.lines.join()).toContain('ECONNREFUSED');
  });
});

describe('completeSignIn: the callback', () => {
  const url = (params: Record<string, string>) => new URL(`https://nwflorida.us/auth/callback?${new URLSearchParams(params)}`);

  it('signs the reader in with a new session id, keeps the tokens on the server, and goes back where they were', async () => {
    const d = deps();
    const { cookieHeader, state } = await started(d);
    const out = await completeSignIn(d, { url: url({ code: 'c', state }), cookieHeader });
    expect(out.kind).toBe('redirect');
    if (out.kind !== 'redirect') return;
    expect(out.location).toBe('/about');
    expect(out.cookies[0]).toBe(`${AUTH_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure`);
    const session = readSession(jar(out.cookies), key, NOW);
    expect(session).toMatchObject({ sub: 'user-1', name: 'Alex Sample', officer: true });
    expect(out.cookies.join()).not.toMatch(/access-1|id-1/);
    expect(d.tokens.get(session!.sid, NOW)).toMatchObject({ access_token: 'access-1', id_token: 'id-1' });
    expect(d.oidc.finishSignIn).toHaveBeenCalledWith(cfg, expect.any(URL), expect.objectContaining({ state, nonce: 'nonce-1', verifier: 'verifier-1' }));
  });

  it('refuses a callback with no transaction, or one older than ten minutes, as timed out', async () => {
    const d = deps();
    expect(await completeSignIn(d, { url: url({ code: 'c', state: 's' }), cookieHeader: undefined })).toMatchObject({ kind: 'refused', reason: 'expired' });
    const { cookieHeader, state } = await started(d);
    const late = { ...d, now: () => NOW + TRANSACTION_SECONDS };
    expect(await completeSignIn(late, { url: url({ code: 'c', state }), cookieHeader })).toMatchObject({ kind: 'refused', reason: 'expired' });
  });

  it('refuses a state that is not exactly this browser’s', async () => {
    const d = deps();
    const { cookieHeader, state } = await started(d);
    for (const forged of [`${state}x`, state.slice(0, -1), state.toUpperCase(), '']) {
      expect(await completeSignIn(d, { url: url({ code: 'c', state: forged }), cookieHeader }), forged).toMatchObject({ kind: 'refused', reason: 'mismatch' });
    }
    expect(await completeSignIn(d, { url: url({ code: 'c' }), cookieHeader })).toMatchObject({ kind: 'refused', reason: 'mismatch' });
    expect(d.oidc.finishSignIn).not.toHaveBeenCalled();
  });

  it('takes a callback once only, even with the same cookie sent again', async () => {
    const d = deps();
    const { cookieHeader, state } = await started(d);
    expect((await completeSignIn(d, { url: url({ code: 'c', state }), cookieHeader })).kind).toBe('redirect');
    expect(await completeSignIn(d, { url: url({ code: 'c', state }), cookieHeader })).toMatchObject({ kind: 'refused', reason: 'used' });
  });

  it('says plainly that sign-in was cancelled, and never repeats what the provider said', async () => {
    const d = deps();
    const { cookieHeader, state } = await started(d);
    const out = await completeSignIn(d, { url: url({ error: 'access_denied', error_description: '<script>alert(1)</script>', state }), cookieHeader });
    expect(out).toMatchObject({ kind: 'refused', reason: 'cancelled' });
    expect(JSON.stringify(out)).not.toContain('script');
    expect(d.lines.join()).toContain('access_denied');
    expect(d.lines.join()).not.toContain('script');
  });

  it('logs only a tidy error code from the provider', async () => {
    const d = deps();
    const { cookieHeader, state } = await started(d);
    await completeSignIn(d, { url: url({ error: 'server_error<b>\n', state }), cookieHeader });
    expect(d.lines.join()).toContain('"error":"server_errorb"');
  });

  it('refuses when the code exchange or the ID token check fails (a wrong nonce among them)', async () => {
    const d = deps();
    vi.mocked(d.oidc.finishSignIn).mockRejectedValueOnce(new Error('unexpected ID Token "nonce" claim value'));
    const { cookieHeader, state } = await started(d);
    expect(await completeSignIn(d, { url: url({ code: 'c', state }), cookieHeader })).toMatchObject({ kind: 'refused', reason: 'failed' });
    expect(d.lines.join()).toContain('nonce');
  });

  it('is unavailable when sign-in is not set up', async () => {
    expect(await completeSignIn(deps({ key: undefined }), { url: url({}), cookieHeader: undefined })).toEqual({ kind: 'unavailable' });
  });

  it('words every refusal for a reader, with a way forward', () => {
    expect(Object.keys(REFUSALS).sort()).toEqual(['cancelled', 'expired', 'failed', 'mismatch', 'used']);
    for (const message of Object.values(REFUSALS)) expect(message).toMatch(/^[A-Z][^<>]+\.$/);
  });
});

describe('signOut', () => {
  it('drops the session and its tokens, clears storage, and goes on to end the provider’s session too', async () => {
    const d = deps();
    const session = newSession({ sub: 'u', groups: ['nwfl-members'] }, NOW);
    d.tokens.put(session.sid, { access_token: 'a', id_token: 'id-9' }, session.exp);
    const header = `${sessionSetCookie(session, key, NOW).split(';')[0]}; ${SIZE_COOKIE}=4; ${THEME_COOKIE}=dark`;
    const out = await signOut(d, { cookieHeader: header });
    // Not "cookies" yet: that would clear the provider's cookies too (the same
    // registered domain), and it could not end its session.
    expect(out.clearSiteData).toBe('"storage"');
    expect(out.cookies.slice(0, 2)).toEqual([`${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure`, `${AUTH_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure`]);
    expect(out.cookies[2]).toMatch(new RegExp(`^${OUT_COOKIE}=[\\w-]{20,}; Path=/; Max-Age=600; SameSite=Lax; HttpOnly; Secure$`));
    expect(d.tokens.get(session.sid, NOW)).toBeUndefined();
    expect(d.oidc.endSessionUrl).toHaveBeenCalledWith(cfg, { idToken: 'id-9', state: expect.stringMatching(/^v1\./) });
    expect(out.location).toMatch(/^https:\/\/login\.nwflorida\.us\/end\?state=v1\./);
  });

  it('comes back to the signed-out page directly when the provider offers no logout, or cannot be reached', async () => {
    const d = deps();
    vi.mocked(d.oidc.endSessionUrl).mockResolvedValueOnce(undefined);
    expect(await signOut(d, { cookieHeader: undefined })).toMatchObject({ location: expect.stringMatching(/^\/signed-out\?state=v1\./) });
    vi.mocked(d.oidc.endSessionUrl).mockRejectedValueOnce(new Error('down'));
    expect(await signOut(d, { cookieHeader: undefined })).toMatchObject({ location: expect.stringMatching(/^\/signed-out\?state=v1\./) });
  });

  it('with no key, clears everything at once: there is no session, and nothing to bring back', async () => {
    const out = await signOut(deps({ key: undefined, setup: { enabled: false, reason: 'x' } }), { cookieHeader: undefined });
    expect(out).toMatchObject({ location: '/signed-out', clearSiteData: '"cookies", "storage"' });
    expect(out.cookies).toHaveLength(2);
  });
});

describe('landSignedOut: back from the provider', () => {
  const page = 'https://nwflorida.us/signed-out';
  /** Sign out with these prefs; the URL and cookies the browser then comes back with. */
  async function signedOut(d: Deps) {
    const out = await signOut(d, { cookieHeader: `${SIZE_COOKIE}=4; ${THEME_COOKIE}=dark` });
    const state = new URL(out.location, page).searchParams.get('state')!;
    const binding = out.cookies[2]!.split(';')[0]!;
    return { state, binding };
  }

  it('clears every cookie and storage now, then sets text size and theme again', async () => {
    const d = deps();
    const { state, binding } = await signedOut(d);
    const cleared = landSignedOut(d, { url: new URL(`${page}?state=${state}`), cookieHeader: binding });
    // The binding goes too, by name, for a browser that does not know Clear-Site-Data: it works once.
    expect(cleared).toEqual({
      kind: 'redirect',
      location: `/signed-out?restore=${state}`,
      cookies: [`${OUT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure`],
      clearSiteData: '"cookies", "storage"',
    });
    const restored = landSignedOut(d, { url: new URL(`${page}?restore=${state}`), cookieHeader: null });
    expect(restored).toEqual({
      kind: 'redirect',
      location: '/signed-out',
      cookies: [`${SIZE_COOKIE}=4; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly; Secure`, `${THEME_COOKIE}=dark; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly; Secure`],
    });
  });

  it('clears nothing for a link from elsewhere: only the browser that signed out may', async () => {
    const d = deps();
    const { state } = await signedOut(d);
    const other = await signedOut(d);
    for (const cookieHeader of [null, other.binding, `${OUT_COOKIE}=`]) {
      expect(landSignedOut(d, { url: new URL(`${page}?state=${state}`), cookieHeader })).toEqual({ kind: 'redirect', location: '/signed-out', cookies: [] });
    }
  });

  it('clears nothing for a state it did not seal, or one too old', async () => {
    const d = deps();
    const { binding } = await signedOut(d);
    const out = binding.split('=')[1];
    for (const state of [
      sealValue({ prefs: {}, out, exp: NOW + 600 }, randomBytes(32), 'signed-out'),
      sealValue({ prefs: {}, out, exp: NOW - 1 }, key, 'signed-out'),
      sealValue({ prefs: {}, exp: NOW + 600 }, key, 'signed-out'),
      'v1.x',
    ]) {
      expect(landSignedOut(d, { url: new URL(`${page}?state=${state}`), cookieHeader: binding })).toEqual({ kind: 'redirect', location: '/signed-out', cookies: [] });
    }
  });

  it('restores nothing from a state it did not seal, one too old, or with no key', () => {
    const d = deps();
    const restore = (state: string, over: Partial<Deps> = {}) => landSignedOut(deps(over), { url: new URL(`${page}?restore=${state}`), cookieHeader: null });
    expect(restore(sealValue({ prefs: { size: 5, theme: 'dark' }, exp: NOW + 600 }, randomBytes(32), 'signed-out'))).toMatchObject({ cookies: [] });
    expect(restore(sealValue({ prefs: { size: 5, theme: 'dark' }, exp: NOW - 1 }, key, 'signed-out'))).toMatchObject({ cookies: [] });
    expect(restore('v1.x', { key: undefined })).toMatchObject({ cookies: [] });
    expect(d.lines).toEqual([]);
  });

  it('shows the page itself at its plain address', () => {
    expect(landSignedOut(deps(), { url: new URL(page), cookieHeader: null })).toEqual({ kind: 'page' });
    expect(landSignedOut(deps({ key: undefined }), { url: new URL(`${page}?state=v1.x`), cookieHeader: null })).toEqual({ kind: 'redirect', location: '/signed-out', cookies: [] });
  });
});

describe('TokenStore and ConsumedStates (server-side, bounded)', () => {
  it('forgets tokens when their session ends, and keeps at most the cap', () => {
    const store = new TokenStore(2);
    store.put('a', { access_token: '1' }, NOW + 10);
    expect(store.get('a', NOW + 9)).toEqual({ access_token: '1' });
    expect(store.get('a', NOW + 10)).toBeUndefined();
    store.put('b', { access_token: '2' }, NOW + 10);
    store.put('c', { access_token: '3' }, NOW + 10);
    store.put('d', { access_token: '4' }, NOW + 10);
    expect(['b', 'c', 'd'].filter((sid) => store.get(sid, NOW))).toEqual(['c', 'd']);
    expect(store.take('c', NOW)).toEqual({ access_token: '3' });
    expect(store.get('c', NOW)).toBeUndefined();
  });

  it('remembers a used state until its transaction could no longer be used anyway', () => {
    const used = new ConsumedStates(2);
    used.add('s1', NOW + 600);
    expect(used.has('s1', NOW + 599)).toBe(true);
    expect(used.has('s1', NOW + 600)).toBe(false);
    used.add('s2', NOW + 600);
    used.add('s3', NOW + 600);
    used.add('s4', NOW + 600);
    expect(used.has('s2', NOW)).toBe(false);
    expect(used.has('s4', NOW)).toBe(true);
  });
});

describe('depsFromEnv', () => {
  it('reads the settings and the key from the environment, with the real OIDC client', () => {
    const d = depsFromEnv({
      OIDC_ISSUER: 'https://login.nwflorida.us/application/o/nwfl-site/',
      OIDC_CLIENT_ID: 'nwfl-site',
      OIDC_CLIENT_SECRET: 'x',
      OIDC_REDIRECT_URI: 'https://nwflorida.us/auth/callback',
      OIDC_POST_LOGOUT_REDIRECT_URI: 'https://nwflorida.us/signed-out',
      SESSION_KEY: key.toString('base64'),
    });
    expect(d.setup.enabled).toBe(true);
    expect(d.key?.equals(key)).toBe(true);
    expect(Math.abs(d.now() - Date.now() / 1000)).toBeLessThan(2);
    expect(typeof d.oidc.startSignIn).toBe('function');
  });

  it('logs a malformed key and runs without one, so sign-in is unavailable rather than broken', () => {
    const lines: string[] = [];
    const d = depsFromEnv({ SESSION_KEY: 'short' }, (line) => lines.push(line));
    expect(d.key).toBeUndefined();
    expect(lines.join()).toContain('SESSION_KEY must be 32 bytes');
  });
});
