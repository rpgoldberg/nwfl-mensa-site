// L-ITEM (SPEC-v3 3.4): LinkCheckService, the link checker's own service, over gRPC against a migrated
// database (0031) with the production routes and caller gate and a stand-in token.
//   ListLinksAwaitingVerdict  addresses only, never text, words or titles: those of every piece waiting
//                             for approval or approved (ready, cleared), its office's event addresses
//                             included, that no reviewer has answered on the version as it stands and
//                             that have had no verdict in the last day. Each list handed out is audited
//                             (links_read, audience officers).
//   RecordLinkVerdicts        a verdict per address it was given, for every piece the address waits in.
//                             It cannot accept a link that needs a sign-in, answer for a reviewer, or
//                             change an address.
// Only the link checker may call it, and it may call nothing else. Every person, place and address here
// is made up.
import { type Client, Code, ConnectError } from '@connectrpc/connect';
import pgLib from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalRuleService } from '../../src/gen/nwfl/mensa/v1/approval_pb.js';
import { ContentKind, ContentService, type ContentItem, ItemVisibility, MachineVerdict, ReviewerAnswer } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { EventService } from '../../src/gen/nwfl/mensa/v1/event_pb.js';
import { LinkCheckService } from '../../src/gen/nwfl/mensa/v1/link_check_pb.js';
import { MembershipVerifierService } from '../../src/gen/nwfl/mensa/v1/membership_verifier_pb.js';
import { NewsletterService } from '../../src/gen/nwfl/mensa/v1/newsletter_pb.js';
import { type Api, as, dump, insertId, startApi } from '../helpers/api.js';
import { MIGRATOR, MIGRATOR_PW, live, urlFor } from '../helpers/pg.js';

const PUBLICATIONS = as('pub-token');
const TREASURER = as('treasurer-token');
const OFFICER = as('officer-token');
const ADMIN = as('admin-token');
const CHECKER = as('linkcheck-token');

const codeOf = async (call: Promise<unknown>): Promise<Code | 'ok'> => {
  try {
    await call;
    return 'ok';
  } catch (error) {
    return ConnectError.from(error).code;
  }
};

