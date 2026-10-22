// A3: bearer tokens verified against each client's JWKS with jose. Three
// clients, each with its own issuer, audience and (for the two machine
// clients) scope and subject. Tested against LOCAL key sets, plus one served
// over HTTP to exercise the remote path.
import { type AddressInfo } from 'node:net';
import http from 'node:http';
import { type JWK, type JWTVerifyGetKey, SignJWT, UnsecuredJWT, createLocalJWKSet, createRemoteJWKSet, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ClientConfig, createJwtVerifier } from './jwt.js';

const SITE_ISS = 'https://login.example.org/application/o/nwfl-site/';
const AGENT_ISS = 'https://login.example.org/application/o/nwfl-agent/';
const VERIFIER_ISS = 'https://login.example.org/application/o/nwfl-verifier/';

type Keys = Awaited<ReturnType<typeof generateKeyPair>>;
let rsa: Keys;
let ec: Keys;
let stranger: Keys;
let jwks: { keys: JWK[] };

async function sign(claims: Record<string, unknown>, options: { keys?: Keys; alg?: string; kid?: string; expiresIn?: string | number } = {}): Promise<string> {
  const keys = options.keys ?? rsa;
  const alg = options.alg ?? 'RS256';
  let jwt = new SignJWT(claims).setProtectedHeader({ alg, kid: options.kid ?? (keys === ec ? 'ec-1' : 'rsa-1') }).setIssuedAt();
  if (options.expiresIn !== undefined) jwt = jwt.setExpirationTime(options.expiresIn);
  else jwt = jwt.setExpirationTime('5m');
  return jwt.sign(keys.privateKey);
}

function clients(keySet: JWTVerifyGetKey = createLocalJWKSet(jwks)): ClientConfig[] {
  return [
    { kind: 'site', issuer: SITE_ISS, audience: 'nwfl-site', jwks: keySet },
    { kind: 'agent', issuer: AGENT_ISS, audience: 'nwfl-agent', jwks: keySet, scope: 'newsletter.read', subject: 'svc-nwfl-newsletter' },
    { kind: 'verifier', issuer: VERIFIER_ISS, audience: 'nwfl-verifier', jwks: keySet, scope: 'membership.verify', subject: 'svc-nwfl-verifier' },
  ];
}

const site = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: SITE_ISS,
  aud: 'nwfl-site',
  sub: 'user-123',
  groups: ['nwfl-members', 'nwfl-office-treasurer'],
  ...extra,
});

beforeAll(async () => {
  rsa = await generateKeyPair('RS256');
  ec = await generateKeyPair('ES256');
  stranger = await generateKeyPair('RS256');
  jwks = {
    keys: [
      { ...(await exportJWK(rsa.publicKey)), kid: 'rsa-1', alg: 'RS256', use: 'sig' },
      { ...(await exportJWK(ec.publicKey)), kid: 'ec-1', alg: 'ES256', use: 'sig' },
    ],
  };
});

