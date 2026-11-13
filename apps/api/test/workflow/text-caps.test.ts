// MARKUP-DOS round 2, end to end over gRPC: the API itself refuses long text
// before it parses or stores anything, its receive limit keeps multi-megabyte
// messages from any handler, and markup nested too deeply for the tree to be
// stored is refused with a plain reason instead of failing inside the save.
// Synthetic text only.
import { create, toBinary } from '@bufbuild/protobuf';
import { type Client, Code, type ConnectError } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentKind, ContentService, ItemVisibility, SaveDraftRequestSchema, type ContentItem } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import {
  Area,
  EventCategory,
  EventOccurrenceSchema,
  EventSeriesSchema,
  EventService,
  EventVisibility,
  OccurrenceStatus,
  VenueKind,
  VenueSchema,
} from '../../src/gen/nwfl/mensa/v1/event_pb.js';
import { DateSchema } from '../../src/gen/nwfl/mensa/v1/common_pb.js';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { NESTED_TOO_DEEPLY } from '../../src/content/markup.js';
import { READ_MAX_BYTES } from '../../src/grpc/server.js';
import { type Api, as, insertId, startApi } from '../helpers/api.js';
import { live } from '../helpers/pg.js';

const PUB = as('pub-token');
const OFFICER = as('officer-token');
const CAP = 48 * 1024;
const OVER = 'a'.repeat(CAP + 1);

describe('the receive limit', () => {
  it('is 256 KiB, and the fullest SaveDraft the site can send fits under it with room to spare', () => {
    expect(READ_MAX_BYTES).toBe(256 * 1024);
    // 48 KiB of markup (the cap counts bytes), and a title and summary at their limits in four-byte letters.
    const fullest = create(SaveDraftRequestSchema, {
      itemId: '7a0d3d4e-1f1b-4c55-9a51-0b8f1c6a2e01',
      title: '😀'.repeat(200),
      summary: '😀'.repeat(300),
      visibility: ItemVisibility.MEMBERS,
      bodyMarkup: 'a'.repeat(CAP),
    });
    expect(toBinary(SaveDraftRequestSchema, fullest).length * 4).toBeLessThan(READ_MAX_BYTES);
  });
});