describe.skipIf(!live)('L-ITEM: LinkCheckService', () => {
  let api: Api;
  let owner: pgLib.Client;
  let content: Client<typeof ContentService>;
  let checker: Client<typeof LinkCheckService>;
  const offices: Record<string, string> = {};
  let n = 0;

  /** An item of `office` with this body, saved by the Publications Officer (the Admin for another office); ready unless `draft`. */
  const piece = async (body: string, options: { office?: string; draft?: boolean; title?: string; visibility?: ItemVisibility } = {}) => {
    const PUB = (options.office ?? 'publications') === 'publications' ? PUBLICATIONS : ADMIN;
    const item = (await content.createItem({ kind: ContentKind.ARTICLE, officeId: offices[options.office ?? 'publications'] as string, slug: `lc-${(n += 1)}`, title: options.title ?? 'Games night' }, PUB))
      .item as ContentItem;
    await content.saveDraft({ itemId: item.id, title: options.title ?? 'Games night', summary: '', visibility: options.visibility ?? ItemVisibility.PUBLIC, bodyMarkup: body }, PUB);
    if (options.draft === true) return { itemId: item.id, hash: new Uint8Array() };
    const ready = await content.markReady({ itemId: item.id }, PUB);
    return { itemId: item.id, hash: ready.item?.working?.contentHash as Uint8Array };
  };
  /** A machine verdict given `days` ago, written by the owner as the clock cannot be moved: it stands for time passing. */
  const aged = (itemId: string, url: string, answer: string, days: number) =>
    owner.query(`INSERT INTO content_link_check (item_id, url, source, answer, by_sub, at) VALUES ($1, $2, 'machine', $3, 'svc-nwfl-linkcheck', now() - make_interval(days => $4))`, [
      itemId,
      url,
      answer,
      days,
    ]);
  const machineRows = async (itemId: string) =>
    (
      await api.pool.query<{ url: string; answer: string; reasons: string[]; version_id: string | null; by_sub: string; source: string }>(
        `SELECT url, answer, reasons, version_id, by_sub, source FROM content_link_check WHERE item_id = $1 AND source = 'machine' ORDER BY id`,
        [itemId],
      )
    ).rows;
  const audits = async (action: string) =>
    (
      await api.pool.query<{ actor_kind: string; actor_sub: string; subject_kind: string; subject_id: string; item_id: string | null; payload: Record<string, unknown> }>(
        `SELECT actor_kind, actor_sub, subject_kind, subject_id, item_id, payload FROM audit_event WHERE action = $1 ORDER BY id`,
        [action],
      )
    ).rows;
  const awaiting = async () => (await checker.listLinksAwaitingVerdict({}, CHECKER)).urls;

  beforeAll(async () => {
    api = await startApi('nwfl_link_check');
    content = api.client(ContentService);
    checker = api.client(LinkCheckService);
    const db = (await api.pool.query<{ db: string }>(`SELECT current_database() AS db`)).rows[0]?.db as string;
    owner = new pgLib.Client({ connectionString: urlFor(MIGRATOR, MIGRATOR_PW, db) });
    await owner.connect();
    for (const [slug, title] of [
      ['publications', 'Publications Officer'],
      ['treasurer', 'Treasurer'],
      ['president', 'President'],
    ]) {
      offices[slug as string] = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ($1, $2, 'appointed') RETURNING id`, [slug, title]);
    }
    // The President's event, upcoming: today is Thursday 2026-10-22 (Central) in the API under test.
    const cafe = await insertId(api.pool, `INSERT INTO venue (kind, name, area, url) VALUES ('business', 'Corner Cafe', 'okaloosa', 'https://cafe.example.org/') RETURNING id`);
    await api.pool.query(`INSERT INTO event_occurrence (title, starts_at, url, detail, venue_id, visibility, owner_office_id) VALUES ($1, $2, $3, $4, $5, 'public', $6)`, [
      'Secret strategy night',
      '2026-11-05T23:00:00Z',
      'https://www.facebook.com/events/1234',
      'Parking map: https://parking.example.org/map.',
      cafe,
      offices['president'],
    ]);
  });

  afterAll(async () => {
    await owner?.end();
    await api?.close();
  });

  // Each test reads the list as a whole; they run in order, each adding pieces.
  describe('ListLinksAwaitingVerdict', () => {
    it('hands out addresses only, sorted and each once, from ready pieces and their office events; never a draft', async () => {
      await piece('Join [the hidden games club](https://club.example.org/games) and see https://print.example.org/page today.', { title: 'Confidential plans' });
      await piece('Also at [the club](https://club.example.org/games).', { office: 'president' });
      await piece('Draft only: https://draft.example.org/', { draft: true });
      const reply = await checker.listLinksAwaitingVerdict({}, CHECKER);
      expect(reply.urls).toEqual([
        'https://cafe.example.org/',
        'https://club.example.org/games',
        'https://parking.example.org/map',
        'https://print.example.org/page',
        'https://www.facebook.com/events/1234',
      ]);
      expect(reply.more).toBe(false);
      // Addresses only: no words of a link, no title, no event name, no place.
      for (const words of ['hidden games club', 'Confidential plans', 'Games night', 'Secret strategy night', 'Corner Cafe', 'event:', 'venue:', 'in the text']) {
        expect(dump(reply)).not.toContain(words);
      }
    });

    it('audits each list handed out as links_read at the officers audience, with counts and the items, never an address', async () => {
      const before = (await audits('links_read')).length;
      const urls = await awaiting();
      const rows = (await audits('links_read')).slice(before);
      expect(rows).toHaveLength(1);
      const row = rows[0] as (typeof rows)[number];
      expect(row).toMatchObject({ actor_kind: 'linkcheck', actor_sub: 'svc-nwfl-linkcheck', subject_kind: 'link_list', item_id: null });
      expect(row.subject_id).toMatch(/^[0-9a-f]{64}$/);
      expect(row.payload).toMatchObject({ audience: 'officers', urls: urls.length, more: false });
      expect(row.payload['item_ids']).toHaveLength(2);
      expect(row.payload['items']).toBe(2);
      for (const url of urls) expect(JSON.stringify(row)).not.toContain(url);
    });

    it('includes the addresses of an officers-only piece and of a members-only passage: the checker reads the list as it is', async () => {
      await piece('Board only: https://board.example.org/minutes', { office: 'treasurer', visibility: ItemVisibility.OFFICERS });
      await piece('Open part. :members[Members only: https://members.example.org/list]', { office: 'treasurer' });
      const urls = await awaiting();
      expect(urls).toContain('https://board.example.org/minutes');
      expect(urls).toContain('https://members.example.org/list');
    });

    it('leaves out an address a reviewer answered on the version as it stands, in that piece only', async () => {
      const { itemId } = await piece('Only here: https://answered.example.org/ and https://shared.example.org/');
      await piece('Also https://shared.example.org/ here.');
      const { linksSha256 } = await content.getItemLinks({ itemId }, TREASURER);
      await content.confirmLinks({ itemId, linksSha256, answers: [{ url: 'https://answered.example.org/', yes: false }, { url: 'https://shared.example.org/', yes: true }] }, TREASURER);
      const urls = await awaiting();
      expect(urls).not.toContain('https://answered.example.org/');
      // Still waiting in the other piece.
      expect(urls).toContain('https://shared.example.org/');
    });

    it('leaves out for a day an address with a verdict, then hands it out again', async () => {
      const { itemId } = await piece('Daily: https://daily.example.org/');
      expect(await awaiting()).toContain('https://daily.example.org/');
      await checker.recordLinkVerdicts({ verdicts: [{ url: 'https://daily.example.org/', verdict: MachineVerdict.OK }] }, CHECKER);
      expect(await awaiting()).not.toContain('https://daily.example.org/');
      const { itemId: older } = await piece('Yesterday: https://yesterday.example.org/');
      await aged(older, 'https://yesterday.example.org/', 'ok', 2);
      expect(await awaiting()).toContain('https://yesterday.example.org/');
      expect(itemId).not.toBe(older);
    });

    it('includes an approved piece not yet published, and drops a piece once it is live or back in draft', async () => {
      const { itemId, hash } = await piece('Approved: https://cleared.example.org/', { office: 'treasurer' });
      // Approved on an OK from two days ago (still under 7 days), so it waits for a fresh verdict again.
      await aged(itemId, 'https://cleared.example.org/', 'ok', 2);
      await content.approve({ itemId, contentHash: hash }, OFFICER);
      expect(await awaiting()).toContain('https://cleared.example.org/');
      await content.publish({ itemId, contentHash: hash }, ADMIN);
      expect(await awaiting()).not.toContain('https://cleared.example.org/');
      const sent = await piece('Sent back: https://sentback.example.org/');
      expect(await awaiting()).toContain('https://sentback.example.org/');
      await content.sendBack({ itemId: sent.itemId, note: 'Reword, please.' }, OFFICER);
      expect(await awaiting()).not.toContain('https://sentback.example.org/');
    });

    it('writes no audit row when there is nothing to hand out', async () => {
      const quiet = await startApi('nwfl_link_check_quiet');
      try {
        expect((await quiet.client(LinkCheckService).listLinksAwaitingVerdict({}, CHECKER)).urls).toEqual([]);
        expect((await quiet.pool.query(`SELECT 1 FROM audit_event WHERE action = 'links_read'`)).rows).toEqual([]);
      } finally {
        await quiet.close();
      }
    });

    it('hands out at most 500 at a time, and says that more wait', async () => {
      const many = Array.from({ length: 501 }, (_, i) => `https://zz${String(i).padStart(3, '0')}.example.org/`);
      await piece(many.join(' '));
      const reply = await checker.listLinksAwaitingVerdict({}, CHECKER);
      expect(reply.urls).toHaveLength(500);
      expect(reply.more).toBe(true);
      expect((await audits('links_read')).at(-1)?.payload).toMatchObject({ urls: 500, more: true });
      // The rest come once the first are recorded.
      await checker.recordLinkVerdicts({ verdicts: reply.urls.map((url) => ({ url, verdict: MachineVerdict.CONFIRM })) }, CHECKER);
      const next = await checker.listLinksAwaitingVerdict({}, CHECKER);
      expect(next.more).toBe(false);
      expect(next.urls).toContain('https://zz500.example.org/');
    });
  });

  describe('RecordLinkVerdicts', () => {
    it('records a machine verdict, with its reasons, for every piece the address waits in, and audits counts only', async () => {
      const a = await piece('First https://both.example.org/ and https://gone.example.org/');
      const b = await piece('Second https://both.example.org/');
      const before = (await audits('link_verdicts')).length;
      const reply = await checker.recordLinkVerdicts(
        {
          verdicts: [
            { url: 'https://both.example.org/', verdict: MachineVerdict.OK },
            { url: 'https://gone.example.org/', verdict: MachineVerdict.DROP, reasons: ['nxdomain'] },
          ],
        },
        CHECKER,
      );
      expect(reply).toMatchObject({ recorded: 3, notAwaiting: [] });
      expect(await machineRows(a.itemId)).toEqual([
        { url: 'https://both.example.org/', answer: 'ok', reasons: [], version_id: null, by_sub: 'svc-nwfl-linkcheck', source: 'machine' },
        { url: 'https://gone.example.org/', answer: 'drop', reasons: ['nxdomain'], version_id: null, by_sub: 'svc-nwfl-linkcheck', source: 'machine' },
      ]);
      expect(await machineRows(b.itemId)).toEqual([expect.objectContaining({ url: 'https://both.example.org/', answer: 'ok' })]);
      const rows = (await audits('link_verdicts')).slice(before);
      expect(rows).toEqual([expect.objectContaining({ actor_kind: 'linkcheck', subject_kind: 'link_list', item_id: null })]);
      expect(rows[0]?.payload).toEqual({ ok: 1, confirm: 0, drop: 1, recorded: 3, not_awaiting: 0 });
      expect(JSON.stringify(rows[0])).not.toContain('example.org');
    });

    it('records nothing for an address it was not given: a changed address, one not in any waiting piece, one too long', async () => {
      const { itemId } = await piece('Exact: https://exact.example.org/page');
      const reply = await checker.recordLinkVerdicts(
        {
          verdicts: [
            { url: 'https://exact.example.org/page/', verdict: MachineVerdict.OK },
            { url: 'https://EXACT.example.org/page', verdict: MachineVerdict.OK },
            { url: 'https://elsewhere.example.org/', verdict: MachineVerdict.OK },
            { url: 'https://draft.example.org/', verdict: MachineVerdict.OK },
            { url: `https://exact.example.org/${'a'.repeat(2048)}`, verdict: MachineVerdict.OK },
          ],
        },
        CHECKER,
      );
      expect(reply.recorded).toBe(0);
      expect(reply.notAwaiting).toHaveLength(5);
      expect(await machineRows(itemId)).toEqual([]);
    });

    it('records nothing for an address a reviewer has answered in that piece', async () => {
      const { itemId } = await piece('Looked at: https://looked.example.org/');
      const { linksSha256 } = await content.getItemLinks({ itemId }, TREASURER);
      await content.confirmLinks({ itemId, linksSha256, answers: [{ url: 'https://looked.example.org/', yes: false }] }, TREASURER);
      const reply = await checker.recordLinkVerdicts({ verdicts: [{ url: 'https://looked.example.org/', verdict: MachineVerdict.OK }] }, CHECKER);
      expect(reply).toMatchObject({ recorded: 0, notAwaiting: ['https://looked.example.org/'] });
      expect(await machineRows(itemId)).toEqual([]);
    });

    it('keeps the last verdict given for an address in one call', async () => {
      const { itemId } = await piece('Twice: https://twice.example.org/');
      await checker.recordLinkVerdicts(
        { verdicts: [{ url: 'https://twice.example.org/', verdict: MachineVerdict.OK }, { url: 'https://twice.example.org/', verdict: MachineVerdict.DROP, reasons: ['dead'] }] },
        CHECKER,
      );
      expect((await machineRows(itemId)).map((row) => row.answer)).toEqual(['drop']);
    });

    it('cannot accept a link that needs a sign-in: OK on one refuses the whole call and records nothing', async () => {
      const { itemId } = await piece('Group https://www.facebook.com/groups/example-games and https://fine.example.org/');
      const call = checker.recordLinkVerdicts(
        { verdicts: [{ url: 'https://fine.example.org/', verdict: MachineVerdict.OK }, { url: 'https://www.facebook.com/groups/example-games', verdict: MachineVerdict.OK }] },
        CHECKER,
      );
      await expect(call).rejects.toMatchObject({ code: Code.InvalidArgument, rawMessage: 'the link checker cannot accept a link that needs a sign-in to check' });
      expect(await machineRows(itemId)).toEqual([]);
      // CONFIRM or DROP on one is a verdict it may give.
      await checker.recordLinkVerdicts({ verdicts: [{ url: 'https://www.facebook.com/groups/example-games', verdict: MachineVerdict.CONFIRM, reasons: ['login-walled'] }] }, CHECKER);
      expect((await machineRows(itemId)).map((row) => row.answer)).toEqual(['confirm']);
    });

    it.each([
      ['no verdicts', { verdicts: [] }],
      ['an unspecified verdict', { verdicts: [{ url: 'https://fine.example.org/', verdict: MachineVerdict.UNSPECIFIED }] }],
      ['an unknown verdict', { verdicts: [{ url: 'https://fine.example.org/', verdict: 9 as MachineVerdict }] }],
      ['a reason that is not a code', { verdicts: [{ url: 'https://fine.example.org/', verdict: MachineVerdict.DROP, reasons: ['Not Found <b>'] }] }],
      ['an empty reason', { verdicts: [{ url: 'https://fine.example.org/', verdict: MachineVerdict.DROP, reasons: [''] }] }],
      ['nine reasons', { verdicts: [{ url: 'https://fine.example.org/', verdict: MachineVerdict.DROP, reasons: Array.from({ length: 9 }, () => 'dead') }] }],
      ['501 verdicts', { verdicts: Array.from({ length: 501 }, (_, i) => ({ url: `https://x${i}.example.org/`, verdict: MachineVerdict.OK })) }],
    ])('refuses %s with INVALID_ARGUMENT', async (_label, request) => {
      expect(await codeOf(checker.recordLinkVerdicts(request, CHECKER))).toBe(Code.InvalidArgument);
    });

    it('never writes a reviewer answer: the piece still shows no answer and who answered nobody', async () => {
      const { itemId } = await piece('Machine only: https://machine.example.org/');
      await checker.recordLinkVerdicts({ verdicts: [{ url: 'https://machine.example.org/', verdict: MachineVerdict.OK, reasons: ['upgraded'] }] }, CHECKER);
      const [link] = (await content.getItemLinks({ itemId }, TREASURER)).links;
      expect(link).toMatchObject({ machineVerdict: MachineVerdict.OK, reasons: ['upgraded'], reviewerAnswer: ReviewerAnswer.UNSPECIFIED, answeredByLabel: '', accepted: true });
      expect((await api.pool.query(`SELECT 1 FROM content_link_check WHERE item_id = $1 AND source = 'human'`, [itemId])).rows).toEqual([]);
    });
  });

  describe('who may call it', () => {
    it('refuses everyone but the link checker: no token, a member, an officer, the Admin, the agent, the verifier', async () => {
      expect(await codeOf(checker.listLinksAwaitingVerdict({}))).toBe(Code.Unauthenticated);
      for (const token of ['member-token', 'officer-token', 'admin-token', 'webmaster-token', 'agent-token', 'verifier-token'] as const) {
        expect(await codeOf(checker.listLinksAwaitingVerdict({}, as(token))), token).toBe(Code.PermissionDenied);
        expect(await codeOf(checker.recordLinkVerdicts({ verdicts: [{ url: 'https://fine.example.org/', verdict: MachineVerdict.OK }] }, as(token))), token).toBe(Code.PermissionDenied);
      }
    });

    it('refuses the link checker on every other service: content (links, answers, approve), events, the newsletter, the verifier, approval rules', async () => {
      const { itemId, hash } = await piece('Refused: https://refused.example.org/');
      const { linksSha256 } = await content.getItemLinks({ itemId }, TREASURER);
      const calls: Array<[string, Promise<unknown>]> = [
        ['GetItemLinks', content.getItemLinks({ itemId }, CHECKER)],
        ['ConfirmLinks', content.confirmLinks({ itemId, linksSha256, answers: [{ url: 'https://refused.example.org/', yes: true }] }, CHECKER)],
        ['Approve', content.approve({ itemId, contentHash: hash }, CHECKER)],
        ['ListPublished', content.listPublishedItems({}, CHECKER)],
        ['ListVenues', api.client(EventService).listVenues({}, CHECKER)],
        ['ListEditions', api.client(NewsletterService).listEditions({}, CHECKER)],
        ['ListPendingVerifications', api.client(MembershipVerifierService).listPendingVerifications({}, CHECKER)],
        ['GetApprovalRules', api.client(ApprovalRuleService).getApprovalRules({}, CHECKER)],
      ];
      for (const [name, call] of calls) expect(await codeOf(call), name).toBe(Code.PermissionDenied);
      expect((await api.pool.query(`SELECT 1 FROM content_link_check WHERE item_id = $1`, [itemId])).rows).toEqual([]);
    });
  });
});
