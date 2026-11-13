// EDITOR E2: the officer editor's client for the ContentService workflow and the EventService writes,
// over the gRPC wire against an API on loopback. Every call carries the signed-in officer's token as a
// bearer and nothing else; each answer is read into the editor's own shape; and each refusal becomes
// the one thing a page can act on: sign in again, the version changed, not allowed, the slug is taken,
// the API's words for a step the item is not ready for, not found, or unavailable.
import { clone, create } from '@bufbuild/protobuf';
import { TimestampSchema, timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { newSession } from '../../../server/session.mjs';
import { TokenStore } from '../../../server/token-store.mjs';
import {
  ContentItemSchema,
  ContentKind,
  ContentService,
  HistoryEntrySchema,
  ItemState,
  ItemVisibility,
  VersionStatus,
} from '../../gen/nwfl/mensa/v1/content_pb.js';
import { EventOccurrenceSchema, EventSeriesSchema, EventService, OccurrenceStatus, VenueKind, VenueSchema } from '../../gen/nwfl/mensa/v1/event_pb.js';
import type { Tokens } from '../auth/oidc';
import { ApiNotFound, ApiUnavailable } from './client';
import {
  DraftChanged,
  Duplicate,
  EditorRefused,
  NotAllowed,
  REASON_MAX,
  SignInAgain,
  SlugTaken,
  VersionChanged,
  editorAdmits,
  editorApi,
  editorFromEnv,
  editorReader,
  baseTimestamp,
  baseToken,
  grpcEditor,
  unavailableEditor,
  type EditorApi,
} from './editor';
import { OfficerSignInAgain } from './officer';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function grpcServer(routes: (router: ConnectRouter) => void): Promise<{ url: string; headers: http2.IncomingHttpHeaders[] }> {
  const headers: http2.IncomingHttpHeaders[] = [];
  const adapter = connectNodeAdapter({ routes, grpc: true, grpcWeb: false, connect: false });
  const sessions = new Set<http2.ServerHttp2Session>();
  const server = http2.createServer((req, res) => {
    headers.push({ ...req.headers });
    void adapter(req, res);
  });
  server.on('session', (s) => sessions.add(s));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        for (const s of sessions) s.destroy();
      }),
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, headers };
}

const OFFICER = { bearer: 'officer.tok-en' };
const ITEM_ID = 'c0000000-0000-4000-8000-000000000001';
const OFFICE_ID = '11111111-1111-4111-8111-111111111111';
const HASH = new Uint8Array(32).fill(7);
const READY_AT = new Date('2026-11-10T16:00:00Z');
const WITHDRAWN_AT = new Date('2026-11-11T17:30:00Z');
const para = (text: string) => ({ kind: { case: 'paragraph' as const, value: { inlines: [{ kind: { case: 'text' as const, value: { text } } }] } } });

/** A published item with a ready change waiting, as an officer reads it. */
const ITEM = create(ContentItemSchema, {
  id: ITEM_ID,
  slug: 'lunch-moves',
  kind: ContentKind.ANNOUNCEMENT,
  officeId: OFFICE_ID,
  state: ItemState.PUBLISHED,
  live: { id: 'v1', itemId: ITEM_ID, number: 1, status: VersionStatus.APPROVED, title: 'Lunch moves', summary: '', visibility: ItemVisibility.PUBLIC, body: { blocks: [para('Old.')] as never }, bodyMarkup: 'Old.' },
  working: {
    id: 'v2',
    itemId: ITEM_ID,
    number: 2,
    status: VersionStatus.READY,
    title: 'Lunch moves again',
    summary: 'To Thursdays',
    visibility: ItemVisibility.MEMBERS,
    body: { blocks: [para('New.')] as never },
    bodyMarkup: 'New.',
    contentHash: HASH,
    targets: { website: true, newsletter: true },
    editionId: 'e0000000-0000-4000-8000-000000000001',
    readyAt: timestampFromDate(READY_AT),
    callerEdited: true,
  },
});

const LIVE_VERSION = {
  id: 'v1',
  number: 1,
  status: 'approved',
  title: 'Lunch moves',
  summary: '',
  visibility: 'public',
  body: ITEM.live!.body,
  markup: 'Old.',
  markupWithheld: false,
  contentHash: new Uint8Array(0),
  targets: { website: false, newsletter: false, email: false },
  editionId: '',
  printAsIs: false,
  onBehalfOf: '',
  sendBackNote: '',
  callerEdited: false,
};
const WORKING_VERSION = {
  id: 'v2',
  number: 2,
  status: 'ready',
  title: 'Lunch moves again',
  summary: 'To Thursdays',
  visibility: 'members',
  body: ITEM.working!.body,
  markup: 'New.',
  markupWithheld: false,
  contentHash: HASH,
  targets: { website: true, newsletter: true, email: false },
  editionId: 'e0000000-0000-4000-8000-000000000001',
  printAsIs: false,
  onBehalfOf: '',
  readyAt: READY_AT,
  sendBackNote: '',
  callerEdited: true,
};
const EDITOR_ITEM = { id: ITEM_ID, slug: 'lunch-moves', kind: 'announcement', officeId: OFFICE_ID, state: 'published', live: LIVE_VERSION, working: WORKING_VERSION };

