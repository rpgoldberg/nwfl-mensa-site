// A3 end to end: real signed tokens, verified by jose against a local key set,
// through the production interceptors and routes, over gRPC.
import { Code } from '@connectrpc/connect';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createJwtVerifier } from '../../src/auth/jwt.js';
import { ContentService } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { EventService } from '../../src/gen/nwfl/mensa/v1/event_pb.js';
import { NewsletterService } from '../../src/gen/nwfl/mensa/v1/newsletter_pb.js';
import { type Api, dump, insertId, startApi } from '../helpers/api.js';
import { membersSpan, paragraph, publishItem, text } from '../helpers/content.js';
import { live } from '../helpers/pg.js';

const SITE = 'https://login.example.org/application/o/nwfl-site/';
const AGENT = 'https://login.example.org/application/o/nwfl-agent/';
const EDGE = 'cloudflared.nwfl-edge.serviceaccount.identity.linkerd.cluster.local';
// Site subjects are Authentik user UUIDs (NA1). Made-up values.
const MEMBER_SUB = '3c5e7a91-2b4d-4f6a-8c1e-5d7f9a1b3c5e';
const NO_ACCOUNT_SUB = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const OFFICER_SUB = '1f2e3d4c-5b6a-4987-a654-3f2e1d0c9b8a';
const APPROVER_SUB = '7e6d5c4b-3a29-4817-b6a5-9e8d7c6b5a49';

describe.skipIf(!live)('auth end to end', () => {
  let api: Api;
  let sign: (claims: Record<string, unknown>) => Promise<string>;
  const auth = (token: string, extra: Record<string, string> = {}) => ({ headers: { authorization: `Bearer ${token}`, ...extra } });

  beforeAll(async () => {
    const keys = await generateKeyPair('RS256');
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256' }] });
    sign = (claims) => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
    const verifier = createJwtVerifier([
      { kind: 'site', issuer: SITE, audience: 'nwfl-site', jwks },
      { kind: 'agent', issuer: AGENT, audience: 'nwfl-agent', jwks, scope: 'newsletter.read', subject: 'svc-nwfl-newsletter' },
    ]);
    api = await startApi('nwfl_auth_e2e', { verifier });
    await api.pool.query(
      `INSERT INTO member_account (sub, status, route, approved_by_sub, approved_at, verified_on) VALUES ($1, 'member', 'signup', $2, now(), '2026-10-01')`,
      [MEMBER_SUB, APPROVER_SUB],
    );
    const office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('president', 'President', 'elected') RETURNING id`);
    await publishItem(api.pool, { slug: 'report', officeId: office, title: 'Report', body: { blocks: [paragraph(text('Open '), membersSpan('members-only-words'))] } });
  });

  afterAll(async () => {
    await api?.close();
  });

  const report = async (options = {}): Promise<string> => dump(await api.client(ContentService).getPublishedItem({ slug: 'report' }, options));

  it('shows members content to a signed-in member with a member_account, and not to one without', async () => {
    expect(await report(auth(await sign({ iss: SITE, aud: 'nwfl-site', sub: MEMBER_SUB, groups: ['nwfl-members'] })))).toContain('members-only-words');
    expect(await report(auth(await sign({ iss: SITE, aud: 'nwfl-site', sub: NO_ACCOUNT_SUB, groups: ['nwfl-members'] })))).not.toContain('members-only-words');
    expect(await report()).not.toContain('members-only-words');
  });

  it('refuses a site token whose subject is not a UUID, even one naming a member_account, and never reads it as public', async () => {
    // startApi seeds a member_account under 'sub-member'; the token's groups would make it an officer.
    const named = await sign({ iss: SITE, aud: 'nwfl-site', sub: 'sub-member', groups: ['nwfl-members', 'nwfl-officers'] });
    await expect(report(auth(named))).rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(report(auth(await sign({ iss: SITE, aud: 'nwfl-site', sub: MEMBER_SUB.toUpperCase(), groups: ['nwfl-members'] })))).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
  });

  it('refuses a token signed by anyone else', async () => {
    const other = await generateKeyPair('RS256');
    const forged = await new SignJWT({ iss: SITE, aud: 'nwfl-site', sub: MEMBER_SUB, groups: ['nwfl-officers'] })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setExpirationTime('5m')
      .sign(other.privateKey);
    await expect(report(auth(forged))).rejects.toMatchObject({ code: Code.Unauthenticated });
  });

  it('keeps the agent out of the site services and the site out of NewsletterService', async () => {
    const agent = await sign({ iss: AGENT, aud: 'nwfl-agent', sub: 'svc-nwfl-newsletter', scope: 'newsletter.read' });
    await expect(api.client(EventService).listVenues({}, auth(agent))).rejects.toMatchObject({ code: Code.PermissionDenied });
    const member = await sign({ iss: SITE, aud: 'nwfl-site', sub: MEMBER_SUB, groups: ['nwfl-members'] });
    await expect(api.client(NewsletterService).listEditions({}, auth(member))).rejects.toMatchObject({ code: Code.PermissionDenied });
    // The agent passes the gate and is answered.
    await expect(api.client(NewsletterService).listEditions({}, auth(agent))).resolves.toMatchObject({ editions: [] });
  });

  it('refuses a site call that came through the edge, even with a forged web identity alongside', async () => {
    const officer = await sign({ iss: SITE, aud: 'nwfl-site', sub: OFFICER_SUB, groups: ['nwfl-officers'] });
    await expect(api.client(EventService).listVenues({}, auth(officer, { 'l5d-client-id': EDGE }))).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect((await api.client(EventService).listVenues({}, auth(officer))).venues).toEqual([]);
  });
});
