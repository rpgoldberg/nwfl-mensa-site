// CHALLENGER (R2a): end-to-end adversarial reads. Fix 3: A2, A3 and A7 fetch by id, as a withheld
// slug is now not found; they test what the answer holds, not how the item is found. Each `it` asserts the SECURE outcome; red = finding.
import { createHash } from 'node:crypto';
import { Code, ConnectError } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Audience } from '../../src/gen/nwfl/mensa/v1/common_pb.js';
import { ContentService } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { EventService } from '../../src/gen/nwfl/mensa/v1/event_pb.js';
import { NewsletterService } from '../../src/gen/nwfl/mensa/v1/newsletter_pb.js';
import { MarkField, MarkSubjectKind, RedactionAction, RedactionAudience, RedactionCategory, RedactionPolicyService } from '../../src/gen/nwfl/mensa/v1/redaction_pb.js';
import type { TokenVerifier, VerifiedToken } from '../../src/auth/caller.js';
import { type Api, OFFICER, PEOPLE, as, dump, insertId, startApi } from '../helpers/api.js';
import { paragraph, publishItem, text } from '../helpers/content.js';
import { live } from '../helpers/pg.js';

const EXTRA: Record<string, VerifiedToken> = {
  'shout-token': { client: 'site', subject: 'sub-shout', groups: ['NWFL-OFFICERS', 'NWFL-MEMBERS'], scopes: [] },
  'space-token': { client: 'site', subject: 'sub-space', groups: ['nwfl-officers ', ' nwfl-members'], scopes: [] },
  'tenant-token': { client: 'site', subject: 'sub-tenant', groups: ['pcola-officers', 'officers', 'nwfl-officers-x'], scopes: [] },
  'agentoff-token': { client: 'agent', subject: 'svc-x', groups: ['nwfl-officers'], scopes: ['newsletter.read'] },
};
const verifier: TokenVerifier = {
  verify: (token) => {
    const person = PEOPLE[token] ?? EXTRA[token];
    return person === undefined ? Promise.reject(new Error('unknown')) : Promise.resolve(person);
  },
};
const tok = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

