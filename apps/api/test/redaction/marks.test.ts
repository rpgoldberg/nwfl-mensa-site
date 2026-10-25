// REDACT R2a: redaction marks (0014) and their RPCs. An officer, or the
// person who wrote an item, marks a passage or the whole item; that applies at
// once. Removing a mark needs a second, different officer, and the database
// holds that: the app role cannot write either table, only 0014's SECURITY
// DEFINER functions can, and the history cannot be rewritten by anyone.
// Every person here is made up.
import { createHash } from 'node:crypto';
import { type Client, Code } from '@connectrpc/connect';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create, toBinary } from '@bufbuild/protobuf';
import { ContentService, GetPublishedItemRequestSchema } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { h2Request } from '../helpers/h2.js';
import { EventService } from '../../src/gen/nwfl/mensa/v1/event_pb.js';
import {
  MarkField,
  MarkStatus,
  MarkSubjectKind,
  RedactionAction,
  RedactionAudience,
  RedactionCategory as Category,
  RedactionPolicyService,
} from '../../src/gen/nwfl/mensa/v1/redaction_pb.js';
import { type Api, MEMBER, OFFICER, as, dump, insertId, startApi } from '../helpers/api.js';
import { paragraph, publishItem, text } from '../helpers/content.js';
import { WITHHELD } from '../../src/redaction/render.js';
import { live, sqlstate, url } from '../helpers/pg.js';

const SECOND = as('pub-token');
const PHONE = '850-555-0142';
const RANGE = { from: { year: 2026, month: 10, day: 22 }, to: { year: 2026, month: 12, day: 31 } };