describe('createJwtVerifier', () => {
  it('verifies a site token and reports its client, subject, groups and scopes', async () => {
    const verifier = createJwtVerifier(clients());
    const token = await sign(site({ scope: 'openid profile' }));
    expect(await verifier.verify(token)).toEqual({ client: 'site', subject: 'user-123', groups: ['nwfl-members', 'nwfl-office-treasurer'], scopes: ['openid', 'profile'] });
  });

  it('accepts ES256 as well as RS256', async () => {
    const verifier = createJwtVerifier(clients());
    expect((await verifier.verify(await sign(site(), { keys: ec, alg: 'ES256' }))).client).toBe('site');
  });

  it('verifies the agent and the verifier by their own audience, scope and subject, with no groups', async () => {
    const verifier = createJwtVerifier(clients());
    const agent = await sign({ iss: AGENT_ISS, aud: 'nwfl-agent', sub: 'svc-nwfl-newsletter', scope: 'newsletter.read', groups: ['nwfl-admin'] });
    expect(await verifier.verify(agent)).toEqual({ client: 'agent', subject: 'svc-nwfl-newsletter', groups: [], scopes: ['newsletter.read'] });
    const checker = await sign({ iss: VERIFIER_ISS, aud: 'nwfl-verifier', sub: 'svc-nwfl-verifier', scope: 'openid membership.verify' });
    expect((await verifier.verify(checker)).client).toBe('verifier');
  });

  it.each([
    ['an expired token', () => sign(site(), { expiresIn: Math.floor(Date.now() / 1000) - 120 })],
    ['a token not valid yet', () => new SignJWT(site()).setProtectedHeader({ alg: 'RS256', kid: 'rsa-1' }).setNotBefore('10m').setExpirationTime('20m').sign(rsa.privateKey)],
    ['a token without an expiry', () => new SignJWT(site()).setProtectedHeader({ alg: 'RS256', kid: 'rsa-1' }).sign(rsa.privateKey)],
    ['a token from an unknown issuer', () => sign(site({ iss: 'https://evil.example.org/' }))],
    ['a site token for another audience', () => sign(site({ aud: 'fc-coordinator' }))],
    ['a token for two of our audiences at once', () => sign(site({ aud: ['nwfl-site', 'nwfl-agent'] }))],
    ['a token signed by a key not in the set', () => sign(site(), { keys: stranger })],
    ['a token whose kid names our key but was signed by another', () => sign(site(), { keys: stranger, kid: 'rsa-1' })],
    ['an unsigned token (alg none)', () => Promise.resolve(new UnsecuredJWT(site()).setExpirationTime('5m').encode())],
    ['a token without a subject', () => sign(site({ sub: undefined }))],
    ['a site token whose groups are not a list of strings', () => sign(site({ groups: 'nwfl-officers' }))],
    ['an agent token without the read scope', () => sign({ iss: AGENT_ISS, aud: 'nwfl-agent', sub: 'svc-nwfl-newsletter', scope: 'openid' })],
    ['an agent token for another subject', () => sign({ iss: AGENT_ISS, aud: 'nwfl-agent', sub: 'someone-else', scope: 'newsletter.read' })],
    ['a verifier token presented with the agent audience', () => sign({ iss: VERIFIER_ISS, aud: 'nwfl-agent', sub: 'svc-nwfl-verifier', scope: 'membership.verify' })],
    ['a token that is not a JWT', () => Promise.resolve('not.a.jwt')],
  ])('refuses %s', async (_label, make) => {
    await expect(createJwtVerifier(clients()).verify(await make())).rejects.toThrow();
  });

  describe('token lifetime (STACK-FIX): an issue time is required, and exp - iat is at most 1 h for a site token, 24 h for a machine token', () => {
    const now = (): number => Math.floor(Date.now() / 1000);
    const at = (claims: Record<string, unknown>, iat: number | undefined, exp: number): Promise<string> => {
      let jwt = new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'rsa-1' }).setExpirationTime(exp);
      if (iat !== undefined) jwt = jwt.setIssuedAt(iat);
      return jwt.sign(rsa.privateKey);
    };
    const agent = { iss: AGENT_ISS, aud: 'nwfl-agent', sub: 'svc-nwfl-newsletter', scope: 'newsletter.read' };
    const verifierClaims = { iss: VERIFIER_ISS, aud: 'nwfl-verifier', sub: 'svc-nwfl-verifier', scope: 'membership.verify' };

    it('refuses a token without an issue time', async () => {
      await expect(createJwtVerifier(clients()).verify(await at(site(), undefined, now() + 300))).rejects.toThrow(/"iat"/);
    });

    it('accepts a site token living exactly 1 h, and refuses one living longer', async () => {
      const verifier = createJwtVerifier(clients());
      const t = now();
      expect((await verifier.verify(await at(site(), t, t + 3600))).client).toBe('site');
      await expect(verifier.verify(await at(site(), t, t + 3601))).rejects.toThrow(/lifetime/);
      await expect(verifier.verify(await at(site(), t, t + 10 * 365 * 86400))).rejects.toThrow(/lifetime/);
    });

    it('refuses a site token issued over 1 h ago even with a near expiry', async () => {
      const t = now();
      await expect(createJwtVerifier(clients()).verify(await at(site(), t - 7200, t + 300))).rejects.toThrow();
    });

    it('refuses a token issued in the future', async () => {
      const t = now();
      await expect(createJwtVerifier(clients()).verify(await at(site(), t + 600, t + 900))).rejects.toThrow(/"iat"/);
    });

    it('accepts a machine token living 24 h, and refuses one living longer', async () => {
      const verifier = createJwtVerifier(clients());
      const t = now();
      expect((await verifier.verify(await at(agent, t, t + 86400))).client).toBe('agent');
      await expect(verifier.verify(await at(agent, t, t + 86401))).rejects.toThrow(/lifetime/);
      expect((await verifier.verify(await at(verifierClaims, t, t + 86400))).client).toBe('verifier');
      await expect(verifier.verify(await at(verifierClaims, t, t + 86401))).rejects.toThrow(/lifetime/);
    });
  });

  it('refuses every token when no client is configured', async () => {
    await expect(createJwtVerifier([]).verify(await sign(site()))).rejects.toThrow();
  });

  describe('a JWKS served over HTTP (the production path)', () => {
    let server: http.Server;
    let fetches = 0;

    beforeAll(async () => {
      server = http.createServer((_req, res) => {
        fetches += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(jwks));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('fetches the key set once and verifies against it', async () => {
      const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks/`);
      const verifier = createJwtVerifier(clients(createRemoteJWKSet(url)));
      expect((await verifier.verify(await sign(site()))).subject).toBe('user-123');
      expect((await verifier.verify(await sign(site({ sub: 'user-456' })))).subject).toBe('user-456');
      expect(fetches).toBe(1);
    });
  });
});