describe('grpcEditor: each call, with the officer\'s bearer, read into the editor\'s shape', () => {
  it('creates an item posting as an office, with the slug and title given', async () => {
    const seen: unknown[] = [];
    const server = await grpcServer((router) =>
      router.service(ContentService, {
        createItem: (req) => {
          seen.push({ kind: req.kind, officeId: req.officeId, slug: req.slug, title: req.title, onBehalfOf: req.onBehalfOf });
          return { item: ITEM };
        },
      }),
    );
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    expect(await api.createItem(OFFICER, { kind: 'president_report', officeId: OFFICE_ID, slug: 'a-note', title: 'A note' })).toEqual(EDITOR_ITEM);
    expect(seen).toEqual([{ kind: ContentKind.PRESIDENT_REPORT, officeId: OFFICE_ID, slug: 'a-note', title: 'A note', onBehalfOf: '' }]);
    expect(server.headers[0]?.['authorization']).toBe('Bearer officer.tok-en');
    expect(server.headers[0]?.['content-type']).toBe('application/grpc+proto');
    expect(server.headers[0]?.['cookie']).toBeUndefined();
  });

  it('saves a draft and gives the markup problems back', async () => {
    const seen: unknown[] = [];
    const server = await grpcServer((router) =>
      router.service(ContentService, {
        saveDraft: (req) => {
          seen.push({ itemId: req.itemId, title: req.title, summary: req.summary, visibility: req.visibility, bodyMarkup: req.bodyMarkup });
          return { item: ITEM, problems: [{ line: 4, message: 'the link must start with https://' }] };
        },
      }),
    );
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    expect(await api.saveDraft(OFFICER, { itemId: ITEM_ID, title: 'T', summary: 'S', visibility: 'officers', markup: '# Hi' })).toEqual({
      item: EDITOR_ITEM,
      problems: [{ line: 4, message: 'the link must start with https://' }],
    });
    expect(seen).toEqual([{ itemId: ITEM_ID, title: 'T', summary: 'S', visibility: ItemVisibility.OFFICERS, bodyMarkup: '# Hi' }]);
    expect(server.headers[0]?.['authorization']).toBe('Bearer officer.tok-en');
  });

  it('marks a draft ready with its targets, edition and print-as-is', async () => {
    const seen: unknown[] = [];
    const server = await grpcServer((router) =>
      router.service(ContentService, {
        markReady: (req) => {
          seen.push({ itemId: req.itemId, targets: { website: req.targets?.website, newsletter: req.targets?.newsletter, email: req.targets?.email }, editionId: req.editionId, printAsIs: req.printAsIs });
          return { item: ITEM };
        },
      }),
    );
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    expect(await api.markReady(OFFICER, { itemId: ITEM_ID, targets: { website: true, newsletter: false, email: false } })).toEqual(EDITOR_ITEM);
    await api.markReady(OFFICER, { itemId: ITEM_ID, targets: { website: true, newsletter: true, email: false }, editionId: 'e1', printAsIs: true });
    expect(seen).toEqual([
      { itemId: ITEM_ID, targets: { website: true, newsletter: false, email: false }, editionId: '', printAsIs: false },
      { itemId: ITEM_ID, targets: { website: true, newsletter: true, email: false }, editionId: 'e1', printAsIs: true },
    ]);
  });

  it('sends a version back with its note', async () => {
    const seen: unknown[] = [];
    const server = await grpcServer((router) =>
      router.service(ContentService, {
        sendBack: (req) => {
          seen.push({ itemId: req.itemId, note: req.note });
          return { item: ITEM };
        },
      }),
    );
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    expect(await api.sendBack(OFFICER, { itemId: ITEM_ID, note: 'Please add the time.' })).toEqual(EDITOR_ITEM);
    expect(seen).toEqual([{ itemId: ITEM_ID, note: 'Please add the time.' }]);
  });

  it('approves by the hash seen, keeping the targets and edition unless changed, break-glass only when asked', async () => {
    const seen: unknown[] = [];
    const server = await grpcServer((router) =>
      router.service(ContentService, {
        approve: (req) => {
          seen.push({ itemId: req.itemId, hash: [...req.contentHash], targets: req.targets ? { ...req.targets, $typeName: undefined } : undefined, editionId: req.editionId, breakGlass: req.breakGlass, reason: req.breakGlassReason });
          return { item: ITEM };
        },
      }),
    );
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    expect(await api.approve(OFFICER, { itemId: ITEM_ID, contentHash: HASH })).toEqual(EDITOR_ITEM);
    await api.approve(OFFICER, { itemId: ITEM_ID, contentHash: HASH, targets: { website: true, newsletter: false, email: false }, editionId: 'e2', breakGlass: { reason: 'The Webmaster is away' } });
    expect(seen).toEqual([
      { itemId: ITEM_ID, hash: [...HASH], targets: undefined, editionId: '', breakGlass: false, reason: '' },
      { itemId: ITEM_ID, hash: [...HASH], targets: { website: true, newsletter: false, email: false, $typeName: undefined }, editionId: 'e2', breakGlass: true, reason: 'The Webmaster is away' },
    ]);
  });

  it('takes an item down', async () => {
    const seen: string[] = [];
    const down = create(ContentItemSchema, { ...ITEM, state: ItemState.WITHDRAWN, withdrawnAt: timestampFromDate(WITHDRAWN_AT), working: undefined });
    const server = await grpcServer((router) =>
      router.service(ContentService, {
        withdraw: (req) => {
          seen.push(req.itemId);
          return { item: down };
        },
      }),
    );
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    expect(await api.withdraw(OFFICER, ITEM_ID)).toEqual({ id: ITEM_ID, slug: 'lunch-moves', kind: 'announcement', officeId: OFFICE_ID, state: 'withdrawn', withdrawnAt: WITHDRAWN_AT, live: LIVE_VERSION });
    expect(seen).toEqual([ITEM_ID]);
  });

  it('lists the working items by state, office and edition, and reads one', async () => {
    const seen: unknown[] = [];
    const server = await grpcServer((router) =>
      router.service(ContentService, {
        listWorkingItems: (req) => {
          seen.push({ states: [...req.states], officeId: req.officeId, editionId: req.editionId });
          return { items: [ITEM] };
        },
        getWorkingItem: (req) => {
          seen.push(req.itemId);
          return { item: ITEM };
        },
      }),
    );
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    expect(await api.listWorkingItems(OFFICER)).toEqual([EDITOR_ITEM]);
    expect(await api.listWorkingItems(OFFICER, { states: ['ready'], officeId: OFFICE_ID, editionId: 'e1' })).toEqual([EDITOR_ITEM]);
    expect(await api.getWorkingItem(OFFICER, ITEM_ID)).toEqual(EDITOR_ITEM);
    expect(seen).toEqual([{ states: [], officeId: '', editionId: '' }, { states: [ItemState.READY], officeId: OFFICE_ID, editionId: 'e1' }, ITEM_ID]);
    expect(server.headers.map((h) => h['authorization'])).toEqual(['Bearer officer.tok-en', 'Bearer officer.tok-en', 'Bearer officer.tok-en']);
  });

  it("reads an item's history, oldest first as the API gives it, with each actor's label", async () => {
    const at = new Date('2026-11-17T16:42:00Z');
    const server = await grpcServer((router) =>
      router.service(ContentService, {
        listItemHistory: () => ({
          entries: [
            create(HistoryEntrySchema, { at: timestampFromDate(at), action: 'ready', actorSubject: 's1', actingOfficeId: OFFICE_ID, versionNumber: 2, fromState: 'draft', toState: 'ready', actorLabel: 'Publications Officer' }),
            create(HistoryEntrySchema, { action: 'send_back', actorSubject: 's2', note: 'Add the time.', actorLabel: 'Webmaster' }),
          ],
        }),
      }),
    );
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    expect(await api.listItemHistory(OFFICER, ITEM_ID)).toEqual([
      { at, action: 'ready', actorSubject: 's1', actorLabel: 'Publications Officer', actingOfficeId: OFFICE_ID, versionNumber: 2, fromState: 'draft', toState: 'ready', note: '' },
      { action: 'send_back', actorSubject: 's2', actorLabel: 'Webmaster', actingOfficeId: '', versionNumber: 0, fromState: '', toState: '', note: 'Add the time.' },
    ]);
  });

  it('previews what the public and members will see; an unset body stays unset', async () => {
    const server = await grpcServer((router) =>
      router.service(ContentService, {
        previewWorkingItem: (req) =>
          req.itemId === ITEM_ID
            ? { title: 'T', summary: 'S', publicBody: { blocks: [para('p')] as never }, membersBody: { blocks: [para('m')] as never }, problems: [{ line: 2, message: 'bad' }] }
            : { title: 'Officers only', summary: '' },
      }),
    );
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    const both = await api.previewWorkingItem(OFFICER, ITEM_ID);
    expect(both).toMatchObject({ title: 'T', summary: 'S', problems: [{ line: 2, message: 'bad' }] });
    expect(both.publicBody?.blocks).toHaveLength(1);
    expect(both.membersBody?.blocks).toHaveLength(1);
    const neither = await api.previewWorkingItem(OFFICER, 'c0000000-0000-4000-8000-000000000002');
    expect(neither).toEqual({ title: 'Officers only', summary: '', problems: [] });
    expect('publicBody' in neither || 'membersBody' in neither).toBe(false);
  });

  it('reads the withheld flag, the send-back note and print-as-is from a version', async () => {
    const withheld = create(ContentItemSchema, {
      id: ITEM_ID,
      slug: '',
      kind: ContentKind.ARTICLE,
      officeId: OFFICE_ID,
      state: ItemState.DRAFT,
      working: { id: 'v1', number: 1, status: VersionStatus.DRAFT, title: 'T', visibility: ItemVisibility.PUBLIC, bodyMarkupWithheld: true, sendBackNote: 'Shorter, please.', printAsIs: true, onBehalfOf: 'A guest writer', approvedAt: timestampFromDate(READY_AT) },
    });
    const server = await grpcServer((router) => router.service(ContentService, { getWorkingItem: () => ({ item: withheld }) }));
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    expect((await api.getWorkingItem(OFFICER, ITEM_ID)).working).toMatchObject({ markup: '', markupWithheld: true, sendBackNote: 'Shorter, please.', printAsIs: true, onBehalfOf: 'A guest writer', approvedAt: READY_AT, status: 'draft' });
  });

  it('reads a version approved and waiting to be published (EDITOR A1: CLEARED) as cleared, not as an answer it cannot read', async () => {
    const waiting = create(ContentItemSchema, {
      id: ITEM_ID,
      slug: '',
      kind: ContentKind.ARTICLE,
      officeId: OFFICE_ID,
      state: ItemState.READY,
      working: { id: 'v1', number: 1, status: VersionStatus.CLEARED, title: 'T', visibility: ItemVisibility.PUBLIC, approvedAt: timestampFromDate(READY_AT) },
    });
    const server = await grpcServer((router) => router.service(ContentService, { getWorkingItem: () => ({ item: waiting }) }));
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    expect((await api.getWorkingItem(OFFICER, ITEM_ID)).working).toMatchObject({ status: 'cleared', approvedAt: READY_AT });
  });

  it("says an event's venue is decided later only when asked (EDITOR E6: one save, never two)", async () => {
    const seen: unknown[] = [];
    const occurrence = create(EventOccurrenceSchema, { id: 'stored', venueId: '' });
    const server = await grpcServer((router) =>
      router.service(EventService, {
        saveOccurrence: (req) => {
          seen.push({ id: req.occurrence?.id, venueId: req.occurrence?.venueId, later: req.venueDecidedLater });
          return { occurrence };
        },
      }),
    );
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    await api.saveOccurrence(OFFICER, { id: 'series:2026-11-18', venueId: '' }, { venueDecidedLater: true });
    await api.saveOccurrence(OFFICER, { id: 'series:2026-11-18', venueId: '' });
    await api.saveOccurrence(OFFICER, { id: 'series:2026-11-18', venueId: 'v1' }, { venueDecidedLater: false });
    expect(seen).toEqual([
      { id: 'series:2026-11-18', venueId: '', later: true },
      { id: 'series:2026-11-18', venueId: '', later: false },
      { id: 'series:2026-11-18', venueId: 'v1', later: false },
    ]);
  });

  it('saves an event date, a series and a venue, live on save; switching on or off only when asked', async () => {
    const seen: unknown[] = [];
    const occurrence = create(EventOccurrenceSchema, { id: 'series:2026-11-18', title: 'Lunch', status: OccurrenceStatus.CANCELLED, statusNote: 'Thanksgiving week' });
    const series = create(EventSeriesSchema, { id: 's1', slug: 'lunch', title: 'Lunch' });
    const venue = create(VenueSchema, { id: 'v1', kind: VenueKind.BUSINESS, name: 'Sample Bistro' });
    const server = await grpcServer((router) =>
      router.service(EventService, {
        saveOccurrence: (req) => {
          seen.push({ id: req.occurrence?.id, status: req.occurrence?.status });
          return { occurrence };
        },
        saveSeries: (req) => {
          seen.push({ id: req.series?.id, active: req.active });
          return { series };
        },
        saveVenue: (req) => {
          seen.push({ id: req.venue?.id, active: req.active });
          return { venue };
        },
      }),
    );
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    expect(await api.saveOccurrence(OFFICER, { id: 'series:2026-11-18', status: OccurrenceStatus.CANCELLED })).toEqual(occurrence);
    expect(await api.saveSeries(OFFICER, { id: 's1' })).toEqual(series);
    await api.saveSeries(OFFICER, { id: 's1' }, false);
    expect(await api.saveVenue(OFFICER, { id: 'v1' })).toEqual(venue);
    await api.saveVenue(OFFICER, { id: 'v1' }, true);
    expect(seen).toEqual([
      { id: 'series:2026-11-18', status: OccurrenceStatus.CANCELLED },
      { id: 's1', active: undefined },
      { id: 's1', active: false },
      { id: 'v1', active: undefined },
      { id: 'v1', active: true },
    ]);
    expect(server.headers.every((h) => h['authorization'] === 'Bearer officer.tok-en')).toBe(true);
  });
});

