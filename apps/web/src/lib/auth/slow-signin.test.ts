// SIGNIN-SLOW: the callback against a provider whose token endpoint takes the code and never answers
// (a slow path out through the edge and back), with the real OIDC client and the real flow. The reader
// is answered within the timeout and a second, sent on to one fresh sign-in, and the code is never
// sent twice; a stall in the fresh round's own callback shows the refusal page, as before. And the
// real error chains openid-client 6.8.8 throws (a stall after the headers, a socket closed mid-body four
// causes deep, a 5xx), each read as passing or not by the real flow.
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authConfig } from '../../../server/auth-config.mjs';
import { TokenStore } from '../../../server/token-store.mjs';
import { ConsumedStates, beginSignIn, completeSignIn, type Deps, type Outcome } from './flow';
import * as oidc from './oidc';

const TIMEOUT_MS = 1000;
let server: http.Server;
let issuer: string;
/** How the token endpoint answers. */
let mode: 'stall' | 'ok' | 'headers-then-stall' | 'headers-then-close' | '503-invalid-grant' | '502-page' | '530-cloudflare-json' = 'stall';
let codes: string[] = [];
let nonce = '';
let keys: Awaited<ReturnType<typeof generateKeyPair>>;

beforeAll(async () => {
  keys = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const json = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json({
        issuer,
        authorization_endpoint: `${issuer}/auth`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        id_token_signing_alg_values_supported: ['ES256'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url.pathname === '/jwks') return json({ keys: [jwk] });
    if (url.pathname === '/token') {
      let body = '';
      for await (const chunk of req) body += chunk;
      codes.push(new URLSearchParams(body).get('code') ?? '');
      if (mode === 'stall') return; // takes the code, and never answers
      if (mode === 'headers-then-stall' || mode === 'headers-then-close') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '200' });
        res.write('{"access_token":');
        if (mode === 'headers-then-close') setTimeout(() => req.socket.destroy(), 20);
        return;
      }
      if (mode === '503-invalid-grant') {
        res.writeHead(503, { 'content-type': 'application/json' });
        return res.end('{"error":"invalid_grant"}');
      }
      // Cloudflare's structured error (RFC 9457) for a tunnel down, as it answers openid-client's Accept: application/json.
      if (mode === '530-cloudflare-json') {
        res.writeHead(530, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ type: 'https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1033/', title: 'Error 1033: Cloudflare Tunnel error', status: 530, error_code: 1033, error_name: 'tunnel_error', cloudflare_error: true, retryable: true }));
      }
      if (mode === '502-page') {
        res.writeHead(502, { 'content-type': 'text/html' });
        return res.end('<html><body>Bad gateway</body></html>');
      }
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({ iss: issuer, aud: 'nwfl-site', sub: 'user-1', iat: now, exp: now + 300, nonce, groups: ['nwfl-members'] })
        .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
        .sign(keys.privateKey);
      return json({ access_token: 'access-1', token_type: 'Bearer', expires_in: 300, id_token: idToken });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

let d: Deps;
beforeEach(() => {
  mode = 'stall';
  codes = [];
  oidc.forgetDiscovery();
  const setup = authConfig({
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: 'nwfl-site',
    OIDC_CLIENT_SECRET: 'test-secret',
    OIDC_REDIRECT_URI: 'https://localhost:8443/auth/callback',
    OIDC_POST_LOGOUT_REDIRECT_URI: 'https://localhost:8443/signed-out',
    OIDC_TIMEOUT_MS: String(TIMEOUT_MS),
  });
  d = { setup, key: randomBytes(32), now: () => Math.floor(Date.now() / 1000), oidc, tokens: new TokenStore(), consumed: new ConsumedStates(), log: () => {} };
});

/** What a browser keeps: each Set-Cookie's name and value, a cleared one dropped. */
function keep(jar: Map<string, string>, setCookies: string[]) {
  for (const c of setCookies) {
    const [pair] = c.split(';');
    const [name, value] = [pair!.slice(0, pair!.indexOf('=')), pair!.slice(pair!.indexOf('=') + 1)];
    if (value) jar.set(name, value);
    else jar.delete(name);
  }
}
const header = (jar: Map<string, string>) => [...jar].map(([n, v]) => `${n}=${v}`).join('; ');

