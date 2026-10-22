// THE CANARY (R26, P17, addendum-publishing section 4 rule 7): the evidence
// that members-only content stays in the API's chokepoint.
//
// A random token is seeded into every members-only place there is: a passage
// inside a public item, a members file attached to it, a whole members item,
// an officers item, a members event series and a members one-off event. Then
// EVERY read RPC the port serves is called with no token, and the token must
// appear in no response and no error. Called as a member, it must appear.
//
// The list of reads is not hand-kept: it is every NO_SIDE_EFFECTS method of
// every served service, and a read without a request here fails the test, so
// a new read RPC cannot ship without passing the canary.
import { randomBytes } from 'node:crypto';
import type { DescMessage, DescMethod, DescService, MessageInitShape } from '@bufbuild/protobuf';
import { MethodOptions_IdempotencyLevel as Idempotency } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentService } from '../src/gen/nwfl/mensa/v1/content_pb.js';
import { EventService } from '../src/gen/nwfl/mensa/v1/event_pb.js';
import { type Api, MEMBER, dump, insertId, startApi } from './helpers/api.js';
import { membersSpan, paragraph, publishItem, text } from './helpers/content.js';
import { live } from './helpers/pg.js';

const TOKEN = `canary${randomBytes(8).toString('hex')}`;
const SERVED: DescService[] = [EventService, ContentService];
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
      GetPublishedItem: () => [{ slug: 'canary-public' }, { slug: 'canary-members' }, { slug: 'canary-officers' }],
      GetRoster: () => [{}],
      ListPublishedEditions: () => [{}],
      ListWorkingItems: () => [{}],
      GetWorkingItem: () => [{ itemId: ids['publicItem'] }],
    },
  };

  const readMethods = (): DescMethod[] =>
    SERVED.flatMap((service) => service.methods).filter((method) => method.idempotency === Idempotency.NO_SIDE_EFFECTS);

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
          expect([Code.NotFound, Code.Unimplemented], `${method.name}: ${connectError.message}`).toContain(connectError.code);
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
      body: { blocks: [paragraph(text('Meet at '), membersSpan(TOKEN), text('.')), { type: 'members', children: [paragraph(text(`Block ${TOKEN}`))] }] },
    });
    ids['publicItem'] = publicItem.itemId;
    await pool.query(
      `INSERT INTO stored_file (version_id, object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ($1, $2, $2, 'application/pdf', 10, $3, 'members')`,
      [publicItem.versionId, `${TOKEN}.pdf`, Buffer.alloc(32, 3)],
    );
    await publishItem(pool, { slug: 'canary-members', officeId: office, visibility: 'members', title: 'Members notice', body: { blocks: [paragraph(text(TOKEN))] } });
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
    expect(calls).toBeGreaterThanOrEqual(15);
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

