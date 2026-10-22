// THE CANARY (R26, P17, addendum-publishing section 4 rule 7): the evidence
// that members-only content stays in the API's chokepoint.
//
// A random token is seeded into every members-only place there is: a passage
// inside a public item, a members block, a members file attached to it, the
// target of a link whose text is a members passage, a whole members item, an
// officers item, a members event series and a members one-off event. Then
// EVERY read RPC the port serves is called with no token, and the token must
// appear in no response and no error. Called as a member, it must appear.
//
// Positive controls (STACK-FIX): each seeded place is read, by itself, by the
// audience allowed to see it, and must show its own marker. A seed that is
// lost or never reaches its place fails the canary instead of leaving the
// public half passing vacuously.
//
// The list of reads is not hand-kept: it is every NO_SIDE_EFFECTS method of
// every served service, and a read without a request here fails the test, so
// a new read RPC cannot ship without passing the canary.
import { randomBytes } from 'node:crypto';
import type { DescMessage, DescMethod, MessageInitShape } from '@bufbuild/protobuf';
import { MethodOptions_IdempotencyLevel as Idempotency } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Audience } from '../src/gen/nwfl/mensa/v1/common_pb.js';
import { ContentService } from '../src/gen/nwfl/mensa/v1/content_pb.js';
import { EventService } from '../src/gen/nwfl/mensa/v1/event_pb.js';
import { SERVED_SERVICES } from '../src/grpc/routes.js';
import { type Api, MEMBER, OFFICER, dump, insertId, startApi } from './helpers/api.js';
import { membersSpan, paragraph, publishItem, text } from './helpers/content.js';
import { live } from './helpers/pg.js';

const TOKEN = `canary${randomBytes(8).toString('hex')}`;
const RANGE = { from: { year: 2026, month: 10, day: 22 }, to: { year: 2027, month: 1, day: 31 } };

type Requests = Record<string, () => Array<MessageInitShape<DescMessage>>>;