describe.skipIf(!live)('R2a challenge: API', () => {
  let api: Api;
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    api = await startApi('nwfl_chal', { verifier });
    const { pool } = api;
    const office = await insertId(pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
    ids['office'] = office;
    ids['edition'] = await insertId(pool, `INSERT INTO edition (slug, title, kind, period_start, period_end, status) VALUES ('2026-11', 'November 2026', 'regular', '2026-11-01', '2026-11-30', 'collecting') RETURNING id`);
    const ed = ids['edition'];
    ids['slug'] = (await publishItem(pool, { slug: 'picnic-with-john-smith', officeId: office, title: 'Picnic with John Smith', editionId: ed, body: { blocks: [paragraph(text('Annual picnic. Ann drives.'))] }, approvedAt: '2026-10-01T12:00:00Z' })).itemId;
    ids['nfd'] = (await publishItem(pool, { slug: 'nfd', officeId: office, title: 'Ride with José Núñez', editionId: ed, body: { blocks: [paragraph(text('x'))] }, approvedAt: '2026-10-02T12:00:00Z' })).itemId;
    ids['bravo'] = (await publishItem(pool, { slug: 'bravo', officeId: office, title: 'Bravo notes', editionId: ed, body: { blocks: [paragraph(text('b'))] } })).itemId;
    ids['delta'] = (await publishItem(pool, { slug: 'delta', officeId: office, title: 'Delta notes', editionId: ed, body: { blocks: [paragraph(text('d'))] } })).itemId;
    ids['charlie'] = (await publishItem(pool, { slug: 'thanks', officeId: office, title: 'Charlie Quinn thanks', editionId: ed, body: { blocks: [paragraph(text('c'))] } })).itemId;
    ids['series'] = await insertId(pool, `INSERT INTO event_series (slug, title, category, recurrence, starts_on, default_start, area, description) VALUES ('coffee', 'Coffee', 'other', 'FREQ=MONTHLY;BYDAY=3SU', '2026-01-18', '10:00', 'bay', 'Call John Smith') RETURNING id`);
    const policy = api.client(RedactionPolicyService);
    const mark = (kind: MarkSubjectKind, id: string, field: MarkField, quote: string) => policy.addRedactionMark({ subjectKind: kind, subjectId: id, field, quote, category: RedactionCategory.MEMBER_NAME }, OFFICER);
    await mark(MarkSubjectKind.CONTENT_ITEM, ids['slug'], MarkField.TITLE, 'John Smith');
    await mark(MarkSubjectKind.CONTENT_ITEM, ids['slug'], MarkField.BODY, 'Ann');
    await mark(MarkSubjectKind.CONTENT_ITEM, ids['nfd'], MarkField.TITLE, 'José Núñez');
    await mark(MarkSubjectKind.CONTENT_ITEM, ids['charlie'], MarkField.TITLE, 'Charlie Quinn');
    await mark(MarkSubjectKind.EVENT_SERIES, ids['series'], MarkField.DESCRIPTION, 'John Smith');
  });
  afterAll(async () => { await api?.close(); });

  it('A1 slug: the public never gets the marked name in the item slug', async () => {
    const out = dump(await api.client(ContentService).listPublishedItems({ pageSize: 50 }));
    expect(out).toContain('Picnic with [withheld]'); // control: the title IS redacted
    expect(out).not.toMatch(/john-smith/);
  });
  it('A2 substring via the public API: no "[withheld]ual"', async () => {
    const out = dump(await api.client(ContentService).getPublishedItem({ slug: ids['slug'] as string }));
    expect(out).not.toContain('[withheld]ual');
  });
  it('A3 NFD title, NFC mark: the public title is withheld', async () => {
    const out = dump(await api.client(ContentService).getPublishedItem({ slug: ids['nfd'] as string }));
    expect(out.normalize('NFC')).not.toContain('José Núñez');
  });
  it('A4 print order: the public export does not place a withheld title by its hidden text', async () => {
    const ex = await api.client(NewsletterService).exportEdition({ editionId: ids['edition'] as string, audience: Audience.PUBLIC }, as('agent-token'));
    const j = ex.contentJson;
    const b = j.indexOf('Bravo notes'), c = j.indexOf('[withheld] thanks'), d = j.indexOf('Delta notes');
    expect([b, c, d].every((n) => n >= 0)).toBe(true);
    expect(b < c && c < d).toBe(false);
  });
  it('A5 one editor evades a series mark with a soft hyphen (no four-eyes)', async () => {
    await api.pool.query(`UPDATE event_series SET description = 'Call John Sm­ith' WHERE id = $1`, [ids['series']]);
    const out = dump(await api.client(EventService).listSeries({}));
    expect(out.replace(/­/g, '')).not.toContain('John Smith');
  });
  it('A6 officers audience REDACTS member_name: bodyMarkup and history hashes must not carry it', async () => {
    const { pool } = api;
    const v2 = await insertId(pool, `INSERT INTO content_version (item_id, n, title, visibility, body_ast, body_src, created_by_sub, acting_office_id)
       VALUES ($1, 2, 'Picnic with John Smith', 'public', $2, '**John** Smith hosts', 'sub-author', $3) RETURNING id`,
      [ids['slug'], JSON.stringify({ blocks: [paragraph(text('John Smith hosts'))] }), ids['office']]);
    await pool.query(`UPDATE content_item SET working_version_id = $2 WHERE id = $1`, [ids['slug'], v2]);
    await pool.query(`INSERT INTO audit_event (actor_kind, actor_sub, action, subject_kind, subject_id, item_id, version_id, content_hash)
       VALUES ('user', 'sub-pub', 'ready', 'content_version', $2::text, $1, $2::uuid, $3)`, [ids['slug'], v2, createHash('sha256').update('x').digest()]);
    await api.client(RedactionPolicyService).proposeRedactionChange({ audience: RedactionAudience.OFFICERS, category: RedactionCategory.MEMBER_NAME, action: RedactionAction.REDACT }, OFFICER);
    const item = dump(await api.client(ContentService).getWorkingItem({ itemId: ids['slug'] as string }, OFFICER));
    expect(item).toContain('Picnic with [withheld]'); // control
    expect.soft(item).not.toMatch(/John\*\*\s+Smith/);
    const hist = await api.client(ContentService).listItemHistory({ itemId: ids['slug'] as string }, OFFICER);
    expect(hist.entries.length).toBeGreaterThan(0);
    expect.soft(hist.entries.filter((e) => e.contentHash.length > 0)).toEqual([]);
  });
  it('A7 spoofed audiences read as public and cannot list marks', async () => {
    const callers = [
      ...Object.keys(EXTRA).filter((k) => k !== 'agentoff-token').map(tok),
      { headers: { 'x-audience': 'officers', 'x-forwarded-groups': 'nwfl-officers', 'x-nwfl-audience': 'members', 'l5d-client-id': 'officer.nwfl.serviceaccount.identity.linkerd.cluster.local' } },
    ];
    for (const c of callers) {
      const out = dump(await api.client(ContentService).getPublishedItem({ slug: ids['charlie'] as string }, c));
      expect(out, JSON.stringify(c)).not.toContain('Charlie Quinn');
      const err = await api.client(RedactionPolicyService).listRedactionMarks({ subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: ids['charlie'] as string }, c).then(() => undefined, (e: unknown) => ConnectError.from(e).code);
      expect([Code.PermissionDenied, Code.Unauthenticated], JSON.stringify(c)).toContain(err);
      const add = await api.client(RedactionPolicyService).proposeMarkRemoval({ markId: '00000000-0000-0000-0000-000000000000' }, c).then(() => undefined, (e: unknown) => ConnectError.from(e).code);
      expect([Code.PermissionDenied, Code.Unauthenticated], JSON.stringify(c)).toContain(add);
    }
    const agent = await api.client(RedactionPolicyService).listRedactionMarks({ subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: ids['charlie'] as string }, tok('agentoff-token')).then(() => undefined, (e: unknown) => ConnectError.from(e).code);
    expect([Code.PermissionDenied, Code.Unauthenticated]).toContain(agent);
    const ex = await api.client(NewsletterService).exportEdition({ editionId: ids['edition'] as string, audience: 3 as Audience }, tok('agentoff-token')).then((r) => r.contentJson, (e: unknown) => ConnectError.from(e).code);
    expect(String(ex)).not.toContain('Charlie Quinn');
  });
});
describe.skipIf(!live)('A8 personal fields', () => {
  it('a member home name and street never reach the public even when private_venue is loosened to SHOW', async () => {
    const api = await startApi('nwfl_a8', { verifier });
    try {
      const host = await insertId(api.pool, `INSERT INTO office (slug, title, kind, role_alias, role_alias_verified_on) VALUES ('hospitality', 'Hospitality', 'appointed', 'hospitality@nwflorida.us', '2026-10-01') RETURNING id`);
      const home = await insertId(api.pool, `INSERT INTO venue (kind, name, area, host_office_id) VALUES ('member_home', 'Canary Home 123 Elm St', 'okaloosa', $1) RETURNING id`, [host]);
      await api.pool.query(`INSERT INTO event_occurrence (title, starts_at, visibility, venue_id, owner_office_id) VALUES ('Potluck', '2026-11-21T23:00:00Z', 'public', $1, $2)`, [home, host]);
      const p = api.client(RedactionPolicyService);
      const ch = await p.proposeRedactionChange({ audience: RedactionAudience.PUBLIC, category: RedactionCategory.PRIVATE_VENUE, action: RedactionAction.SHOW }, OFFICER);
      await p.approveRedactionChange({ changeId: ch.change!.changeId }, as('pub-token'));
      const ev = api.client(EventService);
      const out = dump(await ev.listVenues({})) + dump(await ev.listOccurrences({ from: { year: 2026, month: 11, day: 1 }, to: { year: 2026, month: 11, day: 30 } }));
      expect(out).toContain('hospitality'.length ? host : '');
      expect(out).not.toContain('Elm St');
    } finally { await api.close(); }
  });
});
// M2 (an un-annotated read RPC) needed a planted SearchItems RPC; the leak contract's write allowlist test covers it (S1).
