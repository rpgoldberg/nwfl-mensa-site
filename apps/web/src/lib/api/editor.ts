// EDITOR E2: the officer editor's client for nwfl-mensa-api: the ContentService workflow (create, save
// a draft, mark ready, send back, approve, take down; the working items, one item, its history and the
// preview as the public and members will see it) and the EventService writes (a date, a series, a
// venue; live on save). The same wire as officer.ts: gRPC over HTTP/2 only, the API's address and
// timeout from API_URL and API_TIMEOUT_MS, and every call carries the signed-in officer's access token
// as "Authorization: Bearer", never a cookie. The API decides who may do what; the site only hides
// what the officer cannot use.
//
// A refusal becomes the one thing a page can act on:
//   UNAUTHENTICATED (or a bearer that is not one b64token)  SignInAgain: the page keeps the typed text
//                                                           and asks the officer to sign in again
//   ABORTED              VersionChanged: the version changed since it was opened (the approve hash)
//   FAILED_PRECONDITION  EditorRefused, with the API's words: a step the item is not ready for
//   INVALID_ARGUMENT     EditorRefused too: a value the API refused (the forms check first)
//   PERMISSION_DENIED    NotAllowed
//   ALREADY_EXISTS       SlugTaken: CreateItem tries the next slug (src/lib/editor/slug.ts)
//   NOT_FOUND            ApiNotFound, as for the public reads; also an item id that is not one, never sent
//   anything else        ApiUnavailable
// Each is logged by call and code only: never the API's message, the token or what was typed.
import type { MessageInitShape } from '@bufbuild/protobuf';
import { timestampDate, type Timestamp } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { PUBLIC_ONLY } from 'astro:env/server';
import type { Session } from '../../../server/session.mjs';
import {
  type ContentItem,
  ContentKind,
  ContentService,
  type ContentVersion,
  type Document,
  type HistoryEntry,
  ItemState,
  ItemVisibility,
  VersionStatus,
} from '../../gen/nwfl/mensa/v1/content_pb.js';
import { type EventOccurrence, type EventOccurrenceSchema, type EventSeries, type EventSeriesSchema, EventService, type Venue, type VenueSchema } from '../../gen/nwfl/mensa/v1/event_pb.js';
import { type ApiConfig, ApiNotFound, ApiUnavailable, READ_MAX_BYTES, type Reader, apiSetup, sendable } from './client';
import { sessionReader } from './membership';
import { OfficerSignInAgain, type OfficerReaderDeps } from './officer';

/** The officer's token was refused, has run out, or is not one to send: the officer pages' own (officer.ts). */
export { OfficerSignInAgain as SignInAgain };

/** The version changed since the approver opened it: show it again. */
export class VersionChanged extends Error {
  constructor(readonly rpc: string) {
    super(`the version changed before ${rpc}`);
    this.name = 'VersionChanged';
  }
}

/** The API refused the officer this step on this item. */
export class NotAllowed extends Error {
  constructor(readonly rpc: string) {
    super(`not allowed: ${rpc}`);
    this.name = 'NotAllowed';
  }
}

/** The slug is someone else's already. */
export class SlugTaken extends Error {
  constructor(readonly rpc: string) {
    super(`the slug is taken (${rpc})`);
    this.name = 'SlugTaken';
  }
}

/** The most of the API's words a page shows. */
export const REASON_MAX = 300;

/** A step the item is not ready for, or a value the API refused, in the API's words (`reason`), for the page to show. */
export class EditorRefused extends Error {
  constructor(
    readonly rpc: string,
    readonly reason: string,
  ) {
    super(`the API refused ${rpc}`);
    this.name = 'EditorRefused';
  }
}

export type KindName = 'article' | 'president_report' | 'announcement' | 'minutes' | 'treasurer_summary' | 'document' | 'page';
export type StateName = 'draft' | 'ready' | 'published' | 'withdrawn';
export type VersionStatusName = 'draft' | 'ready' | 'approved' | 'superseded' | 'discarded';
export type VisibilityName = 'public' | 'members' | 'officers';

export interface Targets {
  website: boolean;
  newsletter: boolean;
  email: boolean;
}

