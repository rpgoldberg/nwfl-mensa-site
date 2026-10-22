// ContentService reads (R2, R5, R22, R26): the roster, published items with
// the body filtered for the caller's audience, and published editions.
import { type Client, Code } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentKind, ContentService, ItemState, ItemVisibility } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { TermStatus } from '../../src/gen/nwfl/mensa/v1/roster_pb.js';
import { type Api, MEMBER, OFFICER, dump, insertId, startApi } from '../helpers/api.js';
import { membersSpan, paragraph, publishItem, text } from '../helpers/content.js';
import { live } from '../helpers/pg.js';

const HIDDEN = 'pavilion-three-gate';

describe.skipIf(!live)('ContentService reads', () => {
  let api: Api;
  let content: Client<typeof ContentService>;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    api = await startApi('nwfl_content');
    content = api.client(ContentService);
    const { pool } = api;
    ids['president'] = await insertId(pool, `INSERT INTO office (slug, title, kind, sort_order, role_alias, role_alias_verified_on) VALUES ('president', 'President', 'elected', 1, 'president@nwflorida.us', '2026-10-01') RETURNING id`);
    ids['treasurer'] = await insertId(pool, `INSERT INTO office (slug, title, kind, sort_order, role_alias) VALUES ('treasurer', 'Treasurer', 'elected', 2, 'treasurer@nwflorida.us') RETURNING id`);
    ids['membership'] = await insertId(pool, `INSERT INTO office (slug, title, kind, sort_order) VALUES ('membership', 'Membership Officer', 'appointed', 3) RETURNING id`);
    await pool.query(`INSERT INTO office (slug, title, kind, sort_order, active) VALUES ('historian', 'Historian', 'appointed', 4, false)`);
    await pool.query(`INSERT INTO office_term (office_id, holder_display_name, starts_on, ends_on, status) VALUES ($1, 'Former Example', '2024-10-01', '2026-09-30', 'active')`, [ids['president']]);
    await pool.query(`INSERT INTO office_term (office_id, holder_display_name, starts_on, status) VALUES ($1, 'Pat Example', '2026-10-01', 'active')`, [ids['president']]);
    await pool.query(`INSERT INTO office_term (office_id, holder_display_name, starts_on, status) VALUES ($1, 'Sam Sample', '2026-10-01', 'acting')`, [ids['treasurer']]);
    await pool.query(`INSERT INTO office_term (office_id, starts_on, status) VALUES ($1, '2026-10-01', 'vacant')`, [ids['membership']]);
    await pool.query(`INSERT INTO office_term (office_id, holder_display_name, starts_on, status) VALUES ($1, 'Future Example', '2026-12-01', 'active')`, [ids['membership']]);

    const report = await publishItem(pool, {
      slug: 'presidents-report-october',
      officeId: ids['president'],
      kind: 'president_report',
      title: "President's report",
      summary: 'October',
      body: { blocks: [paragraph(text('The picnic is at '), membersSpan(HIDDEN), text('.'))] },
      approvedAt: '2026-10-10T12:00:00Z',
    });
    ids['report'] = report.itemId;
    ids['reportVersion'] = report.versionId;
    for (const [name, audience, mime, role] of [
      ['flyer.pdf', 'public', 'application/pdf', 'primary'],
      ['map.pdf', 'members', 'application/pdf', 'primary'],
      ['draft.docx', 'officers', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'source'],
    ] as const) {
      await pool.query(
        `INSERT INTO stored_file (version_id, object_key, filename, mime_type, size_bytes, sha256, audience, role) VALUES ($1, $2, $2, $3, 10, $4, $5, $6)`,
        [report.versionId, name, mime, Buffer.alloc(32, 1), audience, role],
      );
    }
    await publishItem(pool, { slug: 'members-notice', officeId: ids['president'], kind: 'announcement', visibility: 'members', title: 'Dues reminder', summary: 'For members', body: { blocks: [paragraph(text(HIDDEN))] }, approvedAt: '2026-10-12T12:00:00Z' });
    await publishItem(pool, { slug: 'officers-memo', officeId: ids['treasurer'], kind: 'document', visibility: 'officers', title: 'Bank signatories', body: { blocks: [paragraph(text(HIDDEN))] }, approvedAt: '2026-10-14T12:00:00Z' });
    await publishItem(pool, {
      slug: 'column-loaded-from-public-ast',
      officeId: ids['treasurer'],
      title: 'Treasurer summary',
      body: { blocks: [paragraph(text('BODY-AST-ONLY'))] },
      publicAst: { blocks: [paragraph(text('PUBLIC-AST-COLUMN')), { type: 'members', children: [paragraph(text(HIDDEN))] }] },
      approvedAt: '2026-10-05T12:00:00Z',
    });
    const withdrawn = await publishItem(pool, { slug: 'withdrawn-item', officeId: ids['president'], title: 'Old notice', body: { blocks: [] }, approvedAt: '2026-09-01T12:00:00Z' });
    await pool.query(`UPDATE content_item SET state = 'withdrawn', withdrawn_at = '2026-10-20T12:00:00Z' WHERE id = $1`, [withdrawn.itemId]);
    await pool.query(`INSERT INTO content_item (slug, kind, office_id) VALUES ('never-published', 'article', $1)`, [ids['president']]);

    for (const [slug, status, start, fileAudience] of [
      ['2026-08', 'published', '2026-08-01', 'public'],
      ['2026-10', 'published', '2026-10-01', 'members'],
      ['2026-12', 'collecting', '2026-12-01', null],
    ] as const) {
      const edition = await insertId(pool, `INSERT INTO edition (slug, title, kind, period_start, period_end, status, volume, issue_number) VALUES ($1, $1, 'regular', $2, ($2::date + 60), $3, 30, 4) RETURNING id`, [slug, start, status]);
      if (fileAudience !== null) {
        const file = await insertId(pool, `INSERT INTO stored_file (edition_id, object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ($1, $2, $2, 'application/pdf', 10, $3, $4) RETURNING id`, [edition, `pdf-${slug}`, Buffer.alloc(32, 2), fileAudience]);
        // Only a public file of the edition can be its hosted PDF (0007); a members file stays unlinked.
        if (fileAudience === 'public') await pool.query(`UPDATE edition SET public_pdf_file_id = $2 WHERE id = $1`, [edition, file]);
        ids[`pdf-${slug}`] = file;
        await pool.query(`INSERT INTO edition_calendar_range (edition_id, starts_on, ends_on) VALUES ($1, $2, ($2::date + 30))`, [edition, start]);
      }
    }
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('GetRoster', () => {
    it('lists active offices in order with their current terms, a vacancy as a term with no holder', async () => {
      const { offices } = await content.getRoster({});
      expect(offices.map((o) => [o.slug, o.terms.map((t) => [t.holderDisplayName, t.status])])).toEqual([
        ['president', [['Pat Example', TermStatus.ACTIVE]]],
        ['treasurer', [['Sam Sample', TermStatus.ACTING]]],
        ['membership', [['', TermStatus.VACANT]]],
      ]);
    });

    it('shows a role alias only once a test message to it has been delivered', async () => {
      const { offices } = await content.getRoster({});
      expect(offices.map((o) => o.roleAlias)).toEqual(['president@nwflorida.us', '', '']);
    });
  });

  describe('GetPublishedItem', () => {
    it('gives the public the filtered tree: the members passage is a bare placeholder', async () => {
      const { item } = await content.getPublishedItem({ slug: 'presidents-report-october' });
      expect(item).toMatchObject({ kind: ContentKind.PRESIDENT_REPORT, state: ItemState.PUBLISHED, officeId: ids['president'] });
      expect(dump(item)).not.toContain(HIDDEN);
      const inlines = item?.live?.body?.blocks[0]?.kind;
      expect(inlines?.case === 'paragraph' && inlines.value.inlines.map((i) => i.kind.case)).toEqual(['text', 'redacted', 'text']);
      expect(item?.live?.contentHash.length).toBe(0);
      expect(item?.live?.bodyMarkup).toBe('');
      expect(item?.working).toBeUndefined();
    });

    it('gives a member the members passage, marked as such', async () => {
      const { item } = await content.getPublishedItem({ slug: 'presidents-report-october' }, MEMBER);
      const inlines = item?.live?.body?.blocks[0]?.kind;
      expect(inlines?.case === 'paragraph' && inlines.value.inlines.map((i) => i.kind.case)).toEqual(['text', 'members', 'text']);
      expect(dump(item)).toContain(HIDDEN);
      expect(item?.live?.contentHash.length).toBe(0);
    });

    it('returns the content hash to officers only', async () => {
      const { item } = await content.getPublishedItem({ slug: 'presidents-report-october' }, OFFICER);
      expect(item?.live?.contentHash.length).toBe(32);
    });

    it("lists only the files the caller's audience may have", async () => {
      const names = async (options = {}) => (await content.getPublishedItem({ slug: 'presidents-report-october' }, options)).item?.live?.files.map((f) => f.filename);
      expect(await names()).toEqual(['flyer.pdf']);
      expect(await names(MEMBER)).toEqual(['flyer.pdf', 'map.pdf']);
      expect(await names(OFFICER)).toEqual(['draft.docx', 'flyer.pdf', 'map.pdf']);
    });

    it('reads public_ast for the public, never body_ast, and re-filters it', async () => {
      const publicItem = dump((await content.getPublishedItem({ slug: 'column-loaded-from-public-ast' })).item);
      expect(publicItem).toContain('PUBLIC-AST-COLUMN');
      expect(publicItem).not.toContain('BODY-AST-ONLY');
      expect(publicItem).not.toContain(HIDDEN);
      expect(dump((await content.getPublishedItem({ slug: 'column-loaded-from-public-ast' }, MEMBER)).item)).toContain('BODY-AST-ONLY');
    });

    it('gives the public only the title and summary of a members item', async () => {
      const { item } = await content.getPublishedItem({ slug: 'members-notice' });
      expect(item?.live).toMatchObject({ title: 'Dues reminder', summary: 'For members', visibility: ItemVisibility.MEMBERS });
      expect(item?.live?.body?.blocks.map((b) => b.kind.case)).toEqual(['redacted']);
      expect(dump(item)).not.toContain(HIDDEN);
      expect(dump((await content.getPublishedItem({ slug: 'members-notice' }, MEMBER)).item)).toContain(HIDDEN);
    });

    it('answers NOT_FOUND for an officers item unless the caller is an officer', async () => {
      await expect(content.getPublishedItem({ slug: 'officers-memo' })).rejects.toMatchObject({ code: Code.NotFound });
      await expect(content.getPublishedItem({ slug: 'officers-memo' }, MEMBER)).rejects.toMatchObject({ code: Code.NotFound });
      expect((await content.getPublishedItem({ slug: 'officers-memo' }, OFFICER)).item?.live?.title).toBe('Bank signatories');
    });

    it('marks a withdrawn item with its date and nothing else', async () => {
      const { item } = await content.getPublishedItem({ slug: 'withdrawn-item' });
      expect(item).toMatchObject({ state: ItemState.WITHDRAWN, slug: 'withdrawn-item' });
      expect(item?.withdrawnAt?.seconds).toBe(BigInt(Date.parse('2026-10-20T12:00:00Z') / 1000));
      expect(item?.live).toBeUndefined();
    });

    it('answers NOT_FOUND for an unknown or never-published slug', async () => {
      await expect(content.getPublishedItem({ slug: 'never-published' })).rejects.toMatchObject({ code: Code.NotFound });
      await expect(content.getPublishedItem({ slug: 'no-such-item' })).rejects.toMatchObject({ code: Code.NotFound });
    });
  });

  describe('ListPublishedItems', () => {
    it('lists published items newest first, without officers items for the public', async () => {
      const { items } = await content.listPublishedItems({});
      expect(items.map((i) => i.slug)).toEqual(['members-notice', 'presidents-report-october', 'column-loaded-from-public-ast']);
      expect(dump(items)).not.toContain(HIDDEN);
      expect((await content.listPublishedItems({}, OFFICER)).items.map((i) => i.slug)).toContain('officers-memo');
    });

    it('filters by kind and office', async () => {
      expect((await content.listPublishedItems({ kind: ContentKind.ANNOUNCEMENT })).items.map((i) => i.slug)).toEqual(['members-notice']);
      expect((await content.listPublishedItems({ officeId: ids['treasurer'] })).items.map((i) => i.slug)).toEqual(['column-loaded-from-public-ast']);
    });

    it('pages with an opaque token', async () => {
      const first = await content.listPublishedItems({ pageSize: 2 });
      expect(first.items.map((i) => i.slug)).toEqual(['members-notice', 'presidents-report-october']);
      const second = await content.listPublishedItems({ pageSize: 2, pageToken: first.nextPageToken });
      expect(second.items.map((i) => i.slug)).toEqual(['column-loaded-from-public-ast']);
      expect(second.nextPageToken).toBe('');
    });

    it('refuses a page token it did not issue and a negative page size', async () => {
      const forged = (parts: string[]): string => Buffer.from(JSON.stringify(parts)).toString('base64url');
      await expect(content.listPublishedItems({ pageToken: 'garbage' })).rejects.toMatchObject({ code: Code.InvalidArgument });
      await expect(content.listPublishedItems({ pageToken: forged(['items', 'yesterday', 'x']) })).rejects.toMatchObject({ code: Code.InvalidArgument });
      await expect(content.listPublishedItems({ pageToken: forged(['editions', '2026-10-01', ids['president'] as string]) })).rejects.toMatchObject({ code: Code.InvalidArgument });
      await expect(content.listPublishedEditions({ pageToken: forged(['editions', 'October', 'x']) })).rejects.toMatchObject({ code: Code.InvalidArgument });
      await expect(content.listPublishedItems({ officeId: 'treasurer' })).rejects.toMatchObject({ code: Code.InvalidArgument });
      await expect(content.listPublishedItems({ pageSize: -1 })).rejects.toMatchObject({ code: Code.InvalidArgument });
    });
  });

  describe('ListPublishedEditions', () => {
    it('lists published editions newest first, with the PDF only when that file is public', async () => {
      const { editions } = await content.listPublishedEditions({});
      expect(editions.map((e) => [e.slug, e.publicPdfFileId])).toEqual([
        ['2026-10', ''],
        ['2026-08', ids['pdf-2026-08']],
      ]);
      expect(editions[0]).toMatchObject({ volume: 30, issueNumber: 4 });
      expect(editions[1]?.calendarRanges.map((r) => [r.start?.day, r.end?.month, r.end?.day])).toEqual([[1, 8, 31]]);
    });

    it('pages, and refuses a bad token', async () => {
      const first = await content.listPublishedEditions({ pageSize: 1 });
      expect(first.editions.map((e) => e.slug)).toEqual(['2026-10']);
      const second = await content.listPublishedEditions({ pageSize: 1, pageToken: first.nextPageToken });
      expect(second.editions.map((e) => e.slug)).toEqual(['2026-08']);
      await expect(content.listPublishedEditions({ pageToken: 'x' })).rejects.toMatchObject({ code: Code.InvalidArgument });
    });
  });

  it('leaves the officer workflow RPCs unimplemented until A4b', async () => {
    await expect(content.listWorkingItems({}, OFFICER)).rejects.toMatchObject({ code: Code.Unimplemented });
  });
});
