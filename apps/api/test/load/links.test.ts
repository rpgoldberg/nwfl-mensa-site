// LINKS L2, on the database: the issue loader's nwfl-issue/2 bundle attaches each file's approved
// links in the load's one transaction (before the public input hash is checked), its approval
// reason names the links hash, and a repeated run compares the links too. nwfl-issue/1 loads and
// repeats as before, even once links were attached later. The links command (nwfl-links/1)
// attaches links to an issue already loaded, and nothing else: no content version, file or mark
// changes. Every URL is under a reserved example name; every person is made up.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentService, ItemVisibility } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { applyLinksBundle, parseLinksBundle, runAttach } from '../../src/load/attach.js';
import { LOADER, LoadError, type LoadResult, type Mark, applyBundle, parseBundle } from '../../src/load/load.js';
import { type IssueLinks, linksSha256 } from '../../src/load/links.js';
import { type Api, as, insertId, startApi } from '../helpers/api.js';
import { APP, APP_PW, urlFor, live } from '../helpers/pg.js';
import { linesPdf } from '../pdf/fixtures.js';
import { EMAIL, LINKS, MARKS, bundleJson, linksBundleJson, mailLink, membersPdf, publicInputHash, publicPdf, sha256, stdinOf, webLink } from './bundle.js';

const ADMIN = as('admin-token');
/** The links command's own links: an id is attached once in the whole database, so not LINKS, which the nwfl-issue/2 loads hold. */
const CLI_LINKS: IssueLinks = { public: [webLink(61), mailLink(62)], members: [webLink(63), mailLink(64), webLink(65, 'https://social.example.net/groups/nwfl', true)] };
const WEBMASTER = as('webmaster-token');
/** A made-up venue the public policy withholds (private_venue), beside the withheld address. */
const VENUE = 'Müllerhaus Ballroom';
const VENUE_MARKS: Mark[] = [...MARKS, { quote: VENUE, category: 'private_venue' }];
/** The encoded targets the round-2 and round-3 challengers loaded through both loaders (B1, B3, S4): each must be refused. */
const ENCODED_TARGETS = [
  'https://example.org/redirect?to=https://xn--mllerhaus-ballroom-m6b.example/',
  'https://example.org/l?u=https%3A%2F%2Fxn--mllerhaus-ballroom-m6b.example%2F',
  `https://example.org/t?e=${Buffer.from(EMAIL).toString('base64url')}`,
  'https://example.org/q.brask%25252540example.org',
  // Round 3: a quote one decoder reveals and the next would eat (B3), and a zero-padded HTML reference (S4).
  'https://example.org/xn--qbrask%40example.org',
  'https://example.org/q.brask&#00000064;example.org',
];