/** Every call the client makes, by its RPC name, against an API whose every handler refuses alike. */
const CALLS: Record<string, (api: EditorApi) => Promise<unknown>> = {
  CreateItem: (api) => api.createItem(OFFICER, { kind: 'article', officeId: OFFICE_ID, slug: 'x', title: 'X' }),
  SaveDraft: (api) => api.saveDraft(OFFICER, { itemId: ITEM_ID, title: 'X', summary: '', visibility: 'public', markup: '' }),
  MarkReady: (api) => api.markReady(OFFICER, { itemId: ITEM_ID, targets: { website: true, newsletter: false, email: false } }),
  SendBack: (api) => api.sendBack(OFFICER, { itemId: ITEM_ID, note: 'n' }),
  Approve: (api) => api.approve(OFFICER, { itemId: ITEM_ID, contentHash: HASH }),
  Withdraw: (api) => api.withdraw(OFFICER, ITEM_ID),
  ListWorkingItems: (api) => api.listWorkingItems(OFFICER),
  GetWorkingItem: (api) => api.getWorkingItem(OFFICER, ITEM_ID),
  ListItemHistory: (api) => api.listItemHistory(OFFICER, ITEM_ID),
  PreviewWorkingItem: (api) => api.previewWorkingItem(OFFICER, ITEM_ID),
  SaveOccurrence: (api) => api.saveOccurrence(OFFICER, { id: 'x' }),
  SaveSeries: (api) => api.saveSeries(OFFICER, { id: 'x' }),
  SaveVenue: (api) => api.saveVenue(OFFICER, { id: 'x' }),
};

