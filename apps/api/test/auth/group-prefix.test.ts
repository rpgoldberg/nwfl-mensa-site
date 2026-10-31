// CF-ISO-0 end to end: with SITE_GROUP_PREFIX=mensa-nwfl-, a real signed mensa-nwfl-officers token is
// an officer all the way down to the SQL, which still checks the internal 'nwfl-officers' (0014:157);
// a bare nwfl-officers token and another chapter's are not. Every name is made up.
import { Code } from '@connectrpc/connect';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createJwtVerifier } from '../../src/auth/jwt.js';
import { MarkField, MarkSubjectKind, RedactionCategory, RedactionPolicyService } from '../../src/gen/nwfl/mensa/v1/redaction_pb.js';
import { type Api, insertId, startApi } from '../helpers/api.js';
import { paragraph, publishItem, text } from '../helpers/content.js';
import { live } from '../helpers/pg.js';

const SITE = 'https://login.example.org/application/o/nwfl-site/';
const OFFICER_SUB = '2a4c6e80-1b3d-4f5a-9c7e-0d2f4a6c8e01';

describe.skipIf(!live)('the chapter group prefix, end to end', () => {
  let api: Api;
  let item: string;
  let sign: (groups: string[]) => Promise<string>;

  beforeAll(async () => {
    const keys = await generateKeyPair('RS256');
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256' }] });
    sign = (groups) =>
      new SignJWT({ iss: SITE, aud: 'nwfl-site', sub: OFFICER_SUB, groups }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
    api = await startApi('nwfl_group_prefix', { verifier: createJwtVerifier([{ kind: 'site', issuer: SITE, audience: 'nwfl-site', jwks }]), groupPrefix: 'mensa-nwfl-' });
    const office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('president', 'President', 'elected') RETURNING id`);
    // Written by someone else, so only the officer rule (in the handler and in SQL) lets the token mark it.
    item = (await publishItem(api.pool, { slug: 'report', officeId: office, title: 'Report', body: { blocks: [paragraph(text('Call 850-555-0143.'))] } })).itemId;
  });

  afterAll(async () => {
    await api?.close();
  });

  const mark = async (groups: string[], quote: string) =>
    api
      .client(RedactionPolicyService)
      .addRedactionMark(
        { subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: item, field: MarkField.BODY, quote, category: RedactionCategory.MEMBER_PHONE },
        { headers: { authorization: `Bearer ${await sign(groups)}` } },
      );

  it('lets a mensa-nwfl-officers token mark an item, recorded with the internal group name', async () => {
    const { mark: added } = await mark(['mensa-nwfl-members', 'mensa-nwfl-officers'], '850-555-0143');
    expect(added?.quote).toBe('850-555-0143');
    const audit = await api.pool.query<{ groups: string[] }>(`SELECT actor_groups AS groups FROM audit_event WHERE action = 'redaction_mark_add'`);
    expect(audit.rows.map((row) => row.groups)).toEqual([['nwfl-members', 'nwfl-officers']]);
  });

  it('refuses a bare nwfl-officers token and another chapter\'s officers', async () => {
    await expect(mark(['nwfl-members', 'nwfl-officers'], 'Call 850')).rejects.toMatchObject({ code: Code.PermissionDenied });
    await expect(mark(['mensa-other-members', 'mensa-other-officers'], 'Call 850')).rejects.toMatchObject({ code: Code.PermissionDenied });
  });
});
