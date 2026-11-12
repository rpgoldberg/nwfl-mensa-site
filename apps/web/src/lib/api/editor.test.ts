// EDITOR E2: the officer editor's client for the ContentService workflow and the EventService writes,
// over the gRPC wire against an API on loopback. Every call carries the signed-in officer's token as a
// bearer and nothing else; each answer is read into the editor's own shape; and each refusal becomes
// the one thing a page can act on: sign in again, the version changed, not allowed, the slug is taken,
// the API's words for a step the item is not ready for, not found, or unavailable.
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
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
  EditorRefused,
  NotAllowed,
  SignInAgain,
  SlugTaken,
  VersionChanged,
  editorApi,
  editorFromEnv,
  editorReader,
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
  [Code.AlreadyExists, 'already_exists', SlugTaken],
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
      expect(error, rpc).toBeInstanceOf(kind);
      expect((error as { rpc: string }).rpc, rpc).toBe(rpc);
    }
    expect(lines.map((l) => JSON.parse(l) as { rpc: string; code: string }).map((l) => [l.rpc, l.code])).toEqual(Object.keys(CALLS).map((rpc) => [rpc, name]));
    expect(lines.join('\n')).not.toMatch(/SECRET|tok-en/);
  });

  it("gives the API's own words for a step the item is not ready for, or a value it refused, plainly and capped", async () => {
    const long = `only a draft can be marked ready\u0007${'x'.repeat(600)}`;
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
    expect(error.reason.length).toBeLessThanOrEqual(300);
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
});