describe.skipIf(!live)('approved links, through the loader and the links command', () => {
  let api: Api;
  let database: string;

  /** Row counts of every table a load or an attach writes. */
  const counts = async (): Promise<Record<string, number>> => {
    const tables = ['content_item', 'content_version', 'stored_file', 'pdf_original', 'redaction_mark', 'redaction_mark_anchor', 'audit_event', 'publication_ledger', 'pdf_link', 'pdf_link_status'];
    const out: Record<string, number> = {};
    for (const table of tables) out[table] = Number((await api.pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n);
    return out;
  };
  const linkRows = async (fileId: string) =>
    (
      await api.pool.query<{ id: string; page: number; rect: number[]; url: string; host: string; kind: string; confirm: boolean; approval_reference: string; links_sha256: Buffer; created_by_sub: string }>(
        `SELECT id, page, rect, url, host, kind, confirm, approval_reference, links_sha256, created_by_sub FROM pdf_link WHERE file_id = $1 ORDER BY id`,
        [fileId],
      )
    ).rows;
  const reasonOf = async (itemId: string): Promise<string> =>
    (await api.pool.query<{ reason: string }>(`SELECT v.approval_reason AS reason FROM content_item i JOIN content_version v ON v.id = i.live_version_id WHERE i.id = $1`, [itemId])).rows[0]!.reason;
  /** A loaded issue's period, PDFs and the bundle options that load it. */
  const issue = async (period: string) => ({ period, publicPdf: await publicPdf(period), membersPdf: await membersPdf(period) });
  type Issue = Awaited<ReturnType<typeof issue>>;
  /** An issue that also names the withheld venue, with its marks. */
  const venueIssue = async (period: string) => {
    const lines = ['Game night host: Quillon Brask', 'Rides: call 850-555-0142 by Friday.', 'Potluck at 12 Example Lane on Sunday.', `Write to ${EMAIL} to join.`, `Party at ${VENUE} on Saturday.`];
    return { period, publicPdf: await linesPdf([`Pensa Mensa ${period}`, ...lines]), membersPdf: await linesPdf([`Pensa Mensa ${period}`, ...lines, 'Members only: the board meets Tuesday.']), marks: VENUE_MARKS };
  };
  /** Both files' sha256, as the links hash binds them. */
  const filesOf = (loaded: Issue) => ({ public: sha256(loaded.publicPdf).toString('hex'), members: sha256(loaded.membersPdf).toString('hex') });
  const linksFor = (loaded: Issue, options: { links?: IssueLinks; reference?: string; linksSha256?: string; publicInputHash?: string; slug?: string; publicSha256?: string; membersSha256?: string } = {}) =>
    parseLinksBundle(
      linksBundleJson({
        slug: options.slug ?? `pensa-mensa-${loaded.period}`,
        publicSha256: options.publicSha256 ?? sha256(loaded.publicPdf).toString('hex'),
        membersSha256: options.membersSha256 ?? sha256(loaded.membersPdf).toString('hex'),
        links: options.links ?? CLI_LINKS,
        reference: options.reference,
        linksSha256: options.linksSha256,
        publicInputHash: options.publicInputHash ?? publicInputHash(loaded.publicPdf, MARKS, (options.links ?? CLI_LINKS).public),
      }),
    );

  beforeAll(async () => {
    api = await startApi('nwfl_links');
    database = (await api.pool.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db;
    await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('editor', 'Newsletter Editor', 'appointed') RETURNING id`);
  }, 60_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('nwfl-issue/2', () => {
    let first: Issue;
    let loading: Promise<LoadResult>;
    beforeAll(async () => {
      first = await issue('2026-10');
      loading = bundleJson({ ...first, format: 'nwfl-issue/2' }).then((json) => applyBundle(api.pool, parseBundle(json)));
      await loading.catch(() => undefined);
    });

    it("attaches each file's approved links as the loader, with their hosts, under the approval reference and links hash", async () => {
      const loaded = await loading;
      expect(loaded.status).toBe('loaded');
      const pub = await linkRows(loaded.publicFileId);
      const members = await linkRows(loaded.membersFileId);
      expect(pub.map(({ id, page, rect, url, kind, confirm }) => ({ id, page, rect, url, kind, confirm }))).toEqual(LINKS.public);
      expect(members.map(({ id, page, rect, url, kind, confirm }) => ({ id, page, rect, url, kind, confirm }))).toEqual(LINKS.members);
      expect([...pub, ...members].map((row) => row.host)).toEqual(['example.org', 'example.org', 'example.org', 'example.org', 'social.example.net']);
      for (const row of [...pub, ...members]) expect(row).toMatchObject({ approval_reference: 'PUBCOPY', links_sha256: Buffer.from(linksSha256(filesOf(first), LINKS), 'hex'), created_by_sub: LOADER });
      const active = await api.pool.query(`SELECT DISTINCT status, reason, by_sub FROM pdf_link_status`);
      expect(active.rows).toEqual([{ status: 'active', reason: 'attached', by_sub: LOADER }]);
      const audit = await api.pool.query(`SELECT subject_id, payload->>'links' AS n FROM audit_event WHERE action = 'pdf_links_attach' ORDER BY payload->>'links'`);
      expect(audit.rows).toEqual([
        { subject_id: loaded.publicFileId, n: '2' },
        { subject_id: loaded.membersFileId, n: '3' },
      ]);
    });

    it('names the links hash in the approval reason, after the three hashes of nwfl-issue/1', async () => {
      const loaded = await loading;
      expect(await reasonOf(loaded.itemId)).toBe(
        `Issue loader, approved as PUBCOPY: marks sha256 ${parseBundle(await bundleJson(first)).approval.marksSha256}, public inputHash ${publicInputHash(first.publicPdf, MARKS, LINKS.public)}, members sha256 ${sha256(first.membersPdf).toString('hex')}, links sha256 ${linksSha256(filesOf(first), LINKS)}`,
      );
    });

    it('changes nothing on a repeated run, with the links in any order', async () => {
      const loaded = await loading;
      const before = await counts();
      expect(await applyBundle(api.pool, parseBundle(await bundleJson({ ...first, format: 'nwfl-issue/2' })))).toEqual({ ...loaded, status: 'unchanged' });
      const reordered = { public: [...LINKS.public].reverse(), members: [...LINKS.members].reverse() };
      expect((await applyBundle(api.pool, parseBundle(await bundleJson({ ...first, format: 'nwfl-issue/2', links: reordered })))).status).toBe('unchanged');
      expect(await counts()).toEqual(before);
    });

    it('refuses a repeated run with other links, and one in nwfl-issue/1, never revising the issue', async () => {
      await loading;
      const before = await counts();
      const other = { public: [webLink(1, 'https://example.org/games/other')], members: LINKS.members };
      await expect(applyBundle(api.pool, parseBundle(await bundleJson({ ...first, format: 'nwfl-issue/2', links: other })))).rejects.toThrow(
        /^pensa-mensa-2026-10 is already loaded with other links: the loader never revises an issue$/,
      );
      await expect(applyBundle(api.pool, parseBundle(await bundleJson(first)))).rejects.toThrow(/already loaded under another approval/);
      expect(await counts()).toEqual(before);
    });

    it('loads an issue whose public file has no links, attaching the members file\'s alone', async () => {
      const next = await issue('2026-08');
      const links = { public: [], members: [webLink(11), mailLink(12)] };
      const loaded = await applyBundle(api.pool, parseBundle(await bundleJson({ ...next, format: 'nwfl-issue/2', links })));
      expect(await linkRows(loaded.publicFileId)).toEqual([]);
      expect((await linkRows(loaded.membersFileId)).map((row) => row.id)).toEqual(links.members.map((link) => link.id));
      expect((await applyBundle(api.pool, parseBundle(await bundleJson({ ...next, format: 'nwfl-issue/2', links })))).status).toBe('unchanged');
    });

    it('applies nothing when a link is refused in the database: an id another issue already holds', async () => {
      await loading;
      const next = await issue('2026-06');
      const before = await counts();
      const reused = { public: [webLink(21)], members: [LINKS.members[0]!] };
      await expect(applyBundle(api.pool, parseBundle(await bundleJson({ ...next, format: 'nwfl-issue/2', links: reused })))).rejects.toMatchObject({ code: '23505' });
      expect(await counts()).toEqual(before);
      expect((await api.pool.query(`SELECT 1 FROM content_item WHERE slug = 'pensa-mensa-2026-06'`)).rowCount).toBe(0);
    });

    it("refuses a link whose target holds a passage the public policy withholds, on either file, applying nothing (CONTRACT item 5)", async () => {
      const next = await issue('2023-04');
      const before = await counts();
      const load = async (links: IssueLinks) => applyBundle(api.pool, parseBundle(await bundleJson({ ...next, format: 'nwfl-issue/2', links })));
      await expect(load({ public: [webLink(81), mailLink(82, 'mailto:q.brask@example.org')], members: [] })).rejects.toThrow(
        /^links\.public\[1\]: its target holds a passage the public policy withholds$/,
      );
      await expect(load({ public: [], members: [webLink(83, 'https://example.org/call/850.555.0142')] })).rejects.toThrow(/^links\.members\[0\]: its target holds/);
      await expect(load({ public: [webLink(84, 'https://example.org/q.brask%40example.org')], members: [] })).rejects.toThrow(/^links\.public\[0\]: its target holds/);
      expect(await counts()).toEqual(before);
      // A member's name is shown to the public (0022), so a link that names one is kept.
      expect((await load({ public: [webLink(85, 'https://example.org/quillon-brask')], members: [] })).status).toBe('loaded');
    });

    it('refuses a withheld quote in a nested, base64 or deeply escaped target, applying nothing (CONTRACT item 9)', async () => {
      const next = await venueIssue('2022-03');
      const before = await counts();
      for (const [n, target] of ENCODED_TARGETS.entries()) {
        const bundle = parseBundle(await bundleJson({ ...next, format: 'nwfl-issue/2', links: { public: [webLink(101), webLink(102 + n, target)], members: [] } }));
        await expect(applyBundle(api.pool, bundle)).rejects.toThrow(/^links\.public\[1\]: its target holds a passage the public policy withholds$/);
      }
      expect(await counts()).toEqual(before);
      expect((await applyBundle(api.pool, parseBundle(await bundleJson({ ...next, format: 'nwfl-issue/2', links: { public: [webLink(101)], members: [] } })))).status).toBe('loaded');
    });

    it('still checks the public input hash, after the links are in', async () => {
      const next = await issue('2026-04');
      const before = await counts();
      await expect(applyBundle(api.pool, parseBundle(await bundleJson({ ...next, format: 'nwfl-issue/2', links: { public: [webLink(31)], members: [] }, publicInputHash: 'e'.repeat(64) })))).rejects.toThrow(
        /the public copy's inputs are not the approved ones/,
      );
      expect(await counts()).toEqual(before);
    });
  });

  describe('the links command, nwfl-links/1, on an issue loaded as nwfl-issue/1', () => {
    let loadedIssue: Issue;
    let loaded: LoadResult;
    beforeAll(async () => {
      loadedIssue = await issue('2025-10');
      loaded = await applyBundle(api.pool, parseBundle(await bundleJson(loadedIssue)));
    });

    it('attaches the links, as the loader, and touches no content version, file, mark or approval', async () => {
      const before = await counts();
      const reason = await reasonOf(loaded.itemId);
      const result = await applyLinksBundle(api.pool, linksFor(loadedIssue));
      expect(result).toEqual({ status: 'attached', itemId: loaded.itemId, publicFileId: loaded.publicFileId, membersFileId: loaded.membersFileId, links: { public: 2, members: 3 } });
      const after = await counts();
      expect(after).toEqual({ ...before, pdf_link: before.pdf_link! + 5, pdf_link_status: before.pdf_link_status! + 5, audit_event: before.audit_event! + 2 });
      expect(await reasonOf(loaded.itemId)).toBe(reason);
      expect((await linkRows(loaded.publicFileId)).map((row) => ({ id: row.id, reference: row.approval_reference, by: row.created_by_sub }))).toEqual(
        CLI_LINKS.public.map((link) => ({ id: link.id, reference: 'LINKS', by: LOADER })),
      );
      const queued = await api.pool.query(`SELECT 1 FROM pdf_regen WHERE file_id = ANY($1)`, [[loaded.publicFileId, loaded.membersFileId]]);
      expect(queued.rowCount).toBe(2);
    });

    it('reports unchanged for the same links again, and the nwfl-issue/1 loader still reports unchanged', async () => {
      await applyLinksBundle(api.pool, linksFor(loadedIssue)).catch(() => undefined);
      const before = await counts();
      expect(await applyLinksBundle(api.pool, linksFor(loadedIssue, { links: { public: [...CLI_LINKS.public].reverse(), members: CLI_LINKS.members } }))).toMatchObject({
        status: 'unchanged',
        links: { public: 2, members: 3 },
      });
      expect(await applyBundle(api.pool, parseBundle(await bundleJson(loadedIssue)))).toEqual({ ...loaded, status: 'unchanged' });
      expect(await counts()).toEqual(before);
    });

    it('refuses other links, or the same links under another approval, once a file has links', async () => {
      await applyLinksBundle(api.pool, linksFor(loadedIssue)).catch(() => undefined);
      const before = await counts();
      await expect(applyLinksBundle(api.pool, linksFor(loadedIssue, { links: { public: [webLink(41)], members: [] } }))).rejects.toThrow(
        /^pensa-mensa-2025-10 already has other links: a file's links are attached once$/,
      );
      await expect(applyLinksBundle(api.pool, linksFor(loadedIssue, { reference: 'LINKS-2' }))).rejects.toThrow(/already has other links/);
      expect(await counts()).toEqual(before);
    });

    describe('the refusals, each leaving nothing behind', () => {
      const refused = async (bundle: ReturnType<typeof linksFor>, message: RegExp): Promise<void> => {
        const before = await counts();
        const error = await applyLinksBundle(api.pool, bundle).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(LoadError);
        expect((error as Error).message).toMatch(message);
        expect(await counts()).toEqual(before);
      };

      it('refuses an issue that was never loaded', async () => {
        await refused(linksFor(await issue('2024-02')), /^pensa-mensa-2024-02 is not loaded: links are attached only to a loaded issue$/);
      });

      it('refuses a slug the loader did not write', async () => {
        const office = (await api.pool.query<{ id: string }>(`SELECT id FROM office WHERE slug = 'editor'`)).rows[0]!.id;
        await api.pool.query(`INSERT INTO content_item (slug, kind, office_id) VALUES ('pensa-mensa-2024-04', 'document', $1)`, [office]);
        await refused(linksFor(await issue('2024-04')), /^pensa-mensa-2024-04 was not written by the loader: it is never touched$/);
      });

      it('refuses an issue with a draft edit waiting, or whose edit someone else approved, or that was withdrawn', async () => {
        const draft = (itemId: string, title: string) =>
          api.client(ContentService).saveDraft({ itemId, title, summary: 'Volume 30, Number 5', visibility: ItemVisibility.PUBLIC, bodyMarkup: '' }, ADMIN);
        const waiting = await issue('2024-06');
        const one = await applyBundle(api.pool, parseBundle(await bundleJson(waiting)));
        await draft(one.itemId, 'Pensa Mensa (corrected)');
        await refused(linksFor(waiting), /^pensa-mensa-2024-06 was edited or withdrawn after loading: links are attached only to an issue as loaded$/);

        const approved = await issue('2024-07');
        const two = await applyBundle(api.pool, parseBundle(await bundleJson(approved)));
        await draft(two.itemId, 'Pensa Mensa (corrected)');
        const content = api.client(ContentService);
        const hash = (await content.markReady({ itemId: two.itemId, targets: { website: true, newsletter: false, email: false } }, ADMIN)).item?.working?.contentHash as Uint8Array;
        await content.approve({ itemId: two.itemId, contentHash: hash }, WEBMASTER);
        await content.publish({ itemId: two.itemId, contentHash: hash }, WEBMASTER);
        await refused(linksFor(approved), /^pensa-mensa-2024-07 was edited or withdrawn after loading/);

        const withdrawn = await issue('2024-08');
        const three = await applyBundle(api.pool, parseBundle(await bundleJson(withdrawn)));
        await content.withdraw({ itemId: three.itemId }, WEBMASTER);
        await refused(linksFor(withdrawn), /^pensa-mensa-2024-08 was edited or withdrawn after loading/);
      });

      it("refuses links approved for another issue: its hash names that issue's files (CONTRACT item 4)", async () => {
        const other = await issue('2023-06');
        await applyBundle(api.pool, parseBundle(await bundleJson(other)));
        // The other issue's own files, with this issue's approved hash: refused before the database.
        expect(() => linksFor(other, { linksSha256: linksSha256(filesOf(loadedIssue), CLI_LINKS) })).toThrow(/^the links are not the approved ones/);
        // This issue's files and hash, named as the other issue: its files are not the bundle's.
        await refused(linksFor(loadedIssue, { slug: 'pensa-mensa-2023-06' }), /^pensa-mensa-2023-06's files are not the bundle's/);
      });

      it('refuses a link whose target holds a passage the public policy withholds (CONTRACT item 5)', async () => {
        const fresh = await issue('2023-08');
        await applyBundle(api.pool, parseBundle(await bundleJson(fresh)));
        await refused(linksFor(fresh, { links: { public: [webLink(86)], members: [webLink(87, 'https://12.example.lane.example.org/')] } }), /^links\.members\[0\]: its target holds a passage the public policy withholds$/);
      });

      it('refuses a withheld quote in a nested, base64 or deeply escaped target (CONTRACT item 9)', async () => {
        const fresh = await venueIssue('2022-05');
        await applyBundle(api.pool, parseBundle(await bundleJson(fresh)));
        const inputs = publicInputHash(fresh.publicPdf, VENUE_MARKS, [webLink(111)]);
        for (const [n, target] of ENCODED_TARGETS.entries()) {
          await refused(linksFor(fresh, { links: { public: [webLink(111)], members: [webLink(112 + n, target)] }, publicInputHash: inputs }), /^links\.members\[0\]: its target holds a passage the public policy withholds$/);
        }
        expect((await applyLinksBundle(api.pool, linksFor(fresh, { links: { public: [webLink(111)], members: [] }, publicInputHash: inputs }))).status).toBe('attached');
      });

      it('refuses, never reports unchanged, when the two files hold the same hash under two approvals', async () => {
        const fresh = await issue('2023-09');
        const one = await applyBundle(api.pool, parseBundle(await bundleJson(fresh)));
        const links: IssueLinks = { public: [webLink(88)], members: [webLink(89)] };
        const hash = Buffer.from(linksSha256(filesOf(fresh), links), 'hex');
        const rows = (list: IssueLinks['public']) => JSON.stringify(list.map((link) => ({ ...link, host: 'example.org' })));
        // Straight through the one writer: the public file under LINKS, the members file under OTHER.
        await api.pool.query(`SELECT pdf_links_attach($1, $2::jsonb, 'LINKS', $3, $4, NULL)`, [one.publicFileId, rows(links.public), hash, LOADER]);
        await api.pool.query(`SELECT pdf_links_attach($1, $2::jsonb, 'OTHER', $3, $4, NULL)`, [one.membersFileId, rows(links.members), hash, LOADER]);
        for (const reference of ['LINKS', 'OTHER']) await refused(linksFor(fresh, { links, reference }), /^pensa-mensa-2023-09 already has other links/);
      });

      it("refuses files other than the issue's, by either sha256", async () => {
        await refused(linksFor(loadedIssue, { publicSha256: 'f'.repeat(64) }), /^pensa-mensa-2025-10's files are not the bundle's: links are attached only to the files approved with them$/);
        await refused(linksFor(loadedIssue, { membersSha256: sha256(loadedIssue.publicPdf).toString('hex') }), /files are not the bundle's/);
      });

      it('refuses a public input hash other than the approved one, naming the one it computed', async () => {
        const fresh = await issue('2024-09');
        await applyBundle(api.pool, parseBundle(await bundleJson(fresh)));
        await refused(linksFor(fresh, { publicInputHash: 'c'.repeat(64), links: { public: [webLink(71)], members: [] } }), new RegExp(`^the public copy's inputs are not the approved ones: computed ${publicInputHash(fresh.publicPdf, MARKS, [webLink(71)])}$`));
      });
    });

    describe('the command', () => {
      it('attaches from a pipe in production mode, prints ids and counts only, then reports unchanged', async () => {
        const fresh = await issue('2024-10');
        await applyBundle(api.pool, parseBundle(await bundleJson(fresh)));
        const env = { NODE_ENV: 'production', DATABASE_URL: urlFor(APP, APP_PW, database) };
        const json = JSON.stringify(
          linksBundleJson({
            slug: 'pensa-mensa-2024-10',
            publicSha256: sha256(fresh.publicPdf).toString('hex'),
            membersSha256: sha256(fresh.membersPdf).toString('hex'),
            links: { public: [webLink(51)], members: [webLink(52), mailLink(53)] },
            publicInputHash: publicInputHash(fresh.publicPdf, MARKS, [webLink(51)]),
          }),
        );
        const lines: string[] = [];
        expect(await runAttach(['-'], env, stdinOf(json, 'pipe'), (line) => lines.push(line))).toBe(0);
        expect(await runAttach(['-'], env, stdinOf(json, 'socket'), (line) => lines.push(line))).toBe(0);
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatch(/^attached: item [0-9a-f-]{36}, public file [0-9a-f-]{36} \(1 links\), members file [0-9a-f-]{36} \(2 links\)$/);
        expect(lines[1]).toBe(lines[0]!.replace(/^attached/, 'unchanged'));
        expect(lines.join('\n')).not.toContain('example');
      });

      it('exits 1, nothing applied, on a database-side refusal', async () => {
        const lines: string[] = [];
        const json = JSON.stringify(linksBundleJson({ slug: 'pensa-mensa-2023-02', publicSha256: 'a'.repeat(64), membersSha256: 'b'.repeat(64), publicInputHash: 'c'.repeat(64) }));
        expect(await runAttach(['-'], { DATABASE_URL: urlFor(APP, APP_PW, database) }, stdinOf(json), (line) => lines.push(line))).toBe(1);
        expect(lines).toEqual(['links refused, nothing applied: pensa-mensa-2023-02 is not loaded: links are attached only to a loaded issue']);
      });

      it('exits 1, naming only the driver code, when the database refuses a link', async () => {
        const fresh = await issue('2024-11');
        await applyBundle(api.pool, parseBundle(await bundleJson(fresh)));
        const lines: string[] = [];
        const json = JSON.stringify(
          linksBundleJson({
            slug: 'pensa-mensa-2024-11',
            publicSha256: sha256(fresh.publicPdf).toString('hex'),
            membersSha256: sha256(fresh.membersPdf).toString('hex'),
            links: { public: [LINKS.public[0]!], members: [] },
            publicInputHash: publicInputHash(fresh.publicPdf, MARKS, [LINKS.public[0]!]),
          }),
        );
        expect(await runAttach(['-'], { DATABASE_URL: urlFor(APP, APP_PW, database) }, stdinOf(json), (line) => lines.push(line))).toBe(1);
        expect(lines).toEqual(['links failed, nothing applied: 23505']);
      });
    });
  });
});