describe.skipIf(!live)('redaction marks', () => {
  let api: Api;
  let marks: Client<typeof RedactionPolicyService>;
  let office: string;
  let item: string;
  let event: string;
  let series: string;

  /** The same database as the superuser: bypasses grants, but not triggers. */
  const asOwner = async <T>(fn: (client: pg.Client) => Promise<T>): Promise<T> => {
    const target = new URL(url as string);
    target.pathname = new URL((api.pool as unknown as { options: { connectionString: string } }).options.connectionString).pathname;
    const client = new pg.Client({ connectionString: target.toString() });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  };
  const publicBody = async (slug: string) => dump(await api.client(ContentService).getPublishedItem({ slug }));
  /** GetPublishedItem as the public, raw: status, headers but the date, trailers and body. */
  const raw = async (asked: string) => {
    const message = toBinary(GetPublishedItemRequestSchema, create(GetPublishedItemRequestSchema, { slug: asked }));
    const frame = Buffer.concat([Buffer.from([0, 0, 0, 0, message.length]), Buffer.from(message)]);
    const response = await h2Request(
      api.baseUrl,
      { ':method': 'POST', ':path': '/nwfl.mensa.v1.ContentService/GetPublishedItem', 'content-type': 'application/grpc', te: 'trailers' },
      frame,
    );
    // The date header is the clock, not the answer.
    const headers = Object.fromEntries(Object.entries(response.headers).filter(([name]) => name !== 'date'));
    return JSON.stringify({ status: response.status, headers, trailers: response.trailers, body: response.body.toString('hex') });
  };
  const add = (quote: string, options: { subject?: string; kind?: MarkSubjectKind; field?: MarkField; category?: Category } = {}, who = OFFICER) =>
    marks.addRedactionMark(
      {
        subjectKind: options.kind ?? MarkSubjectKind.CONTENT_ITEM,
        subjectId: options.subject ?? item,
        field: options.field ?? (quote === '' ? MarkField.UNSPECIFIED : MarkField.BODY),
        quote,
        category: options.category ?? Category.MEMBER_PHONE,
      },
      who,
    );

  beforeAll(async () => {
    api = await startApi('nwfl_marks');
    marks = api.client(RedactionPolicyService);
    office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
    item = (await publishItem(api.pool, { slug: 'ride-share', officeId: office, title: 'Ride share', body: { blocks: [paragraph(text(`Call ${PHONE} for a ride`))] } })).itemId;
    event = await insertId(api.pool, `INSERT INTO event_occurrence (title, starts_at, visibility, detail) VALUES ('Games night', '2026-11-06T23:00:00Z', 'public', $1) RETURNING id`, [
      `Text ${PHONE} if late`,
    ]);
    series = await insertId(
      api.pool,
      `INSERT INTO event_series (slug, title, category, recurrence, starts_on, area, description) VALUES ('coffee', 'Coffee', 'other', 'FREQ=MONTHLY;BYDAY=1SU', '2026-01-04', 'bay', 'Ask for Pat Example') RETURNING id`,
    );
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('the database: the app role writes marks only through 0014', () => {
    it('refuses the app role any direct INSERT, UPDATE or DELETE on both tables', async () => {
      const added = await add(PHONE);
      const id = added.mark?.markId as string;
      expect(await sqlstate(api.pool as unknown as pg.Client, `INSERT INTO redaction_mark (content_item_id, field, quote, category, created_by_sub) VALUES ($1, 'body', 'xyz', 'member_name', 'sub-x')`, [item])).toBe('42501');
      expect(await sqlstate(api.pool as unknown as pg.Client, `UPDATE redaction_mark SET status = 'removed', removed_at = now() WHERE id = $1`, [id])).toBe('42501');
      expect(await sqlstate(api.pool as unknown as pg.Client, `DELETE FROM redaction_mark WHERE id = $1`, [id])).toBe('42501');
      expect(await sqlstate(api.pool as unknown as pg.Client, `INSERT INTO redaction_mark_removal (mark_id, status, proposed_by_sub, approved_by_sub, approved_at) VALUES ($1, 'applied', 'a', 'b', now())`, [id])).toBe('42501');
      expect(await sqlstate(api.pool as unknown as pg.Client, `UPDATE redaction_mark_removal SET status = 'applied'`)).toBe('42501');
      expect(await sqlstate(api.pool as unknown as pg.Client, `DELETE FROM redaction_mark_removal`)).toBe('42501');
      expect(await sqlstate(api.pool as unknown as pg.Client, `SELECT count(*) FROM redaction_mark`)).toBe('ok');
    });

    it('freezes the history for every role, the owner included', async () => {
      const id = (await add('for a ride', { category: Category.MEMBER_NAME })).mark?.markId as string;
      await asOwner(async (owner) => {
        // Removed without an approved removal.
        expect(await sqlstate(owner, `UPDATE redaction_mark SET status = 'removed', removed_at = now() WHERE id = $1`, [id])).toBe('55000');
        expect(await sqlstate(owner, `UPDATE redaction_mark SET quote = 'something else' WHERE id = $1`, [id])).toBe('55000');
        expect(await sqlstate(owner, `UPDATE redaction_mark SET category = 'business_venue' WHERE id = $1`, [id])).toBe('55000');
        expect(await sqlstate(owner, `DELETE FROM redaction_mark WHERE id = $1`, [id])).toBe('55000');
        // A removal is born pending.
        expect(await sqlstate(owner, `INSERT INTO redaction_mark_removal (mark_id, status, proposed_by_sub, approved_by_sub, approved_at) VALUES ($1, 'applied', 'a', 'b', now())`, [id])).toBe('55000');
        // A mark is born active.
        expect(await sqlstate(owner, `INSERT INTO redaction_mark (content_item_id, field, quote, category, status, removed_at, created_by_sub) VALUES ($1, 'body', 'xyz', 'member_name', 'removed', now(), 'a')`, [item])).toBe('55000');
      });
      const removal = await marks.proposeMarkRemoval({ markId: id }, OFFICER);
      await asOwner(async (owner) => {
        expect(await sqlstate(owner, `UPDATE redaction_mark_removal SET proposed_by_sub = 'someone' WHERE id = $1`, [removal.removal?.removalId])).toBe('55000');
        expect(await sqlstate(owner, `DELETE FROM redaction_mark_removal WHERE id = $1`, [removal.removal?.removalId])).toBe('55000');
      });
      await marks.approveMarkRemoval({ removalId: removal.removal?.removalId as string }, SECOND);
      await asOwner(async (owner) => {
        expect(await sqlstate(owner, `UPDATE redaction_mark SET status = 'active', removed_at = NULL WHERE id = $1`, [id])).toBe('55000');
        expect(await sqlstate(owner, `UPDATE redaction_mark_removal SET status = 'pending', approved_by_sub = NULL, approved_at = NULL WHERE id = $1`, [removal.removal?.removalId])).toBe('55000');
      });
    });

    it('holds four-eyes and the officer rule in the functions themselves, called as the app role', async () => {
      const db = api.pool;
      const id = (await add('Call', { category: Category.MEMBER_NAME })).mark?.markId as string;
      // Not an officer: no removal proposal.
      expect(await sqlstate(db as unknown as pg.Client, `SELECT redaction_mark_propose_removal($1, 'sub-member', ARRAY['nwfl-members'], NULL)`, [id])).toBe('42501');
      const proposed = await db.query<{ id: string }>(`SELECT (redaction_mark_propose_removal($1, 'sub-a', ARRAY['nwfl-officers'], NULL)).id`, [id]);
      const removalId = proposed.rows[0]?.id as string;
      // Its proposer cannot approve it; nor can someone who is not an officer.
      expect(await sqlstate(db as unknown as pg.Client, `SELECT redaction_mark_approve_removal($1, 'sub-a', ARRAY['nwfl-officers'], NULL)`, [removalId])).toBe('42501');
      expect(await sqlstate(db as unknown as pg.Client, `SELECT redaction_mark_approve_removal($1, 'sub-b', ARRAY['nwfl-members'], NULL)`, [removalId])).toBe('42501');
      expect(await sqlstate(db as unknown as pg.Client, `SELECT redaction_mark_approve_removal($1, '', ARRAY['nwfl-officers'], NULL)`, [removalId])).toBe('42501');
      // A second waiting removal of the same mark.
      expect(await sqlstate(db as unknown as pg.Client, `SELECT redaction_mark_propose_removal($1, 'sub-c', ARRAY['nwfl-officers'], NULL)`, [id])).toBe('55000');
      expect(await sqlstate(db as unknown as pg.Client, `SELECT redaction_mark_approve_removal($1, 'sub-b', ARRAY['nwfl-officers'], NULL)`, [removalId])).toBe('ok');
      // Decided once.
      expect(await sqlstate(db as unknown as pg.Client, `SELECT redaction_mark_approve_removal($1, 'sub-c', ARRAY['nwfl-officers'], NULL)`, [removalId])).toBe('55000');
      expect(await sqlstate(db as unknown as pg.Client, `SELECT redaction_mark_propose_removal($1, 'sub-c', ARRAY['nwfl-officers'], NULL)`, [id])).toBe('55000');
      const { rows } = await db.query(`SELECT status FROM redaction_mark WHERE id = $1`, [id]);
      expect(rows[0]).toEqual({ status: 'removed' });
    });

    it('lets exactly one of four racing approvals, and one of four racing proposals, through', async () => {
      const id = (await add('Call 850-555', { category: Category.MEMBER_NAME })).mark?.markId as string;
      const settle = (calls: Array<Promise<unknown>>) => Promise.allSettled(calls).then((all) => all.filter((r) => r.status === 'fulfilled').length);
      const proposals = await settle(['p1', 'p2', 'p3', 'p4'].map((sub) => api.pool.query(`SELECT redaction_mark_propose_removal($1, $2, ARRAY['nwfl-officers'], NULL)`, [id, sub])));
      expect(proposals).toBe(1);
      const { rows } = await api.pool.query<{ id: string }>(`SELECT id FROM redaction_mark_removal WHERE mark_id = $1`, [id]);
      expect(rows).toHaveLength(1);
      const approvals = await settle(['a1', 'a2', 'a3', 'a4'].map((sub) => api.pool.query(`SELECT redaction_mark_approve_removal($1, $2, ARRAY['nwfl-officers'], NULL)`, [rows[0]?.id, sub])));
      expect(approvals).toBe(1);
      const audit = await api.pool.query(`SELECT 1 FROM audit_event WHERE action = 'redaction_mark_approve_removal' AND subject_id = $1`, [rows[0]?.id]);
      expect(audit.rows).toHaveLength(1);
    });

    it('lets a non-officer add a mark only to an item they wrote, and never to an event', async () => {
      const db = api.pool as unknown as pg.Client;
      const call = `SELECT redaction_mark_add($1, $2, 'body', 'a ride', 'member_name', $3, $4, NULL)`;
      expect(await sqlstate(db, call, ['content_item', item, 'sub-stranger', ['nwfl-members']])).toBe('42501');
      expect(await sqlstate(db, call.replace("'body'", "'detail'"), ['event_occurrence', event, 'sub-author', ['nwfl-members']])).toBe('42501');
      // publishItem writes its versions as sub-author.
      expect(await sqlstate(db, call, ['content_item', item, 'sub-author', ['nwfl-members']])).toBe('ok');
      expect(await sqlstate(db, call, ['content_item', item, '', ['nwfl-officers']])).toBe('42501');
      expect(await sqlstate(db, call, ['venue', item, 'sub-a', ['nwfl-officers']])).toBe('22023');
    });

    it('audits every add, proposal and approval, without the marked text', async () => {
      const added = await add('Call 850', { category: Category.MEMBER_PHONE });
      const id = added.mark?.markId as string;
      const removal = await marks.proposeMarkRemoval({ markId: id }, OFFICER);
      await marks.approveMarkRemoval({ removalId: removal.removal?.removalId as string }, SECOND);
      const { rows } = await api.pool.query<{ action: string; actor_sub: string; payload: unknown }>(
        `SELECT action, actor_sub, payload FROM audit_event WHERE subject_id IN ($1, $2) ORDER BY id`,
        [id, removal.removal?.removalId],
      );
      expect(rows.map((row) => [row.action, row.actor_sub])).toEqual([
        ['redaction_mark_add', 'sub-officer'],
        ['redaction_mark_propose_removal', 'sub-officer'],
        ['redaction_mark_approve_removal', 'sub-pub'],
      ]);
      expect(JSON.stringify(rows)).not.toContain('Call 850');
    });
  });

  describe('the RPCs', () => {
    it('applies a new mark at once, keeps it through a waiting removal, and lifts it only on a second officer’s approval', async () => {
      const slug = 'carpool';
      const carpool = (await publishItem(api.pool, { slug, officeId: office, title: 'Carpool', body: { blocks: [paragraph(text('Ring 850-555-0199 first'))] } })).itemId;
      expect(await publicBody(slug)).toContain('850-555-0199');
      const added = await add('850-555-0199', { subject: carpool });
      expect(added.mark).toMatchObject({ status: MarkStatus.ACTIVE, quote: '850-555-0199', field: MarkField.BODY, createdBy: 'sub-officer' });
      // While the mark applies, the public reaches the item by its id, never by its slug (B2).
      expect(await publicBody(carpool)).not.toContain('850-555-0199');
      expect(await publicBody(carpool)).toContain('[withheld]');
      await expect(api.client(ContentService).getPublishedItem({ slug })).rejects.toMatchObject({ code: Code.NotFound });
      expect(dump(await api.client(ContentService).getPublishedItem({ slug }, MEMBER))).toContain('850-555-0199');

      const removal = await marks.proposeMarkRemoval({ markId: added.mark?.markId as string }, OFFICER);
      expect(removal.removal).toMatchObject({ applied: false, proposedBy: 'sub-officer' });
      expect(await publicBody(carpool)).not.toContain('850-555-0199');
      const listed = await marks.listRedactionMarks({ subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: carpool }, OFFICER);
      expect(listed.marks).toEqual([expect.objectContaining({ pendingRemovalId: removal.removal?.removalId, removalProposedBy: 'sub-officer' })]);

      await expect(marks.approveMarkRemoval({ removalId: removal.removal?.removalId as string }, OFFICER)).rejects.toMatchObject({ code: Code.PermissionDenied });
      const approved = await marks.approveMarkRemoval({ removalId: removal.removal?.removalId as string }, SECOND);
      expect(approved.removal).toMatchObject({ applied: true, approvedBy: 'sub-pub' });
      expect(await publicBody(slug)).toContain('850-555-0199');
      const after = await marks.listRedactionMarks({ subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: carpool }, OFFICER);
      expect(after.marks.map((mark) => mark.status)).toEqual([MarkStatus.REMOVED]);
      await expect(marks.approveMarkRemoval({ removalId: removal.removal?.removalId as string }, as('admin-token'))).rejects.toMatchObject({ code: Code.FailedPrecondition });
      await expect(marks.proposeMarkRemoval({ markId: added.mark?.markId as string }, OFFICER)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    });

    it('drops a whole-item mark’s item for the public and keeps it for members', async () => {
      const slug = 'memorial';
      const memorial = (await publishItem(api.pool, { slug, officeId: office, title: 'In memory', body: { blocks: [paragraph(text('A friend'))] } })).itemId;
      await add('', { subject: memorial, category: Category.MEMBER_NAME });
      await expect(api.client(ContentService).getPublishedItem({ slug })).rejects.toMatchObject({ code: Code.NotFound });
      expect(dump(await api.client(ContentService).listPublishedItems({ pageSize: 50 }))).not.toContain(memorial);
      expect(dump(await api.client(ContentService).getPublishedItem({ slug }, MEMBER))).toContain('A friend');
    });

    it('marks events: a stored occurrence and a series', async () => {
      await add(PHONE, { kind: MarkSubjectKind.EVENT_OCCURRENCE, subject: event, field: MarkField.DETAIL });
      await add('Pat Example', { kind: MarkSubjectKind.EVENT_SERIES, subject: series, field: MarkField.DESCRIPTION, category: Category.MEMBER_NAME });
      const events = api.client(EventService);
      const anonymous = dump(await events.listOccurrences(RANGE)) + dump(await events.getOccurrence({ id: event })) + dump(await events.listSeries({}));
      expect(anonymous).not.toContain(PHONE);
      expect(anonymous).not.toContain('Pat Example');
      expect(anonymous).toContain('Games night');
      const member = dump(await events.getOccurrence({ id: event }, MEMBER)) + dump(await events.listSeries({}, MEMBER));
      expect(member).toContain(PHONE);
      expect(member).toContain('Pat Example');
    });

    it('lets the item’s writer mark it, and no other non-officer', async () => {
      await expect(add('a ride', {}, MEMBER)).rejects.toMatchObject({ code: Code.PermissionDenied });
      const own = (await publishItem(api.pool, { slug: 'own-item', officeId: office, title: 'Mine', body: { blocks: [paragraph(text('my number 850-555-0177'))] } })).itemId;
      // A second version, written by the member: the item's writers are its versions' authors.
      await api.pool.query(
        `INSERT INTO content_version (item_id, n, title, created_by_sub, acting_office_id) VALUES ($1, 2, 'Mine', 'sub-member', $2)`,
        [own, office],
      );
      const added = await add('850-555-0177', { subject: own }, MEMBER);
      expect(added.mark?.createdBy).toBe('sub-member');
      await expect(add(PHONE, { kind: MarkSubjectKind.EVENT_OCCURRENCE, subject: event, field: MarkField.DETAIL }, MEMBER)).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(marks.proposeMarkRemoval({ markId: added.mark?.markId as string }, MEMBER)).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(marks.listRedactionMarks({ subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: own }, MEMBER)).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(marks.listRedactionMarks({ subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: own })).rejects.toMatchObject({ code: Code.Unauthenticated });
    });

    it('fails closed: a mark that matches nowhere withholds the whole item from an audience that redacts it, until it is removed by two officers', async () => {
      const events = api.client(EventService);
      const lunch = await insertId(
        api.pool,
        `INSERT INTO event_series (slug, title, category, recurrence, starts_on, area, description) VALUES ('tea', 'Tea', 'other', 'FREQ=MONTHLY;BYDAY=2SU', '2026-01-11', 'bay', 'Pour: Robin Example') RETURNING id`,
      );
      const added = await add('Robin Example', { kind: MarkSubjectKind.EVENT_SERIES, subject: lunch, field: MarkField.DESCRIPTION, category: Category.MEMBER_NAME });
      expect(dump(await events.listSeries({}))).toContain('Pour: [withheld]');
      // One editor rewrites the name so the mark no longer finds it.
      await api.pool.query(`UPDATE event_series SET description = 'Pour: R0bin Exampl3' WHERE id = $1`, [lunch]);
      expect(dump(await events.listSeries({}))).not.toContain(lunch);
      expect(dump(await events.listSeries({}, MEMBER))).toContain('R0bin Exampl3');
      // A mark whose text was never there hides a content item the same way.
      const slug = 'never-there';
      const item = (await publishItem(api.pool, { slug, officeId: office, title: 'Plain', body: { blocks: [paragraph(text('Nothing to see'))] } })).itemId;
      await add('Nobody Here', { subject: item, category: Category.MEMBER_NAME });
      await expect(api.client(ContentService).getPublishedItem({ slug })).rejects.toMatchObject({ code: Code.NotFound });
      expect(dump(await api.client(ContentService).getPublishedItem({ slug }, MEMBER))).toContain('Nothing to see');
      // Lifted only by a second officer.
      const removal = await marks.proposeMarkRemoval({ markId: added.mark?.markId as string }, OFFICER);
      expect(dump(await events.listSeries({}))).not.toContain(lunch);
      await marks.approveMarkRemoval({ removalId: removal.removal?.removalId as string }, SECOND);
      expect(dump(await events.listSeries({}))).toContain(lunch);
    });

    it('gives an audience that does not see a marked title the item id, never the slug, and finds the item by its id', async () => {
      const slug = 'lunch-with-robin-example';
      const lunch = (await publishItem(api.pool, { slug, officeId: office, title: 'Lunch with Robin Example', body: { blocks: [paragraph(text('Noon'))] } })).itemId;
      await add('Robin Example', { subject: lunch, field: MarkField.TITLE, category: Category.MEMBER_NAME });
      const content = api.client(ContentService);
      const listed = dump(await content.listPublishedItems({ pageSize: 50 }));
      expect(listed).not.toMatch(/robin-example/);
      expect(listed).toContain(lunch);
      // Asked for by its slug, it is not there for this audience: the slug is no oracle.
      await expect(content.getPublishedItem({ slug })).rejects.toMatchObject({ code: Code.NotFound });
      const byId = await content.getPublishedItem({ slug: lunch });
      expect(byId.item).toMatchObject({ slug: lunch, live: { title: 'Lunch with [withheld]' } });
      expect((await content.getPublishedItem({ slug }, MEMBER)).item?.slug).toBe(slug);
      // A series' slug the same way.
      const series = await insertId(
        api.pool,
        `INSERT INTO event_series (slug, title, category, recurrence, starts_on, area) VALUES ('walk-with-robin-example', 'Walk with Robin Example', 'other', 'FREQ=MONTHLY;BYDAY=4SU', '2026-01-25', 'bay') RETURNING id`,
      );
      await add('Robin Example', { kind: MarkSubjectKind.EVENT_SERIES, subject: series, field: MarkField.TITLE, category: Category.MEMBER_NAME });
      const anonymous = dump(await api.client(EventService).listSeries({}));
      expect(anonymous).not.toMatch(/robin-example/);
      expect(anonymous).toContain('Walk with [withheld]');
    });

    it('answers a withheld slug byte for byte as a slug that never existed, for the public', async () => {
      const slug = 'supper-with-robin-example';
      await add('Robin Example', {
        subject: (await publishItem(api.pool, { slug, officeId: office, title: 'Supper with Robin Example', body: { blocks: [paragraph(text('Six'))] } })).itemId,
        field: MarkField.TITLE,
        category: Category.MEMBER_NAME,
      });
      const withheld = await raw(slug);
      expect(withheld).toContain('"grpc-message":"item%20not%20found","grpc-status":"5"');
      expect(withheld).toBe(await raw('supper-that-never-was'));
    });

    it('holds a member to the members policy the same way: a slug whose title a member may not see is not found', async () => {
      const slug = 'party-at-12-example-lane';
      const party = (await publishItem(api.pool, { slug, officeId: office, title: 'Party at 12 Example Lane', body: { blocks: [paragraph(text('Bring a dish'))] } })).itemId;
      await add('12 Example Lane', { subject: party, field: MarkField.TITLE, category: Category.MEMBER_ADDRESS });
      const content = api.client(ContentService);
      await expect(content.getPublishedItem({ slug }, MEMBER)).rejects.toMatchObject({ code: Code.NotFound, rawMessage: 'item not found' });
      expect((await content.getPublishedItem({ slug: party }, MEMBER)).item).toMatchObject({ slug: party, live: { title: 'Party at [withheld]' } });
      // Officers see addresses (the default), so the slug is theirs to use.
      expect((await content.getPublishedItem({ slug }, OFFICER)).item?.slug).toBe(slug);
    });

    it('never gives the public the slug of an item with a withheld passage anywhere, though the slug spells the name without its accents (B2)', async () => {
      const slug = 'memorial-jose-nunez';
      const memorial = (await publishItem(api.pool, { slug, officeId: office, title: 'In memoriam', body: { blocks: [paragraph(text('We remember José Núñez.'))] } })).itemId;
      await add('José Núñez', { subject: memorial, category: Category.MEMBER_NAME });
      const content = api.client(ContentService);
      const listed = dump(await content.listPublishedItems({ pageSize: 50 }));
      expect(listed).toContain('In memoriam');
      expect(listed).toContain(memorial);
      expect(listed).not.toContain(slug);
      // By the slug, exactly as a slug that never existed; by the id, found and redacted.
      const withheld = await raw(slug);
      expect(withheld).toContain('"grpc-message":"item%20not%20found","grpc-status":"5"');
      expect(withheld).toBe(await raw('memorial-that-never-was'));
      const byId = dump(await content.getPublishedItem({ slug: memorial }));
      expect(byId).toContain(`We remember ${WITHHELD}.`);
      expect(byId).not.toContain(slug);
      // Members see names (the default): the slug is theirs.
      expect((await content.getPublishedItem({ slug }, MEMBER)).item?.slug).toBe(slug);
      // A series the same way, the mark in its description.
      const walk = await insertId(
        api.pool,
        `INSERT INTO event_series (slug, title, category, recurrence, starts_on, area, description) VALUES ('memorial-walk-jose-nunez', 'Memorial walk', 'other', 'FREQ=MONTHLY;BYDAY=3SA', '2026-01-17', 'bay', 'For José Núñez') RETURNING id`,
      );
      await add('José Núñez', { kind: MarkSubjectKind.EVENT_SERIES, subject: walk, field: MarkField.DESCRIPTION, category: Category.MEMBER_NAME });
      const series = dump(await api.client(EventService).listSeries({}));
      expect(series).toContain(walk);
      expect(series).toContain(`For ${WITHHELD}`);
      expect(series).not.toContain('memorial-walk-jose-nunez');
      expect(dump(await api.client(EventService).listSeries({}, MEMBER))).toContain('memorial-walk-jose-nunez');
    });

    it('refuses a malformed mark', async () => {
      const bad: Array<[string, Parameters<typeof add>]> = [
        ['a quote too short', ['ab']],
        ['a quote that is only spaces', ['     ']],
        ['a field the subject does not have', [PHONE, { field: MarkField.DETAIL }]],
        ['a passage with no field', [PHONE, { field: MarkField.UNSPECIFIED }]],
        ['a whole-item mark with a field', ['', { field: MarkField.BODY }]],
        ['an image category', [PHONE, { category: Category.IMAGE }]],
        ['no category', [PHONE, { category: Category.UNSPECIFIED }]],
        ['no subject kind', [PHONE, { kind: MarkSubjectKind.UNSPECIFIED }]],
        ['a subject that is not an id', [PHONE, { subject: 'ride-share' }]],
      ];
      for (const [why, args] of bad) await expect(add(...args), why).rejects.toMatchObject({ code: Code.InvalidArgument });
      await expect(add(PHONE, { subject: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({ code: Code.NotFound });
      await expect(marks.proposeMarkRemoval({ markId: 'nope' }, OFFICER)).rejects.toMatchObject({ code: Code.InvalidArgument });
      await expect(marks.proposeMarkRemoval({ markId: '00000000-0000-4000-8000-000000000000' }, OFFICER)).rejects.toMatchObject({ code: Code.NotFound });
      await expect(marks.approveMarkRemoval({ removalId: 'nope' }, OFFICER)).rejects.toMatchObject({ code: Code.InvalidArgument });
      await expect(marks.approveMarkRemoval({ removalId: '00000000-0000-4000-8000-000000000000' }, OFFICER)).rejects.toMatchObject({ code: Code.NotFound });
      await expect(marks.listRedactionMarks({ subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: 'nope' }, OFFICER)).rejects.toMatchObject({ code: Code.InvalidArgument });
      await expect(marks.listRedactionMarks({ subjectKind: MarkSubjectKind.UNSPECIFIED, subjectId: item }, OFFICER)).rejects.toMatchObject({ code: Code.InvalidArgument });
    });

    it('trims the quote it stores', async () => {
      const added = await add('  for a ride  ', { category: Category.MEMBER_NAME });
      expect(added.mark?.quote).toBe('for a ride');
    });
  });
});

// S2: one mark, the officers' policy tightened to redact names. The markup can split a name with its
// own syntax (Jo**hn** Smith), where the lens cannot find it, and a hash covers what was withheld:
// both are left out.
describe.skipIf(!live)('an officer who may not see a name (S2)', () => {
  let api: Api;
  afterAll(async () => {
    await api?.close();
  });

  it('gets no markup and no hash for an item with one marked name, live or working, nor in its history', async () => {
    const MARKUP = 'Jo**hn** Smith and **John** Smith host';
    api = await startApi('nwfl_marks_s2');
    const office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
    const picnic = (await publishItem(api.pool, { slug: 'picnic', officeId: office, title: 'Picnic with John Smith', body: { blocks: [paragraph(text('Noon at the pier'))] } })).itemId;
    const working = await insertId(
      api.pool,
      `INSERT INTO content_version (item_id, n, title, visibility, body_ast, body_src, content_hash, created_by_sub, acting_office_id)
       VALUES ($1, 2, 'Picnic with John Smith', 'public', $2, $3, $4, 'sub-author', $5) RETURNING id`,
      [picnic, JSON.stringify({ blocks: [paragraph(text('John Smith and John Smith host'))] }), MARKUP, createHash('sha256').update('v2').digest(), office],
    );
    await api.pool.query(`UPDATE content_item SET working_version_id = $2 WHERE id = $1`, [picnic, working]);
    await api.pool.query(
      `INSERT INTO audit_event (actor_kind, actor_sub, action, subject_kind, subject_id, item_id, version_id, content_hash)
       VALUES ('user', 'sub-pub', 'ready', 'content_version', $2::text, $1, $2::uuid, $3)`,
      [picnic, working, createHash('sha256').update('v2').digest()],
    );
    await api.client(RedactionPolicyService).addRedactionMark(
      { subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: picnic, field: MarkField.TITLE, quote: 'John Smith', category: Category.MEMBER_NAME },
      OFFICER,
    );
    const content = api.client(ContentService);
    // Control: before the policy changes, an officer sees the markup and the hashes.
    const before = (await content.getWorkingItem({ itemId: picnic }, OFFICER)).item;
    expect(before?.working).toMatchObject({ bodyMarkup: MARKUP });
    expect(before?.working?.contentHash.length).toBe(32);
    await api.client(RedactionPolicyService).proposeRedactionChange({ audience: RedactionAudience.OFFICERS, category: Category.MEMBER_NAME, action: RedactionAction.REDACT }, OFFICER);
    const item = (await content.getWorkingItem({ itemId: picnic }, OFFICER)).item;
    expect(item?.working?.bodyMarkup).not.toMatch(/\*\*John\*\* Smith|Jo\*\*hn\*\* Smith/);
    // The working version is shown (not dropped), redacted.
    expect(item?.working).toMatchObject({ id: working, title: `Picnic with ${WITHHELD}`, bodyMarkup: '' });
    expect(item?.live).toMatchObject({ title: `Picnic with ${WITHHELD}`, bodyMarkup: '' });
    expect(dump(item)).not.toMatch(/John\W+Smith/);
    expect(item?.working?.contentHash.length).toBe(0);
    expect(item?.live?.contentHash.length).toBe(0);
    const history = await content.listItemHistory({ itemId: picnic }, OFFICER);
    expect(history.entries.length).toBeGreaterThan(0);
    expect(history.entries.filter((entry) => entry.contentHash.length > 0)).toEqual([]);
  });
});
