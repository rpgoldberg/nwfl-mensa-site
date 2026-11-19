// SIGNIN-SLOW: the callback against a provider whose token endpoint takes the code and never answers
// (a slow path out through the edge and back), with the real OIDC client and the real flow. The reader
// is answered within the timeout and a second, sent on to one fresh sign-in, and the code is never
// sent twice; a second stall within ten minutes shows the refusal page, as before.
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authConfig } from '../../../server/auth-config.mjs';
import { FRESH_COOKIE } from '../../../server/session.mjs';
import { TokenStore } from '../../../server/token-store.mjs';
import { ConsumedStates, beginSignIn, completeSignIn, type Deps, type Outcome } from './flow';
import * as oidc from './oidc';

const TIMEOUT_MS = 1000;
let server: http.Server;
let issuer: string;
let stall = true;
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
      if (stall) return; // takes the code, and never answers
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
  stall = true;
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

/** /sign-in, then the provider's answer at the callback with `code`: the outcome and how long the callback took. */
async function round(jar: Map<string, string>, back: string | null, code: string): Promise<{ out: Outcome; ms: number }> {
  const begun = await beginSignIn(d, { cookieHeader: header(jar), back });
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
    expect(out).toMatchObject({ kind: 'redirect', location: '/sign-in?return=%2Fmembers%3Ftab%3Ddues' });
    expect(out.kind === 'redirect' && out.cookies).toContain(`${FRESH_COOKIE}=1; Path=/; Max-Age=600; SameSite=Lax; HttpOnly; Secure`);
    expect(jar.get(FRESH_COOKIE)).toBe('1');
    await new Promise((r) => setTimeout(r, 200));
    expect(codes).toEqual(['code-1']);
  });

  it('shows the refusal page on a second stall within ten minutes, never a loop, and never a code twice', async () => {
    const jar = new Map<string, string>();
    const first = await round(jar, '/members', 'code-1');
    expect(first.out.kind).toBe('redirect');
    const back = new URL(`https://localhost:8443${first.out.kind === 'redirect' ? first.out.location : ''}`).searchParams.get('return');
    const second = await round(jar, back, 'code-2');
    expect(second.ms).toBeLessThan(TIMEOUT_MS + 1000);
    expect(second.out).toEqual({ kind: 'refused', reason: 'failed', cookies: [expect.stringMatching(/^__Host-nwfl-auth=;/)] });
    await new Promise((r) => setTimeout(r, 200));
    expect(codes).toEqual(['code-1', 'code-2']);
  });

  it('signs the reader in on the fresh round once the provider answers, back to their page', async () => {
    const jar = new Map<string, string>();
    const first = await round(jar, '/members', 'code-1');
    stall = false;
    const back = new URL(`https://localhost:8443${first.out.kind === 'redirect' ? first.out.location : ''}`).searchParams.get('return');
    const second = await round(jar, back, 'code-2');
    expect(second.out).toMatchObject({ kind: 'redirect', location: '/members' });
    expect(codes).toEqual(['code-1', 'code-2']);
  });
});
