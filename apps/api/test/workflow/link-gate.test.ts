// EDITOR A3b: the link gate, over gRPC against a migrated database (0030). GetItemLinks lists a
// piece's links: every link and printed URL in the working version's text, and the web addresses of
// its office's upcoming events and their venues (today to the end of the piece's edition, or the next
// 92 days without one), with a hash of the list. ConfirmLinks takes a reviewer's answers, per link,
// on a READY version they did not edit; each is kept at once, bound to the version's ready time.
// Approve waits while a link that needs a sign-in (Facebook and the like) has no yes on the version
// as it stands. Also AUDIT-FOROFFICE: the Admin's save for an office is audited as for that office.
// Every person, place and address here is made up.
import { createHash } from 'node:crypto';
import { type Client, Code, ConnectError } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentKind, ContentService, type ContentItem, type ItemLink, ItemVisibility, MachineVerdict, VersionStatus } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { type Api, as, insertId, startApi } from '../helpers/api.js';
import { MarkField, MarkSubjectKind, RedactionCategory, RedactionPolicyService } from '../../src/gen/nwfl/mensa/v1/redaction_pb.js';
import { live } from '../helpers/pg.js';

const PUB = as('pub-token');
const TREASURER = as('treasurer-token');
const OFFICER = as('officer-token');
const ADMIN = as('admin-token');
const WEBMASTER = as('webmaster-token');
const LONE_WEBMASTER = as('lone-webmaster-token');
const LONE_HOLDER = as('lone-holder-token');
const AFFILIATE = as('affiliate-token');
const MEMBER = as('member-token');

const FACEBOOK = 'https://www.facebook.com/groups/example-games';
const TEXT = 'in the text';
/** The list hash as the API documents it: SHA-256 of the JSON array of [url, where] pairs, sorted by url then where. */
const sha = (pairs: Array<[string, string]>): Uint8Array =>
  new Uint8Array(createHash('sha256').update(JSON.stringify([...pairs].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)))).digest());

/** The RPC's error code, or 'ok'. */
const codeOf = async (call: Promise<unknown>): Promise<Code | 'ok'> => {
  try {
    await call;
    return 'ok';
  } catch (error) {
    return ConnectError.from(error).code;
  }
};
const messageOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
    return 'ok';
  } catch (error) {
    return ConnectError.from(error).rawMessage;
  }
};

