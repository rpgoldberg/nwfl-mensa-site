// LINKS L4: ContentService.GetLinkTarget, the leaving page's one read. A link id resolves only
// when it is in pdf_copy_link for the copy this audience is served now, its latest status is
// active, and its URL holds none of this audience's withheld quotes as they stand at the read
// (targetHolds, src/load/links.ts). A link turned off says so, with its date and file and page,
// never its URL, and only to an audience whose copy carried it (the publication ledger names the
// copies each audience was served, and pdf_copy_link what each held), or to an officer, for a file
// they may have. Every other id (unknown,
// malformed, another audience's, dropped from the copy served now, held by a mark, of a hidden
// or unpublished file, or asked by an officer, who is served the original) is answered exactly
// as an unknown one. The links and copies are seeded rows, and the ledger recorded over them as the
// worker records it with each copy: the worker (L3) is not needed here.
// Every URL is under a reserved example name; every person is made up.
import { createHash } from 'node:crypto';
import { Code, ConnectError } from '@connectrpc/connect';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentService, LinkTargetKind, LinkTargetStatus } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { MarkField, MarkSubjectKind, RedactionCategory, RedactionPolicyService } from '../../src/gen/nwfl/mensa/v1/redaction_pb.js';
import { recordAll } from '../../src/ledger/ledger.js';
import { inputsFor, storeOriginal } from '../../src/pdf/store.js';
import { type Api, MEMBER, OFFICER, dump, insertId, startApi } from '../helpers/api.js';
import { paragraph, publishItem, text } from '../helpers/content.js';
import { live, url } from '../helpers/pg.js';

const PHONE = '850-555-0147';
const EMAIL = 'events@example.org';
const STORER = { sub: 'sub-officer', groups: ['nwfl-members', 'nwfl-officers'] };
const sha = (value: string): Buffer => createHash('sha256').update(value).digest();

/** A link id: 26 lower-case base32 characters, one per test link. */
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const id = (n: number): string => `lfour${BASE32[n >> 5]}${BASE32[n & 31]}`.padEnd(26, 'q');

const LINKS = {
  web: id(1),
  social: id(2),
  mail: id(3),
  dropped: id(4),
  off: id(5),
  held: id(6),
  heldEncoded: id(7),
  members: id(8),
  membersOff: id(9),
  hidden: id(10),
  noStatus: id(11),
  notReady: id(12),
  draft: id(13),
  membersCopyOff: id(14),
  neverServedOff: id(15),
  historyOff: id(16),
};

type Options = { headers?: Record<string, string> };
type Answer = { status: LinkTargetStatus; url: string; host: string; kind: LinkTargetKind; confirm: boolean; fileId: string; page: number; statusAt?: Date } | { error: unknown };