/** A version as the editor uses it. */
export interface EditorVersion {
  id: string;
  number: number;
  status: VersionStatusName;
  /** Always public. */
  title: string;
  /** Always public. */
  summary: string;
  visibility: VisibilityName;
  /** Filtered for the officer's lens. */
  body?: Document;
  /** What the author typed: empty when withheld. */
  markup: string;
  /** The officer's lens withholds part of it: the markup is empty, and the edit form must not open (src/lib/editor/form.ts). */
  markupWithheld: boolean;
  /** Set once ready; empty bytes before, or when withheld. */
  contentHash: Uint8Array;
  targets: Targets;
  editionId: string;
  printAsIs: boolean;
  onBehalfOf: string;
  readyAt?: Date;
  approvedAt?: Date;
  /** The approver's note since the version was last marked ready; empty once it is ready again. */
  sendBackNote: string;
  /** This officer edited the version: approving it needs one approver set, or the Admin's break-glass. */
  callerEdited: boolean;
}

export interface EditorItem {
  id: string;
  slug: string;
  kind: KindName;
  officeId: string;
  state: StateName;
  /** What readers see now. */
  live?: EditorVersion;
  /** The draft or ready revision. */
  working?: EditorVersion;
  withdrawnAt?: Date;
}

export interface Problem {
  line: number;
  message: string;
}

/** The working version (else the live one) as each audience will get it once approved. An unset body: that audience will not see it. */
export interface Preview {
  title: string;
  summary: string;
  publicBody?: Document;
  membersBody?: Document;
  problems: Problem[];
}

/** One audited step, as the API gives it (oldest first); src/lib/editor/history.ts puts it in words. */
export interface HistoryStep {
  at?: Date;
  action: string;
  actorSubject: string;
  /** Who acted, by role at the time: never a name. */
  actorLabel: string;
  actingOfficeId: string;
  versionNumber: number;
  fromState: string;
  toState: string;
  /** A send-back note or a break-glass reason. */
  note: string;
}

export interface EditorApi {
  createItem(as: Reader, item: { kind: KindName; officeId: string; slug: string; title: string; onBehalfOf?: string }): Promise<EditorItem>;
  saveDraft(as: Reader, draft: { itemId: string; title: string; summary: string; visibility: VisibilityName; markup: string }): Promise<{ item: EditorItem; problems: Problem[] }>;
  markReady(as: Reader, ready: { itemId: string; targets: Targets; editionId?: string; printAsIs?: boolean }): Promise<EditorItem>;
  sendBack(as: Reader, back: { itemId: string; note: string }): Promise<EditorItem>;
  /** `targets` and `editionId` unset keep what was chosen at ready; `breakGlass` is the Admin's own change, with a reason. */
  approve(as: Reader, approval: { itemId: string; contentHash: Uint8Array; targets?: Targets; editionId?: string; breakGlass?: { reason: string } }): Promise<EditorItem>;
  withdraw(as: Reader, itemId: string): Promise<EditorItem>;
  /** No states: drafts and ready ones. */
  listWorkingItems(as: Reader, filter?: { states?: readonly StateName[]; officeId?: string; editionId?: string }): Promise<EditorItem[]>;
  getWorkingItem(as: Reader, itemId: string): Promise<EditorItem>;
  /** Oldest first, as the API gives it. */
  listItemHistory(as: Reader, itemId: string): Promise<HistoryStep[]>;
  previewWorkingItem(as: Reader, itemId: string): Promise<Preview>;
  /** Live on save. A series date is addressed as `<series>:<YYYY-MM-DD>`; an empty id creates a one-off. */
  saveOccurrence(as: Reader, occurrence: MessageInitShape<typeof EventOccurrenceSchema>): Promise<EventOccurrence>;
  /** `active` unset keeps the series as it is. */
  saveSeries(as: Reader, series: MessageInitShape<typeof EventSeriesSchema>, active?: boolean): Promise<EventSeries>;
  /** `active` unset keeps the venue as it is. */
  saveVenue(as: Reader, venue: MessageInitShape<typeof VenueSchema>, active?: boolean): Promise<Venue>;
}