/** An API that refuses every call with `code`, its message carrying words that must never reach a log. */
async function refusingServer(code: Code) {
  const refuse = () => {
    throw new ConnectError('SECRET-MESSAGE for officer.tok-en', code);
  };
  const content = Object.fromEntries(['createItem', 'saveDraft', 'markReady', 'sendBack', 'approve', 'withdraw', 'listWorkingItems', 'getWorkingItem', 'listItemHistory', 'previewWorkingItem'].map((m) => [m, refuse]));
  const events = Object.fromEntries(['saveOccurrence', 'saveSeries', 'saveVenue'].map((m) => [m, refuse]));
  return grpcServer((router) => {
    router.service(ContentService, content);
    router.service(EventService, events);
  });
}

const MAPPING: [Code, string, abstract new (...args: never[]) => Error][] = [
  [Code.Unauthenticated, 'unauthenticated', SignInAgain],
  [Code.Aborted, 'aborted', VersionChanged],
  [Code.FailedPrecondition, 'failed_precondition', EditorRefused],
  [Code.InvalidArgument, 'invalid_argument', EditorRefused],
  [Code.PermissionDenied, 'permission_denied', NotAllowed],
  // SlugTaken for CreateItem alone (below): the slug is the only thing it can collide on.
  [Code.AlreadyExists, 'already_exists', Duplicate],
  [Code.NotFound, 'not_found', ApiNotFound],
  [Code.Internal, 'internal', ApiUnavailable],
  [Code.Unavailable, 'unavailable', ApiUnavailable],
  [Code.ResourceExhausted, 'resource_exhausted', ApiUnavailable],
];

