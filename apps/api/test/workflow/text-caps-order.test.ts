// MARKUP-DOS round 3 (the challenger's S4): over-cap text is refused BEFORE it is parsed or checked. Spies on
// the markup parser, the recurrence parser and the URL rule must see nothing of an oversized request.
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { type Client, Code } from '@connectrpc/connect';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as markup from '../../src/content/markup.js';
import * as recurrence from '../../src/events/recurrence.js';
import * as rule from '../../src/links/rule.js';
import { ContentKind, ContentService, ItemVisibility, type ContentItem } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { Area, EventCategory, EventOccurrenceSchema, EventSeriesSchema, EventService, EventVisibility, OccurrenceStatus, VenueKind, VenueSchema } from '../../src/gen/nwfl/mensa/v1/event_pb.js';
import { type Api, as, insertId, startApi } from '../helpers/api.js';
import { live } from '../helpers/pg.js';

vi.mock('../../src/content/markup.js', async (original) => {
  const actual = await original<typeof markup>();
  return { ...actual, parseMarkup: vi.fn(actual.parseMarkup) };
});
vi.mock('../../src/events/recurrence.js', async (original) => {
  const actual = await original<typeof recurrence>();
  return { ...actual, parseRule: vi.fn(actual.parseRule) };
});
vi.mock('../../src/links/rule.js', async (original) => {
  const actual = await original<typeof rule>();
  return { ...actual, urlProblem: vi.fn(actual.urlProblem), textUrlProblems: vi.fn(actual.textUrlProblems) };
});

const PUB = as('pub-token');
const TREASURER = as('treasurer-token');
const OVER = 'a'.repeat(48 * 1024 + 1);

describe.skipIf(!live)('long text is refused before anything reads it', () => {
  let api: Api;
  let content: Client<typeof ContentService>;
  let events: Client<typeof EventService>;
  const offices: Record<string, string> = {};

  beforeAll(async () => {
    api = await startApi('nwfl_textorder');
    content = api.client(ContentService);
    events = api.client(EventService);
    for (const slug of ['publications', 'treasurer']) {
      offices[slug] = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ($1, $1, 'appointed') RETURNING id`, [slug]);
    }
  });

  afterAll(async () => {
    await api?.close();
  });

  beforeEach(() => {
    vi.mocked(markup.parseMarkup).mockClear();
    vi.mocked(recurrence.parseRule).mockClear();
    vi.mocked(rule.urlProblem).mockClear();
    vi.mocked(rule.textUrlProblems).mockClear();
  });

  it('SaveDraft: the markup parser never sees an oversized body, title or summary', async () => {
    const item = (await content.createItem({ kind: ContentKind.ARTICLE, officeId: offices['publications'] as string, slug: 'order-1', title: 'Fall picnic' }, PUB)).item as ContentItem;
    const draft = { itemId: item.id, title: 'Fall picnic', summary: 'Noon', visibility: ItemVisibility.PUBLIC, bodyMarkup: 'Fine.' };
    await content.saveDraft(draft, PUB);
    expect(markup.parseMarkup).toHaveBeenCalledTimes(1);
    vi.mocked(markup.parseMarkup).mockClear();
    for (const extra of [{ bodyMarkup: OVER }, { title: OVER }, { summary: OVER }]) {
      await expect(content.saveDraft({ ...draft, ...extra }, PUB)).rejects.toMatchObject({ code: Code.InvalidArgument });
    }
    expect(markup.parseMarkup).not.toHaveBeenCalled();
  });

  it('SaveSeries: the recurrence parser never sees an oversized field', async () => {
    const series = create(EventSeriesSchema, {
      slug: 'order-lunch',
      title: 'Order Lunch',
      category: EventCategory.LUNCH,
      recurrence: 'FREQ=WEEKLY;BYDAY=WE',
      defaultStart: { hours: 11, minutes: 30 },
      defaultDurationMinutes: 90,
      area: Area.BAY,
      hostOfficeId: offices['treasurer'] as string,
      visibility: EventVisibility.PUBLIC,
      startsOn: { year: 2026, month: 11, day: 4 },
    });
    for (const field of ['recurrence', 'description', 'cadenceLabel'] as const) {
      await expect(events.saveSeries({ series: { ...series, [field]: OVER } }, TREASURER)).rejects.toMatchObject({ code: Code.InvalidArgument });
    }
    expect(recurrence.parseRule).not.toHaveBeenCalled();
  });

  it('SaveVenue and SaveOccurrence: the URL rule never sees an oversized url or detail', async () => {
    const venue = create(VenueSchema, { kind: VenueKind.BUSINESS, name: 'Example Grill', area: Area.BAY });
    await expect(events.saveVenue({ venue: { ...venue, url: `https://a.example/${OVER}` } }, as('officer-token'))).rejects.toMatchObject({ code: Code.InvalidArgument });
    const occurrence = create(EventOccurrenceSchema, {
      title: 'One-off',
      startsAt: timestampFromDate(new Date('2026-11-20T17:00:00Z')),
      status: OccurrenceStatus.SCHEDULED,
      visibility: EventVisibility.PUBLIC,
      ownerOfficeId: offices['treasurer'] as string,
    });
    for (const extra of [{ detail: `http://x.example ${OVER}` }, { url: `https://a.example/${OVER}` }]) {
      await expect(events.saveOccurrence({ occurrence: { ...occurrence, ...extra } }, TREASURER)).rejects.toMatchObject({ code: Code.InvalidArgument });
    }
    expect(rule.urlProblem).not.toHaveBeenCalled();
    expect(rule.textUrlProblems).not.toHaveBeenCalled();
  });
});
