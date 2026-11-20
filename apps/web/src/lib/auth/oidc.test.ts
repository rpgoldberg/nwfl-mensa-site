// The real openid-client against a small identity provider made here: its
// discovery document, its key set, and a token endpoint that records what it
// was sent and answers with an ID token signed by a test key.
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthConfig } from '../../../server/auth-config.mjs';
import { endSessionUrl, finishSignIn, forgetDiscovery, startSignIn } from './oidc';

let server: http.Server;
let issuer: string;
let tokenRequests: { authorization: string | undefined; body: URLSearchParams }[] = [];
let idToken: Record<string, unknown> = {};
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let discoveryCalls = 0;
let failDiscovery = false;
let offerLogout = true;
// SIGNIN-SLOW: a provider that takes the request and never answers (a slow path through the edge).
let stallDiscovery = false;
let stallToken = false;

beforeAll(async () => {
  keys = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      discoveryCalls++;
      if (stallDiscovery) return;
      if (failDiscovery) return json({ error: 'down' }, 503);
      return json({
        issuer,
        authorization_endpoint: `${issuer}/auth`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        ...(offerLogout ? { end_session_endpoint: `${issuer}/session/end` } : {}),
        id_token_signing_alg_values_supported: ['ES256'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url.pathname === '/jwks') return json({ keys: [jwk] });
    if (url.pathname === '/token') {
      let body = '';
      for await (const chunk of req) body += chunk;
      tokenRequests.push({ authorization: req.headers.authorization, body: new URLSearchParams(body) });
      if (stallToken) return;
      const now = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({ iss: issuer, aud: 'nwfl-site', sub: 'user-1', iat: now, exp: now + 300, ...idToken })
        .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
        .sign(keys.privateKey);
      return json({ access_token: 'access-1', token_type: 'Bearer', expires_in: 300, refresh_token: 'refresh-1', id_token: token });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  // A stalled request holds its socket open: drop it, so the server can close.
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

const config = (): AuthConfig => ({
  issuer: new URL(issuer),
  clientId: 'nwfl-site',
  clientSecret: 's3cret',
  redirectUri: 'https://localhost:8443/auth/callback',
  postLogoutRedirectUri: 'https://localhost:8443/signed-out',
  scope: 'openid profile',
  allowInsecure: true,
  groupPrefix: 'nwfl-',
  timeoutMs: 1000,
});

beforeEach(() => {
  tokenRequests = [];
  idToken = {};
  failDiscovery = false;
  offerLogout = true;
  stallDiscovery = false;
  stallToken = false;
  forgetDiscovery();
});

/** The authorization response a browser would bring back to the callback. */
const callback = (params: Record<string, string>) => new URL(`https://localhost:8443/auth/callback?${new URLSearchParams(params)}`);

describe('startSignIn', () => {
  it('sends the reader to the authorization endpoint with PKCE S256, state and nonce', async () => {
    const start = await startSignIn(config());
    const q = start.location.searchParams;
    expect(`${start.location.origin}${start.location.pathname}`).toBe(`${issuer}/auth`);
    expect(Object.fromEntries(q)).toMatchObject({
      response_type: 'code',
      client_id: 'nwfl-site',
      redirect_uri: 'https://localhost:8443/auth/callback',
      scope: 'openid profile',
      code_challenge_method: 'S256',
      state: start.state,
      nonce: start.nonce,
    });
    expect(q.get('code_challenge')).toBe(createHash('sha256').update(start.verifier).digest('base64url'));
  });

  it('makes fresh state, nonce and verifier for every sign-in', async () => {
    const [a, b] = [await startSignIn(config()), await startSignIn(config())];
    expect(new Set([a.state, a.nonce, a.verifier, b.state, b.nonce, b.verifier]).size).toBe(6);
    for (const value of [a.state, a.nonce, a.verifier]) expect(value.length).toBeGreaterThanOrEqual(43);
  });

  it('refuses a plain-http provider unless the test setting allows it', async () => {
    await expect(startSignIn({ ...config(), allowInsecure: false })).rejects.toThrow();
  });

  it('reads the provider’s metadata once, and again after a failure', async () => {
    discoveryCalls = 0;
    failDiscovery = true;
    await expect(startSignIn(config())).rejects.toThrow();
    failDiscovery = false;
    await startSignIn(config());
    await startSignIn(config());
    expect(discoveryCalls).toBe(2);
  });
});

describe('finishSignIn', () => {
  it('exchanges the code as a confidential client (secret in the body), with the verifier and the configured redirect URI', async () => {
    const start = await startSignIn(config());
    idToken = { nonce: start.nonce, name: 'Alex Sample', groups: ['nwfl-members'] };
    const done = await finishSignIn(config(), callback({ code: 'code-1', state: start.state, iss: issuer }), start);
    expect(done.claims).toMatchObject({ sub: 'user-1', name: 'Alex Sample', groups: ['nwfl-members'] });
    expect(done.tokens).toMatchObject({ access_token: 'access-1', refresh_token: 'refresh-1' });
    const [request] = tokenRequests;
    expect(request?.authorization).toBeUndefined();
    expect(Object.fromEntries(request!.body)).toMatchObject({
      client_id: 'nwfl-site',
      client_secret: 's3cret',
      grant_type: 'authorization_code',
      code: 'code-1',
      code_verifier: start.verifier,
      redirect_uri: 'https://localhost:8443/auth/callback',
    });
  });

  it('refuses an ID token whose nonce is not the one this sign-in sent', async () => {
    const start = await startSignIn(config());
    idToken = { nonce: 'someone-elses-nonce' };
    await expect(finishSignIn(config(), callback({ code: 'c', state: start.state, iss: issuer }), start)).rejects.toThrow();
  });

  it('refuses a response whose state is not this sign-in’s', async () => {
    const start = await startSignIn(config());
    idToken = { nonce: start.nonce };
    await expect(finishSignIn(config(), callback({ code: 'c', state: 'forged', iss: issuer }), start)).rejects.toThrow();
    expect(tokenRequests).toEqual([]);
  });

  it('refuses an ID token for another client or from another issuer', async () => {
    const start = await startSignIn(config());
    idToken = { nonce: start.nonce, aud: 'another-client' };
    await expect(finishSignIn(config(), callback({ code: 'c', state: start.state, iss: issuer }), start)).rejects.toThrow();
    idToken = { nonce: start.nonce, iss: 'https://login.example.org' };
    await expect(finishSignIn(config(), callback({ code: 'c', state: start.state, iss: issuer }), start)).rejects.toThrow();
  });
});

// SIGNIN-SLOW: openid-client waits 30 s by default; a reader at the callback must not.
describe('a provider that does not answer', () => {
  const timed = async (work: Promise<unknown>) => {
    const t0 = performance.now();
    const error = await work.then(
      () => undefined,
      (e: unknown) => e,
    );
    return { error: error as { code?: string } | undefined, ms: performance.now() - t0 };
  };

  it('gives up on the token call after OIDC_TIMEOUT_MS, having sent the code once only', async () => {
    const start = await startSignIn(config());
    stallToken = true;
    const { error, ms } = await timed(finishSignIn(config(), callback({ code: 'code-1', state: start.state, iss: issuer }), start));
    expect(error?.code).toBe('OAUTH_TIMEOUT');
    expect(ms).toBeGreaterThanOrEqual(900);
    expect(ms).toBeLessThan(2000);
    // Authentik's codes are single-use: a second request with it would only be refused, or spend it.
    await new Promise((r) => setTimeout(r, 300));
    expect(tokenRequests.map((r) => r.body.get('code'))).toEqual(['code-1']);
  });

  it('gives up on discovery after OIDC_TIMEOUT_MS too, and reads it afresh next time', async () => {
    stallDiscovery = true;
    const { error, ms } = await timed(startSignIn(config()));
    expect(error?.code).toBe('OAUTH_TIMEOUT');
    expect(ms).toBeLessThan(2000);
    stallDiscovery = false;
    await expect(startSignIn(config())).resolves.toMatchObject({ state: expect.any(String) });
  });

  it('reads the metadata again when the timeout changes, so the new one applies to every call', async () => {
    discoveryCalls = 0;
    await startSignIn(config());
    await startSignIn({ ...config(), timeoutMs: 2000 });
    expect(discoveryCalls).toBe(2);
  });
});

describe('endSessionUrl', () => {
  it('ends the provider’s session too, and brings the reader back to the signed-out page', async () => {
    const url = await endSessionUrl(config(), { idToken: 'id-1' });
    expect(`${url?.origin}${url?.pathname}`).toBe(`${issuer}/session/end`);
    expect(Object.fromEntries(url!.searchParams)).toEqual({
      client_id: 'nwfl-site',
      post_logout_redirect_uri: 'https://localhost:8443/signed-out',
      id_token_hint: 'id-1',
    });
  });

  it('is undefined when the provider offers no logout', async () => {
    offerLogout = false;
    expect(await endSessionUrl(config(), {})).toBeUndefined();
  });

  it('leaves out the hint when the ID token is no longer held', async () => {
    const url = await endSessionUrl(config(), {});
    expect(url?.searchParams.has('id_token_hint')).toBe(false);
  });
});
