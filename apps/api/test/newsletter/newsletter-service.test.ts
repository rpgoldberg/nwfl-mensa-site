// N2: NewsletterService end to end (R12, P20). Only the agent gets in; the
// items are the edition's approved newsletter items (pinned once frozen); the
// export is the generator's content JSON, members text resolved for MEMBERS
// and replaced for PUBLIC. Every value is made up; the golden exports in
// test/fixtures are what the generator itself was run against.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Client, Code } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Audience } from '../../src/gen/nwfl/mensa/v1/common_pb.js';
import { ContentKind, ContentService, ItemVisibility } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { EditionKind, EditionStatus } from '../../src/gen/nwfl/mensa/v1/edition_pb.js';
import { NewsletterService } from '../../src/gen/nwfl/mensa/v1/newsletter_pb.js';
import { PUBLIC_PLACEHOLDER } from '../../src/newsletter/content-json.js';
import { type Api, as, insertId, startApi } from '../helpers/api.js';
import { live } from '../helpers/pg.js';

const AGENT = as('agent-token');
const PUB = as('pub-token');
const ADMIN = as('admin-token');
const WEBMASTER = as('webmaster-token');
const CANARY = 'canarygatecode4417';
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');

describe.skipIf(!live)('NewsletterService', () => {
  let api: Api;
  let newsletter: Client<typeof NewsletterService>;
  let content: Client<typeof ContentService>;
  let editionId: string;
  let otherEditionId: string;
  const items: Record<string, { id: string; version: string }> = {};
  let publications: string;

  const publish = async (
    slug: string,
    kind: ContentKind,
    markup: string,
    extra: { visibility?: ItemVisibility; edition?: string; newsletter?: boolean; summary?: string; title?: string } = {},
  ) => {
    const title = extra.title ?? slug.replace(/-/g, ' ');
    const itemId = (await content.createItem({ kind, officeId: publications, slug, title }, PUB)).item?.id as string;
    await content.saveDraft({ itemId, title, summary: extra.summary ?? '', bodyMarkup: markup, visibility: extra.visibility ?? ItemVisibility.PUBLIC }, PUB);
    const hash = (await content.markReady({ itemId, editionId: extra.edition ?? editionId, targets: { website: true, newsletter: extra.newsletter ?? true, email: false } }, PUB)).item
      ?.working?.contentHash as Uint8Array;
    const version = (await content.approve({ itemId, contentHash: hash }, WEBMASTER)).item?.live?.id as string;
    items[slug] = { id: itemId, version };
  };

  beforeAll(async () => {
    api = await startApi('nwfl_newsletter');
    newsletter = api.client(NewsletterService);
    content = api.client(ContentService);
    const { pool } = api;
    const office = async (slug: string, title: string, sort: number, alias: string | null = null): Promise<string> =>
      insertId(pool, `INSERT INTO office (slug, title, kind, sort_order, role_alias, role_alias_verified_on) VALUES ($1, $2, 'elected', $3, $4, $5) RETURNING id`, [
        slug,
        title,
        sort,
        alias,
        alias === null ? null : '2026-10-01',
      ]);
    const president = await office('president', 'President', 1, 'president@nwflorida.us');
    const vp = await office('vice-president', 'Vice President', 2, 'vp@nwflorida.us');
    const membership = await office('membership', 'Membership Officer', 3);
    publications = await office('publications', 'Publications Officer', 4);
    const term = (officeId: string, holder: string | null, starts: string, status: string, ends: string | null = null): Promise<unknown> =>
      pool.query(`INSERT INTO office_term (office_id, holder_display_name, starts_on, ends_on, status) VALUES ($1, $2, $3, $4, $5)`, [officeId, holder, starts, ends, status]);
    await term(president, 'Pat Example', '2026-10-01', 'active');
    await term(vp, 'Former Sample', '2024-10-01', 'active', '2027-01-31');
    await term(vp, 'Sam Sample', '2027-02-01', 'active');
    await term(membership, null, '2026-10-01', 'vacant');
    await term(publications, 'Jordan Fictional', '2026-10-01', 'active');

    const grill = await insertId(pool, `INSERT INTO venue (kind, name, business_address, city, area, url) VALUES ('business', 'Example Grill', '100 Example Parkway', 'Panama City', 'bay', 'https://example.org/grill') RETURNING id`);
    const home = await insertId(pool, `INSERT INTO venue (kind, name, area, host_office_id) VALUES ('member_home', 'Host home', 'okaloosa', $1) RETURNING id`, [vp]);
    await pool.query(
      `INSERT INTO event_series (slug, title, category, recurrence, starts_on, default_start, default_venue_id, area, visibility, host_office_id)
       VALUES ('panama-city-lunch', 'Panama City Lunch', 'lunch', 'FREQ=MONTHLY;BYDAY=1SA', '2027-01-02', '11:30', $1, 'bay', 'public', $2)`,
      [grill, president],
    );
    await pool.query(
      `INSERT INTO event_series (slug, title, category, recurrence, starts_on, default_start, default_venue_id, area, visibility, host_office_id, description)
       VALUES ('game-night', 'Game night', 'party', 'FREQ=MONTHLY;BYDAY=3FR', '2027-01-15', '18:00', $1, 'okaloosa', 'members', $2, $3)`,
      [home, vp, `Bring ${CANARY}`],
    );
    await pool.query(
      `INSERT INTO event_occurrence (title, starts_at, visibility, status, status_note, owner_office_id) VALUES ('Fall picnic', '2027-03-13T17:00:00Z', 'public', 'cancelled', 'Rain', $1)`,
      [president],
    );

    editionId = (
      await content.saveEdition(
        {
          edition: {
            slug: '2027-02',
            title: 'February and March 2027',
            kind: EditionKind.REGULAR,
            volume: 31,
            issueNumber: 1,
            periodStart: { year: 2027, month: 2, day: 1 },
            periodEnd: { year: 2027, month: 3, day: 31 },
            calendarRanges: [{ start: { year: 2027, month: 2, day: 1 }, end: { year: 2027, month: 3, day: 31 } }],
            status: EditionStatus.COLLECTING,
          },
        },
        ADMIN,
      )
    ).edition?.id as string;
    otherEditionId = (
      await content.saveEdition(
        { edition: { slug: '2027-04', title: 'April and May 2027', kind: EditionKind.REGULAR, periodStart: { year: 2027, month: 4, day: 1 }, periodEnd: { year: 2027, month: 5, day: 31 } } },
        ADMIN,
      )
    ).edition?.id as string;

    await publish('presidents-report', ContentKind.PRESIDENT_REPORT, `Welcome back.\n\nThe game night code is :members[${CANARY}].\n\nWrite to [the board](mailto:president@nwflorida.us).`);
    await publish('dues-notice', ContentKind.ANNOUNCEMENT, `Members only: ${CANARY} dues details.`, { visibility: ItemVisibility.MEMBERS, summary: 'Dues for 2027' });
    await publish('excomm-minutes', ContentKind.MINUTES, 'Called to order at 10:02. Adjourned at 11:15.');
    // Print order within a kind is by title, then slug; neither agrees with the order these are made in.
    await publish('puzzle-corner', ContentKind.ARTICLE, 'Which number comes next: 2, 3, 5, 7?');
    await publish('zz-book-club', ContentKind.ARTICLE, 'This month: a made-up novel.', { title: 'book club' });
    await publish('book-club-extra', ContentKind.ARTICLE, 'Also: a made-up memoir.', { title: 'book club' });
    // Published, then taken down: never in an edition.
    await publish('withdrawn-note', ContentKind.ARTICLE, 'Taken down.');
    await content.withdraw({ itemId: items['withdrawn-note']?.id as string }, PUB);
    await publish('website-only', ContentKind.ARTICLE, 'Not for print.', { newsletter: false });
    await publish('next-issue', ContentKind.ARTICLE, 'For April.', { edition: otherEditionId });
    // Ready, never approved: never in an edition.
    const pending = (await content.createItem({ kind: ContentKind.ARTICLE, officeId: publications, slug: 'pending', title: 'pending' }, PUB)).item?.id as string;
    await content.saveDraft({ itemId: pending, title: 'pending', bodyMarkup: 'Waiting.' }, PUB);
    await content.markReady({ itemId: pending, editionId }, PUB);
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('who may call it', () => {
    it.each([
      ['an anonymous caller', {}, Code.Unauthenticated],
      ['a member', as('member-token'), Code.PermissionDenied],
      ['an officer', PUB, Code.PermissionDenied],
      ['the Admin', ADMIN, Code.PermissionDenied],
      ['the membership verifier', as('verifier-token'), Code.PermissionDenied],
    ])('refuses %s', async (_label, options, code) => {
      await expect(newsletter.listEditions({}, options)).rejects.toMatchObject({ code });
      await expect(newsletter.exportEdition({ editionId, audience: Audience.MEMBERS }, options)).rejects.toMatchObject({ code });
    });
  });

  it('lists the editions, by status when asked', async () => {
    expect((await newsletter.listEditions({}, AGENT)).editions.map((e) => e.slug)).toEqual(['2027-04', '2027-02']);
    expect((await newsletter.listEditions({ statuses: [EditionStatus.COLLECTING] }, AGENT)).editions.map((e) => e.slug)).toEqual(['2027-02']);
  });

  it('lists the approved newsletter items of the edition only, each with its hash', async () => {
    const listed = (await newsletter.listEditionItems({ editionId }, AGENT)).items;
    expect(listed.map((i) => i.title)).toEqual(['presidents report', 'dues notice', 'book club', 'book club', 'puzzle corner', 'excomm minutes']);
    expect(listed.slice(2, 4).map((i) => i.itemId)).toEqual([items['book-club-extra']?.id, items['zz-book-club']?.id]);
    expect(listed.every((i) => i.contentHash.length === 32 && i.versionNumber === 1)).toBe(true);
    await expect(newsletter.listEditionItems({ editionId: 'nope' }, AGENT)).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(newsletter.listEditionItems({ editionId: '6a1f0c8e-0000-4000-8000-000000000000' }, AGENT)).rejects.toMatchObject({ code: Code.NotFound });
  });

  it('gives the calendar of the edition’s grids in full, members events and cancellations included', async () => {
    const { occurrences, series } = await newsletter.getEditionCalendar({ editionId }, AGENT);
    expect(series.map((s) => s.slug)).toEqual(['game-night', 'panama-city-lunch']);
    const titles = occurrences.map((o) => o.title);
    expect(titles.filter((t) => t === 'Panama City Lunch')).toHaveLength(2);
    expect(titles.filter((t) => t === 'Game night')).toHaveLength(2);
    expect(occurrences.find((o) => o.title === 'Fall picnic')?.statusNote).toBe('Rain');
    expect(occurrences.every((o) => !o.detailsWithheld)).toBe(true);
  });

  it('gives the roster as of the first day of the first grid month', async () => {
    const offices = (await newsletter.getEditionRoster({ editionId }, AGENT)).offices;
    expect(offices.map((o) => [o.slug, o.terms.map((t) => t.holderDisplayName)])).toEqual([
      ['president', ['Pat Example']],
      ['vice-president', ['Sam Sample']],
      ['membership', ['']],
      ['publications', ['Jordan Fictional']],
    ]);
  });

  it('uses the edition’s period when it has no calendar ranges', async () => {
    const offices = (await newsletter.getEditionRoster({ editionId: otherEditionId }, AGENT)).offices;
    expect(offices.find((o) => o.slug === 'vice-president')?.terms.map((t) => t.holderDisplayName)).toEqual(['Sam Sample']);
    const { occurrences } = await newsletter.getEditionCalendar({ editionId: otherEditionId }, AGENT);
    expect([...new Set(occurrences.map((o) => `${o.localDate?.year}-${o.localDate?.month}`))]).toEqual(['2027-4', '2027-5']);
    const exported = JSON.parse((await newsletter.exportEdition({ editionId: otherEditionId, audience: Audience.PUBLIC }, AGENT)).contentJson) as {
      config: { calendar_months: unknown; volume: string };
      articles: Array<{ title: string }>;
    };
    expect(exported.config).toMatchObject({ calendar_months: [{ month: 4, year: 2027 }, { month: 5, year: 2027 }], volume: '' });
    expect(exported.articles.map((a) => a.title)).toEqual(['next issue']);
  });

  describe('ExportEdition', () => {
    const exportOf = async (audience: Audience): Promise<Record<string, unknown>> => {
      const response = await newsletter.exportEdition({ editionId, audience }, AGENT);
      expect(response.contractVersion).toBe('1');
      return JSON.parse(response.contentJson) as Record<string, unknown>;
    };

    const golden = (name: string, actual: unknown): void => {
      const file = path.join(FIXTURES, name);
      if (process.env['NWFL_UPDATE_GOLDEN'] === '1') writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
      expect(actual).toEqual(JSON.parse(readFileSync(file, 'utf8')) as unknown);
    };

    it('matches the golden made-up MEMBERS export, members text resolved', async () => {
      const members = await exportOf(Audience.MEMBERS);
      expect(JSON.stringify(members)).toContain(CANARY);
      golden('export.members.golden.json', members);
    });

    it('matches the golden made-up PUBLIC export, with no members text anywhere', async () => {
      const exported = await exportOf(Audience.PUBLIC);
      const text = JSON.stringify(exported);
      expect(text).not.toContain(CANARY);
      expect(text).toContain(PUBLIC_PLACEHOLDER);
      golden('export.public.golden.json', exported);
    });

    it('carries no personal email, phone or event contact in either audience', async () => {
      for (const audience of [Audience.MEMBERS, Audience.PUBLIC]) {
        const text = JSON.stringify(await exportOf(audience));
        const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
        expect(emails.every((email) => email.endsWith('@nwflorida.us'))).toBe(true);
        expect(text).not.toMatch(/\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/);
        expect(text).not.toMatch(/"(phone|name|email)":/);
      }
    });

    it('pins the frozen edition: a revision approved later is not exported', async () => {
      await content.freezeEdition({ editionId }, ADMIN);
      const item = items['presidents-report'] as { id: string; version: string };
      await content.saveDraft({ itemId: item.id, title: 'presidents report', bodyMarkup: 'A revision after print.' }, PUB);
      const hash = (await content.markReady({ itemId: item.id }, PUB)).item?.working?.contentHash as Uint8Array;
      await content.approve({ itemId: item.id, contentHash: hash }, WEBMASTER);
      const listed = (await newsletter.listEditionItems({ editionId }, AGENT)).items;
      expect(listed.find((i) => i.itemId === item.id)?.versionId).toBe(item.version);
      expect(JSON.stringify(await exportOf(Audience.MEMBERS))).not.toContain('A revision after print.');
    });

    it('leaves out a pinned item withdrawn after the freeze, and brings back its pinned version once it is republished', async () => {
      const item = items['zz-book-club'] as { id: string; version: string };
      const listed = async (): Promise<string[]> => (await newsletter.listEditionItems({ editionId }, AGENT)).items.map((i) => i.versionId);
      await content.withdraw({ itemId: item.id }, PUB);
      expect(await listed()).not.toContain(item.version);
      expect(JSON.stringify(await exportOf(Audience.MEMBERS))).not.toContain('made-up novel');
      // Restore opens a draft; the item is published again only when that is approved.
      await content.restore({ itemId: item.id }, PUB);
      expect(await listed()).not.toContain(item.version);
      const hash = (await content.markReady({ itemId: item.id }, PUB)).item?.working?.contentHash as Uint8Array;
      await content.approve({ itemId: item.id, contentHash: hash }, WEBMASTER);
      expect(await listed()).toContain(item.version);
    });

    it('refuses no audience, and records every export with its audience', async () => {
      await expect(newsletter.exportEdition({ editionId, audience: Audience.UNSPECIFIED }, AGENT)).rejects.toMatchObject({ code: Code.InvalidArgument });
      const { rows } = await api.pool.query<{ actor_kind: string; actor_sub: string; payload: { audience: string } }>(
        `SELECT actor_kind, actor_sub, payload FROM audit_event WHERE action = 'export_read' AND subject_id = $1 ORDER BY id`,
        [editionId],
      );
      expect(rows.length).toBeGreaterThanOrEqual(4);
      expect(rows[0]).toEqual({ actor_kind: 'agent', actor_sub: 'svc-nwfl-newsletter', payload: { audience: 'members' } });
      expect(rows.map((r) => r.payload.audience)).toContain('public');
    });
  });
});
