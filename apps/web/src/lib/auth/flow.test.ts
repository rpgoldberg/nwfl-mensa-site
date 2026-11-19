import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SIZE_COOKIE, THEME_COOKIE } from '../../../server/prefs.mjs';
import { AUTH_COOKIE, FRESH_COOKIE, SESSION_COOKIE, TRANSACTION_SECONDS, newSession, readSession, sessionSetCookie, transactionSetCookie } from '../../../server/session.mjs';
import type { AuthConfig, AuthSetup } from '../../../server/auth-config.mjs';
import { TokenStore } from '../../../server/token-store.mjs';
import { ConsumedStates, REFUSALS, beginSignIn, completeSignIn, depsFromEnv, signOut, type Deps } from './flow';

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
  groupPrefix: 'nwfl-',
  timeoutMs: 8000,
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
      endSessionUrl: vi.fn(async () => new URL('https://login.nwflorida.us/end')),
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

/** The once-only mark a fresh round leaves (SIGNIN-SLOW), as the browser sends it back. */
const FRESH = `${FRESH_COOKIE}=1`;

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
    const session = newSession({ sub: 'u' }, NOW);
    d.tokens.put(session.sid, { access_token: 'a' }, session.exp);
    const header = sessionSetCookie(session, key, NOW).split(';')[0];
    expect(await beginSignIn(d, { cookieHeader: header, back: '/calendar' })).toEqual({ kind: 'redirect', location: '/calendar', cookies: [] });
    expect(d.oidc.startSignIn).not.toHaveBeenCalled();
  });

  // A14: "Sign in again" on /news, when the token has lapsed or the API refused it, must get a fresh token.
  it('starts a fresh sign-in for someone already signed in who asks again', async () => {
    const d = deps();
    const session = newSession({ sub: 'u' }, NOW);
    d.tokens.put(session.sid, { access_token: 'a' }, session.exp);
    const header = sessionSetCookie(session, key, NOW).split(';')[0];
    const out = await beginSignIn(d, { cookieHeader: header, back: '/news', again: true });
    expect(out).toMatchObject({ kind: 'redirect', location: 'https://login.nwflorida.us/auth?n=1' });
    expect(d.oidc.startSignIn).toHaveBeenCalledTimes(1);
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

// S2: the session cookie is host-only on the profile's origin, so /sign-in on any other host of ours starts there.
describe('beginSignIn on another of our hosts', () => {
  // In production authConfig names the SITE_ORIGIN profile's origin (siteOrigin); outside it, none.
  const local: AuthConfig = { ...cfg, redirectUri: 'https://canary.nwflmensa.us/auth/callback', postLogoutRedirectUri: 'https://canary.nwflmensa.us/signed-out' };
  const canary: AuthConfig = { ...local, siteOrigin: 'https://canary.nwflmensa.us' };
  const onCanary = (over: Partial<Deps> = {}) => deps({ setup: { enabled: true, config: canary }, ...over });
  const outsideProduction = () => deps({ setup: { enabled: true, config: local } });

  it.each(['www.nwflmensa.us', 'nwflmensa.us', 'nwflorida.us', 'www.nwflorida.us', 'canary.nwflorida.us', 'WWW.NWFLMENSA.US:443'])(
    'sends a reader on %s to sign in on the profile’s origin, with the same return, never stored',
    async (host) => {
      const d = onCanary();
      const out = await beginSignIn(d, { cookieHeader: undefined, back: '/news', host });
      expect(out).toEqual({ kind: 'redirect', location: 'https://canary.nwflmensa.us/sign-in?return=%2Fnews', cookies: [], cache: 'private, no-store' });
      expect(d.oidc.startSignIn).not.toHaveBeenCalled();
    },
  );

  it('keeps a return only when it is a path on this site, sanitised as any return is', async () => {
    const d = onCanary();
    const at = async (back: string | null) => {
      const out = await beginSignIn(d, { cookieHeader: undefined, back, host: 'www.nwflmensa.us' });
      return out.kind === 'redirect' ? out.location : out.kind;
    };
    expect(await at('/events?month=2027-01')).toBe('https://canary.nwflmensa.us/sign-in?return=%2Fevents%3Fmonth%3D2027-01');
    expect(await at('/about#top')).toBe('https://canary.nwflmensa.us/sign-in?return=%2Fabout');
    for (const back of [null, '', '/', '//evil.example/', '/\\evil.example', 'https://evil.example/', 'javascript:alert(1)', '/a\nb', '/caf\u00e9']) {
      expect(await at(back), String(back)).toBe('https://canary.nwflmensa.us/sign-in');
    }
  });

  it('keeps asking again (a fresh token, A14)', async () => {
    const out = await beginSignIn(onCanary(), { cookieHeader: undefined, back: '/news', again: true, host: 'nwflorida.us' });
    expect(out.kind === 'redirect' && out.location).toBe('https://canary.nwflmensa.us/sign-in?return=%2Fnews&again=1');
  });

  it.each(['canary.nwflmensa.us', 'canary.nwflmensa.us:443', 'Canary.NWFLmensa.us', ' canary.nwflmensa.us '])('signs in on the profile’s own host (%j)', async (host) => {
    for (const d of [onCanary(), outsideProduction()]) {
      const out = await beginSignIn(d, { cookieHeader: undefined, back: '/about', host });
      expect(out).toMatchObject({ kind: 'redirect', location: 'https://login.nwflorida.us/auth?n=1' });
      expect(d.oidc.startSignIn).toHaveBeenCalledTimes(1);
    }
  });

  // F5: in production every other Host, listed or not, a trailing dot, or none, gets the same fixed address.
  it.each(['www.nwflmensa.us.', 'canary.nwflmensa.us.', 'evil.example', 'canary.nwflmensa.us.evil.example', 'localhost:8443', `x${'@'}canary.nwflmensa.us`, 'canary.nwflmensa.us:x', '', undefined, null])(
    'in production, sends a reader on any other host (%j) to sign in on the profile’s origin, never stored',
    async (host) => {
      const d = onCanary();
      const out = await beginSignIn(d, { cookieHeader: undefined, back: '/news', again: true, host });
      expect(out).toEqual({ kind: 'redirect', location: 'https://canary.nwflmensa.us/sign-in?return=%2Fnews&again=1', cookies: [], cache: 'private, no-store' });
      expect(d.oidc.startSignIn).not.toHaveBeenCalled();
    },
  );

  it('in production, sends an unlisted host on with the return sanitised, so the address is never the reader’s to choose', async () => {
    for (const host of ['evil.example', 'www.nwflmensa.us.']) {
      for (const back of ['//evil.example/', '/\\evil.example', 'https://evil.example/', 'javascript:alert(1)', '/a\r\nSet-Cookie: x=1']) {
        const out = await beginSignIn(onCanary(), { cookieHeader: undefined, back, host });
        expect(out, `${host} ${back}`).toEqual({ kind: 'redirect', location: 'https://canary.nwflmensa.us/sign-in', cookies: [], cache: 'private, no-store' });
      }
    }
  });

  it.each(['localhost:8443', 'evil.example', 'canary.nwflmensa.us.evil.example', 'www.nwflmensa.us.', `x${'@'}www.nwflmensa.us`, '', undefined, null])(
    'outside production, signs in as before on a host that is not ours (%j): a local run stays where it is',
    async (host) => {
      const d = outsideProduction();
      const out = await beginSignIn(d, { cookieHeader: undefined, back: '/about', host });
      expect(out).toMatchObject({ kind: 'redirect', location: 'https://login.nwflorida.us/auth?n=1' });
      expect(d.oidc.startSignIn).toHaveBeenCalledTimes(1);
    },
  );

  it('is unavailable on any host when sign-in is off, as before', async () => {
    const off = deps({ setup: { enabled: false, reason: 'SITE_ORIGIN is not set' } as AuthSetup });
    expect(await beginSignIn(off, { cookieHeader: undefined, back: '/news', host: 'www.nwflmensa.us' })).toEqual({ kind: 'unavailable' });
    expect(await beginSignIn(onCanary({ key: undefined }), { cookieHeader: undefined, back: '/news', host: 'www.nwflmensa.us' })).toEqual({ kind: 'unavailable' });
  });

  it('starts there for the local provider too: the callback’s origin is where the cookie lives', async () => {
    const local = deps({ setup: { enabled: true, config: { ...cfg, redirectUri: 'https://localhost:8443/auth/callback' } } });
    const out = await beginSignIn(local, { cookieHeader: undefined, back: '/news', host: 'www.nwflmensa.us' });
    expect(out.kind === 'redirect' && out.location).toBe('https://localhost:8443/sign-in?return=%2Fnews');
  });

  it('signs in as before when the callback is not a URL (a local misconfiguration), rather than guess', async () => {
    const d = deps({ setup: { enabled: true, config: { ...cfg, redirectUri: 'not a url' } } });
    const out = await beginSignIn(d, { cookieHeader: undefined, back: '/news', host: 'www.nwflmensa.us' });
    expect(out).toMatchObject({ kind: 'redirect', location: 'https://login.nwflorida.us/auth?n=1' });
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
    const session = readSession(jar(out.cookies), key, NOW, d.tokens);
    expect(session).toMatchObject({ sub: 'user-1', name: 'Alex Sample', officer: true });
    // W-SIGNUP D3: the new session goes back to the callback, which picks the first stop by it.
    expect(out.session).toEqual(session);
    expect(out.cookies.join()).not.toMatch(/access-1|id-1/);
    expect(d.tokens.get(session!.sid, NOW)).toMatchObject({ access_token: 'access-1', id_token: 'id-1' });
    expect(d.oidc.finishSignIn).toHaveBeenCalledWith(cfg, expect.any(URL), expect.objectContaining({ state, nonce: 'nonce-1', verifier: 'verifier-1' }));
  });

  // A14 (S5a): the site forwards a token only while it has time to live, so it keeps when the token expires.
  it('keeps when the access token expires, from expires_in, and no expiry at all when the provider gave none or a nonsense one', async () => {
    const signIn = async (expires_in: unknown) => {
      const d = deps();
      vi.mocked(d.oidc.finishSignIn).mockResolvedValueOnce({ claims: { sub: 'user-4' }, tokens: { access_token: 'a', id_token: 'i', expires_in: expires_in as number } });
      const { cookieHeader, state } = await started(d);
      const out = await completeSignIn(d, { url: url({ code: 'c', state }), cookieHeader });
      if (out.kind !== 'redirect') throw new Error(out.kind);
      return d.tokens.get(readSession(jar(out.cookies), key, NOW, d.tokens)!.sid, NOW);
    };
    expect(await signIn(300)).toEqual({ access_token: 'a', id_token: 'i', expires_in: 300, expires_at: NOW + 300 });
    for (const odd of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, '300']) {
      const kept = await signIn(odd);
      expect(kept, String(odd)).toMatchObject({ access_token: 'a' });
      expect(kept, String(odd)).not.toHaveProperty('expires_at');
    }
  });

  it('ends the session it replaces: signing in again leaves the old session cookie reading as nobody', async () => {
    const d = deps();
    const old = newSession({ sub: 'user-1' }, NOW);
    d.tokens.put(old.sid, { access_token: 'old' }, old.exp);
    const oldCookie = sessionSetCookie(old, key, NOW).split(';')[0]!;
    const begun = await beginSignIn(d, { cookieHeader: oldCookie, back: '/news', again: true });
    if (begun.kind !== 'redirect') throw new Error(begun.kind);
    const cookieHeader = `${oldCookie}; ${jar(begun.cookies)}`;
    const out = await completeSignIn(d, { url: url({ code: 'c', state: 'state-1' }), cookieHeader });
    expect(out.kind).toBe('redirect');
    expect(readSession(oldCookie, key, NOW, d.tokens)).toBeUndefined();
    if (out.kind === 'redirect') expect(readSession(jar(out.cookies), key, NOW, d.tokens)).toBeDefined();
  });

  it('reads the groups under the configured chapter prefix (CF-ISO-0): mensa-nwfl-officers is an officer, a bare nwfl-officers is not', async () => {
    const signIn = async (prefix: string, groups: string[]) => {
      const d = deps({ setup: { enabled: true, config: { ...cfg, groupPrefix: prefix } } });
      vi.mocked(d.oidc.finishSignIn).mockResolvedValueOnce({ claims: { sub: 'user-2', groups }, tokens: { access_token: 'a', id_token: 'i' } });
      const { cookieHeader, state } = await started(d);
      const out = await completeSignIn(d, { url: url({ code: 'c', state }), cookieHeader });
      return out.kind === 'redirect' ? readSession(jar(out.cookies), key, NOW, d.tokens) : undefined;
    };
    expect(await signIn('mensa-nwfl-', ['mensa-nwfl-members', 'mensa-nwfl-officers'])).toMatchObject({ officer: true, member: true, groups: ['nwfl-members', 'nwfl-officers'] });
    expect(await signIn('mensa-nwfl-', ['nwfl-members', 'nwfl-officers'])).toMatchObject({ officer: false, member: false, groups: [] });
  });

  it('refuses a sign-in whose groups claim holds a non-string, as the API would refuse the token (CF-ISO-0 N3)', async () => {
    const d = deps();
    vi.mocked(d.oidc.finishSignIn).mockResolvedValueOnce({ claims: { sub: 'user-3', groups: ['nwfl-officers', 7] }, tokens: { access_token: 'a', id_token: 'i' } });
    const { cookieHeader, state } = await started(d);
    expect(await completeSignIn(d, { url: url({ code: 'c', state }), cookieHeader })).toMatchObject({ kind: 'refused', reason: 'failed' });
  });

  // SIGNIN-SLOW: refused, as here, once the one fresh round (below) has been taken.
  it('refuses a callback with no transaction, or one older than ten minutes, as timed out', async () => {
    const d = deps();
    expect(await completeSignIn(d, { url: url({ code: 'c', state: 's' }), cookieHeader: FRESH })).toMatchObject({ kind: 'refused', reason: 'expired' });
    const { cookieHeader, state } = await started(d);
    const late = { ...d, now: () => NOW + TRANSACTION_SECONDS };
    expect(await completeSignIn(late, { url: url({ code: 'c', state }), cookieHeader: `${cookieHeader}; ${FRESH}` })).toMatchObject({ kind: 'refused', reason: 'expired' });
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
    expect(await completeSignIn(d, { url: url({ code: 'c', state }), cookieHeader: `${cookieHeader}; ${FRESH}` })).toMatchObject({ kind: 'refused', reason: 'used' });
    expect(d.oidc.finishSignIn).toHaveBeenCalledTimes(1);
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

// SIGNIN-SLOW: a callback refused as used, expired, or failed on a slow or broken path to the provider
// starts one fresh sign-in instead of the refusal page; the provider still has the reader's session, so
// it normally passes straight through. A mark (a cookie, ten minutes) makes it once only: a second
// refusal shows the page as before. A mismatch or a cancel never takes it.
describe('completeSignIn: one fresh round', () => {
  const url = (params: Record<string, string>) => new URL(`https://nwflorida.us/auth/callback?${new URLSearchParams(params)}`);
  const FRESH_SET = `${FRESH_COOKIE}=1; Path=/; Max-Age=600; SameSite=Lax; HttpOnly; Secure`;
  const CLEAR_TX = `${AUTH_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure`;
  const timedOut = () => Object.assign(new Error('operation timed out'), { name: 'ClientError', code: 'OAUTH_TIMEOUT' });

  it('takes a used callback (a code already spent) to a fresh sign-in, back to the same page, once only', async () => {
    const d = deps();
    const { cookieHeader, state } = await started(d, '/calendar?month=2026-12');
    await completeSignIn(d, { url: url({ code: 'c', state }), cookieHeader });
    const out = await completeSignIn(d, { url: url({ code: 'c', state }), cookieHeader });
    expect(out).toEqual({ kind: 'redirect', location: '/sign-in?return=%2Fcalendar%3Fmonth%3D2026-12', cookies: [CLEAR_TX, FRESH_SET] });
    expect(new URL(`https://nwflorida.us${out.kind === 'redirect' ? out.location : ''}`).searchParams.get('return')).toBe('/calendar?month=2026-12');
    expect(await completeSignIn(d, { url: url({ code: 'c', state }), cookieHeader: `${cookieHeader}; ${FRESH}` })).toEqual({ kind: 'refused', reason: 'used', cookies: [CLEAR_TX] });
  });

  it('takes an expired callback, whose page is not known, to a fresh sign-in that returns home', async () => {
    const d = deps();
    expect(await completeSignIn(d, { url: url({ code: 'c', state: 's' }), cookieHeader: undefined })).toEqual({ kind: 'redirect', location: '/sign-in', cookies: [CLEAR_TX, FRESH_SET] });
    const { cookieHeader, state } = await started(d);
    const late = { ...d, now: () => NOW + TRANSACTION_SECONDS };
    expect(await completeSignIn(late, { url: url({ code: 'c', state }), cookieHeader })).toMatchObject({ kind: 'redirect', location: '/sign-in' });
    expect(await completeSignIn(late, { url: url({ code: 'c', state }), cookieHeader: `${cookieHeader}; ${FRESH}` })).toMatchObject({ kind: 'refused', reason: 'expired' });
  });

  it('takes a token call that timed out to a fresh sign-in, never the same code again; a second time shows the page', async () => {
    const d = deps();
    vi.mocked(d.oidc.finishSignIn).mockRejectedValue(timedOut());
    const first = await started(d);
    expect(await completeSignIn(d, { url: url({ code: 'c', state: first.state }), cookieHeader: first.cookieHeader })).toEqual({
      kind: 'redirect',
      location: '/sign-in?return=%2Fabout',
      cookies: [CLEAR_TX, FRESH_SET],
    });
    expect(d.oidc.finishSignIn).toHaveBeenCalledTimes(1);
    const second = await started(d);
    expect(await completeSignIn(d, { url: url({ code: 'c2', state: second.state }), cookieHeader: `${second.cookieHeader}; ${FRESH}` })).toEqual({
      kind: 'refused',
      reason: 'failed',
      cookies: [CLEAR_TX],
    });
    expect(d.oidc.finishSignIn).toHaveBeenCalledTimes(2);
  });

  it('counts a network failure or a gateway error on the way to the provider as passing too', async () => {
    const network = new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
    const wrapped = Object.assign(new Error('something went wrong', { cause: network }), { name: 'ClientError' });
    const gateway = Object.assign(new Error('unexpected HTTP response status code', { cause: { status: 524 } }), { code: 'OAUTH_RESPONSE_IS_NOT_CONFORM' });
    const aborted = Object.assign(new Error('operation aborted'), { code: 'OAUTH_ABORT' });
    const dns = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo'), { code: 'EAI_AGAIN' }) });
    for (const err of [network, wrapped, gateway, aborted, dns]) {
      const d = deps();
      vi.mocked(d.oidc.finishSignIn).mockRejectedValueOnce(err);
      const { cookieHeader, state } = await started(d);
      expect(await completeSignIn(d, { url: url({ code: 'c', state }), cookieHeader }), err.message).toMatchObject({ kind: 'redirect', location: '/sign-in?return=%2Fabout' });
    }
  });

  it('shows the page at once for a failure that another round would not mend: a bad token, a refusal, a bug', async () => {
    const notFound = Object.assign(new Error('unexpected HTTP response status code', { cause: { status: 404 } }), { code: 'OAUTH_RESPONSE_IS_NOT_CONFORM' });
    const refused = Object.assign(new Error('server responded with an error in the response body'), { code: 'OAUTH_RESPONSE_BODY_ERROR', status: 400, error: 'invalid_client' });
    const typeBug = new TypeError("Cannot read properties of undefined (reading 'x')");
    const odd = { cause: { cause: { cause: { cause: { cause: { cause: { code: 'ECONNRESET' } } } } } } };
    for (const err of [new Error('unexpected ID Token "nonce" claim value'), notFound, refused, typeBug, odd, 'a string', null]) {
      const d = deps();
      vi.mocked(d.oidc.finishSignIn).mockRejectedValueOnce(err);
      const { cookieHeader, state } = await started(d);
      expect(await completeSignIn(d, { url: url({ code: 'c', state }), cookieHeader }), String(err)).toMatchObject({ kind: 'refused', reason: 'failed' });
    }
  });

  it('never takes a mismatch, a cancel or an error the provider sent: those show the page as before', async () => {
    const d = deps();
    const { cookieHeader, state } = await started(d);
    for (const params of [{ code: 'c', state: `${state}x` }, { error: 'access_denied', state }]) {
      const out = await completeSignIn(deps(), { url: url(params), cookieHeader });
      expect(out.kind, JSON.stringify(params)).toBe('refused');
      expect(JSON.stringify(out)).not.toContain(FRESH_COOKIE);
    }
    expect(await completeSignIn(d, { url: url({ error: 'server_error', state }), cookieHeader })).toMatchObject({ kind: 'refused', reason: 'failed' });
  });

  it('keeps the return rules: a return that is not a path on this site goes home', async () => {
    const d = deps();
    const { cookieHeader, state } = await started(d, '//evil.example.org/x');
    await completeSignIn(d, { url: url({ code: 'c', state }), cookieHeader });
    expect(await completeSignIn(d, { url: url({ code: 'c', state }), cookieHeader })).toMatchObject({ location: '/sign-in' });
    // Even a transaction sealed with an unsafe return (none of ours is) is read through the same rules.
    for (const back of ['https://evil.example.org/', '/\\evil.example.org', '/ok\nx']) {
      const tx = transactionSetCookie({ state: 'st', nonce: 'n', verifier: 'v', back }, key, NOW).split(';')[0]!;
      const d2 = deps();
      vi.mocked(d2.oidc.finishSignIn).mockRejectedValueOnce(timedOut());
      expect(await completeSignIn(d2, { url: url({ code: 'c', state: 'st' }), cookieHeader: tx }), back).toMatchObject({ location: '/sign-in' });
    }
  });

  it('logs the refusal as before, saying a fresh round was taken, and never the code or the state', async () => {
    const d = deps();
    vi.mocked(d.oidc.finishSignIn).mockRejectedValueOnce(timedOut());
    const { cookieHeader, state } = await started(d);
    await completeSignIn(d, { url: url({ code: 'SECRETCODE', state }), cookieHeader });
    const line = JSON.parse(d.lines.at(-1)!) as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'warn', msg: 'sign-in refused', reason: 'failed', fresh_round: true });
    expect(d.lines.join('\n')).not.toContain('SECRETCODE');
    expect(d.lines.join('\n')).not.toContain(state);
  });
});

describe('signOut', () => {
  const expired = [`${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure`, `${AUTH_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure`];

  it('expires our own cookies by name, drops the tokens, and ends the provider’s session, clearing no site data', async () => {
    const d = deps();
    const session = newSession({ sub: 'u', groups: ['nwfl-members'] }, NOW);
    d.tokens.put(session.sid, { access_token: 'a', id_token: 'id-9' }, session.exp);
    const header = `${sessionSetCookie(session, key, NOW).split(';')[0]}; ${SIZE_COOKIE}=4; ${THEME_COOKIE}=dark`;
    const out = await signOut(d, { cookieHeader: header });
    // SIGNOUT: no Clear-Site-Data at all. "cookies" would clear the whole registered domain (the
    // provider's cookies, the reader's text size and theme); "cache" stalled the installed app's
    // navigation, and nothing members-only is ever stored (every such answer is private, no-store);
    // "storage" has nothing to clear (the site keeps nothing in the browser's storage).
    expect(out).not.toHaveProperty('clearSiteData');
    expect(out.cookies).toEqual(expired);
    expect(d.tokens.get(session.sid, NOW)).toBeUndefined();
    expect(d.oidc.endSessionUrl).toHaveBeenCalledWith(cfg, { idToken: 'id-9' });
    expect(out.location).toBe('https://login.nwflorida.us/end');
  });

  it('kills the session at once: its cookie, kept and sent again, reads as nobody', async () => {
    const d = deps();
    const session = newSession({ sub: 'u', groups: ['nwfl-members'] }, NOW);
    d.tokens.put(session.sid, { access_token: 'a', id_token: 'id-9' }, session.exp);
    const kept = sessionSetCookie(session, key, NOW).split(';')[0]!;
    expect(readSession(kept, key, NOW, d.tokens)).toBeDefined();
    await signOut(d, { cookieHeader: kept });
    expect(readSession(kept, key, NOW, d.tokens)).toBeUndefined();
    // Sign-in no longer takes it for a signed-in reader either.
    expect(await beginSignIn(d, { cookieHeader: kept, back: '/about' })).toMatchObject({ location: expect.stringMatching(/^https:\/\/login\.nwflorida\.us\//) });
  });

  it('comes to the signed-out page directly when the provider offers no logout, or cannot be reached', async () => {
    const d = deps();
    vi.mocked(d.oidc.endSessionUrl).mockResolvedValueOnce(undefined);
    expect(await signOut(d, { cookieHeader: undefined })).toEqual({ location: '/signed-out', cookies: expired });
    vi.mocked(d.oidc.endSessionUrl).mockRejectedValueOnce(new Error('down'));
    expect(await signOut(d, { cookieHeader: undefined })).toEqual({ location: '/signed-out', cookies: expired });
  });

  it('does the same when sign-in is not set up', async () => {
    const out = await signOut(deps({ key: undefined, setup: { enabled: false, reason: 'x' } }), { cookieHeader: undefined });
    expect(out).toEqual({ location: '/signed-out', cookies: expired });
  });
});

describe('ConsumedStates (server-side, bounded)', () => {
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