describe('grpcEditor: every refusal, on every call, as one thing a page can act on', () => {
  it.each(MAPPING)('code %s (%s) becomes %o on every call, logged by call and code only', async (code, name, kind) => {
    const server = await refusingServer(code);
    const lines: string[] = [];
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, (line) => lines.push(line));
    for (const [rpc, call] of Object.entries(CALLS)) {
      const error = await call(api).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error, rpc).toBeInstanceOf(code === Code.AlreadyExists && rpc === 'CreateItem' ? SlugTaken : kind);
      expect((error as { rpc: string }).rpc, rpc).toBe(rpc);
    }
    expect(lines.map((l) => JSON.parse(l) as { rpc: string; code: string }).map((l) => [l.rpc, l.code])).toEqual(Object.keys(CALLS).map((rpc) => [rpc, name]));
    expect(lines.join('\n')).not.toMatch(/SECRET|tok-en/);
  });

  it('takes ALREADY_EXISTS as a taken slug on CreateItem only: a series slug or a date already held is a duplicate', async () => {
    const server = await refusingServer(Code.AlreadyExists);
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    expect(await CALLS['CreateItem']!(api).catch((e: unknown) => e)).toBeInstanceOf(SlugTaken);
    for (const rpc of ['SaveSeries', 'SaveOccurrence', 'SaveVenue']) {
      const error = await CALLS[rpc]!(api).catch((e: unknown) => e);
      expect(error, rpc).toBeInstanceOf(Duplicate);
      expect(error, rpc).not.toBeInstanceOf(SlugTaken);
    }
  });

  it('cuts the API\'s words by whole characters, never through one written as two UTF-16 units', async () => {
    const server = await grpcServer((router) =>
      router.service(ContentService, {
        withdraw: () => {
          throw new ConnectError('😀'.repeat(REASON_MAX + 100), Code.FailedPrecondition);
        },
      }),
    );
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    const error = (await api.withdraw(OFFICER, ITEM_ID).catch((e: unknown) => e)) as EditorRefused;
    expect(error.reason).toBe(`${'😀'.repeat(REASON_MAX - 1)}…`);
    expect(error.reason).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect([...error.reason]).toHaveLength(REASON_MAX);
  });

  it("keeps every one of an event save's URL reasons (EDITOR E6: the form shows each on its field)", async () => {
    // A3a's events/writes.ts: one reason per bad address, joined by "; ". Three run well past 300 characters.
    const reasons = ['url: the address "http://example.org/" must start with https://, not http://', ...[1, 2, 3].map((n) => `detail line ${n}: the address "https://example.org:808${n}/" names a port (a colon and a number after the site name), which is not allowed`)].join('; ');
    const server = await grpcServer((router) =>
      router.service(EventService, {
        saveOccurrence: () => {
          throw new ConnectError(reasons, Code.InvalidArgument);
        },
      }),
    );
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    const error = (await api.saveOccurrence(OFFICER, { id: '' }).catch((e: unknown) => e)) as EditorRefused;
    expect(reasons.length).toBeGreaterThan(400);
    expect(error.reason).toBe(reasons);
    expect(REASON_MAX).toBeGreaterThanOrEqual(2000);
  });

  it("gives the API's own words for a step the item is not ready for, or a value it refused, plainly and capped", async () => {
    const long = `only a draft can be marked ready\u0007${'x'.repeat(REASON_MAX + 600)}`;
    const server = await grpcServer((router) =>
      router.service(ContentService, {
        markReady: () => {
          throw new ConnectError('the markup has 2 problem(s); fix them first', Code.FailedPrecondition);
        },
        sendBack: () => {
          throw new ConnectError('a note for the author is required', Code.InvalidArgument);
        },
        withdraw: () => {
          throw new ConnectError(long, Code.FailedPrecondition);
        },
      }),
    );
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    await expect(api.markReady(OFFICER, { itemId: ITEM_ID, targets: { website: true, newsletter: false, email: false } })).rejects.toMatchObject({
      reason: 'the markup has 2 problem(s); fix them first',
    });
    await expect(api.sendBack(OFFICER, { itemId: ITEM_ID, note: ' ' })).rejects.toMatchObject({ reason: 'a note for the author is required' });
    const error = (await api.withdraw(OFFICER, ITEM_ID).catch((e: unknown) => e)) as EditorRefused;
    expect(error.reason).toMatch(/^only a draft can be marked ready x+…$/);
    expect(error.reason.length).toBeLessThanOrEqual(REASON_MAX);
  });

  it('is the same sign-in-again the officer pages already handle', () => {
    expect(SignInAgain).toBe(OfficerSignInAgain);
  });

  it('refuses an answer it cannot read: no item, or an item, state, kind, status or visibility unset', async () => {
    const bad = (patch: Record<string, unknown>) => create(ContentItemSchema, { ...ITEM, ...patch } as never);
    const answers = [
      undefined,
      bad({ state: ItemState.UNSPECIFIED }),
      bad({ kind: ContentKind.UNSPECIFIED }),
      bad({ working: { ...ITEM.working, status: VersionStatus.UNSPECIFIED } }),
      bad({ live: { ...ITEM.live, visibility: ItemVisibility.UNSPECIFIED } }),
    ];
    let next = 0;
    const server = await grpcServer((router) =>
      router.service(ContentService, {
        getWorkingItem: () => (answers[next++] === undefined ? {} : { item: answers[next - 1] }),
        saveDraft: () => ({}),
      }),
    );
    const lines: string[] = [];
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, (line) => lines.push(line));
    for (let i = 0; i < answers.length; i++) await expect(api.getWorkingItem(OFFICER, ITEM_ID)).rejects.toBeInstanceOf(ApiUnavailable);
    await expect(api.saveDraft(OFFICER, { itemId: ITEM_ID, title: 'T', summary: '', visibility: 'public', markup: '' })).rejects.toBeInstanceOf(ApiUnavailable);
    expect(new Set(lines.map((l) => (JSON.parse(l) as { code: string }).code))).toEqual(new Set(['data_loss']));
  });

  it('refuses an event answer with nothing in it', async () => {
    const server = await grpcServer((router) => router.service(EventService, { saveOccurrence: () => ({}), saveSeries: () => ({}), saveVenue: () => ({}) }));
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    await expect(api.saveOccurrence(OFFICER, { id: 'x' })).rejects.toBeInstanceOf(ApiUnavailable);
    await expect(api.saveSeries(OFFICER, { id: 'x' })).rejects.toBeInstanceOf(ApiUnavailable);
    await expect(api.saveVenue(OFFICER, { id: 'x' })).rejects.toBeInstanceOf(ApiUnavailable);
  });

  it('never sends a bearer that is not one b64token: it asks to sign in again instead', async () => {
    const server = await refusingServer(Code.Internal);
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    for (const call of Object.values(CALLS)) {
      await expect(call(rebind(api, { bearer: 'two words' }))).rejects.toBeInstanceOf(SignInAgain);
    }
    expect(server.headers).toEqual([]);
  });

  it('never sends an item id that is not one: it is not found, and nothing is asked', async () => {
    const server = await refusingServer(Code.Internal);
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    const calls = [
      api.saveDraft(OFFICER, { itemId: '../x', title: 'T', summary: '', visibility: 'public', markup: '' }),
      api.markReady(OFFICER, { itemId: 'nope', targets: { website: true, newsletter: false, email: false } }),
      api.sendBack(OFFICER, { itemId: '', note: 'n' }),
      api.approve(OFFICER, { itemId: 'C0000000-0000-4000-8000-000000000001', contentHash: HASH }),
      api.withdraw(OFFICER, 'x'),
      api.getWorkingItem(OFFICER, 'x'),
      api.listItemHistory(OFFICER, 'x'),
      api.previewWorkingItem(OFFICER, 'x'),
    ];
    for (const call of calls) await expect(call).rejects.toBeInstanceOf(ApiNotFound);
    expect(server.headers).toEqual([]);
  });

  it('is unavailable everywhere when the API is set up wrongly', async () => {
    const api = unavailableEditor();
    for (const [rpc, call] of Object.entries(CALLS)) await expect(call(api), rpc).rejects.toMatchObject({ name: 'ApiUnavailable', rpc });
  });
});

