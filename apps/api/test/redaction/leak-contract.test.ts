// THE REDACTION LEAK CONTRACT (REDACT R2a). Random canaries are seeded where
// the redaction policy or a mark withholds them from the public:
//   - marked passages: a body (member_phone), a title (member_name), an
//     event's status note (member_address, withheld from members too), a
//     series description (member_phone);
//   - a whole-item mark, and a passage in a category the public policy HIDES;
//   - structured fields: an item's on-behalf-of name (member_name), a private
//     venue's name and link (private_venue), an event's contact office
//     (officer_contact).
// Then EVERY read RPC the port serves is called as each audience, and the
// whole serialized response (the protobuf bytes, unknown fields included) and
// every error is searched. The public must never get a canary; an officer must
// get every one (the positive control: a seed that never reached its place
// would otherwise pass vacuously).
//
//
// A PDF carries the marked canaries too (REDACT R3c): ReadFile's streamed
// bytes are searched as served and with every Flate stream inflated.
//
// The reads are enumerated from the service definitions (every
// NO_SIDE_EFFECTS method of every served service), and a read with no request
// here fails the first test, so a new read RPC cannot ship without joining it.
import { randomBytes } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { type DescMessage, type DescMethod, type MessageInitShape, fromBinary, toBinary } from '@bufbuild/protobuf';
import { MethodOptions_IdempotencyLevel as Idempotency, timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Audience } from '../../src/gen/nwfl/mensa/v1/common_pb.js';
import { ContentService } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { NewsletterService } from '../../src/gen/nwfl/mensa/v1/newsletter_pb.js';
import {
  LedgerSubjectKind,
  MarkField,
  MarkSubjectKind,
  RedactionAction,
  RedactionAudience,
  RedactionCategory,
  RedactionPolicyService,
} from '../../src/gen/nwfl/mensa/v1/redaction_pb.js';
import { SERVED_SERVICES } from '../../src/grpc/routes.js';
import { type Api, MEMBER, OFFICER, as, dump, insertId, startApi } from '../helpers/api.js';
import { paragraph, publishItem, text } from '../helpers/content.js';
import { live } from '../helpers/pg.js';
import { drain } from '../../src/pdf/regenerate.js';
import { storeOriginal } from '../../src/pdf/store.js';
import { extractAll } from '../pdf/extract.js';
import { linesPdf } from '../pdf/fixtures.js';

const canary = (name: string): string => `${name}${randomBytes(6).toString('hex')}`;
const C = {
  phone: canary('phone'),
  name: canary('name'),
  byline: canary('byline'),
  whole: canary('whole'),
  email: canary('email'),
  address: canary('address'),
  description: canary('description'),
  venueName: canary('venuename'),
  venueUrl: canary('venueurl'),
};
const ALIAS = 'hospitality@nwflorida.us';
const RANGE = { from: { year: 2026, month: 11, day: 1 }, to: { year: 2026, month: 11, day: 30 } };
const AGENT = as('agent-token');

type Requests = Record<string, () => Array<MessageInitShape<DescMessage>>>;