describe.skipIf(!live)('ContentService.GetLinkTarget', () => {
  let api: Api;
  let root: pg.Client;
  let office: string;
  const files: Record<string, string> = {};
  const items: Record<string, string> = {};

  async function ask(linkId: string, options: Options = {}): Promise<Answer> {
    try {
      const got = await api.client(ContentService).getLinkTarget({ linkId }, options);
      return { status: got.status, url: got.url, host: got.host, kind: got.kind, confirm: got.confirm, fileId: got.fileId, page: got.page, ...(got.statusAt ? { statusAt: new Date(Number(got.statusAt.seconds) * 1000 + Math.floor(got.statusAt.nanos / 1e6)) } : {}) };
    } catch (error) {
      const e = ConnectError.from(error);
      return { error: { code: e.code, message: e.message, details: e.details, metadata: [...e.metadata].filter(([k]) => k !== 'date') } };
    }
  }

  /** A published item with one PDF file of this audience, its original stored. */
  const publish = async (slug: string, audience: 'public' | 'members', extra: { visibility?: 'public' | 'members' | 'officers'; publishIt?: boolean } = {}) => {
    const bytes = Buffer.from(`%PDF-1.7\n% ${slug}\n%%EOF\n`, 'latin1');
    const { itemId, versionId } = await publishItem(api.pool, {
      slug,
      officeId: office,
      title: `Picnic ${slug}`,
      visibility: extra.visibility ?? 'public',
      body: { blocks: [paragraph(text(`Rides: call ${PHONE}. Write to ${EMAIL} to help.`))] },
      files: [{ objectKey: `k-${slug}`, audience, bytes }],
    });
    const file = (await api.pool.query<{ id: string }>(`SELECT id FROM stored_file WHERE version_id = $1`, [versionId])).rows[0]!.id;
    await storeOriginal(api.pool, { fileId: file, bytes, ...STORER });
    return { itemId, file };
  };

  /** A link row as the loader writes it (0024), and its first status, unless `status` is false. */
  const link = async (linkId: string, fileId: string, url: string, extra: { page?: number; confirm?: boolean; status?: boolean } = {}) => {
    const mail = url.startsWith('mailto:');
    const host = mail ? url.slice(url.indexOf('@') + 1) : new URL(url).hostname;
    await root.query(
      `INSERT INTO pdf_link (id, file_id, page, rect, url, host, kind, confirm, approval_reference, links_sha256, created_by_sub)
       VALUES ($1, $2, $3, '{72, 500, 300, 514}', $4, $5, $6, $7, 'LINKS-L4', $8, 'system:issue-loader')`,
      [linkId, fileId, extra.page ?? 1, url, host, mail ? 'mail' : 'web', extra.confirm ?? false, sha('links')],
    );
    if (extra.status !== false) await root.query(`INSERT INTO pdf_link_status (link_id, status, reason, by_sub) VALUES ($1, 'active', 'attached', 'system:issue-loader')`, [linkId]);
  };

  /** The copy this audience is given now (store.ts inputsFor), stored ready, holding these links. */
  const copy = async (fileId: string, audience: string, linkIds: string[], hash?: Buffer) => {
    const inputs = await inputsFor(api.pool, fileId, audience);
    if (hash === undefined && inputs?.kind !== 'copy') throw new Error(`no copy for ${audience}`);
    const key = hash ?? (inputs as { hash: Buffer }).hash;
    await root.query(`INSERT INTO pdf_copy (file_id, input_hash, engine, status, bytes) VALUES ($1, $2, 'e', 'ready', '\\x25504446') ON CONFLICT DO NOTHING`, [fileId, key]);
    for (const linkId of linkIds) await root.query(`INSERT INTO pdf_copy_link (file_id, input_hash, link_id) VALUES ($1, $2, $3)`, [fileId, key, linkId]);
  };

  const mark = (itemId: string, field: MarkField, quote: string, category: RedactionCategory) =>
    api.client(RedactionPolicyService).addRedactionMark({ subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: itemId, field, quote, category }, OFFICER);

  beforeAll(async () => {
    api = await startApi('nwfl_linktarget');
    const database = (await api.pool.query<{ db: string }>(`SELECT current_database() AS db`)).rows[0]!.db;
    const rootUrl = new URL(url as string);
    rootUrl.pathname = `/${database}`;
    root = new pg.Client({ connectionString: rootUrl.toString() });
    await root.connect();
    office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);

    // A public file on a public item, the phone marked: the public is served a copy without it,
    // members (who are shown phones, and not addresses) a copy of their own.
    const trip = await publish('trip', 'public');
    files['trip'] = trip.file;
    items['trip'] = trip.itemId;
    await mark(trip.itemId, MarkField.BODY, PHONE, RedactionCategory.MEMBER_PHONE);
    await link(LINKS.web, trip.file, 'https://club.example/picnic?day=sat', { page: 2 });
    await link(LINKS.social, trip.file, 'https://www.social.example/groups/nwfl', { confirm: true });
    await link(LINKS.mail, trip.file, `mailto:${EMAIL}`);
    await link(LINKS.dropped, trip.file, 'https://club.example/old');
    await link(LINKS.off, trip.file, 'https://parked.example/', { page: 3 });
    await link(LINKS.held, trip.file, `https://club.example/rides/call-${PHONE}`);
    await link(LINKS.heldEncoded, trip.file, 'https://club.example/r/850%2D555%2D0147');
    await link(LINKS.noStatus, trip.file, 'https://club.example/no-status', { status: false });
    // Turned off below: one only the members copy held, one no copy held.
    await link(LINKS.membersCopyOff, trip.file, 'https://club.example/members-copy-only', { page: 4 });
    await link(LINKS.neverServedOff, trip.file, 'https://club.example/never-served', { page: 5 });
    // The copies a buggy worker could have made: the held links in them too (the read checks again).
    await copy(trip.file, 'public', [LINKS.web, LINKS.social, LINKS.mail, LINKS.off, LINKS.held, LINKS.heldEncoded, LINKS.noStatus]);
    await copy(trip.file, 'members', [LINKS.web, LINKS.held, LINKS.membersCopyOff]);
    // An older copy, keyed by inputs no longer current, that still held the dropped link.
    await copy(trip.file, 'public', [LINKS.dropped], sha('an older copy'));

    // A members file: the public may not have it.
    const club = await publish('club', 'members');
    files['club'] = club.file;
    await link(LINKS.members, club.file, 'https://club.example/members-night');
    await link(LINKS.membersOff, club.file, 'https://club.example/gone');
    await copy(club.file, 'members', [LINKS.members, LINKS.membersOff]);

    // A file whose item a whole-item mark hides from the public.
    const hidden = await publish('hidden', 'public');
    await link(LINKS.hidden, hidden.file, 'https://club.example/hidden');
    await copy(hidden.file, 'public', [LINKS.hidden]);
    await mark(hidden.itemId, MarkField.UNSPECIFIED, '', RedactionCategory.PRIVATE_VENUE);

    // A file whose copy is not made yet.
    const fresh = await publish('fresh', 'public');
    await link(LINKS.notReady, fresh.file, 'https://club.example/fresh');

    // A draft's file: stored, never published.
    const draftItem = await insertId(api.pool, `INSERT INTO content_item (slug, kind, office_id) VALUES ('draft', 'article', $1) RETURNING id`, [office]);
    const draftVersion = await insertId(api.pool, `INSERT INTO content_version (item_id, n, title, created_by_sub, acting_office_id) VALUES ($1, 1, 'Draft', 'sub-author', $2) RETURNING id`, [draftItem, office]);
    const draftBytes = Buffer.from('%PDF-1.7\n% draft\n%%EOF\n', 'latin1');
    const draft = await insertId(
      api.pool,
      `INSERT INTO stored_file (version_id, object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ($1, 'k-draft', 'd.pdf', 'application/pdf', $2, $3, 'public') RETURNING id`,
      [draftVersion, draftBytes.length, createHash('sha256').update(draftBytes).digest()],
    );
    await storeOriginal(api.pool, { fileId: draft, bytes: draftBytes, ...STORER });
    await link(LINKS.draft, draft, 'https://club.example/draft');
    await copy(draft, 'public', [LINKS.draft]);

    // A public file whose public copy held a link, and then a new mark gave the public another copy
    // (not made yet) before the link was turned off: the public was still served the copy with it.
    const history = await publish('history', 'public');
    await mark(history.itemId, MarkField.BODY, PHONE, RedactionCategory.MEMBER_PHONE);
    await link(LINKS.historyOff, history.file, 'https://club.example/history', { page: 6 });
    await copy(history.file, 'public', [LINKS.historyOff]);

    // What each audience is served, as the worker records it with each copy (ledger.ts recordClaimedFile).
    await recordAll(api.pool);
    await mark(history.itemId, MarkField.BODY, EMAIL, RedactionCategory.MEMBER_EMAIL);
    await recordAll(api.pool);

    // Turned off after its copy was made (LinkCheckService, L5, through 0024's pdf_link_disable).
    await api.pool.query(`SELECT pdf_link_disable($1, 'parked', 'svc-nwfl-linkcheck', NULL)`, [LINKS.off]);
    await api.pool.query(`SELECT pdf_link_disable($1, 'nxdomain', 'svc-nwfl-linkcheck', NULL)`, [LINKS.membersOff]);
    for (const off of [LINKS.membersCopyOff, LINKS.neverServedOff, LINKS.historyOff]) await api.pool.query(`SELECT pdf_link_disable($1, 'parked', 'svc-nwfl-linkcheck', NULL)`, [off]);
  });

  afterAll(async () => {
    await root?.end();
    await api?.close();
  });

  const statusAt = async (linkId: string): Promise<Date> =>
    (await root.query<{ at: Date }>(`SELECT at FROM pdf_link_status WHERE link_id = $1 ORDER BY at DESC, id DESC LIMIT 1`, [linkId])).rows[0]!.at;

  describe('a link in the copy this audience is served now', () => {
    it('resolves to its URL, host, kind, file, page and the date it was last checked', async () => {
      expect(await ask(LINKS.web)).toEqual({
        status: LinkTargetStatus.ACTIVE,
        url: 'https://club.example/picnic?day=sat',
        host: 'club.example',
        kind: LinkTargetKind.WEB,
        confirm: false,
        fileId: files['trip'],
        page: 2,
        statusAt: await statusAt(LINKS.web),
      });
    });

    it('says when Ross confirmed a login-walled link by hand', async () => {
      expect(await ask(LINKS.social)).toMatchObject({ status: LinkTargetStatus.ACTIVE, host: 'www.social.example', confirm: true });
    });

    it('gives a mail link as kind mail, its host the mail domain', async () => {
      expect(await ask(LINKS.mail)).toMatchObject({ status: LinkTargetStatus.ACTIVE, url: 'mailto:events@example.org', host: 'example.org', kind: LinkTargetKind.MAIL });
    });

    it('resolves for a member from the members copy, and a members file link for a member', async () => {
      expect(await ask(LINKS.web, MEMBER)).toMatchObject({ status: LinkTargetStatus.ACTIVE, url: 'https://club.example/picnic?day=sat' });
      expect(await ask(LINKS.members, MEMBER)).toMatchObject({ status: LinkTargetStatus.ACTIVE, url: 'https://club.example/members-night', fileId: files['club'] });
    });

    it("checks the target against this audience's withheld quotes: a phone members are shown resolves for them", async () => {
      expect(await ask(LINKS.held, MEMBER)).toMatchObject({ status: LinkTargetStatus.ACTIVE, url: `https://club.example/rides/call-${PHONE}` });
    });
  });

  describe('a link turned off', () => {
    it('is DISABLED, with the date it was turned off and its file and page, and no URL, host or kind', async () => {
      expect(await ask(LINKS.off)).toEqual({
        status: LinkTargetStatus.DISABLED,
        url: '',
        host: '',
        kind: LinkTargetKind.UNSPECIFIED,
        confirm: false,
        fileId: files['trip'],
        page: 3,
        statusAt: await statusAt(LINKS.off),
      });
    });

    it('says so to a member for a members file, and is not found for the public', async () => {
      expect(await ask(LINKS.membersOff, MEMBER)).toMatchObject({ status: LinkTargetStatus.DISABLED, url: '', fileId: files['club'] });
      expect(await ask(LINKS.membersOff)).toEqual(await ask(id(99)));
    });

    it('goes only to an audience whose copy carried it: a link only the members copy held is not found for the public', async () => {
      expect(await ask(LINKS.membersCopyOff, MEMBER)).toMatchObject({ status: LinkTargetStatus.DISABLED, url: '', host: '', fileId: files['trip'], page: 4 });
      expect(await ask(LINKS.membersCopyOff)).toEqual(await ask(id(99)));
    });

    it('is not found for members when only the public copy held it', async () => {
      expect(await ask(LINKS.off, MEMBER)).toEqual(await ask(id(99)));
    });

    it('is not found for the public or members when no copy they were served held it', async () => {
      const unknown = await ask(id(99));
      expect(await ask(LINKS.neverServedOff)).toEqual(unknown);
      expect(await ask(LINKS.neverServedOff, MEMBER)).toEqual(unknown);
    });

    it('goes to an audience whose earlier copy held it, though the copy served now is another', async () => {
      expect(await ask(LINKS.historyOff)).toMatchObject({ status: LinkTargetStatus.DISABLED, url: '', page: 6 });
    });

    it('goes to an officer for any link turned off on a file they may have, though no copy of theirs held it', async () => {
      expect(await ask(LINKS.off, OFFICER)).toEqual({
        status: LinkTargetStatus.DISABLED,
        url: '',
        host: '',
        kind: LinkTargetKind.UNSPECIFIED,
        confirm: false,
        fileId: files['trip'],
        page: 3,
        statusAt: await statusAt(LINKS.off),
      });
      expect(await ask(LINKS.neverServedOff, OFFICER)).toMatchObject({ status: LinkTargetStatus.DISABLED, url: '', page: 5 });
      expect(await ask(LINKS.membersOff, OFFICER)).toMatchObject({ status: LinkTargetStatus.DISABLED, url: '', fileId: files['club'] });
    });
  });

  describe('every other id is answered exactly as an unknown one', () => {
    let unknown: Answer;
    beforeAll(async () => {
      unknown = await ask(id(99));
    });

    it('an unknown id is NOT_FOUND, "link not found", with nothing else', () => {
      expect(unknown).toEqual({ error: { code: Code.NotFound, message: '[not_found] link not found', details: [], metadata: expect.any(Array) as unknown } });
    });

    const malformed = ['', LINKS.web.toUpperCase(), `${LINKS.web}a`, LINKS.web.slice(1), `${LINKS.web.slice(0, 25)}1`, `${LINKS.web}?x=1`, `../${LINKS.web}`, `${LINKS.web.slice(0, 25)}é`, ' '.repeat(26), `${LINKS.web}\n`];
    it.each(malformed.map((value) => [JSON.stringify(value), value]))('a malformed id, %s', async (_name, value) => {
      expect(await ask(value)).toEqual(unknown);
    });

    const others: Array<[string, () => string, Options]> = [
      ["another audience's file (a members file, asked by the public)", () => LINKS.members, {}],
      ['a link dropped from the copy served now (held only by an older copy)', () => LINKS.dropped, {}],
      ["a link whose target holds a quote this audience's policy withholds, though the copy holds it", () => LINKS.held, {}],
      ['the same, percent-encoded in the URL', () => LINKS.heldEncoded, {}],
      ['a link of a file not in the copy this audience is served (members, for a public-copy-only link)', () => LINKS.social, MEMBER],
      ['a link of a file a whole-item mark hides', () => LINKS.hidden, {}],
      ['a link of a file whose copy is not made yet', () => LINKS.notReady, {}],
      ["a link of a draft's file, never published", () => LINKS.draft, {}],
      ['a link with no status at all', () => LINKS.noStatus, {}],
      ['an officer, who is served the original with its own links (Q8): an active link', () => LINKS.web, OFFICER],
    ];
    it.each(others)('%s', async (_name, linkId, options) => {
      expect(await ask(linkId(), options)).toEqual(unknown);
    });

    it('a link turned off on a file the reader may not have', async () => {
      expect(await ask(LINKS.membersOff)).toEqual(unknown);
    });
  });

  it('checks the marks as they stand at the read: a new mark on the target holds the link before the next copy is made', async () => {
    const before = await ask(LINKS.mail);
    expect(before).toMatchObject({ status: LinkTargetStatus.ACTIVE });
    await mark(items['trip'] as string, MarkField.BODY, EMAIL, RedactionCategory.MEMBER_EMAIL);
    // The inputs changed, so no copy is current: even the copy a buggy worker made with the link is refused.
    await copy(files['trip'] as string, 'public', [LINKS.mail, LINKS.web]);
    expect(await ask(LINKS.mail)).toEqual(await ask(id(99)));
    expect(await ask(LINKS.web)).toMatchObject({ status: LinkTargetStatus.ACTIVE });
  });

  it('logs no URL, host or link id', () => {
    const logs = dump(api.logs);
    for (const secret of ['club.example', 'social.example', LINKS.web, LINKS.held]) expect(logs).not.toContain(secret);
  });
});