/** Every call of `api`, made as `as` whatever reader the test passes. */
function rebind(api: EditorApi, as: { bearer: string }): EditorApi {
  return Object.fromEntries(Object.entries(api).map(([name, fn]) => [name, (_reader: unknown, ...rest: unknown[]) => (fn as (...a: unknown[]) => unknown)(as, ...rest)])) as unknown as EditorApi;
}

describe('editorFromEnv', () => {
  it('is off without API_URL and in the public-only build, unavailable when set wrongly, on otherwise', () => {
    const lines: string[] = [];
    expect(editorFromEnv({}, { publicOnly: false, log: () => {} })).toBeUndefined();
    expect(editorFromEnv({ API_URL: 'http://127.0.0.1:1' }, { publicOnly: true, log: () => {} })).toBeUndefined();
    expect(editorFromEnv({ API_URL: 'ftp://x' }, { publicOnly: false, log: (l) => lines.push(l) })).toBeDefined();
    expect(lines).toHaveLength(1);
    expect(editorFromEnv({ API_URL: 'http://127.0.0.1:1' }, { publicOnly: false, log: () => {} })).toBeDefined();
  });
});

describe('editorApi', () => {
  it('is made once per process, from its environment', () => {
    expect(editorApi()).toBe(editorApi());
  });
});

describe('editorReader', () => {
  const NOW = 1_800_000_000;
  const signedIn = (groups: string[]) => {
    const store = new TokenStore<Tokens>();
    const session = newSession({ sub: '0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b', groups }, NOW - 60);
    store.put(session.sid, { access_token: 'tok.en', expires_at: NOW + 3600 }, session.exp);
    return { session, deps: { tokens: store, now: () => NOW } };
  };

  it('gives the token of an officer, the Admin or the Webmaster, each without the officers group too', () => {
    for (const groups of [['nwfl-officers'], ['nwfl-admin'], ['nwfl-webmaster'], ['nwfl-users', 'nwfl-webmaster']]) {
      const { session, deps } = signedIn(groups);
      expect(editorReader(session, deps), groups.join()).toEqual({ reader: { bearer: 'tok.en' }, lapsed: false });
    }
  });

  it('gives nothing to no session, a member, or a stray group name', () => {
    expect(editorReader(undefined, signedIn([]).deps)).toEqual({ reader: undefined, lapsed: false });
    for (const groups of [['nwfl-members'], ['nwfl-membership-approvers'], ['mensa-nwfl-webmaster']]) {
      const { session, deps } = signedIn(groups);
      expect(editorReader(session, deps), groups.join()).toEqual({ reader: undefined, lapsed: false });
    }
  });

  it('gives nothing to a near-miss name that the session keeps, so it reaches the gate', () => {
    for (const group of ['nwfl-webmasters', 'nwfl-officer', 'nwfl-officers-old', 'nwfl-admins', 'nwfl-admin-x', 'nwfl-web']) {
      const { session, deps } = signedIn([group]);
      expect(session.groups, group).toEqual([group]);
      expect(editorReader(session, deps), group).toEqual({ reader: undefined, lapsed: false });
    }
  });

  it("gives each session its own token, never another's", () => {
    const store = new TokenStore<Tokens>();
    const writer = newSession({ sub: '00000000-0000-4000-8000-0000000000a1', groups: ['nwfl-officers'] }, NOW - 60);
    const approver = newSession({ sub: '00000000-0000-4000-8000-0000000000eb', groups: ['nwfl-webmaster'] }, NOW - 60);
    store.put(writer.sid, { access_token: 'writer.tok', expires_at: NOW + 3600 }, writer.exp);
    store.put(approver.sid, { access_token: 'approver.tok', expires_at: NOW + 3600 }, approver.exp);
    const deps = { tokens: store, now: () => NOW };
    expect(editorReader(writer, deps).reader).toEqual({ bearer: 'writer.tok' });
    expect(editorReader(approver, deps).reader).toEqual({ bearer: 'approver.tok' });
    const stranger = newSession({ sub: '00000000-0000-4000-8000-0000000000ad', groups: ['nwfl-admin'] }, NOW - 60);
    expect(editorReader(stranger, deps)).toEqual({ reader: undefined, lapsed: true });
  });
});