describe.skipIf(!live)('the members-only canary', () => {
  let api: Api;
  const ids: Record<string, string> = {};

  // Every read of every served service, with the requests that reach the seeded rows.
  const reads: Record<string, Requests> = {
    'nwfl.mensa.v1.EventService': {
      ListOccurrences: () => [RANGE, { ...RANGE, includeCancelled: true }],
      GetOccurrence: () => [{ id: ids['oneOff'] }, { id: `${ids['series'] as string}:2026-11-21` }],
      ListSeries: () => [{}, { includeInactive: true }],
      ListVenues: () => [{ includeInactive: true }],
    },
    'nwfl.mensa.v1.ContentService': {
      ListPublishedItems: () => [{}, { pageSize: 50 }],
      GetPublishedItem: () => [{ slug: 'canary-public' }, { slug: 'canary-link' }, { slug: 'canary-members' }, { slug: 'canary-officers' }],
      GetRoster: () => [{}],
      ListPublishedEditions: () => [{}],
      ListWorkingItems: () => [{}],
      GetWorkingItem: () => [{ itemId: ids['publicItem'] }],
      ListItemHistory: () => [{ itemId: ids['publicItem'] }],
    },
    'nwfl.mensa.v1.MembershipService': {
      GetMyAccount: () => [{}],
      ListSignupRequests: () => [{}],
    },
    'nwfl.mensa.v1.NewsletterService': {
      ListEditions: () => [{}],
      ListEditionItems: () => [{ editionId: ids['publicItem'] }],
      GetEditionCalendar: () => [{}],
      GetEditionRoster: () => [{}],
      ExportEdition: () => [{ audience: Audience.MEMBERS }],
    },
    'nwfl.mensa.v1.MembershipVerifierService': {
      ListPendingVerifications: () => [{}],
    },
  };

  const readMethods = (): DescMethod[] =>
    SERVED_SERVICES.flatMap((service) => service.methods).filter((method) => method.idempotency === Idempotency.NO_SIDE_EFFECTS);

  /** Every read, every request: the responses and the error messages, as text. */
  async function sweep(options: { headers?: Record<string, string> }): Promise<{ text: string; calls: number }> {
    const parts: string[] = [];
    for (const method of readMethods()) {
      const client = api.client(method.parent) as unknown as Record<string, (request: unknown, options: unknown) => Promise<unknown>>;
      const call = client[method.localName] as (request: unknown, options: unknown) => Promise<unknown>;
      for (const request of reads[method.parent.typeName]?.[method.name]?.() ?? []) {
        try {
          parts.push(dump(await call(request, options)));
        } catch (error) {
          const connectError = ConnectError.from(error);
          expect([Code.NotFound, Code.Unimplemented, Code.Unauthenticated, Code.PermissionDenied], `${method.name}: ${connectError.message}`).toContain(connectError.code);
          parts.push(connectError.message, dump(connectError.details), dump(connectError.metadata));
        }
      }
    }
    return { text: parts.join('\n'), calls: parts.length };
  }

  beforeAll(async () => {
    api = await startApi('nwfl_canary');
    const { pool } = api;
    const office = await insertId(pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
    const publicItem = await publishItem(pool, {
      slug: 'canary-public',
      officeId: office,
      title: 'Picnic',
      summary: 'Saturday',
      body: { blocks: [paragraph(text('Meet at '), membersSpan(`Span ${TOKEN}`), text('.')), { type: 'members', children: [paragraph(text(`Block ${TOKEN}`))] }] },
    });
    // What `[:members[Zoom room]](https://example.org/zoom?pwd=...)` parses to: the target is the secret.
    await publishItem(pool, {
      slug: 'canary-link',
      officeId: office,
      title: 'Monthly meeting',
      body: { blocks: [paragraph(text('Join us: '), { type: 'link', href: `https://example.org/zoom?pwd=${TOKEN}`, children: [membersSpan('Zoom room')] })] },
    });
    ids['publicItem'] = publicItem.itemId;
    await pool.query(
      `INSERT INTO stored_file (version_id, object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ($1, $2, $2, 'application/pdf', 10, $3, 'members')`,
      [publicItem.versionId, `${TOKEN}.pdf`, Buffer.alloc(32, 3)],
    );
    await publishItem(pool, { slug: 'canary-members', officeId: office, visibility: 'members', title: 'Members notice', body: { blocks: [paragraph(text(`Notice ${TOKEN}`))] } });
    await publishItem(pool, { slug: 'canary-officers', officeId: office, visibility: 'officers', title: `Officers ${TOKEN}`, body: { blocks: [paragraph(text(TOKEN))] } });
    ids['series'] = await insertId(pool,
      `INSERT INTO event_series (slug, title, category, recurrence, starts_on, default_start, area, visibility, description, cadence_label)
       VALUES ('canary-series', $1, 'party', 'FREQ=MONTHLY;BYDAY=3SA', '2026-01-01', '18:00', 'bay', 'members', $1, $1) RETURNING id`, [`Series ${TOKEN}`]);
    ids['oneOff'] = await insertId(pool,
      `INSERT INTO event_occurrence (title, starts_at, visibility, detail, status_note, url) VALUES ($1, '2026-12-05T18:00:00Z', 'members', $1, $1, $2) RETURNING id`,
      [`Event ${TOKEN}`, `https://example.org/${TOKEN}`]);
  });

  afterAll(async () => {
    await api?.close();
  });

  it('has a request for every read RPC the port serves', () => {
    const uncovered = readMethods().filter((method) => (reads[method.parent.typeName]?.[method.name]?.() ?? []).length === 0);
    expect(uncovered.map((method) => `${method.parent.name}.${method.name}`)).toEqual([]);
  });

  it('never shows the token to the public, in any response or error', async () => {
    const { text: everything, calls } = await sweep({});
    expect(calls).toBeGreaterThanOrEqual(23);
    expect(everything.includes(TOKEN)).toBe(false);
  });

  it('shows the token to a member, so the sweep can see it when it is there', async () => {
    const { text: everything } = await sweep(MEMBER);
    expect(everything.includes(TOKEN)).toBe(true);
    const item = dump(await api.client(ContentService).getPublishedItem({ slug: 'canary-public' }, MEMBER));
    expect(item).toContain(TOKEN);
    const events = dump(await api.client(EventService).listOccurrences(RANGE, MEMBER));
    expect(events).toContain(`Event ${TOKEN}`);
  });

  describe('positive controls: each seeded place shows its own marker to the audience allowed to see it', () => {
    const content = () => api.client(ContentService);
    const places: Array<[string, () => Promise<unknown>, () => string]> = [
      ['the members span in a public item', () => content().getPublishedItem({ slug: 'canary-public' }, MEMBER), () => `Span ${TOKEN}`],
      ['the members block in a public item', () => content().getPublishedItem({ slug: 'canary-public' }, MEMBER), () => `Block ${TOKEN}`],
      ['the members file of a public item', () => content().getPublishedItem({ slug: 'canary-public' }, MEMBER), () => `${TOKEN}.pdf`],
      ['the target of a members link', () => content().getPublishedItem({ slug: 'canary-link' }, MEMBER), () => `pwd=${TOKEN}`],
      ['the members item', () => content().getPublishedItem({ slug: 'canary-members' }, MEMBER), () => `Notice ${TOKEN}`],
      ['the officers item, to an officer', () => content().getPublishedItem({ slug: 'canary-officers' }, OFFICER), () => `Officers ${TOKEN}`],
      ['the members series', () => api.client(EventService).listSeries({}, MEMBER), () => `Series ${TOKEN}`],
      ['the members one-off event', () => api.client(EventService).listOccurrences(RANGE, MEMBER), () => `Event ${TOKEN}`],
      ['the members one-off event link', () => api.client(EventService).getOccurrence({ id: ids['oneOff'] as string }, MEMBER), () => `https://example.org/${TOKEN}`],
    ];

    it.each(places)('%s', async (_place, read, marker) => {
      expect(dump(await read())).toContain(marker());
    });

    it('keeps the officers item from a member', async () => {
      await expect(content().getPublishedItem({ slug: 'canary-officers' }, MEMBER)).rejects.toMatchObject({ code: Code.NotFound });
    });
  });

  it('keeps the token out of the public search index and in the members index', async () => {
    const { rows } = await api.pool.query<{ in_public: boolean; in_members: boolean }>(
      `SELECT bool_or(search_public @@ plainto_tsquery('english', $1)) AS in_public,
              bool_or(search_members @@ plainto_tsquery('english', $1)) AS in_members
       FROM content_version`,
      [TOKEN],
    );
    expect(rows[0]).toEqual({ in_public: false, in_members: true });
  });
});