describe.skipIf(!live)('long text and deep markup over gRPC', () => {
  let api: Api;
  let content: Client<typeof ContentService>;
  let events: Client<typeof EventService>;
  const offices: Record<string, string> = {};
  let n = 0;

  beforeAll(async () => {
    api = await startApi('nwfl_textcaps');
    content = api.client(ContentService);
    events = api.client(EventService);
    for (const slug of ['publications', 'treasurer']) {
      offices[slug] = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ($1, $1, 'appointed') RETURNING id`, [slug]);
    }
  });

  afterAll(async () => {
    await api?.close();
  });

  const item = async (): Promise<ContentItem> =>
    (await content.createItem({ kind: ContentKind.ARTICLE, officeId: offices['publications'] as string, slug: `caps-${(n += 1)}`, title: 'Fall picnic' }, PUB)).item as ContentItem;
  const save = (itemId: string, bodyMarkup: string, extra: Record<string, unknown> = {}) =>
    content.saveDraft({ itemId, title: 'Fall picnic', summary: 'Saturday at noon', visibility: ItemVisibility.PUBLIC, bodyMarkup, ...extra }, PUB);
  const body = async (itemId: string): Promise<string> => (await content.getWorkingItem({ itemId }, PUB)).item?.working?.bodyMarkup ?? '';

  describe('SaveDraft', () => {
    it('saves markup of exactly 48 KiB as posted, counting each line break as CRLF', async () => {
      const { id } = await item();
      for (const markup of ['a'.repeat(CAP), `${'a'.repeat(CAP - 2)}\n`, `${'a'.repeat(CAP - 2)}\r\n`]) {
        const saved = await save(id, markup);
        expect(saved.problems).toEqual([]);
      }
    });

    it('refuses one byte more, InvalidArgument with a plain reason, and stores nothing', async () => {
      const { id } = await item();
      await save(id, 'Kept.');
      for (const [markup, size] of [
        [OVER, 49],
        [`${'a'.repeat(CAP - 1)}\n`, 49],
        ['é'.repeat(CAP / 2 + 1), 49],
        ['a'.repeat(200 * 1024), 200],
      ] as const) {
        await expect(save(id, markup)).rejects.toMatchObject({ code: Code.InvalidArgument, rawMessage: `Too long: ${size} KB of 48 KB in body_markup` });
      }
      await expect(save(id, 'Kept.', { summary: OVER })).rejects.toMatchObject({ code: Code.InvalidArgument, rawMessage: 'Too long: 49 KB of 48 KB in summary' });
      await expect(save(id, 'Kept.', { title: OVER })).rejects.toMatchObject({ code: Code.InvalidArgument, rawMessage: 'Too long: 49 KB of 48 KB in title' });
      expect(await body(id)).toBe('Kept.');
    });

    it('never lets a message over the receive limit reach the handler, and keeps serving', async () => {
      const { id } = await item();
      await save(id, 'Kept.');
      await expect(save(id, 'a'.repeat(4 * 1024 * 1024 - 4096))).rejects.toMatchObject({ code: Code.ResourceExhausted });
      await expect(save(id, 'a'.repeat(300 * 1024))).rejects.toMatchObject({ code: Code.ResourceExhausted });
      expect(await body(id)).toBe('Kept.');
    });

    it('refuses markup nested deeper than preview and publication show, with a plain reason, and stores nothing', async () => {
      const { id } = await item();
      await save(id, 'Kept.');
      for (const markup of ['>'.repeat(CAP - 1) + 'x', '::: members\n'.repeat(3000), ':members['.repeat(5000), `${'['.repeat(24)}a${'](https://x.example)'.repeat(24)}`, '>'.repeat(24) + ' x', '>'.repeat(22) + ' - x']) {
        await expect(save(id, markup)).rejects.toMatchObject({ code: Code.InvalidArgument, rawMessage: NESTED_TOO_DEEPLY });
      }
      expect(await body(id)).toBe('Kept.');
      // One level less saves, and the preview shows all of it.
      for (const markup of ['>'.repeat(23) + ' x', '>'.repeat(21) + ' - x', `${'['.repeat(23)}a${'](https://x.example)'.repeat(23)}`]) {
        const saved = await save(id, markup);
        expect(saved.problems).toEqual([]);
        const preview = JSON.stringify(await content.previewWorkingItem({ itemId: id }, PUB));
        expect(preview).not.toMatch(/redacted/i);
        expect(preview).toMatch(/"text":"(x|a)"/);
      }
    });

    it('answers an anonymous caller Unauthenticated, whatever the size (the challenger\'s N4)', async () => {
      const { id } = await item();
      for (const markup of ['a', OVER]) {
        await expect(content.saveDraft({ itemId: id, title: 't', summary: '', visibility: ItemVisibility.PUBLIC, bodyMarkup: markup })).rejects.toMatchObject({ code: Code.Unauthenticated });
      }
    });

    it('answers an anonymous CreateItem Unauthenticated, whatever the size (round 4)', async () => {
      for (const extra of [{}, { slug: OVER }, { title: OVER }]) {
        await expect(
          content.createItem({ kind: ContentKind.ARTICLE, officeId: offices['publications'] as string, slug: 'anon-item', title: 'Fall picnic', ...extra }),
        ).rejects.toMatchObject({ code: Code.Unauthenticated });
      }
    });
  });

  it('refuses CreateItem with a title or slug over 48 KiB', async () => {
    for (const field of ['title', 'slug'] as const) {
      await expect(
        content.createItem({ kind: ContentKind.ARTICLE, officeId: offices['publications'] as string, slug: 'caps-create', title: 'Fall picnic', [field]: OVER }, PUB),
      ).rejects.toMatchObject({ code: Code.InvalidArgument, rawMessage: `Too long: 49 KB of 48 KB in ${field}` });
    }
  });

  describe('event writes', () => {
    it('refuses a venue, series or occurrence with a free-text field over 48 KiB, and stores nothing', async () => {
      const venues = async (): Promise<number> => Number((await api.pool.query<{ n: string }>(`SELECT count(*) AS n FROM venue`)).rows[0]?.n);
      const before = await venues();
      const venue = create(VenueSchema, { kind: VenueKind.BUSINESS, name: 'Example Grill', businessAddress: '1 Example Way', area: Area.BAY });
      for (const field of ['accessibilityNote', 'url', 'name', 'businessAddress', 'city'] as const) {
        await expect(events.saveVenue({ venue: { ...venue, [field]: OVER } }, OFFICER)).rejects.toMatchObject({ code: Code.InvalidArgument, rawMessage: expect.stringMatching(/^Too long: 49 KB of 48 KB in /) as unknown });
      }
      expect(await venues()).toBe(before);

      const series = create(EventSeriesSchema, {
        slug: 'caps-lunch',
        title: 'Caps Lunch',
        category: EventCategory.LUNCH,
        recurrence: 'FREQ=WEEKLY;BYDAY=WE',
        startsOn: create(DateSchema, { year: 2026, month: 11, day: 4 }),
        defaultStart: { hours: 11, minutes: 30 },
        defaultDurationMinutes: 90,
        area: Area.BAY,
        hostOfficeId: offices['treasurer'] as string,
        visibility: EventVisibility.PUBLIC,
      });
      for (const field of ['description', 'cadenceLabel', 'recurrence', 'title', 'slug'] as const) {
        await expect(events.saveSeries({ series: { ...series, [field]: OVER } }, as('treasurer-token'))).rejects.toMatchObject({
          code: Code.InvalidArgument,
          rawMessage: expect.stringMatching(/^Too long: 49 KB of 48 KB in /) as unknown,
        });
      }
      expect((await api.pool.query(`SELECT 1 FROM event_series`)).rows).toHaveLength(0);

      const occurrence = create(EventOccurrenceSchema, {
        title: 'One-off',
        startsAt: timestampFromDate(new Date('2026-11-20T17:00:00Z')),
        status: OccurrenceStatus.SCHEDULED,
        visibility: EventVisibility.PUBLIC,
        ownerOfficeId: offices['treasurer'] as string,
      });
      for (const field of ['detail', 'statusNote', 'url', 'title'] as const) {
        await expect(events.saveOccurrence({ occurrence: { ...occurrence, [field]: OVER } }, as('treasurer-token'))).rejects.toMatchObject({
          code: Code.InvalidArgument,
          rawMessage: expect.stringMatching(/^Too long: 49 KB of 48 KB in /) as unknown,
        });
      }
      expect((await api.pool.query(`SELECT 1 FROM event_occurrence`)).rows).toHaveLength(0);
    });

    it('refuses a long echoed reason cleanly: InvalidArgument, clipped, and the session keeps serving (the challenger\'s N1)', async () => {
      const series = create(EventSeriesSchema, {
        slug: 'echo-lunch',
        title: 'Echo Lunch',
        category: EventCategory.LUNCH,
        recurrence: 'FREQ=WEEKLY;BYDAY=WE',
        startsOn: create(DateSchema, { year: 2026, month: 11, day: 4 }),
        defaultStart: { hours: 11, minutes: 30 },
        defaultDurationMinutes: 90,
        area: Area.BAY,
        hostOfficeId: offices['treasurer'] as string,
        visibility: EventVisibility.PUBLIC,
      });
      for (const recurrence of ['€'.repeat(16_384), '\n'.repeat(24_576), 'a'.repeat(CAP)]) {
        const error = (await events.saveSeries({ series: { ...series, recurrence } }, as('treasurer-token')).catch((e: unknown) => e)) as ConnectError;
        expect(error.code).toBe(Code.InvalidArgument);
        expect(error.rawMessage.startsWith('recurrence: ')).toBe(true);
        expect([...error.rawMessage].length).toBeLessThanOrEqual(1_000);
        await expect(events.listVenues({}, as('member-token'))).resolves.toBeDefined();
      }
      const occurrence = create(EventOccurrenceSchema, {
        title: 'One-off',
        startsAt: timestampFromDate(new Date('2026-11-20T17:00:00Z')),
        status: OccurrenceStatus.SCHEDULED,
        visibility: EventVisibility.PUBLIC,
        ownerOfficeId: offices['treasurer'] as string,
      });
      for (const count of [800, 4_900]) {
        const error = (await events.saveOccurrence({ occurrence: { ...occurrence, detail: 'http://x '.repeat(count) } }, as('treasurer-token')).catch((e: unknown) => e)) as ConnectError;
        expect(error.code).toBe(Code.InvalidArgument);
        expect([...error.rawMessage].length).toBeLessThanOrEqual(1_000);
      }
    });

    it('still saves a long description of exactly 48 KiB', async () => {
      const venue = (await events.saveVenue({ venue: create(VenueSchema, { kind: VenueKind.BUSINESS, name: 'Long Note Cafe', area: Area.BAY, accessibilityNote: 'a'.repeat(CAP) }) }, OFFICER)).venue;
      expect(venue?.accessibilityNote).toHaveLength(CAP);
    });
  });
});