describe.skipIf(!live)('EDITOR A3b: the link gate', () => {
  let api: Api;
  let content: Client<typeof ContentService>;
  const offices: Record<string, string> = {};
  let november: string;
  let n = 0;

  /** An item of `office` with this body, saved by `writer`; ready unless `draft`. */
  const piece = async (body: string, options: { writer?: typeof PUB; office?: string; draft?: boolean; editionId?: string } = {}) => {
    const writer = options.writer ?? PUB;
    const item = (await content.createItem({ kind: ContentKind.ARTICLE, officeId: offices[options.office ?? 'publications'] as string, slug: `lg-${(n += 1)}`, title: 'Games night' }, writer)).item as ContentItem;
    await content.saveDraft({ itemId: item.id, title: 'Games night', summary: '', visibility: ItemVisibility.PUBLIC, bodyMarkup: body }, writer);
    if (options.draft === true) return { itemId: item.id, hash: new Uint8Array() };
    const ready = await content.markReady({ itemId: item.id, ...(options.editionId !== undefined ? { editionId: options.editionId } : {}) }, writer);
    return { itemId: item.id, hash: ready.item?.working?.contentHash as Uint8Array };
  };
  const links = (itemId: string, who = TREASURER) => content.getItemLinks({ itemId }, who);
  const confirm = async (itemId: string, answers: Array<{ url: string; yes: boolean; note?: string }>, who = TREASURER, extra: Record<string, unknown> = {}) => {
    const { linksSha256 } = await links(itemId, who);
    return content.confirmLinks({ itemId, linksSha256, answers, ...extra }, who);
  };
  const stored = async (itemId: string) =>
    (
      await api.pool.query<{ url: string; answer: string; by_sub: string; acting_office_id: string | null; bound: boolean; note: string | null }>(
        `SELECT c.url, c.answer, c.by_sub, c.acting_office_id, c.ready_at_seen = v.ready_at AS bound, c.note FROM content_link_check c JOIN content_version v ON v.id = c.version_id
         WHERE c.item_id = $1 ORDER BY c.id`,
        [itemId],
      )
    ).rows;
  const audits = async (itemId: string, action: string) =>
    (
      await api.pool.query<{ acting_office_id: string | null; payload: Record<string, unknown>; version_id: string | null; content_hash: Buffer | null }>(
        `SELECT acting_office_id, payload, version_id, content_hash FROM audit_event WHERE item_id = $1 AND action = $2 ORDER BY id`,
        [itemId, action],
      )
    ).rows;
  const row = (list: ItemLink[], url: string, where = TEXT): ItemLink | undefined => list.find((link) => link.url === url && link.where === where);

  beforeAll(async () => {
    api = await startApi('nwfl_link_gate');
    content = api.client(ContentService);
    for (const [slug, title] of [
      ['publications', 'Publications Officer'],
      ['treasurer', 'Treasurer'],
      ['president', 'President'],
      ['secretary', 'Secretary'],
    ]) {
      offices[slug as string] = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ($1, $2, 'appointed') RETURNING id`, [slug, title]);
    }
    november = await insertId(
      api.pool,
      `INSERT INTO edition (slug, title, kind, period_start, period_end, status) VALUES ('2026-11', 'November 2026', 'regular', '2026-11-01', '2026-11-30', 'collecting') RETURNING id`,
    );
    // The President's events. Today is Thursday 2026-10-22 (Central) in the API under test.
    const cafe = await insertId(api.pool, `INSERT INTO venue (kind, name, area, url) VALUES ('business', 'Corner Cafe', 'okaloosa', 'https://cafe.example.org/') RETURNING id`);
    const diner = await insertId(api.pool, `INSERT INTO venue (kind, name, area, url) VALUES ('business', 'Harbor Diner', 'okaloosa', 'https://diner.example.org/menu') RETURNING id`);
    const oneOff = `INSERT INTO event_occurrence (title, starts_at, url, detail, venue_id, visibility, owner_office_id) VALUES ($1, $2, $3, $4, $5, 'public', $6)`;
    await api.pool.query(oneOff, ['Board games night', '2026-11-05T23:00:00Z', 'https://www.facebook.com/events/1234', 'Parking map: https://parking.example.org/map.', cafe, offices['president']]);
    await api.pool.query(oneOff, ['Holiday party', '2026-12-05T23:00:00Z', 'https://december.example.org/', null, null, offices['president']]);
    await api.pool.query(oneOff, ['Last week', '2026-10-21T23:00:00Z', 'https://old.example.org/', null, null, offices['president']]);
    await api.pool.query(oneOff, ['Far off', '2027-02-10T23:00:00Z', 'https://far.example.org/', null, null, offices['president']]);
    await api.pool.query(oneOff, ['Treasurer table', '2026-11-06T23:00:00Z', 'https://other.example.org/', null, null, offices['treasurer']]);
    await api.pool.query(
      `INSERT INTO event_series (slug, title, category, recurrence, starts_on, default_start, default_venue_id, area, host_office_id)
       VALUES ('second-tuesday-lunch', 'Second Tuesday lunch', 'lunch', 'FREQ=MONTHLY;BYDAY=2TU', '2026-01-13', '11:30', $1, 'okaloosa', $2)`,
      [diner, offices['president']],
    );
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('GetItemLinks', () => {
    it('lists every link and printed URL in the text once, sorted, with its words, where it is and whether it needs a sign-in', async () => {
      const { itemId } = await piece(
        `Join [our games group](${FACEBOOK}) or see https://example.org/games.\n\n` +
          `Write to [the Publications Officer](mailto:publications@example.org). Again: [the group](${FACEBOOK}).\n\n` +
          ':members[Room code at https://zoom.example.org/j/123]',
      );
      const response = await links(itemId);
      expect(response.links.map((link) => [link.url, link.where])).toEqual([
        ['https://example.org/games', TEXT],
        [FACEBOOK, TEXT],
        ['https://zoom.example.org/j/123', TEXT],
        ['mailto:publications@example.org', TEXT],
      ]);
      expect(row(response.links, FACEBOOK)).toMatchObject({ label: 'our games group', loginWalled: true, accepted: false, answeredByLabel: '', machineVerdict: MachineVerdict.UNSPECIFIED, reasons: [], fix: '' });
      expect(row(response.links, 'https://example.org/games')).toMatchObject({ label: '', loginWalled: false });
      expect(row(response.links, 'mailto:publications@example.org')).toMatchObject({ label: 'the Publications Officer', loginWalled: false });
      expect(response.linksSha256).toEqual(sha(response.links.map((link) => [link.url, link.where])));
      // To the microsecond, as Postgres keeps it.
      const us = (
        await api.pool.query<{ us: string }>(`SELECT (extract(epoch FROM v.ready_at) * 1000000)::bigint::text AS us FROM content_item i JOIN content_version v ON v.id = i.working_version_id WHERE i.id = $1`, [
          itemId,
        ])
      ).rows[0]?.us as string;
      expect((response.readyAt?.seconds ?? 0n) * 1000000n + BigInt((response.readyAt?.nanos ?? 0) / 1000)).toBe(BigInt(us));
    });

    it('gives a draft its links with no ready time, and a piece with none an empty list', async () => {
      const draft = await piece('See https://example.org/draft.', { draft: true });
      const response = await links(draft.itemId, PUB);
      expect(response.links.map((link) => link.url)).toEqual(['https://example.org/draft']);
      expect(response.readyAt).toBeUndefined();
      const plain = await piece('Nothing to follow here.');
      expect((await links(plain.itemId)).links).toEqual([]);
      expect((await links(plain.itemId)).linksSha256).toEqual(sha([]));
    });

    it("adds the office's upcoming events and their venues: today to 92 days ahead without an edition", async () => {
      const { itemId } = await piece('The calendar is below.', { writer: ADMIN, office: 'president' });
      const list = (await links(itemId)).links;
      expect(list.map((link) => [link.url, link.where])).toEqual([
        ['https://cafe.example.org/', 'venue: Corner Cafe'],
        ['https://december.example.org/', 'event: Holiday party'],
        ['https://diner.example.org/menu', 'venue: Harbor Diner'],
        ['https://parking.example.org/map', 'event: Board games night'],
        ['https://www.facebook.com/events/1234', 'event: Board games night'],
      ]);
      expect(row(list, 'https://www.facebook.com/events/1234', 'event: Board games night')?.loginWalled).toBe(true);
    });

    it("stops the events at the end of the piece's edition period", async () => {
      const { itemId } = await piece('For November.', { writer: ADMIN, office: 'president', editionId: november });
      const urls = (await links(itemId)).links.map((link) => link.url);
      expect(urls).toContain('https://www.facebook.com/events/1234');
      expect(urls).not.toContain('https://december.example.org/');
    });

    it('lists no events for an edition whose period has ended, and none past the calendar longest range (400 days)', async () => {
      const ended = await insertId(api.pool, `INSERT INTO edition (slug, title, kind, period_start, period_end, status) VALUES ('2026-09', 'September 2026', 'regular', '2026-09-01', '2026-09-30', 'collecting') RETURNING id`);
      const far = await insertId(api.pool, `INSERT INTO edition (slug, title, kind, period_start, period_end, status) VALUES ('2028-01', 'January 2028', 'regular', '2028-01-01', '2028-06-30', 'collecting') RETURNING id`);
      const oneOff = `INSERT INTO event_occurrence (title, starts_at, url, visibility, owner_office_id) VALUES ($1, $2, $3, 'public', $4)`;
      await api.pool.query(oneOff, ['Within the range', '2027-11-20T23:00:00Z', 'https://within.example.org/', offices['president']]);
      await api.pool.query(oneOff, ['Past the range', '2027-12-10T23:00:00Z', 'https://beyond.example.org/', offices['president']]);
      const past = await piece('For September.', { writer: ADMIN, office: 'president', editionId: ended });
      expect((await links(past.itemId)).links).toEqual([]);
      const later = await piece('For January 2028.', { writer: ADMIN, office: 'president', editionId: far });
      const urls = (await links(later.itemId)).links.map((link) => link.url);
      expect(urls).toContain('https://within.example.org/');
      expect(urls).not.toContain('https://beyond.example.org/');
    });

    it('is for reviewers, and for a holder of the item office who reviews nothing; anyone else is refused', async () => {
      const own = await piece('See https://example.org/own.', { writer: LONE_HOLDER });
      for (const who of [TREASURER, OFFICER, ADMIN, WEBMASTER, LONE_WEBMASTER, LONE_HOLDER]) expect(await codeOf(links(own.itemId, who))).toBe('ok');
      const others = await piece('See https://example.org/theirs.', { writer: TREASURER, office: 'treasurer' });
      expect(await codeOf(links(others.itemId, LONE_HOLDER))).toBe(Code.PermissionDenied);
      expect(await codeOf(links(own.itemId, AFFILIATE))).toBe(Code.NotFound);
      expect(await codeOf(links(own.itemId, MEMBER))).toBe(Code.NotFound);
      expect(await codeOf(content.getItemLinks({ itemId: own.itemId }))).toBe(Code.Unauthenticated);
    });

    it('answers NOT_FOUND for no such item and INVALID_ARGUMENT for a bad id', async () => {
      expect(await codeOf(links('00000000-0000-4000-8000-000000000000'))).toBe(Code.NotFound);
      expect(await codeOf(links('not-an-id'))).toBe(Code.InvalidArgument);
    });

    it('reads the live version when nothing is being worked on, as the preview does; answers go to a ready version only', async () => {
      const { itemId, hash } = await piece('Published at https://example.org/live.');
      await content.approve({ itemId, contentHash: hash }, TREASURER);
      await content.publish({ itemId, contentHash: hash }, WEBMASTER);
      const response = await links(itemId);
      expect(response.links.map((link) => link.url)).toEqual(['https://example.org/live']);
      expect(response.readyAt).toBeDefined();
      expect(await messageOf(content.confirmLinks({ itemId, linksSha256: response.linksSha256, answers: [{ url: 'https://example.org/live', yes: true }] }, TREASURER))).toMatch(
        /only a version waiting for approval/,
      );
    });
  });

  describe('ConfirmLinks', () => {
    it('keeps each answer with the acting office and the ready time, audits links_confirmed, and returns the list with who answered', async () => {
      const { itemId } = await piece(`Join [our games group](${FACEBOOK}) or see https://example.org/games.`);
      const response = await confirm(itemId, [
        { url: FACEBOOK, yes: true, note: 'opens the group page' },
        { url: 'https://example.org/games', yes: false },
        { url: 'https://example.org/not-here', yes: true },
      ]);
      expect(response.notInPiece).toEqual(['https://example.org/not-here']);
      expect(row(response.links, FACEBOOK)).toMatchObject({ accepted: true, answeredByLabel: 'Treasurer' });
      expect(row(response.links, 'https://example.org/games')).toMatchObject({ accepted: false, answeredByLabel: 'Treasurer' });
      expect(await stored(itemId)).toEqual([
        { url: FACEBOOK, answer: 'yes', by_sub: 'sub-treasurer', acting_office_id: offices['treasurer'], bound: true, note: 'opens the group page' },
        { url: 'https://example.org/games', answer: 'no', by_sub: 'sub-treasurer', acting_office_id: offices['treasurer'], bound: true, note: null },
      ]);
      const [audit, ...more] = await audits(itemId, 'links_confirmed');
      expect(more).toEqual([]);
      expect(audit).toMatchObject({ acting_office_id: offices['treasurer'], payload: { answers: 2, yes: 1, no: 1, login_walled: 1 } });
      expect(audit?.version_id).not.toBeNull();
      expect(audit?.content_hash).not.toBeNull();
      // GetItemLinks shows the same answers to anyone who reads the list.
      expect(row((await links(itemId, ADMIN)).links, FACEBOOK)).toMatchObject({ accepted: true, answeredByLabel: 'Treasurer' });
    });

    it('records the office the reviewer names, refuses one they do not hold, and labels the Admin by role', async () => {
      const { itemId } = await piece(`See [the group](${FACEBOOK}).`, { writer: TREASURER, office: 'treasurer' });
      expect(await codeOf(confirm(itemId, [{ url: FACEBOOK, yes: true }], ADMIN, { actingAsOfficeId: offices['treasurer'] }))).toBe(Code.PermissionDenied);
      expect(await stored(itemId)).toEqual([]);
      const response = await confirm(itemId, [{ url: FACEBOOK, yes: true }], ADMIN, { actingAsOfficeId: offices['publications'] });
      expect(row(response.links, FACEBOOK)?.answeredByLabel).toBe('Publications Officer');
      const lone = await confirm(itemId, [{ url: FACEBOOK, yes: true }], LONE_WEBMASTER);
      expect(row(lone.links, FACEBOOK)?.answeredByLabel).toBe('Webmaster');
      expect((await stored(itemId)).map((answer) => answer.acting_office_id)).toEqual([offices['publications'], null]);
    });

    it('keeps the latest answer per link: answers saved in two goes add up, and a later no undoes a yes', async () => {
      const { itemId } = await piece(`See [the group](${FACEBOOK}) and [the page](https://www.facebook.com/example-page).`);
      await confirm(itemId, [{ url: FACEBOOK, yes: true }]);
      const second = await confirm(itemId, [{ url: 'https://www.facebook.com/example-page', yes: true }], OFFICER);
      expect(second.links.filter((link) => link.accepted).map((link) => link.url)).toEqual(['https://www.facebook.com/example-page', FACEBOOK]);
      const third = await confirm(itemId, [{ url: FACEBOOK, yes: false, note: 'the group is private now' }], OFFICER);
      expect(row(third.links, FACEBOOK)).toMatchObject({ accepted: false, answeredByLabel: 'Officer' });
      expect((await stored(itemId)).length).toBe(3);
    });

    it('takes the last of two answers to one link in one call', async () => {
      const { itemId } = await piece(`See [the group](${FACEBOOK}).`);
      const response = await confirm(itemId, [
        { url: FACEBOOK, yes: false },
        { url: FACEBOOK, yes: true },
      ]);
      expect(row(response.links, FACEBOOK)?.accepted).toBe(true);
      expect((await stored(itemId)).map((answer) => answer.answer)).toEqual(['yes']);
    });

    it('refuses whoever edited the version, anyone who is not a reviewer, and stores nothing', async () => {
      const { itemId } = await piece(`See [the group](${FACEBOOK}).`);
      expect(await messageOf(confirm(itemId, [{ url: FACEBOOK, yes: true }], PUB))).toMatch(/you edited this version/);
      expect(await codeOf(confirm(itemId, [{ url: FACEBOOK, yes: true }], PUB))).toBe(Code.PermissionDenied);
      const sha256 = (await links(itemId)).linksSha256;
      for (const who of [AFFILIATE, MEMBER, LONE_HOLDER]) {
        expect(await codeOf(content.confirmLinks({ itemId, linksSha256: sha256, answers: [{ url: FACEBOOK, yes: true }] }, who))).toBe(Code.PermissionDenied);
      }
      expect(await codeOf(content.confirmLinks({ itemId, linksSha256: sha256, answers: [{ url: FACEBOOK, yes: true }] }))).toBe(Code.Unauthenticated);
      expect(await stored(itemId)).toEqual([]);
    });

    it('refuses a list that has changed since it was read (a stale hash), and stores nothing', async () => {
      const { itemId } = await piece(`See [the group](${FACEBOOK}).`);
      const call = content.confirmLinks({ itemId, linksSha256: sha([[FACEBOOK, TEXT], ['https://example.org/new', TEXT]]), answers: [{ url: FACEBOOK, yes: true }] }, TREASURER);
      expect(await codeOf(call)).toBe(Code.FailedPrecondition);
      expect(await messageOf(content.confirmLinks({ itemId, linksSha256: new Uint8Array(), answers: [{ url: FACEBOOK, yes: true }] }, TREASURER))).toMatch(/links changed/);
      expect(await stored(itemId)).toEqual([]);
    });

    it('answers for a ready version only: not a draft, not one already approved', async () => {
      const draft = await piece(`See [the group](${FACEBOOK}).`, { draft: true });
      expect(await codeOf(confirm(draft.itemId, [{ url: FACEBOOK, yes: true }]))).toBe(Code.FailedPrecondition);
      const { itemId, hash } = await piece('See https://example.org/fine.');
      await content.approve({ itemId, contentHash: hash }, TREASURER);
      expect(await codeOf(confirm(itemId, [{ url: 'https://example.org/fine', yes: true }]))).toBe(Code.FailedPrecondition);
      expect(await codeOf(confirm('00000000-0000-4000-8000-000000000000', []))).not.toBe('ok');
    });

    it('needs at least one answer, a note of at most 2000 characters, and at most 500 answers', async () => {
      const { itemId } = await piece(`See [the group](${FACEBOOK}).`);
      expect(await codeOf(confirm(itemId, []))).toBe(Code.InvalidArgument);
      expect(await codeOf(confirm(itemId, [{ url: FACEBOOK, yes: true, note: 'n'.repeat(2001) }]))).toBe(Code.InvalidArgument);
      expect(await codeOf(confirm(itemId, Array.from({ length: 501 }, (_, i) => ({ url: `https://example.org/${i}`, yes: true }))))).toBe(Code.InvalidArgument);
      expect(await stored(itemId)).toEqual([]);
    });

    it('returns an over-long or empty URL as not in the piece', async () => {
      const { itemId } = await piece(`See [the group](${FACEBOOK}).`);
      const long = `https://example.org/${'a'.repeat(2100)}`;
      const response = await confirm(itemId, [
        { url: long, yes: true },
        { url: '', yes: true },
      ]);
      expect(response.notInPiece).toEqual([long, '']);
      expect(await audits(itemId, 'links_confirmed')).toEqual([]);
    });
  });

  describe('the Approve gate', () => {
    it('refuses Approve, in plain words, while a link that needs a sign-in has no yes; a yes lets it through', async () => {
      const { itemId, hash } = await piece(`Join [our games group](${FACEBOOK}) or see https://example.org/games.`);
      const refused = content.approve({ itemId, contentHash: hash }, TREASURER);
      expect(await messageOf(refused)).toBe('1 link needs a sign-in to check (such as Facebook): someone other than the writer must open it and answer yes before this is approved');
      await confirm(itemId, [{ url: FACEBOOK, yes: false }]);
      expect(await codeOf(content.approve({ itemId, contentHash: hash }, TREASURER))).toBe(Code.FailedPrecondition);
      await confirm(itemId, [{ url: FACEBOOK, yes: true }], OFFICER);
      const approved = (await content.approve({ itemId, contentHash: hash }, TREASURER)).item as ContentItem;
      expect(approved.working?.status).toBe(VersionStatus.CLEARED);
    });

    it('counts the links still waiting', async () => {
      const { itemId, hash } = await piece(`See [one](${FACEBOOK}) and [two](https://x.com/example).`);
      expect(await messageOf(content.approve({ itemId, contentHash: hash }, TREASURER))).toMatch(/^2 links need a sign-in to check/);
    });

    it('leaves a piece with no such link as it was: no answers needed, a no on an ordinary link included', async () => {
      const { itemId, hash } = await piece('See https://example.org/games and [the map](https://maps.example.org/park).');
      await confirm(itemId, [{ url: 'https://example.org/games', yes: false }]);
      expect(await codeOf(content.approve({ itemId, contentHash: hash }, TREASURER))).toBe('ok');
    });

    it('drops the answers with any edit: a send-back and a new ready time need a new yes', async () => {
      const { itemId } = await piece(`See [the group](${FACEBOOK}).`);
      await confirm(itemId, [{ url: FACEBOOK, yes: true }]);
      await content.sendBack({ itemId, note: 'Add the time, please.' }, TREASURER);
      await content.saveDraft({ itemId, title: 'Games night', summary: '', visibility: ItemVisibility.PUBLIC, bodyMarkup: `See [the group](${FACEBOOK}) at 7.` }, PUB);
      const hash = (await content.markReady({ itemId }, PUB)).item?.working?.contentHash as Uint8Array;
      expect(row((await links(itemId)).links, FACEBOOK)).toMatchObject({ accepted: false, answeredByLabel: '' });
      expect(await codeOf(content.approve({ itemId, contentHash: hash }, TREASURER))).toBe(Code.FailedPrecondition);
    });

    it('keeps the answers through a change of targets or edition at Approve', async () => {
      const { itemId, hash } = await piece(`See [the group](${FACEBOOK}).`);
      await confirm(itemId, [{ url: FACEBOOK, yes: true }]);
      const approved = await content.approve({ itemId, contentHash: hash, targets: { website: true, newsletter: false, email: false } }, TREASURER);
      expect(approved.item?.working?.status).toBe(VersionStatus.CLEARED);
    });

    it("holds the office's event links too: the President's report waits for a yes on the event's Facebook page", async () => {
      const { itemId, hash } = await piece('The calendar is below.', { writer: ADMIN, office: 'president' });
      expect(await messageOf(content.approve({ itemId, contentHash: hash }, TREASURER))).toMatch(/^1 link needs a sign-in/);
      await confirm(itemId, [{ url: 'https://www.facebook.com/events/1234', yes: true }]);
      expect(await codeOf(content.approve({ itemId, contentHash: hash }, TREASURER))).toBe('ok');
    });

    it('asks for the yes even of a break-glass approval: the Admin cannot answer for a version they edited', async () => {
      const { itemId, hash } = await piece(`See [the group](${FACEBOOK}).`, { writer: ADMIN });
      expect(await codeOf(confirm(itemId, [{ url: FACEBOOK, yes: true }], ADMIN))).toBe(Code.PermissionDenied);
      expect(await codeOf(content.approve({ itemId, contentHash: hash, breakGlass: true, breakGlassReason: 'Deadline tonight' }, ADMIN))).toBe(Code.FailedPrecondition);
      await confirm(itemId, [{ url: FACEBOOK, yes: true }], TREASURER);
      expect(await codeOf(content.approve({ itemId, contentHash: hash, breakGlass: true, breakGlassReason: 'Deadline tonight' }, ADMIN))).toBe('ok');
    });
  });

  describe("the reader's lens", () => {
    // The Admin without the officers group reads as the public, which has a member's phone number withheld.
    const LONE_ADMIN = as('lone-admin-token');
    const PHONE = '850-555-0142';

    it('shows each reader the list as they may see it, hashed as they see it; a reviewer vouches only for what they saw whole', async () => {
      const marks = api.client(RedactionPolicyService);
      const { itemId } = await piece(`Text [${PHONE}](https://www.facebook.com/groups/example-phone), or see https://example.org/ring/${PHONE} and https://example.org/fine.`);
      await marks.addRedactionMark({ subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: itemId, field: MarkField.BODY, quote: PHONE, category: RedactionCategory.MEMBER_PHONE }, OFFICER);
      const officer = await links(itemId);
      const lone = await links(itemId, LONE_ADMIN);
      expect(officer.links.map((link) => [link.url, link.label])).toEqual([
        ['https://example.org/fine', ''],
        [`https://example.org/ring/${PHONE}`, ''],
        ['https://www.facebook.com/groups/example-phone', PHONE],
      ]);
      expect(lone.links.map((link) => [link.url, link.label])).toEqual([
        ['https://example.org/fine', ''],
        ['https://example.org/ring/[withheld]', ''],
        ['https://www.facebook.com/groups/example-phone', '[withheld]'],
      ]);
      expect(lone.linksSha256).toEqual(sha(lone.links.map((link) => [link.url, link.where])));
      expect(lone.linksSha256).not.toEqual(officer.linksSha256);
      // The officer's hash is not the lone Admin's list.
      expect(await codeOf(content.confirmLinks({ itemId, linksSha256: officer.linksSha256, answers: [{ url: 'https://example.org/fine', yes: true }] }, LONE_ADMIN))).toBe(Code.FailedPrecondition);
      const response = await confirm(
        itemId,
        [
          { url: 'https://example.org/fine', yes: true },
          { url: 'https://example.org/ring/[withheld]', yes: true },
          { url: `https://example.org/ring/${PHONE}`, yes: true },
          { url: 'https://www.facebook.com/groups/example-phone', yes: true },
        ],
        LONE_ADMIN,
      );
      expect(response.notInPiece).toEqual(['https://example.org/ring/[withheld]', `https://example.org/ring/${PHONE}`]);
      expect((await stored(itemId)).map((answer) => answer.url)).toEqual(['https://example.org/fine', 'https://www.facebook.com/groups/example-phone']);
      expect(row(response.links, 'https://example.org/fine')).toMatchObject({ accepted: true, answeredByLabel: 'Admin' });
    });

    it('answers NOT_FOUND to a reader whose lens hides the whole item', async () => {
      const marks = api.client(RedactionPolicyService);
      const { itemId } = await piece('See https://example.org/whole.');
      await marks.addRedactionMark({ subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: itemId, field: MarkField.UNSPECIFIED, quote: '', category: RedactionCategory.MEMBER_PHONE }, OFFICER);
      expect(await codeOf(links(itemId, LONE_ADMIN))).toBe(Code.NotFound);
      expect(await codeOf(content.confirmLinks({ itemId, linksSha256: sha([]), answers: [{ url: 'https://example.org/whole', yes: true }] }, LONE_ADMIN))).toBe(Code.NotFound);
      expect(await codeOf(links(itemId))).toBe('ok');
    });

    it('leaves out an event the reader may not see at all', async () => {
      const marks = api.client(RedactionPolicyService);
      const occurrence = await insertId(
        api.pool,
        `INSERT INTO event_occurrence (title, starts_at, url, visibility, owner_office_id) VALUES ('Private supper', '2026-11-12T23:00:00Z', 'https://supper.example.org/', 'public', $1) RETURNING id`,
        [offices['secretary']],
      );
      await marks.addRedactionMark({ subjectKind: MarkSubjectKind.EVENT_OCCURRENCE, subjectId: occurrence, field: MarkField.UNSPECIFIED, quote: '', category: RedactionCategory.MEMBER_PHONE }, OFFICER);
      const { itemId } = await piece('Events below.', { writer: ADMIN, office: 'secretary' });
      expect((await links(itemId, LONE_ADMIN)).links).toEqual([]);
      expect((await links(itemId)).links.map((link) => link.url)).toEqual(['https://supper.example.org/']);
    });

    it("withholds a members event's addresses from a reader at the public's audience, as the calendar does", async () => {
      await api.pool.query(
        `INSERT INTO event_occurrence (title, starts_at, url, venue_id, visibility, owner_office_id) VALUES ('Members dinner', '2026-11-14T23:00:00Z', 'https://dinner.example.org/', (SELECT id FROM venue WHERE name = 'Corner Cafe'), 'members', $1)`,
        [offices['secretary']],
      );
      const { itemId } = await piece('Events below.', { writer: ADMIN, office: 'secretary' });
      expect((await links(itemId)).links.map((link) => link.url)).toEqual(['https://cafe.example.org/', 'https://dinner.example.org/', 'https://supper.example.org/']);
      expect((await links(itemId, LONE_ADMIN)).links.map((link) => link.url)).toEqual([]);
    });

    it("withholds an event's marked detail from a reader who may not see it", async () => {
      const marks = api.client(RedactionPolicyService);
      const { itemId } = await piece('Events below.', { writer: ADMIN, office: 'president' });
      const occurrence = (await api.pool.query<{ id: string }>(`SELECT id FROM event_occurrence WHERE title = 'Board games night'`)).rows[0]?.id as string;
      await marks.addRedactionMark({ subjectKind: MarkSubjectKind.EVENT_OCCURRENCE, subjectId: occurrence, field: MarkField.DETAIL, quote: 'parking.example.org/map', category: RedactionCategory.MEMBER_PHONE }, OFFICER);
      const urls = (await links(itemId, LONE_ADMIN)).links.map((link) => link.url);
      expect(urls).not.toContain('https://parking.example.org/map');
      expect((await links(itemId)).links.map((link) => link.url)).toContain('https://parking.example.org/map');
    });
  });

  describe('AUDIT-FOROFFICE', () => {
    it("records the Admin's save for an office they do not hold as for_office, as CreateItem does; a holder's save stays as it was", async () => {
      const admin = await piece('By the Admin.', { writer: ADMIN, office: 'secretary', draft: true });
      expect((await audits(admin.itemId, 'save')).map((audit) => audit.payload)).toEqual([{ for_office: true }]);
      expect((await audits(admin.itemId, 'create')).map((audit) => audit.payload)).toEqual([{ for_office: true }]);
      await content.saveDraft({ itemId: admin.itemId, title: 'Games night', summary: '', visibility: ItemVisibility.PUBLIC, bodyMarkup: 'Again.', auto: true }, ADMIN);
      expect((await audits(admin.itemId, 'autosave')).map((audit) => audit.payload)).toEqual([{ for_office: true }]);
      const own = await piece('By the holder.', { draft: true });
      expect((await audits(own.itemId, 'save')).map((audit) => audit.payload)).toEqual([{}]);
    });
  });
});