describe.skipIf(!live)('the redaction leak contract', () => {
  let api: Api;
  const ids: Record<string, string> = {};

  const reads: Record<string, Requests> = {
    'nwfl.mensa.v1.EventService': {
      ListOccurrences: () => [RANGE, { ...RANGE, includeCancelled: true }],
      GetOccurrence: () => [{ id: ids['occurrence'] }, { id: `${ids['series'] as string}:2026-11-15` }],
      ListSeries: () => [{}, { includeInactive: true }],
      ListVenues: () => [{}, { includeInactive: true }],
    },
    'nwfl.mensa.v1.ContentService': {
      ListPublishedItems: () => [{}, { pageSize: 1 }, { pageSize: 50 }],
      GetPublishedItem: () => [{ slug: 'leak-public' }, { slug: 'leak-whole' }, { slug: 'leak-hidden' }],
      GetRoster: () => [{}],
      ListPublishedEditions: () => [{}],
      ListWorkingItems: () => [{}, { states: [] }],
      GetWorkingItem: () => [{ itemId: ids['public'] }, { itemId: ids['whole'] }, { itemId: ids['hidden'] }],
      ListItemHistory: () => [{ itemId: ids['public'] }],
      ReadFile: () => [{ fileId: ids['publicFile'] }, { fileId: ids['wholeFile'] }],
    },
    'nwfl.mensa.v1.MembershipService': {
      GetMyAccount: () => [{}],
      ListSignupRequests: () => [{}],
      ListMembers: () => [{}],
    },
    'nwfl.mensa.v1.NewsletterService': {
      ListEditions: () => [{}],
      ListEditionItems: () => [{ editionId: ids['edition'] }],
      GetEditionCalendar: () => [{ editionId: ids['edition'] }],
      GetEditionRoster: () => [{ editionId: ids['edition'] }],
      ExportEdition: () => [{ editionId: ids['edition'], audience: Audience.MEMBERS }],
    },
    'nwfl.mensa.v1.MembershipVerifierService': {
      ListPendingVerifications: () => [{}],
    },
    'nwfl.mensa.v1.RedactionPolicyService': {
      GetRedactionPolicy: () => [{}],
      ListRedactionMarks: () => [
        { subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: ids['public'] },
        { subjectKind: MarkSubjectKind.EVENT_OCCURRENCE, subjectId: ids['occurrence'] },
        { subjectKind: MarkSubjectKind.EVENT_SERIES, subjectId: ids['series'] },
      ],
      // The publication ledger (R-LEDGER): read-only, officers only, and swept like a read.
      LedgerAsOf: () =>
        [RedactionAudience.PUBLIC, RedactionAudience.MEMBERS, RedactionAudience.OFFICERS].flatMap((audience) => [
          { subjectKind: LedgerSubjectKind.STORED_FILE, subjectId: ids['publicFile'], audience, at: timestampFromDate(new Date()) },
          { subjectKind: LedgerSubjectKind.STORED_FILE, subjectId: ids['wholeFile'], audience, at: timestampFromDate(new Date()) },
        ]),
      VerifyLedger: () => [{}],
    },
  };

  // Every method that is NOT swept, by name, with why. Every other method of every served service is
  // swept, whatever its idempotency option says, and the two together must be the service
  // definitions exactly (S1): a new RPC fails the first test until it is placed in one or the other.
  const WRITES = new Set([
    // Health carries no content; Watch streams.
    'Health.Check',
    'Health.List',
    'Health.Watch',
    'EventService.SaveSeries',
    'EventService.SaveOccurrence',
    'EventService.SaveVenue',
    'ContentService.CreateItem',
    'ContentService.SaveDraft',
    'ContentService.MarkReady',
    'ContentService.SendBack',
    'ContentService.Approve',
    'ContentService.Withdraw',
    'ContentService.Restore',
    'ContentService.SaveOfficeTerm',
    'ContentService.SaveEdition',
    'ContentService.FreezeEdition',
    'MembershipService.SubmitSignup',
    'MembershipService.ApproveSignup',
    'MembershipService.RejectSignup',
    'MembershipService.RemoveMember',
    'MembershipService.ConfirmMember',
    'MembershipService.GrantAffiliate',
    'MembershipVerifierService.ReportVerification',
    'RedactionPolicyService.ProposeRedactionChange',
    'RedactionPolicyService.ApproveRedactionChange',
    'RedactionPolicyService.AddRedactionMark',
    'RedactionPolicyService.ProposeMarkRemoval',
    'RedactionPolicyService.ApproveMarkRemoval',
  ]);
  const rpcName = (method: DescMethod): string => `${method.parent.name}.${method.name}`;
  const allMethods = (): DescMethod[] => SERVED_SERVICES.flatMap((service) => service.methods);
  const readMethods = (): DescMethod[] => allMethods().filter((method) => !WRITES.has(rpcName(method)));

  /** A served PDF's Flate streams, inflated. */
  const inflated = (bytes: Buffer): Buffer[] => {
    const out: Buffer[] = [];
    const text = bytes.toString('latin1');
    for (const m of text.matchAll(/stream\r?\n/g)) {
      const start = m.index + m[0].length;
      const end = text.indexOf('endstream', start);
      if (end < 0) continue;
      try {
        out.push(inflateSync(bytes.subarray(start, end)));
      } catch {
        // Not a Flate stream.
      }
    }
    return out;
  };

  /** Every read (or those of one service), every request: the serialized responses and the errors, by RPC. */
  async function sweep(options: { headers?: Record<string, string> }, only?: string): Promise<Map<string, Buffer>> {
    const out = new Map<string, Buffer>();
    for (const method of readMethods().filter((m) => only === undefined || m.parent.typeName === only)) {
      const client = api.client(method.parent) as unknown as Record<string, (request: unknown, options: unknown) => Promise<unknown>>;
      const call = client[method.localName] as (request: unknown, options: unknown) => Promise<unknown>;
      const parts: Buffer[] = [];
      for (const request of reads[method.parent.typeName]?.[method.name]?.() ?? []) {
        try {
          // A stream (ReadFile): each message, the PDF it carries with every Flate stream inflated, and its text as pdf.js reads it.
          if (method.methodKind === 'server_streaming') {
            const served: Buffer[] = [];
            for await (const message of call(request, options) as unknown as AsyncIterable<unknown>) {
              served.push(Buffer.from(toBinary(method.output, message as never)));
              parts.push(Buffer.from(dump(message)));
            }
            const pdf = Buffer.concat(
              served.flatMap((bytes) => {
                const part = fromBinary(method.output, bytes) as unknown as { part: { case?: string; value?: unknown } };
                return part.part.case === 'chunk' ? [Buffer.from(part.part.value as Uint8Array)] : [];
              }),
            );
            parts.push(...served, ...inflated(pdf));
            if (pdf.length > 0) parts.push(Buffer.from(await extractAll(pdf)));
            continue;
          }
          const response = await call(request, options);
          parts.push(Buffer.from(toBinary(method.output, response as never)), Buffer.from(dump(response)));
        } catch (error) {
          const connectError = ConnectError.from(error);
          expect([Code.NotFound, Code.Unauthenticated, Code.PermissionDenied], `${method.name}: ${connectError.message}`).toContain(connectError.code);
          parts.push(Buffer.from([connectError.message, dump(connectError.details), dump(connectError.metadata)].join('\n')));
        }
      }
      out.set(`${method.parent.name}.${method.name}`, Buffer.concat(parts));
    }
    return out;
  }

  /** The canaries found, and in which RPCs. */
  const found = (responses: Map<string, Buffer>, needles: Record<string, string>): Record<string, string[]> =>
    Object.fromEntries(
      Object.entries(needles)
        .map(([key, needle]) => [key, [...responses].filter(([, bytes]) => bytes.includes(Buffer.from(needle))).map(([rpc]) => rpc)] as const)
        .filter(([, rpcs]) => rpcs.length > 0),
    );
  const whole = (responses: Map<string, Buffer>): string => Buffer.concat([...responses.values()]).toString('utf8');

  beforeAll(async () => {
    api = await startApi('nwfl_leak');
    const { pool } = api;
    const policy = api.client(RedactionPolicyService);
    const office = await insertId(pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
    // The group's public contact: an office and its verified role alias, never officer_contact.
    ids['host'] = await insertId(
      pool,
      `INSERT INTO office (slug, title, kind, role_alias, role_alias_verified_on) VALUES ('hospitality', 'Hospitality', 'appointed', $1, '2026-10-01') RETURNING id`,
      [ALIAS],
    );
    ids['edition'] = await insertId(
      pool,
      `INSERT INTO edition (slug, title, kind, period_start, period_end, status) VALUES ('2026-11', 'November 2026', 'regular', '2026-11-01', '2026-11-30', 'collecting') RETURNING id`,
    );
    const edition = ids['edition'];

    const publicPdf = await linesPdf([`Picnic with ${C.name}`, `Rides: call ${C.phone} by Friday.`]);
    const wholePdf = await linesPdf([`Words by ${C.whole}`]);
    ids['public'] = (
      await publishItem(pool, {
        files: [{ objectKey: 'leak-public.pdf', audience: 'public', bytes: publicPdf }],
        slug: 'leak-public',
        officeId: office,
        title: `Picnic with ${C.name}`,
        onBehalfOf: `${C.byline}, guest writer`,
        editionId: edition,
        body: { blocks: [paragraph(text('Rides: call '), text(C.phone), text(' by Friday.'))] },
      })
    ).itemId;
    ids['whole'] = (
      await publishItem(pool, {
        slug: 'leak-whole',
        officeId: office,
        title: 'Remembering a friend',
        editionId: edition,
        body: { blocks: [paragraph(text(`Words by ${C.whole}`))] },
        files: [{ objectKey: 'leak-whole.pdf', audience: 'public', bytes: wholePdf }],
      })
    ).itemId;
    const fileOf = async (key: string) => (await pool.query<{ id: string }>(`SELECT id FROM stored_file WHERE object_key = $1`, [key])).rows[0]!.id;
    ids['publicFile'] = await fileOf('leak-public.pdf');
    ids['wholeFile'] = await fileOf('leak-whole.pdf');
    ids['hidden'] = (await publishItem(pool, { slug: 'leak-hidden', officeId: office, title: 'Mailing list', editionId: edition, body: { blocks: [paragraph(text(`Write to ${C.email}`))] } }))
      .itemId;

    ids['venue'] = await insertId(pool, `INSERT INTO venue (kind, name, area, url, host_office_id) VALUES ('virtual', $1, 'virtual', $2, $3) RETURNING id`, [
      `Room ${C.venueName}`,
      `https://example.org/${C.venueUrl}`,
      ids['host'],
    ]);
    ids['series'] = await insertId(
      pool,
      `INSERT INTO event_series (slug, title, category, recurrence, starts_on, default_start, area, host_office_id, description, default_venue_id)
       VALUES ('leak-coffee', 'Coffee', 'other', 'FREQ=MONTHLY;BYDAY=3SU', '2026-01-18', '10:00', 'bay', $1, $2, $3) RETURNING id`,
      [ids['host'], `Ask for ${C.description}`, ids['venue']],
    );
    ids['occurrence'] = await insertId(
      pool,
      `INSERT INTO event_occurrence (title, starts_at, visibility, venue_id, status_note, detail, owner_office_id) VALUES ('Games night', '2026-11-06T23:00:00Z', 'public', $1, $2, $2, $3) RETURNING id`,
      [ids['venue'], `Meet at ${C.address}`, ids['host']],
    );
    const home = await insertId(pool, `INSERT INTO venue (kind, name, area, host_office_id) VALUES ('member_home', 'A home', 'okaloosa', $1) RETURNING id`, [ids['host']]);
    await pool.query(`INSERT INTO event_occurrence (title, starts_at, visibility, venue_id) VALUES ('Potluck', '2026-11-21T23:00:00Z', 'public', $1)`, [home]);

    const mark = (kind: MarkSubjectKind, subjectId: string, field: MarkField, quote: string, category: RedactionCategory) =>
      policy.addRedactionMark({ subjectKind: kind, subjectId, field, quote, category }, OFFICER);
    await mark(MarkSubjectKind.CONTENT_ITEM, ids['public'], MarkField.BODY, C.phone, RedactionCategory.MEMBER_PHONE);
    await mark(MarkSubjectKind.CONTENT_ITEM, ids['public'], MarkField.TITLE, C.name, RedactionCategory.MEMBER_NAME);
    await mark(MarkSubjectKind.CONTENT_ITEM, ids['whole'], MarkField.UNSPECIFIED, '', RedactionCategory.MEMBER_NAME);
    await mark(MarkSubjectKind.CONTENT_ITEM, ids['hidden'], MarkField.BODY, C.email, RedactionCategory.MEMBER_EMAIL);
    await mark(MarkSubjectKind.EVENT_OCCURRENCE, ids['occurrence'], MarkField.STATUS_NOTE, C.address, RedactionCategory.MEMBER_ADDRESS);
    await mark(MarkSubjectKind.EVENT_SERIES, ids['series'], MarkField.DESCRIPTION, C.description, RedactionCategory.MEMBER_PHONE);
    // A tightening applies at once: the public no longer gets items with a marked email at all.
    await policy.proposeRedactionChange({ audience: RedactionAudience.PUBLIC, category: RedactionCategory.MEMBER_EMAIL, action: RedactionAction.HIDE }, OFFICER);
    // The originals, then their copies, made by the real engine as the background job would.
    const storer = { sub: 'sub-officer', groups: ['nwfl-members', 'nwfl-officers'] };
    await storeOriginal(pool, { fileId: ids['publicFile'], bytes: publicPdf, ...storer });
    await storeOriginal(pool, { fileId: ids['wholeFile'], bytes: wholePdf, ...storer });
    await drain(api.worker);
  }, 60_000);

  afterAll(async () => {
    await api?.close();
  });

  it('places every method of every served service in the sweep or the write allowlist, exactly once', () => {
    const swept = Object.entries(reads).flatMap(([service, methods]) => Object.keys(methods).map((name) => `${service.split('.').at(-1) as string}.${name}`));
    expect(swept.filter((name) => WRITES.has(name))).toEqual([]);
    expect([...swept, ...WRITES].sort()).toEqual(allMethods().map(rpcName).sort());
    const uncovered = readMethods().filter((method) => (reads[method.parent.typeName]?.[method.name]?.() ?? []).length === 0);
    expect(uncovered.map(rpcName)).toEqual([]);
  });

  it('sweeps every side-effect-free method, so the allowlist holds no read', () => {
    expect(allMethods().filter((method) => method.idempotency === Idempotency.NO_SIDE_EFFECTS && WRITES.has(rpcName(method))).map(rpcName)).toEqual([]);
  });

  it('gives the public no canary, in any read RPC or error', async () => {
    const responses = await sweep({});
    expect(responses.size).toBeGreaterThanOrEqual(20);
    expect(found(responses, C)).toEqual({});
    expect(whole(responses)).toContain('[withheld]');
    // The public was served the PDF itself (a redacted copy), not only "not ready".
    expect(responses.get('ContentService.ReadFile')?.includes('%PDF-')).toBe(true);
  });

  it('serves an officer the PDF with its canaries: the PDF positive control', async () => {
    const files = await sweep(OFFICER, 'nwfl.mensa.v1.ContentService');
    expect(found(new Map([['ReadFile', files.get('ContentService.ReadFile') as Buffer]]), { name: C.name, phone: C.phone, whole: C.whole })).toEqual({
      name: ['ReadFile'],
      phone: ['ReadFile'],
      whole: ['ReadFile'],
    });
  });

  it('never gives the public a length-revealing mask', async () => {
    expect(whole(await sweep({}))).not.toMatch(/█|\*{3,}|x{5,}/);
  });

  it('gives a member what the members policy shows, and not a member’s address', async () => {
    const responses = await sweep(MEMBER);
    const { address, ...shown } = C;
    expect(Object.keys(found(responses, shown)).sort()).toEqual(Object.keys(shown).sort());
    expect(found(responses, { address })).toEqual({});
  });

  it('gives an officer every canary and the event contact: the positive control', async () => {
    const responses = await sweep(OFFICER);
    expect(Object.keys(found(responses, C)).sort()).toEqual(Object.keys(C).sort());
    expect(found(await sweep(OFFICER, 'nwfl.mensa.v1.EventService'), { host: ids['host'] as string })).not.toEqual({});
  });

  it('gives the newsletter agent (members) no member’s address, and the members canaries', async () => {
    const responses = await sweep(AGENT, 'nwfl.mensa.v1.NewsletterService');
    const { address, ...shown } = C;
    expect(found(responses, { address })).toEqual({});
    // No newsletter read carries an item's on-behalf-of name; every other members canary reaches the agent.
    expect(Object.keys(found(responses, shown)).sort()).toEqual(['description', 'email', 'name', 'phone', 'venueName', 'venueUrl', 'whole']);
  });

  it('keeps every canary out of the PUBLIC export', async () => {
    const exported = await api.client(NewsletterService).exportEdition({ editionId: ids['edition'] as string, audience: Audience.PUBLIC }, AGENT);
    const bytes = new Map([['ExportEdition', Buffer.from(toBinary(NewsletterService.method.exportEdition.output, exported))]]);
    expect(found(bytes, C)).toEqual({});
    expect(exported.contentJson).toContain('[withheld]');
  });

  // Last: it tightens the public officer_contact cell, which must change none of this.
  it('shows the public each event’s host office and its verified role alias, whatever officer_contact says', async () => {
    await api.client(RedactionPolicyService).proposeRedactionChange(
      { audience: RedactionAudience.PUBLIC, category: RedactionCategory.OFFICER_CONTACT, action: RedactionAction.HIDE },
      OFFICER,
    );
    const host = ids['host'] as string;
    const events = await sweep({}, 'nwfl.mensa.v1.EventService');
    expect(found(events, { host })).toEqual({
      host: ['EventService.ListOccurrences', 'EventService.GetOccurrence', 'EventService.ListSeries', 'EventService.ListVenues'],
    });
    const roster = dump(await api.client(ContentService).getRoster({}));
    expect(roster).toContain('Hospitality');
    expect(roster).toContain(ALIAS);
    const exported = await api.client(NewsletterService).exportEdition({ editionId: ids['edition'] as string, audience: Audience.PUBLIC }, AGENT);
    expect(exported.contentJson).toContain(`(contact ${ALIAS})`);
  });
});