const KINDS: Record<KindName, ContentKind> = {
  article: ContentKind.ARTICLE,
  president_report: ContentKind.PRESIDENT_REPORT,
  announcement: ContentKind.ANNOUNCEMENT,
  minutes: ContentKind.MINUTES,
  treasurer_summary: ContentKind.TREASURER_SUMMARY,
  document: ContentKind.DOCUMENT,
  page: ContentKind.PAGE,
};
const STATES: Record<StateName, ItemState> = { draft: ItemState.DRAFT, ready: ItemState.READY, published: ItemState.PUBLISHED, withdrawn: ItemState.WITHDRAWN };
const STATUSES: Record<VersionStatusName, VersionStatus> = {
  draft: VersionStatus.DRAFT,
  ready: VersionStatus.READY,
  approved: VersionStatus.APPROVED,
  superseded: VersionStatus.SUPERSEDED,
  discarded: VersionStatus.DISCARDED,
};
const VISIBILITIES: Record<VisibilityName, ItemVisibility> = { public: ItemVisibility.PUBLIC, members: ItemVisibility.MEMBERS, officers: ItemVisibility.OFFICERS };

/** The name for an enum value, or a DATA_LOSS refusal for one the site cannot read (unset or unknown). */
function nameOf<K extends string>(table: Record<K, number>, value: number): K {
  const name = (Object.keys(table) as K[]).find((key) => table[key] === value);
  if (name === undefined) throw new ConnectError('an answer the site cannot read', Code.DataLoss);
  return name;
}

const date = (at: Timestamp | undefined) => (at === undefined ? {} : { at: timestampDate(at) });

function versionOf(v: ContentVersion): EditorVersion {
  return {
    id: v.id,
    number: v.number,
    status: nameOf(STATUSES, v.status),
    title: v.title,
    summary: v.summary,
    visibility: nameOf(VISIBILITIES, v.visibility),
    ...(v.body === undefined ? {} : { body: v.body }),
    markup: v.bodyMarkupWithheld ? '' : v.bodyMarkup,
    markupWithheld: v.bodyMarkupWithheld,
    contentHash: v.contentHash,
    targets: { website: v.targets?.website ?? false, newsletter: v.targets?.newsletter ?? false, email: v.targets?.email ?? false },
    editionId: v.editionId,
    printAsIs: v.printAsIs,
    onBehalfOf: v.onBehalfOf,
    ...(v.readyAt === undefined ? {} : { readyAt: timestampDate(v.readyAt) }),
    ...(v.approvedAt === undefined ? {} : { approvedAt: timestampDate(v.approvedAt) }),
    sendBackNote: v.sendBackNote,
    callerEdited: v.callerEdited,
  };
}

function itemOf(item: ContentItem | undefined): EditorItem {
  if (item === undefined) throw new ConnectError('no item in the answer', Code.DataLoss);
  return {
    id: item.id,
    slug: item.slug,
    kind: nameOf(KINDS, item.kind),
    officeId: item.officeId,
    state: nameOf(STATES, item.state),
    ...(item.live === undefined ? {} : { live: versionOf(item.live) }),
    ...(item.working === undefined ? {} : { working: versionOf(item.working) }),
    ...(item.withdrawnAt === undefined ? {} : { withdrawnAt: timestampDate(item.withdrawnAt) }),
  };
}

function stepOf(entry: HistoryEntry): HistoryStep {
  return {
    ...date(entry.at),
    action: entry.action,
    actorSubject: entry.actorSubject,
    actorLabel: entry.actorLabel,
    actingOfficeId: entry.actingOfficeId,
    versionNumber: entry.versionNumber,
    fromState: entry.fromState,
    toState: entry.toState,
    note: entry.note,
  };
}

function present<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new ConnectError(`no ${what} in the answer`, Code.DataLoss);
  return value;
}