// EDITOR E3: the two public reads the writer screens need beside the workflow, sent as the public
// (no bearer, no cookie): the roster, for the office ids an item is posted as, and the office's
// upcoming events, for the President's report's events box.
describe('grpcEditor: the public reads beside the workflow (E3)', () => {
  const at = (iso: string) => timestampFromDate(new Date(iso));

  it('reads the roster as the public: each active office by id, slug and title, in roster order', async () => {
    const server = await grpcServer((router) =>
      router.service(ContentService, {
        getRoster: () => ({
          offices: [
            { id: OFFICE_ID, slug: 'president', title: 'President', sortOrder: 1, active: true, roleAlias: 'president@nwflorida.us' },
            { id: '22222222-2222-4222-8222-222222222222', slug: 'social', title: 'Social Chair', sortOrder: 7, active: true },
            { id: '33333333-3333-4333-8333-333333333333', slug: 'retired', title: 'Retired Office', sortOrder: 9, active: false },
          ],
        }),
      }),
    );
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    expect(await api.offices()).toEqual([
      { id: OFFICE_ID, slug: 'president', title: 'President' },
      { id: '22222222-2222-4222-8222-222222222222', slug: 'social', title: 'Social Chair' },
    ]);
    expect(server.headers[0]?.['authorization']).toBeUndefined();
    expect(server.headers[0]?.['cookie']).toBeUndefined();
  });

  it("reads an office's events as the public: its one-offs, and its series' dates by the series' host", async () => {
    const SERIES_ID = '0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20';
    const OTHER = '22222222-2222-4222-8222-222222222222';
    const seen: unknown[] = [];
    const server = await grpcServer((router) =>
      router.service(EventService, {
        listOccurrences: (req) => {
          const day = (d: { year: number; month: number; day: number } | undefined) => d && { year: d.year, month: d.month, day: d.day };
          seen.push({ from: day(req.from), to: day(req.to), includeCancelled: req.includeCancelled });
          return {
            occurrences: [
              { id: `${SERIES_ID}:2026-11-18`, seriesId: SERIES_ID, title: 'Wednesday Lunchers', startsAt: at('2026-11-18T17:30:00Z'), endsAt: at('2026-11-18T19:00:00Z'), status: OccurrenceStatus.SCHEDULED, localDate: { year: 2026, month: 11, day: 18 } },
              { id: 'a0000000-0000-4000-8000-000000000001', title: 'Board games', status: OccurrenceStatus.CANCELLED, statusNote: 'Snow', localDate: { year: 2026, month: 11, day: 20 }, ownerOfficeId: OFFICE_ID },
              { id: 'a0000000-0000-4000-8000-000000000002', title: 'Happy hour', status: OccurrenceStatus.TENTATIVE, startsAt: at('2026-11-21T23:00:00Z'), localDate: { year: 2026, month: 11, day: 21 }, ownerOfficeId: OTHER },
              { id: 'a0000000-0000-4000-8000-000000000003', title: 'Unknown status', status: OccurrenceStatus.UNSPECIFIED, localDate: { year: 2026, month: 11, day: 22 }, ownerOfficeId: OFFICE_ID },
            ],
          };
        },
        listSeries: () => ({ series: [{ id: SERIES_ID, slug: 'lunch', title: 'Wednesday Lunchers', hostOfficeId: OFFICE_ID, active: true }] }),
      }),
    );
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    expect(await api.officeEvents(OFFICE_ID, '2026-11-17', '2027-01-15')).toEqual([
      { id: `${SERIES_ID}:2026-11-18`, title: 'Wednesday Lunchers', date: '2026-11-18', start: '11:30', end: { date: '2026-11-18', time: '13:00' }, status: 'scheduled', statusNote: '' },
      { id: 'a0000000-0000-4000-8000-000000000001', title: 'Board games', date: '2026-11-20', status: 'cancelled', statusNote: 'Snow' },
    ]);
    expect(seen).toEqual([{ from: { year: 2026, month: 11, day: 17 }, to: { year: 2027, month: 1, day: 15 }, includeCancelled: true }]);
    for (const h of server.headers) {
      expect(h['authorization']).toBeUndefined();
      expect(h['cookie']).toBeUndefined();
    }
  });

  it('is unavailable when a public read fails, whatever the code, logged by call and code only', async () => {
    for (const code of [Code.NotFound, Code.PermissionDenied, Code.Unavailable]) {
      const refuse = () => {
        throw new ConnectError('SECRET-MESSAGE', code);
      };
      const server = await grpcServer((router) => {
        router.service(ContentService, { getRoster: refuse });
        router.service(EventService, { listOccurrences: refuse, listSeries: refuse });
      });
      const lines: string[] = [];
      const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, (line) => lines.push(line));
      await expect(api.offices()).rejects.toMatchObject({ name: 'ApiUnavailable', rpc: 'GetRoster' });
      await expect(api.officeEvents(OFFICE_ID, '2026-11-17', '2026-12-17')).rejects.toMatchObject({ name: 'ApiUnavailable' });
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(lines.join('\n')).not.toContain('SECRET');
    }
    const api = unavailableEditor();
    await expect(api.offices()).rejects.toMatchObject({ name: 'ApiUnavailable', rpc: 'GetRoster' });
    await expect(api.officeEvents(OFFICE_ID, '2026-11-17', '2026-12-17')).rejects.toMatchObject({ name: 'ApiUnavailable', rpc: 'ListOccurrences' });
  });
});