/** Where a fresh round sends the reader: /sign-in with its query, as the page reads it. */
const signInAt = (out: Outcome) => {
  if (out.kind !== 'redirect') throw new Error(out.kind);
  const at = new URL(`https://localhost:8443${out.location}`);
  expect(at.pathname).toBe('/sign-in');
  return { back: at.searchParams.get('return'), fresh: at.searchParams.get('fresh') === '1', again: at.searchParams.get('again') === '1' };
};

/** /sign-in (as sign-in.astro reads its query), then the provider's answer at the callback with `code`: the outcome and how long the callback took. */
async function round(jar: Map<string, string>, back: string | null, code: string, { fresh = false, again = false } = {}): Promise<{ out: Outcome; ms: number }> {
  const begun = await beginSignIn(d, { cookieHeader: header(jar), back, fresh, again });
  if (begun.kind !== 'redirect') throw new Error(begun.kind);
  keep(jar, begun.cookies);
  const at = new URL(begun.location);
  nonce = at.searchParams.get('nonce') ?? '';
  const callback = new URL(`https://localhost:8443/auth/callback?${new URLSearchParams({ code, state: at.searchParams.get('state') ?? '' })}`);
  const t0 = performance.now();
  const out = await completeSignIn(d, { url: callback, cookieHeader: header(jar) });
  const ms = performance.now() - t0;
  if (out.kind !== 'unavailable') keep(jar, out.cookies);
  return { out, ms };
}

describe('a token call that never answers', () => {
  it('answers within the timeout and a second with one fresh sign-in, back to the page, the code sent once', async () => {
    const jar = new Map<string, string>();
    const { out, ms } = await round(jar, '/members?tab=dues', 'code-1');
    expect(ms).toBeLessThan(TIMEOUT_MS + 1000);
    expect(out).toMatchObject({ kind: 'redirect', location: '/sign-in?return=%2Fmembers%3Ftab%3Ddues&fresh=1' });
    expect(out.kind === 'redirect' && out.cookies.map((c) => c.split('=')[0])).toEqual(['__Host-nwfl-auth']);
    expect([...jar.keys()]).toEqual([]);
    await new Promise((r) => setTimeout(r, 200));
    expect(codes).toEqual(['code-1']);
  });

  it('shows the refusal page on a second stall in the same chain, never a loop, and never a code twice', async () => {
    const jar = new Map<string, string>();
    const first = await round(jar, '/members', 'code-1');
    const to = signInAt(first.out);
    const second = await round(jar, to.back, 'code-2', to);
    expect(second.ms).toBeLessThan(TIMEOUT_MS + 1000);
    expect(second.out).toEqual({ kind: 'refused', reason: 'failed', cookies: [expect.stringMatching(/^__Host-nwfl-auth=;/)] });
    await new Promise((r) => setTimeout(r, 200));
    expect(codes).toEqual(['code-1', 'code-2']);
  });

  it('signs the reader in on the fresh round once the provider answers, back to their page', async () => {
    const jar = new Map<string, string>();
    const first = await round(jar, '/members', 'code-1', { again: true });
    mode = 'ok';
    const to = signInAt(first.out);
    expect(to).toEqual({ back: '/members', fresh: true, again: true });
    const second = await round(jar, to.back, 'code-2', to);
    expect(second.out).toMatchObject({ kind: 'redirect', location: '/members' });
    expect(codes).toEqual(['code-1', 'code-2']);
  });
});

describe('the real error chains of a token call that broke', () => {
  it.each(['headers-then-stall', 'headers-then-close', '502-page', '530-cloudflare-json'] as const)('takes %s (the path, not the provider) to one fresh round', async (m) => {
    mode = m;
    const jar = new Map<string, string>();
    const { out, ms } = await round(jar, '/news', 'code-1');
    expect(ms).toBeLessThan(TIMEOUT_MS + 1000);
    expect(out).toMatchObject({ kind: 'redirect', location: '/sign-in?return=%2Fnews&fresh=1' });
    expect(codes).toEqual(['code-1']);
  });

  // The provider's own answer on a 5xx: the code was refused, not lost on the way; the page, as before.
  it('shows the page for a 5xx carrying the provider’s invalid_grant', async () => {
    mode = '503-invalid-grant';
    const { out } = await round(new Map(), '/news', 'code-1');
    expect(out).toMatchObject({ kind: 'refused', reason: 'failed' });
  });
});