/** The API's words as a page may show them: one line of plain text, capped. */
function plainReason(message: string): string {
  const line = message.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX - 1).trimEnd()}…` : line;
}

const codeName = (code: Code) => Code[code].replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function grpcEditor(config: ApiConfig, log: (line: string) => void): EditorApi {
  const transport = createGrpcTransport({ baseUrl: config.baseUrl, defaultTimeoutMs: config.timeoutMs, readMaxBytes: READ_MAX_BYTES });
  const content = createClient(ContentService, transport);
  const events = createClient(EventService, transport);

  const call = async <T>(rpc: string, as: Reader, run: (options: { headers: { authorization: string } }) => Promise<T>, itemId?: string): Promise<T> => {
    const reader = sendable(as);
    if (reader === undefined) throw new OfficerSignInAgain(rpc);
    // An id that is not one is no item at all: never sent (an id in a page's path is anyone's to type).
    if (itemId !== undefined && !UUID.test(itemId)) throw new ApiNotFound(rpc);
    try {
      return await run({ headers: { authorization: `Bearer ${reader.bearer}` } });
    } catch (error) {
      const failure = ConnectError.from(error);
      const code = failure.code;
      // A refusal the page answers is a warning; anything that ends as unavailable is an error.
      const answered = [Code.Unauthenticated, Code.Aborted, Code.FailedPrecondition, Code.InvalidArgument, Code.PermissionDenied, Code.AlreadyExists, Code.NotFound].includes(code);
      log(JSON.stringify(answered ? { level: 'warn', msg: 'api refused the call', rpc, code: codeName(code) } : { level: 'error', msg: 'api call failed', rpc, code: codeName(code) }));
      switch (code) {
        case Code.Unauthenticated:
          throw new OfficerSignInAgain(rpc);
        case Code.Aborted:
          throw new VersionChanged(rpc);
        case Code.FailedPrecondition:
        case Code.InvalidArgument:
          throw new EditorRefused(rpc, plainReason(failure.rawMessage));
        case Code.PermissionDenied:
          throw new NotAllowed(rpc);
        case Code.AlreadyExists:
          throw new SlugTaken(rpc);
        case Code.NotFound:
          throw new ApiNotFound(rpc);
        default:
          throw new ApiUnavailable(rpc);
      }
    }
  };

  return {
    createItem: (as, item) =>
      call('CreateItem', as, async (o) =>
        itemOf((await content.createItem({ kind: KINDS[item.kind], officeId: item.officeId, slug: item.slug, title: item.title, onBehalfOf: item.onBehalfOf ?? '' }, o)).item),
      ),
    saveDraft: (as, draft) =>
      call(
        'SaveDraft',
        as,
        async (o) => {
          const answer = await content.saveDraft({ itemId: draft.itemId, title: draft.title, summary: draft.summary, visibility: VISIBILITIES[draft.visibility], bodyMarkup: draft.markup }, o);
          return { item: itemOf(answer.item), problems: answer.problems.map((p) => ({ line: p.line, message: p.message })) };
        },
        draft.itemId,
      ),
    markReady: (as, ready) =>
      call(
        'MarkReady',
        as,
        async (o) => itemOf((await content.markReady({ itemId: ready.itemId, targets: ready.targets, editionId: ready.editionId ?? '', printAsIs: ready.printAsIs ?? false }, o)).item),
        ready.itemId,
      ),
    sendBack: (as, back) => call('SendBack', as, async (o) => itemOf((await content.sendBack({ itemId: back.itemId, note: back.note }, o)).item), back.itemId),
    approve: (as, approval) =>
      call(
        'Approve',
        as,
        async (o) =>
          itemOf(
            (
              await content.approve(
                {
                  itemId: approval.itemId,
                  contentHash: approval.contentHash,
                  ...(approval.targets === undefined ? {} : { targets: approval.targets }),
                  editionId: approval.editionId ?? '',
                  breakGlass: approval.breakGlass !== undefined,
                  breakGlassReason: approval.breakGlass?.reason ?? '',
                },
                o,
              )
            ).item,
          ),
        approval.itemId,
      ),
    withdraw: (as, itemId) => call('Withdraw', as, async (o) => itemOf((await content.withdraw({ itemId }, o)).item), itemId),
    listWorkingItems: (as, filter = {}) =>
      call('ListWorkingItems', as, async (o) =>
        (await content.listWorkingItems({ states: (filter.states ?? []).map((s) => STATES[s]), officeId: filter.officeId ?? '', editionId: filter.editionId ?? '' }, o)).items.map(itemOf),
      ),
    getWorkingItem: (as, itemId) => call('GetWorkingItem', as, async (o) => itemOf((await content.getWorkingItem({ itemId }, o)).item), itemId),
    listItemHistory: (as, itemId) => call('ListItemHistory', as, async (o) => (await content.listItemHistory({ itemId }, o)).entries.map(stepOf), itemId),
    previewWorkingItem: (as, itemId) =>
      call(
        'PreviewWorkingItem',
        as,
        async (o) => {
          const answer = await content.previewWorkingItem({ itemId }, o);
          return {
            title: answer.title,
            summary: answer.summary,
            ...(answer.publicBody === undefined ? {} : { publicBody: answer.publicBody }),
            ...(answer.membersBody === undefined ? {} : { membersBody: answer.membersBody }),
            problems: answer.problems.map((p) => ({ line: p.line, message: p.message })),
          };
        },
        itemId,
      ),
    saveOccurrence: (as, occurrence) => call('SaveOccurrence', as, async (o) => present((await events.saveOccurrence({ occurrence }, o)).occurrence, 'occurrence')),
    saveSeries: (as, series, active) => call('SaveSeries', as, async (o) => present((await events.saveSeries({ series, ...(active === undefined ? {} : { active }) }, o)).series, 'series')),
    saveVenue: (as, venue, active) => call('SaveVenue', as, async (o) => present((await events.saveVenue({ venue, ...(active === undefined ? {} : { active }) }, o)).venue, 'venue')),
  };
}

/** Every call fails: the API is switched on but set up wrongly. */
export function unavailableEditor(): EditorApi {
  const fail = (rpc: string) => () => Promise.reject(new ApiUnavailable(rpc));
  return {
    createItem: fail('CreateItem'),
    saveDraft: fail('SaveDraft'),
    markReady: fail('MarkReady'),
    sendBack: fail('SendBack'),
    approve: fail('Approve'),
    withdraw: fail('Withdraw'),
    listWorkingItems: fail('ListWorkingItems'),
    getWorkingItem: fail('GetWorkingItem'),
    listItemHistory: fail('ListItemHistory'),
    previewWorkingItem: fail('PreviewWorkingItem'),
    saveOccurrence: fail('SaveOccurrence'),
    saveSeries: fail('SaveSeries'),
    saveVenue: fail('SaveVenue'),
  };
}

/** The editor client for this environment: none without API_URL, and none in a public-only build (no sign-in at all). */
export function editorFromEnv(env: Record<string, string | undefined>, { publicOnly, log }: { publicOnly: boolean; log: (line: string) => void }): EditorApi | undefined {
  if (publicOnly) return undefined;
  const setup = apiSetup(env);
  if (!setup.enabled) return undefined;
  if ('error' in setup) {
    log(JSON.stringify({ level: 'error', msg: setup.error }));
    return unavailableEditor();
  }
  return grpcEditor(setup.config, log);
}

let editor: { api: EditorApi | undefined } | undefined;

/** One per process, as officerApi() is. */
export function editorApi(): EditorApi | undefined {
  editor ??= { api: editorFromEnv(process.env, { publicOnly: PUBLIC_ONLY, log: (line) => console.error(line) }) };
  return editor.api;
}

/** Who may open the editor's pages: the API also lets the Admin and the Webmaster read the queue (E1). */
const EDITOR_GROUPS = ['nwfl-officers', 'nwfl-admin', 'nwfl-webmaster'];

/**
 * The token to send for the editor, if any: for an officer's, the Admin's or the Webmaster's live session
 * whose token has more than 30 seconds to live (officerReader's rule, with the Webmaster too). Lapsed when
 * that session or token has run out (sign in again).
 */
export function editorReader(session: Session | undefined, deps: OfficerReaderDeps): { reader: Reader | undefined; lapsed: boolean } {
  if (session === undefined || !session.groups.some((group) => EDITOR_GROUPS.includes(group))) return { reader: undefined, lapsed: false };
  return sessionReader(session, deps);
}