describe('editorAdmits (E3)', () => {
  it('admits an officer, the Admin and the Webmaster, and nobody else', () => {
    for (const groups of [['nwfl-officers'], ['nwfl-admin'], ['nwfl-webmaster'], ['nwfl-members', 'nwfl-office-president', 'nwfl-officers']]) expect(editorAdmits({ groups }), groups.join()).toBe(true);
    for (const groups of [[], ['nwfl-members'], ['nwfl-office-president'], ['nwfl-membership-approvers'], ['nwfl-officers-x']]) expect(editorAdmits({ groups }), groups.join()).toBe(false);
    expect(editorAdmits(undefined)).toBe(false);
  });
});

describe('grpcEditor: when an item last changed (E3 fix 1)', () => {
  it('reads last_changed_at, and lists published and taken-down items by their states', async () => {
    const CHANGED = new Date('2026-11-12T20:05:00Z');
    const seen: number[][] = [];
    const server = await grpcServer((router) =>
      router.service(ContentService, {
        listWorkingItems: (req) => {
          seen.push([...req.states]);
          return { items: [{ ...ITEM, lastChangedAt: timestampFromDate(CHANGED) }] };
        },
      }),
    );
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    const [listed] = await api.listWorkingItems(OFFICER, { states: ['published', 'withdrawn'] });
    expect(listed?.lastChangedAt).toEqual(CHANGED);
    expect(seen).toEqual([[ItemState.PUBLISHED, ItemState.WITHDRAWN]]);
    const server2 = await grpcServer((router) => router.service(ContentService, { getWorkingItem: () => ({ item: ITEM }) }));
    expect((await grpcEditor({ baseUrl: server2.url, timeoutMs: 2000 }, () => {}).getWorkingItem(OFFICER, ITEM_ID)).lastChangedAt).toBeUndefined();
  });
});

describe('grpcEditor: auto-save (E3 round 2)', () => {
  it('reads each version\'s base to the microsecond, and sends it back with a save, automatic or not', async () => {
    const seen: unknown[] = [];
    const stamp = { seconds: 1794528300n, nanos: 123456000 };
    const answer = clone(ContentItemSchema, ITEM);
    answer.working!.updatedAt = create(TimestampSchema, stamp);
    const server = await grpcServer((router) =>
      router.service(ContentService, {
        getWorkingItem: () => ({ item: answer }),
        saveDraft: (req) => {
          seen.push({ base: req.baseUpdatedAt === undefined ? undefined : { seconds: req.baseUpdatedAt.seconds, nanos: req.baseUpdatedAt.nanos }, auto: req.auto });
          return { item: answer };
        },
      }),
    );
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    const base = (await api.getWorkingItem(OFFICER, ITEM_ID)).working?.base;
    expect(base).toBe('1794528300.123456000');
    const draft = { itemId: ITEM_ID, title: 'T', summary: '', visibility: 'public' as const, markup: 'x' };
    await api.saveDraft(OFFICER, { ...draft, base: base!, auto: true });
    await api.saveDraft(OFFICER, draft);
    expect(seen).toEqual([
      { base: stamp, auto: true },
      { base: undefined, auto: false },
    ]);
  });

  it('tells a save from a base someone else has changed since from any other refusal', async () => {
    let message = 'This draft was changed by someone else since you opened it';
    const server = await grpcServer((router) =>
      router.service(ContentService, {
        saveDraft: () => {
          throw new ConnectError(message, Code.FailedPrecondition);
        },
      }),
    );
    const api = grpcEditor({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    const draft = { itemId: ITEM_ID, title: 'T', summary: '', visibility: 'public' as const, markup: 'x', base: '1.0' };
    await expect(api.saveDraft(OFFICER, draft)).rejects.toBeInstanceOf(DraftChanged);
    message = 'an automatic save only saves a draft';
    await expect(api.saveDraft(OFFICER, draft)).rejects.toMatchObject({ name: 'EditorRefused', reason: 'an automatic save only saves a draft' });
  });

  it('turns a base into a timestamp and back exactly; a base that is no number is no current base', () => {
    expect(baseToken(create(TimestampSchema, { seconds: 5n, nanos: 7000 }))).toBe('5.000007000');
    expect(baseTimestamp('1794528300.123456000')).toMatchObject({ seconds: 1794528300n, nanos: 123456000 });
    expect(baseTimestamp('')).toBeUndefined();
    for (const junk of ['x', '1.2.3', '-1.0', '1.1234567890', '1e9.0']) expect(baseTimestamp(junk), junk).toMatchObject({ seconds: 0n, nanos: 0 });
  });
});
