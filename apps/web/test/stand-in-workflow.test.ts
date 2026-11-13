// EDITOR E2: the stand-in API's publishing workflow (e2e/workflow.mjs), which the editor's screen
// units test against, driven over the gRPC wire by the site's own editor client (src/lib/api/editor.ts)
// as the API's workflow answers it: who may do what, each state and its refusal, the approve hash,
// "you edited this", the send-back note, the history with role labels, the preview per audience, and
// the withheld guard. Callers are told apart by their bearer here; api.mjs verifies a real token.
import { type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkflow, parseMarkup } from '../e2e/workflow.mjs';
import { ContentService, ItemState, VersionStatus } from '../src/gen/nwfl/mensa/v1/content_pb.js';
import { ApiNotFound } from '../src/lib/api/client';
import { DraftChanged, EditorRefused, type EditorApi, type EditorItem, LinksChanged, NotAllowed, SlugTaken, VersionChanged, grpcEditor } from '../src/lib/api/editor';
import { editFormFor } from '../src/lib/editor/form';
import { historySentences } from '../src/lib/editor/history';
import { createWithSlug } from '../src/lib/editor/slug';
import { statusOf } from '../src/lib/editor/status';

const OFFICES = [
  { id: '11111111-1111-4111-8111-111111111111', slug: 'president', title: 'President' },
  { id: '22222222-2222-4222-8222-222222222222', slug: 'social', title: 'Social Chair' },
  { id: '33333333-3333-4333-8333-333333333333', slug: 'treasurer', title: 'Treasurer' },
  { id: '44444444-4444-4444-8444-444444444444', slug: 'publications', title: 'Publications Officer' },
  { id: '55555555-5555-4555-8555-555555555555', slug: 'editor', title: 'Newsletter Editor' },
];
type Office = (typeof OFFICES)[0];
const [PRESIDENT, SOCIAL, TREASURER, , EDITOR_OFFICE] = OFFICES as [Office, Office, Office, Office, Office];
/** EDITOR E4: an edition already frozen for print. */
const FROZEN = { id: 'e0000000-0000-4000-8000-0000000000f0', title: 'October–November 2026' };

/** The test provider's people (e2e/idp.mjs), by the bearer each sends here. */
const PEOPLE: Record<string, { sub: string; groups: string[] }> = {
  officer: { sub: '00000000-0000-4000-8000-0000000000a1', groups: ['nwfl-members', 'nwfl-officers', 'nwfl-office-president'] },
  // EDITOR E4: the Admin holds two offices, as Ross's account does.
  admin: { sub: '00000000-0000-4000-8000-0000000000ad', groups: ['nwfl-members', 'nwfl-officers', 'nwfl-office-publications', 'nwfl-office-editor', 'nwfl-admin'] },
  treasurer: { sub: '00000000-0000-4000-8000-0000000000f8', groups: ['nwfl-members', 'nwfl-officers', 'nwfl-office-treasurer'] },
  // E4: a seat without the officers group (GetItemLinks: its own office's items only).
  'seat-only': { sub: '00000000-0000-4000-8000-0000000000e6', groups: ['nwfl-users', 'nwfl-office-social'] },
  webmaster: { sub: '00000000-0000-4000-8000-0000000000eb', groups: ['nwfl-members', 'nwfl-officers', 'nwfl-webmaster'] },
  'lone-webmaster': { sub: '00000000-0000-4000-8000-0000000000d7', groups: ['nwfl-users', 'nwfl-webmaster'] },
  'officer-only': { sub: '00000000-0000-4000-8000-0000000000a9', groups: ['nwfl-officers'] },
  member: { sub: '00000000-0000-4000-8000-0000000000b2', groups: ['nwfl-members'] },
};
const as = (who: keyof typeof PEOPLE) => ({ bearer: who });

let clock = new Date('2026-11-17T16:42:00Z');
let rule: 'two_person' | 'one_approver' = 'two_person';
let model: ReturnType<typeof createWorkflow>;
let api: EditorApi;
let close: () => Promise<void>;

beforeEach(async () => {
  clock = new Date('2026-11-17T16:42:00Z');
  rule = 'two_person';
  model = createWorkflow({
    offices: OFFICES,
    now: () => {
      clock = new Date(clock.getTime() + 60_000);
      return clock;
    },
    ruleFor: () => rule,
    frozenEditions: [FROZEN],
  });
  const routes = (router: ConnectRouter) =>
    router.service(
      ContentService,
      model.handlers((ctx) => {
        const who = /^Bearer (.+)$/.exec(ctx.requestHeader.get('authorization') ?? '')?.[1] ?? '';
        const person = PEOPLE[who];
        if (person === undefined) throw new Error('unknown test caller');
        return person;
      }),
    );
  const adapter = connectNodeAdapter({ routes, grpc: true, grpcWeb: false, connect: false });
  const sessions = new Set<http2.ServerHttp2Session>();
  const server = http2.createServer((req, res) => void adapter(req, res));
  server.on('session', (s) => sessions.add(s));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  close = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
      for (const s of sessions) s.destroy();
    });
  api = grpcEditor({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, timeoutMs: 2000 }, () => {});
});

afterEach(async () => {
  await close();
});

const create = (who: keyof typeof PEOPLE, title: string, office = PRESIDENT.id) =>
  createWithSlug(title, (slug) => api.createItem(as(who), { kind: 'announcement', officeId: office, slug, title }));
const save = (who: keyof typeof PEOPLE, item: EditorItem, markup: string, visibility: 'public' | 'members' | 'officers' = 'public') =>
  api.saveDraft(as(who), { itemId: item.id, title: item.working?.title ?? item.live?.title ?? 'T', summary: 'A summary', visibility, markup });
const WEBSITE = { website: true, newsletter: false, email: false };
const refusal = (promise: Promise<unknown>) => promise.then(() => undefined, (e: unknown) => e);

/** A ready item by the President's office, from a fresh draft. */
async function readyItem(title: string, who: keyof typeof PEOPLE = 'officer') {
  const item = await create(who, title);
  await save(who, item, 'Lunch is on **Thursday**.');
  return api.markReady(as(who), { itemId: item.id, targets: WEBSITE });
}

/** EDITOR E4: an item the President wrote and the Treasurer approved: "Approved, ready to publish". */
async function approved(title: string) {
  const ready = await readyItem(title);
  return api.approve(as('treasurer'), { itemId: ready.id, contentHash: ready.working!.contentHash });
}

describe('the stand-in workflow: writing', () => {
  it('creates a draft posting as an office, with the slug made from the title, -2 when taken', async () => {
    const first = await create('officer', 'Lunch moves');
    const second = await create('officer', 'Lunch moves');
    expect([first.slug, second.slug]).toEqual(['lunch-moves', 'lunch-moves-2']);
    expect(first).toMatchObject({ kind: 'announcement', officeId: PRESIDENT.id, state: 'draft', working: { number: 1, status: 'draft', title: 'Lunch moves', callerEdited: true } });
    expect(statusOf(first).label).toBe('Draft – only officers can see it');
    await expect(api.createItem(as('officer'), { kind: 'article', officeId: PRESIDENT.id, slug: 'lunch-moves', title: 'x' })).rejects.toBeInstanceOf(SlugTaken);
  });

  it('refuses an office the officer does not hold, a member, an unknown office, a marker in the title and a bad slug', async () => {
    expect(await refusal(api.createItem(as('officer'), { kind: 'article', officeId: SOCIAL.id, slug: 'a', title: 'A' }))).toBeInstanceOf(NotAllowed);
    expect(await refusal(api.createItem(as('member'), { kind: 'article', officeId: PRESIDENT.id, slug: 'a', title: 'A' }))).toBeInstanceOf(NotAllowed);
    expect(await refusal(api.createItem(as('officer'), { kind: 'article', officeId: 'nope', slug: 'a', title: 'A' }))).toMatchObject({ reason: 'unknown office' });
    expect(await refusal(api.createItem(as('officer'), { kind: 'article', officeId: PRESIDENT.id, slug: 'a', title: ':members[x]' }))).toMatchObject({
      reason: 'a title or summary is always public: put members-only words in the body',
    });
    expect(await refusal(api.createItem(as('officer'), { kind: 'article', officeId: PRESIDENT.id, slug: 'Bad Slug', title: 'A' }))).toBeInstanceOf(EditorRefused);
    expect(await refusal(api.createItem(as('officer'), { kind: 'article', officeId: PRESIDENT.id, slug: 'a', title: ' ' }))).toMatchObject({ reason: 'title is required' });
    expect(await refusal(api.createItem(as('officer'), { kind: 'article', officeId: PRESIDENT.id, slug: 'a', title: 'x'.repeat(201) }))).toBeInstanceOf(EditorRefused);
    expect(await refusal(api.createItem(as('officer'), { kind: 'page', officeId: PRESIDENT.id, slug: 'a', title: 'A' }))).toMatchObject({ reason: 'kind is required' });
  });

  it('lets the Admin post for any office', async () => {
    expect(await create('admin', 'For the social chair', SOCIAL.id)).toMatchObject({ officeId: SOCIAL.id, state: 'draft' });
  });

  it('saves a draft with its problems, and refuses to mark it ready until they are fixed', async () => {
    const item = await create('officer', 'With a bad link');
    const saved = await save('officer', item, 'See [the club](http://club.example).\n### Too deep', 'members');
    expect(saved.problems).toEqual([
      { line: 1, message: 'the link "http://club.example" must start with https://, not http://' },
      { line: 2, message: 'only two heading levels (# and ##)' },
    ]);
    expect(saved.item.working).toMatchObject({ visibility: 'members', summary: 'A summary', markup: 'See [the club](http://club.example).\n### Too deep' });
    expect(await refusal(api.markReady(as('officer'), { itemId: item.id, targets: WEBSITE }))).toMatchObject({ reason: 'the markup has 2 problem(s); fix them first' });
    await save('officer', item, 'See [the club](https://club.example).');
    const ready = await api.markReady(as('officer'), { itemId: item.id, targets: WEBSITE });
    expect(ready).toMatchObject({ state: 'ready', working: { status: 'ready', targets: WEBSITE } });
    expect(ready.working?.contentHash).toHaveLength(32);
    expect(statusOf(ready).label).toBe('Waiting for approval');
  });

  it('refuses another office, a marker in the summary, a missing title, and an officers item for the newsletter', async () => {
    const item = await create('officer', 'Guarded');
    expect(await refusal(save('officer-only', item, 'x'))).toBeInstanceOf(NotAllowed);
    expect(await refusal(api.saveDraft(as('officer'), { itemId: item.id, title: 'T', summary: '::: members', visibility: 'public', markup: '' }))).toBeInstanceOf(EditorRefused);
    expect(await refusal(api.saveDraft(as('officer'), { itemId: item.id, title: ' ', summary: '', visibility: 'public', markup: '' }))).toMatchObject({ reason: 'title is required' });
    await save('officer', item, 'Officers only.', 'officers');
    expect(await refusal(api.markReady(as('officer'), { itemId: item.id, targets: { website: true, newsletter: true, email: false } }))).toMatchObject({
      reason: 'an officers-only item cannot go to the newsletter or email',
    });
    expect(await refusal(api.markReady(as('officer-only'), { itemId: item.id, targets: WEBSITE }))).toBeInstanceOf(NotAllowed);
  });

  it('moves a ready version back to draft when it is edited, and refuses to mark ready what is not a draft', async () => {
    const ready = await readyItem('Edited while waiting');
    const edited = await save('officer', ready, 'Changed.');
    expect(edited.item).toMatchObject({ state: 'draft', working: { status: 'draft' } });
    expect(edited.item.working?.contentHash).toHaveLength(0);
    await api.markReady(as('officer'), { itemId: ready.id, targets: WEBSITE });
    expect(await refusal(api.markReady(as('officer'), { itemId: ready.id, targets: WEBSITE }))).toMatchObject({ reason: 'only a draft can be marked ready' });
  });

  it('never lets a ready "print as is" version be edited', async () => {
    const item = await create('officer', 'Print it as it is');
    await save('officer', item, 'As is.');
    const ready = await api.markReady(as('officer'), { itemId: item.id, targets: { website: true, newsletter: true, email: false }, printAsIs: true });
    expect(editFormFor(ready)).toMatchObject({ ok: false, reason: 'print_as_is' });
    expect(await refusal(save('officer', ready, 'Changed.'))).toMatchObject({ reason: 'a print-as-is version can be approved or sent back, never edited' });
  });
});

// EDITOR E4: A1's two steps, as the API answers them (apps/api/src/content/workflow.ts): any reviewer who did
// not edit a version approves it, which makes it CLEARED ("Approved, ready to publish") and publishes nothing;
// the Webmaster, or the Admin as backup, publishes it; a self-approval (break-glass, one approver) is published
// by someone else. Approve, Send back and ConfirmLinks act for an office the reviewer holds.
describe('the stand-in workflow: sending back', () => {
  it('sends back with a note by any reviewer, from waiting or approved, for an office they hold, which the writer reads', async () => {
    const ready = await readyItem('Sent back once');
    expect(await refusal(api.sendBack(as('webmaster'), { itemId: ready.id, note: '  ' }))).toMatchObject({ reason: 'a note for the author is required' });
    expect(await refusal(api.sendBack(as('webmaster'), { itemId: ready.id, note: 'x'.repeat(2001) }))).toBeInstanceOf(EditorRefused);
    expect(await refusal(api.sendBack(as('member'), { itemId: ready.id, note: 'mine' }))).toBeInstanceOf(NotAllowed);
    expect(await refusal(api.sendBack(as('treasurer'), { itemId: ready.id, note: 'As another.', actingAsOfficeId: SOCIAL.id }))).toMatchObject({ reason: 'you do not hold that office' });
    const back = await api.sendBack(as('treasurer'), { itemId: ready.id, note: 'Please add the time.' });
    expect(back).toMatchObject({ state: 'draft', working: { status: 'draft', sendBackNote: 'Please add the time.' } });
    expect(statusOf(back).label).toBe('Sent back – please read the note');
    expect((await api.listItemHistory(as('officer'), ready.id)).at(-1)).toMatchObject({ action: 'send_back', actorLabel: 'Treasurer', actingOfficeId: TREASURER.id, fromState: 'ready' });
    expect(await refusal(api.sendBack(as('webmaster'), { itemId: ready.id, note: 'again' }))).toMatchObject({
      reason: 'only a version waiting for approval, or approved and not yet published, can be sent back',
    });
    const again = await api.markReady(as('officer'), { itemId: ready.id, targets: WEBSITE });
    expect(again.working?.sendBackNote).toBe('');
    const cleared = await approved('Sent back once approved');
    const unclear = await api.sendBack(as('webmaster'), { itemId: cleared.id, note: 'Wrong date.' });
    expect(unclear).toMatchObject({ state: 'draft', working: { status: 'draft', approvedAsLabel: '', approvalKindSelf: false } });
    expect(unclear.working?.contentHash).toHaveLength(0);
  });
});

describe('the stand-in workflow: approving', () => {
  it('approves by the hash seen into "approved, ready to publish": nothing goes live', async () => {
    const ready = await readyItem('Approved by the treasurer');
    expect(ready.working).toMatchObject({ callerEdited: true, callerMayApprove: false, callerMayPublish: false });
    expect((await api.getWorkingItem(as('treasurer'), ready.id)).working).toMatchObject({ callerEdited: false, callerMayApprove: true, callerMayPublish: false });
    expect(await refusal(api.approve(as('treasurer'), { itemId: ready.id, contentHash: new Uint8Array(32) }))).toBeInstanceOf(VersionChanged);
    expect(await refusal(api.approve(as('member'), { itemId: ready.id, contentHash: ready.working!.contentHash }))).toBeInstanceOf(NotAllowed);
    const cleared = await api.approve(as('treasurer'), { itemId: ready.id, contentHash: ready.working!.contentHash });
    expect(cleared).toMatchObject({ state: 'ready', working: { status: 'cleared', approvedAsLabel: 'Treasurer', approvalKindSelf: false, callerMayApprove: false, callerMayPublish: false } });
    expect(cleared.live).toBeUndefined();
    expect(cleared.working?.approvedAt).toBeInstanceOf(Date);
    expect(cleared.working?.publishedAt).toBeUndefined();
    expect(statusOf(cleared).label).toBe('Approved, ready to publish');
    expect((await api.getWorkingItem(as('webmaster'), ready.id)).working).toMatchObject({ callerMayPublish: true });
    expect((await api.listItemHistory(as('officer'), ready.id)).at(-1)).toMatchObject({ action: 'approve', actorLabel: 'Treasurer', actingOfficeId: TREASURER.id, toState: 'cleared' });
    expect(await refusal(api.approve(as('webmaster'), { itemId: ready.id, contentHash: ready.working!.contentHash }))).toMatchObject({ reason: 'only a ready version can be approved' });
  });

  it('refuses the officer who edited it, even under one approver; an office they do not hold; and labels the one they act for', async () => {
    const ready = await readyItem('The President wrote this');
    expect(await refusal(api.approve(as('officer'), { itemId: ready.id, contentHash: ready.working!.contentHash }))).toMatchObject({
      reason: 'you edited this version; a second officer must approve it',
    });
    rule = 'one_approver';
    expect((await api.getWorkingItem(as('officer'), ready.id)).working?.callerMayApprove).toBe(false);
    expect(await refusal(api.approve(as('officer'), { itemId: ready.id, contentHash: ready.working!.contentHash }))).toBeInstanceOf(NotAllowed);
    rule = 'two_person';
    expect(await refusal(api.approve(as('admin'), { itemId: ready.id, contentHash: ready.working!.contentHash, actingAsOfficeId: TREASURER.id }))).toMatchObject({ reason: 'you do not hold that office' });
    expect(await refusal(api.approve(as('admin'), { itemId: ready.id, contentHash: ready.working!.contentHash, actingAsOfficeId: 'not-an-id' }))).toBeInstanceOf(EditorRefused);
    const cleared = await api.approve(as('admin'), { itemId: ready.id, contentHash: ready.working!.contentHash, actingAsOfficeId: EDITOR_OFFICE.id });
    expect(cleared.working?.approvedAsLabel).toBe('Newsletter Editor');
    // The Admin holds two offices: naming none acts for none.
    const other = await readyItem('No office named');
    expect((await api.approve(as('admin'), { itemId: other.id, contentHash: other.working!.contentHash })).working?.approvedAsLabel).toBe('Admin');
  });

  it("lets the Admin approve their own edit by break-glass with a reason, and someone else publish it", async () => {
    const ready = await readyItem('The Admin wrote this', 'admin');
    const hash = ready.working!.contentHash;
    expect(await refusal(api.approve(as('admin'), { itemId: ready.id, contentHash: hash }))).toBeInstanceOf(NotAllowed);
    expect(await refusal(api.approve(as('admin'), { itemId: ready.id, contentHash: hash, breakGlass: { reason: ' ' } }))).toMatchObject({ reason: 'a break-glass approval needs a written reason' });
    const cleared = await api.approve(as('admin'), { itemId: ready.id, contentHash: hash, breakGlass: { reason: 'The Webmaster is away' } });
    expect(cleared.working).toMatchObject({ status: 'cleared', approvalKindSelf: true, callerMayPublish: false });
    expect((await api.listItemHistory(as('admin'), ready.id)).at(-1)).toMatchObject({ action: 'approve_self', note: 'The Webmaster is away', actorLabel: 'Admin' });
    expect(await refusal(api.publish(as('admin'), { itemId: ready.id, contentHash: hash }))).toMatchObject({ reason: 'you approved your own change; someone else must publish it' });
    expect((await api.getWorkingItem(as('webmaster'), ready.id)).working?.callerMayPublish).toBe(true);
    expect((await api.publish(as('webmaster'), { itemId: ready.id, contentHash: hash })).state).toBe('published');
  });

  it('lets a publisher approve their own edit under one approver, as self_single, and refuses its publication once the rule is back', async () => {
    rule = 'one_approver';
    const solo = await readyItem('One approver set', 'admin');
    expect(solo.working?.callerMayApprove).toBe(true);
    const cleared = await api.approve(as('admin'), { itemId: solo.id, contentHash: solo.working!.contentHash });
    expect(cleared.working?.approvalKindSelf).toBe(true);
    expect((await api.listItemHistory(as('officer'), solo.id)).at(-1)?.action).toBe('approve_single');
    rule = 'two_person';
    expect((await api.getWorkingItem(as('webmaster'), solo.id)).working?.callerMayPublish).toBe(false);
    expect(await refusal(api.publish(as('webmaster'), { itemId: solo.id, contentHash: solo.working!.contentHash }))).toMatchObject({ reason: 'the approval rule changed; send it back' });
  });

  it("refuses break-glass to anyone but the Admin, for their own edit", async () => {
    const seeded = model.seed({ slug: 'webmaster-edited', kind: 'announcement', officeId: PRESIDENT.id, state: 'ready', title: 'Webmaster edited', editors: [PEOPLE['webmaster']!.sub] });
    const item = await api.getWorkingItem(as('webmaster'), seeded.id);
    expect(item.working?.callerEdited).toBe(true);
    expect(await refusal(api.approve(as('webmaster'), { itemId: item.id, contentHash: item.working!.contentHash, breakGlass: { reason: 'Away' } }))).toMatchObject({ reason: 'only the Admin may approve their own edit' });
    expect(await refusal(api.approve(as('webmaster'), { itemId: item.id, contentHash: item.working!.contentHash }))).toBeInstanceOf(NotAllowed);
  });

  it('logs a change of targets or edition at approval, and keeps an officers item off the newsletter', async () => {
    const ready = await readyItem('Targets change');
    const cleared = await api.approve(as('webmaster'), { itemId: ready.id, contentHash: ready.working!.contentHash, targets: { website: true, newsletter: true, email: false }, editionId: 'e0000000-0000-4000-8000-000000000001' });
    expect(cleared.working).toMatchObject({ targets: { website: true, newsletter: true, email: false }, editionId: 'e0000000-0000-4000-8000-000000000001' });
    expect((await api.listItemHistory(as('officer'), ready.id)).map((s) => s.action)).toEqual(['create', 'save', 'ready', 'targets_changed', 'edition_changed', 'approve']);
    const officers = await create('officer', 'Officers only item');
    await save('officer', officers, 'x', 'officers');
    const offReady = await api.markReady(as('officer'), { itemId: officers.id, targets: WEBSITE });
    expect(await refusal(api.approve(as('webmaster'), { itemId: offReady.id, contentHash: offReady.working!.contentHash, targets: { website: true, newsletter: true, email: false } }))).toBeInstanceOf(EditorRefused);
  });

  it('refuses to approve or publish for an edition frozen for print, in the API\'s words', async () => {
    const seeded = model.seed({ slug: 'for-a-frozen-issue', kind: 'announcement', officeId: PRESIDENT.id, state: 'ready', title: 'For a frozen issue', editionId: FROZEN.id, newsletter: true });
    const item = await api.getWorkingItem(as('webmaster'), seeded.id);
    expect(await refusal(api.approve(as('webmaster'), { itemId: item.id, contentHash: item.working!.contentHash }))).toMatchObject({
      reason: `${FROZEN.title} is already frozen for print: pick an open edition, then approve`,
    });
    const cleared = model.seed({ slug: 'cleared-for-a-frozen-issue', kind: 'announcement', officeId: PRESIDENT.id, state: 'ready', title: 'Cleared, frozen issue', cleared: true, editionId: FROZEN.id, newsletter: true });
    const read = await api.getWorkingItem(as('webmaster'), cleared.id);
    expect(await refusal(api.publish(as('webmaster'), { itemId: read.id, contentHash: read.working!.contentHash }))).toMatchObject({
      reason: `${FROZEN.title} is already frozen for print: send it back to pick an open edition`,
    });
  });
});

describe('the stand-in workflow: publishing', () => {
  it('publishes an approved version by the Webmaster, by the hash seen; never an officer, never twice', async () => {
    const cleared = await approved('Published by the webmaster');
    const hash = cleared.working!.contentHash;
    expect(await refusal(api.publish(as('officer'), { itemId: cleared.id, contentHash: hash }))).toBeInstanceOf(NotAllowed);
    expect(await refusal(api.publish(as('webmaster'), { itemId: cleared.id, contentHash: new Uint8Array(32) }))).toBeInstanceOf(VersionChanged);
    const published = await api.publish(as('webmaster'), { itemId: cleared.id, contentHash: hash });
    expect(published).toMatchObject({ state: 'published', live: { status: 'approved', number: 1, approvedAsLabel: 'Treasurer' } });
    expect(published.working).toBeUndefined();
    expect(published.live?.publishedAt).toBeInstanceOf(Date);
    expect(statusOf(published).label).toBe('Published');
    expect((await api.listItemHistory(as('officer'), cleared.id)).at(-1)).toMatchObject({ action: 'publish', actorLabel: 'Webmaster', fromState: 'cleared', toState: 'published' });
    expect(await refusal(api.publish(as('webmaster'), { itemId: cleared.id, contentHash: hash }))).toMatchObject({ reason: 'only an approved version can be published' });
  });

  it('lets the Admin publish as backup, and the approver publish what they approved', async () => {
    const one = await approved('Published by the admin');
    expect((await api.publish(as('admin'), { itemId: one.id, contentHash: one.working!.contentHash })).state).toBe('published');
    expect((await api.listItemHistory(as('officer'), one.id)).at(-1)).toMatchObject({ action: 'publish', actorLabel: 'Admin', note: '' });
    const two = await readyItem('Approved and published by the webmaster');
    const cleared = await api.approve(as('webmaster'), { itemId: two.id, contentHash: two.working!.contentHash });
    expect(cleared.working?.callerMayPublish).toBe(true);
    expect((await api.publish(as('webmaster'), { itemId: two.id, contentHash: two.working!.contentHash })).state).toBe('published');
  });

  it('edits a published item as a new version, shown as a change waiting, and supersedes the old one once published', async () => {
    const cleared = await approved('Published then changed');
    await api.publish(as('webmaster'), { itemId: cleared.id, contentHash: cleared.working!.contentHash });
    const changed = await save('officer', cleared, 'Version two.');
    expect(changed.item).toMatchObject({ state: 'published', live: { number: 1 }, working: { number: 2, status: 'draft', markup: 'Version two.' } });
    const waiting = await api.markReady(as('officer'), { itemId: cleared.id, targets: WEBSITE });
    expect(statusOf(waiting).label).toBe('Published – a change is waiting for approval');
    const two = await api.approve(as('treasurer'), { itemId: cleared.id, contentHash: waiting.working!.contentHash });
    expect(statusOf(two).label).toBe('Published – an approved change is waiting to be published');
    const live = await api.publish(as('webmaster'), { itemId: cleared.id, contentHash: waiting.working!.contentHash });
    expect(live).toMatchObject({ state: 'published', live: { number: 2, markup: 'Version two.' } });
    expect(live.working).toBeUndefined();
  });

  it('takes a published item down by its office, the Webmaster or the Admin; voids a change waiting to be published; puts it back only when told', async () => {
    const cleared = await approved('Taken down');
    expect(await refusal(api.withdraw(as('officer'), cleared.id))).toMatchObject({ reason: 'only a published item can be withdrawn' });
    await api.publish(as('webmaster'), { itemId: cleared.id, contentHash: cleared.working!.contentHash });
    await save('officer', cleared, 'A change.');
    const ready = await api.markReady(as('officer'), { itemId: cleared.id, targets: WEBSITE });
    await api.approve(as('treasurer'), { itemId: cleared.id, contentHash: ready.working!.contentHash });
    expect(await refusal(api.withdraw(as('officer-only'), cleared.id))).toBeInstanceOf(NotAllowed);
    const down = await api.withdraw(as('officer'), cleared.id);
    expect(down).toMatchObject({ state: 'withdrawn', working: { status: 'draft' } });
    expect(statusOf(down).label).toBe(`Taken down on ${down.withdrawnAt!.toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'long', day: 'numeric', year: 'numeric' })}`);
    expect((await api.listItemHistory(as('officer'), cleared.id)).slice(-2).map((s) => s.action)).toEqual(['withdraw', 'approval_voided']);
    const again = await api.markReady(as('officer'), { itemId: cleared.id, targets: WEBSITE });
    await api.approve(as('treasurer'), { itemId: cleared.id, contentHash: again.working!.contentHash });
    expect(await refusal(api.publish(as('webmaster'), { itemId: cleared.id, contentHash: again.working!.contentHash }))).toMatchObject({
      reason: 'this item was taken down: publishing puts it back on the website, so confirm that first',
    });
    const back = await api.publish(as('webmaster'), { itemId: cleared.id, contentHash: again.working!.contentHash, republishWithdrawn: true });
    expect(back).toMatchObject({ state: 'published', live: { markup: 'A change.' } });
  });
});

describe('the stand-in workflow: the link gate (A3b)', () => {
  const FACEBOOK = 'https://www.facebook.com/groups/nwfl-sample';
  /** A ready piece by the President with a plain link, a printed address and a Facebook link. */
  async function linked(title: string, extra = '') {
    const item = await create('officer', title);
    await save('officer', item, `See [the picnic page](https://club.example/picnic) and https://club.example/map.\n\nOur [group](${FACEBOOK}).${extra}`);
    return api.markReady(as('officer'), { itemId: item.id, targets: WEBSITE });
  }

  it('lists every link and printed address, sorted, with where it is, its words, and whether it needs a sign-in', async () => {
    const ready = await linked('Links listed');
    const list = await api.getItemLinks(as('treasurer'), ready.id);
    expect(list.linksSha256).toHaveLength(32);
    expect(list.readyAt).toBeInstanceOf(Date);
    expect(list.links).toEqual([
      { url: 'https://club.example/map', label: '', where: 'in the text', loginWalled: false, answeredByLabel: '', accepted: false },
      { url: 'https://club.example/picnic', label: 'the picnic page', where: 'in the text', loginWalled: false, answeredByLabel: '', accepted: false },
      { url: FACEBOOK, label: 'group', where: 'in the text', loginWalled: true, answeredByLabel: '', accepted: false },
    ]);
    expect(await refusal(api.getItemLinks(as('member'), ready.id))).toBeInstanceOf(ApiNotFound);
    const draft = await create('officer', 'A draft has no ready time');
    expect((await api.getItemLinks(as('officer'), draft.id)).readyAt).toBeUndefined();
  });

  it('holds Approve while a sign-in link has no yes, and while any answer is no; a yes from another reviewer clears it', async () => {
    const ready = await linked('Gate held');
    const hash = ready.working!.contentHash;
    expect(await refusal(api.approve(as('treasurer'), { itemId: ready.id, contentHash: hash }))).toMatchObject({
      reason: '1 link needs a sign-in to check (such as Facebook): someone other than the writer must open it and answer yes before this is approved',
    });
    const list = await api.getItemLinks(as('webmaster'), ready.id);
    const answered = await api.confirmLinks(as('webmaster'), {
      itemId: ready.id,
      linksSha256: list.linksSha256,
      answers: [
        { url: FACEBOOK, yes: true, note: 'Opened it in my own browser.' },
        { url: 'https://club.example/map', yes: false, note: 'It shows the wrong park.' },
        { url: 'https://elsewhere.example/', yes: true, note: '' },
      ],
    });
    expect(answered.notInPiece).toEqual(['https://elsewhere.example/']);
    expect(answered.links.map((l) => [l.url, l.answeredByLabel, l.accepted])).toEqual([
      ['https://club.example/map', 'Webmaster', false],
      ['https://club.example/picnic', '', false],
      [FACEBOOK, 'Webmaster', true],
    ]);
    expect(await refusal(api.approve(as('treasurer'), { itemId: ready.id, contentHash: hash }))).toMatchObject({
      reason: 'a reviewer answered no for the link "https://club.example/map" (it does not show the right page): the writer fixes it, or a reviewer changes the answer to yes, before this is approved',
    });
    const yes = await api.confirmLinks(as('treasurer'), { itemId: ready.id, linksSha256: list.linksSha256, answers: [{ url: 'https://club.example/map', yes: true, note: '' }] });
    expect(yes.links[0]).toMatchObject({ answeredByLabel: 'Treasurer', accepted: true });
    expect((await api.approve(as('treasurer'), { itemId: ready.id, contentHash: hash })).working?.status).toBe('cleared');
    expect((await api.listItemHistory(as('officer'), ready.id)).filter((s) => s.action === 'links_confirmed')).toHaveLength(2);
  });

  it("names the first link answered no and counts the rest, and several sign-in links", async () => {
    const ready = await linked('Two noes', `\n\nAnd [ours](https://www.instagram.com/nwfl-sample).`);
    const list = await api.getItemLinks(as('webmaster'), ready.id);
    expect(await refusal(api.approve(as('webmaster'), { itemId: ready.id, contentHash: ready.working!.contentHash }))).toMatchObject({
      reason: '2 links need a sign-in to check (such as Facebook): someone other than the writer must open them and answer yes before this is approved',
    });
    await api.confirmLinks(as('webmaster'), { itemId: ready.id, linksSha256: list.linksSha256, answers: list.links.map((l) => ({ url: l.url, yes: false, note: '' })) });
    expect(await refusal(api.approve(as('treasurer'), { itemId: ready.id, contentHash: ready.working!.contentHash }))).toMatchObject({
      reason: 'a reviewer answered no for the link "https://club.example/map" and 3 more (it does not show the right page): the writer fixes it, or a reviewer changes the answer to yes, before this is approved',
    });
  });

  it('takes answers only from a reviewer who did not edit it, on a waiting version, for the list they read', async () => {
    const ready = await linked('Answers guarded');
    const list = await api.getItemLinks(as('officer'), ready.id);
    const answer = (who: keyof typeof PEOPLE, extra: Partial<{ linksSha256: Uint8Array; actingAsOfficeId: string; answers: { url: string; yes: boolean; note: string }[] }> = {}) =>
      api.confirmLinks(as(who), { itemId: ready.id, linksSha256: list.linksSha256, answers: [{ url: FACEBOOK, yes: true, note: '' }], ...extra });
    expect(await refusal(answer('officer'))).toMatchObject({ reason: 'you edited this version; a second officer must check its links' });
    expect(await refusal(answer('member'))).toBeInstanceOf(NotAllowed);
    expect(await refusal(answer('treasurer', { actingAsOfficeId: PRESIDENT.id }))).toMatchObject({ reason: 'you do not hold that office' });
    expect(await refusal(answer('treasurer', { linksSha256: new Uint8Array(32) }))).toBeInstanceOf(LinksChanged);
    expect(await refusal(answer('treasurer', { answers: [] }))).toMatchObject({ reason: 'no answers were given' });
    expect(await refusal(answer('treasurer', { answers: [{ url: FACEBOOK, yes: true, note: 'x'.repeat(2001) }] }))).toMatchObject({ reason: 'a note is at most 2000 characters' });
    const draft = await create('officer', 'Not waiting');
    const draftList = await api.getItemLinks(as('treasurer'), draft.id);
    expect(await refusal(api.confirmLinks(as('treasurer'), { itemId: draft.id, linksSha256: draftList.linksSha256, answers: [{ url: FACEBOOK, yes: true, note: '' }] }))).toMatchObject({
      reason: 'only a version waiting for approval has its links checked',
    });
  });

  it('forgets the answers once the piece is edited and sent again: a new ready time', async () => {
    const ready = await linked('Answers voided');
    const list = await api.getItemLinks(as('treasurer'), ready.id);
    await api.confirmLinks(as('treasurer'), { itemId: ready.id, linksSha256: list.linksSha256, answers: [{ url: FACEBOOK, yes: true, note: '' }] });
    expect((await api.getItemLinks(as('treasurer'), ready.id)).links.find((l) => l.url === FACEBOOK)).toMatchObject({ accepted: true, answeredByLabel: 'Treasurer' });
    await save('officer', ready, `Our [group](${FACEBOOK}).`);
    const again = await api.markReady(as('officer'), { itemId: ready.id, targets: WEBSITE });
    expect((await api.getItemLinks(as('treasurer'), ready.id)).links).toEqual([{ url: FACEBOOK, label: 'group', where: 'in the text', loginWalled: true, answeredByLabel: '', accepted: false }]);
    expect(await refusal(api.approve(as('treasurer'), { itemId: ready.id, contentHash: again.working!.contentHash }))).toBeInstanceOf(EditorRefused);
  });
});

describe('the stand-in workflow: reading', () => {
  it('lists drafts and ready items to an officer, the Admin and the Webmaster, newest change first, by state and office', async () => {
    const draft = await create('officer', 'Listed draft');
    const ready = await readyItem('Listed ready');
    const social = await create('admin', 'Social draft', SOCIAL.id);
    const all = await api.listWorkingItems(as('lone-webmaster'));
    expect(all.map((i) => i.id)).toEqual([social.id, ready.id, draft.id]);
    expect((await api.listWorkingItems(as('officer-only'), { states: ['ready'] })).map((i) => i.id)).toEqual([ready.id]);
    expect((await api.listWorkingItems(as('admin'), { officeId: SOCIAL.id })).map((i) => i.id)).toEqual([social.id]);
    expect(await api.listWorkingItems(as('admin'), { editionId: 'e0000000-0000-4000-8000-000000000009' })).toEqual([]);
    expect(await refusal(api.listWorkingItems(as('member')))).toBeInstanceOf(NotAllowed);
    expect(await refusal(api.getWorkingItem(as('member'), draft.id))).toBeInstanceOf(NotAllowed);
    expect(await refusal(api.getWorkingItem(as('officer'), '00000000-0000-4000-8000-000000000000'))).toBeInstanceOf(ApiNotFound);
  });

  it('tells the history by role, with "(you)" for the reader\'s own steps', async () => {
    const ready = await readyItem('History told');
    await api.sendBack(as('webmaster'), { itemId: ready.id, note: 'Add the time.' });
    const steps = await api.listItemHistory(as('officer'), ready.id);
    expect(historySentences(steps, { you: PEOPLE['officer']!.sub }).map((s) => s.sentence)).toEqual([
      'Tue 17 Nov, 10:48 – Webmaster sent it back (version 1). The note: “Add the time.”',
      'Tue 17 Nov, 10:47 – President (you) sent it for approval (version 1).',
      'Tue 17 Nov, 10:45 – President (you) saved a draft (version 1).',
      'Tue 17 Nov, 10:44 – President (you) started it as a draft (version 1).',
    ]);
    expect(await refusal(api.listItemHistory(as('member'), ready.id))).toBeInstanceOf(NotAllowed);
  });

  it('previews a public item: the public gets a placeholder where members passages are, members get them', async () => {
    const item = await create('officer', 'Previewed');
    await save('officer', item, '# Lunch\n\nOpen to all :members[gate 4321].\n\n::: members\nSecret room.\n:::\n- one\n- two');
    const preview = await api.previewWorkingItem(as('webmaster'), item.id);
    expect(preview).toMatchObject({ title: 'Previewed', summary: 'A summary', problems: [] });
    const pub = JSON.stringify(preview.publicBody);
    expect(pub).not.toMatch(/4321|Secret room/);
    expect(pub).toContain('"redacted"');
    expect(JSON.stringify(preview.membersBody)).toMatch(/4321[\s\S]*Secret room/);
    expect(preview.membersBody?.blocks.map((b) => b.kind.case)).toEqual(['heading', 'paragraph', 'members', 'list']);
  });

  it('previews a members item as one placeholder for the public, and an officers item for no one', async () => {
    const members = await create('officer', 'Members preview');
    await save('officer', members, 'For members.', 'members');
    const m = await api.previewWorkingItem(as('officer'), members.id);
    expect(m.publicBody?.blocks.map((b) => b.kind.case)).toEqual(['redacted']);
    expect(JSON.stringify(m.membersBody)).toContain('For members.');
    const officers = await create('officer', 'Officers preview');
    await save('officer', officers, 'For officers.', 'officers');
    const o = await api.previewWorkingItem(as('officer'), officers.id);
    expect(o.publicBody).toBeUndefined();
    expect(o.membersBody).toBeUndefined();
  });

  it('previews the live version when there is no working one, and fails closed on an unclosed members block', async () => {
    const ready = await approved('Live preview');
    await api.publish(as('webmaster'), { itemId: ready.id, contentHash: ready.working!.contentHash });
    expect(JSON.stringify((await api.previewWorkingItem(as('officer'), ready.id)).publicBody)).toContain('Thursday');
    const open = await create('officer', 'Unclosed');
    await save('officer', open, 'Before.\n::: members\nNever closed.');
    const p = await api.previewWorkingItem(as('officer'), open.id);
    expect(p.problems).toEqual([{ line: 2, message: 'unclosed ::: members block' }]);
    expect(JSON.stringify(p.publicBody)).not.toContain('Never closed');
  });

  it('gives a withheld item no markup and no hash, so the edit form refuses it, and previews no wider than the lens', async () => {
    const seeded = model.seed({ slug: 'withheld-seed', kind: 'article', officeId: PRESIDENT.id, state: 'ready', title: 'Withheld', markup: 'Open :members[HELD BACK]', withheld: true });
    const item = await api.getWorkingItem(as('officer'), seeded.id);
    expect(item.working).toMatchObject({ markup: '', markupWithheld: true });
    expect(item.working?.contentHash).toHaveLength(0);
    expect(JSON.stringify(item.working?.body)).not.toContain('HELD BACK');
    expect(editFormFor(item)).toMatchObject({ ok: false, reason: 'withheld' });
    expect(JSON.stringify(await api.previewWorkingItem(as('officer'), seeded.id))).not.toContain('HELD BACK');
  });

  it('seeds a published item, a withdrawn one, and a sent-back draft as they read', async () => {
    const published = model.seed({ slug: 'seed-published', kind: 'announcement', officeId: SOCIAL.id, state: 'published', title: 'Seeded' });
    const down = model.seed({ slug: 'seed-down', kind: 'announcement', officeId: SOCIAL.id, state: 'withdrawn', title: 'Down' });
    const back = model.seed({ id: 'c0000000-0000-4000-8000-0000000000aa', slug: 'seed-back', kind: 'article', officeId: SOCIAL.id, state: 'draft', title: 'Back', sendBackNote: 'Shorter.' });
    expect(statusOf(await api.getWorkingItem(as('officer'), published.id)).key).toBe('published');
    expect(statusOf(await api.getWorkingItem(as('officer'), down.id)).key).toBe('taken_down');
    expect(statusOf(await api.getWorkingItem(as('officer'), back.id)).key).toBe('sent_back');
    expect(back.id).toBe('c0000000-0000-4000-8000-0000000000aa');
  });
});

// A3b fix round (008a115): the hash is bound to the ready time; Approve's refusal names only links the
// caller sees whole; a holder who reviews nothing is told PERMISSION_DENIED for a missing item too.
describe('the stand-in workflow: the link gate after A3b\'s fix round', () => {
  const FACEBOOK = 'https://www.facebook.com/groups/nwfl-sample';
  const WITHHELD = (act: string) => `part of this item is withheld from you; an officer who can see all of it must ${act}`;

  it('binds the hash to the ready time: marked ready again, the same list has a new hash, and the old one is refused', async () => {
    const item = await create('officer', 'Ready twice');
    await save('officer', item, `Our [group](${FACEBOOK}).`);
    const draftHash = (await api.getItemLinks(as('treasurer'), item.id)).linksSha256;
    const first = await api.markReady(as('officer'), { itemId: item.id, targets: WEBSITE });
    const before = await api.getItemLinks(as('treasurer'), first.id);
    expect(Buffer.from(before.linksSha256).equals(Buffer.from(draftHash))).toBe(false);
    await api.sendBack(as('treasurer'), { itemId: item.id, note: 'Once more.' });
    await api.markReady(as('officer'), { itemId: item.id, targets: WEBSITE });
    const after = await api.getItemLinks(as('treasurer'), item.id);
    expect(after.links).toEqual(before.links);
    expect(Buffer.from(after.linksSha256).equals(Buffer.from(before.linksSha256))).toBe(false);
    expect(await refusal(api.confirmLinks(as('treasurer'), { itemId: item.id, linksSha256: before.linksSha256, answers: [{ url: FACEBOOK, yes: true, note: '' }] }))).toBeInstanceOf(LinksChanged);
    expect((await api.confirmLinks(as('treasurer'), { itemId: item.id, linksSha256: after.linksSha256, answers: [{ url: FACEBOOK, yes: true, note: '' }] })).links[0]?.accepted).toBe(true);
  });

  it('lists links inside members passages for every reviewer, as A3b does: officers are members (S3)', async () => {
    const item = await create('officer', 'Members passage links');
    await save('officer', item, `Open [page](https://www.instagram.com/nwfl-sample).\n\n::: members\nPhotos on [our members' group](${FACEBOOK}).\n:::`);
    const ready = await api.markReady(as('officer'), { itemId: item.id, targets: WEBSITE });
    const both = ['https://www.instagram.com/nwfl-sample', FACEBOOK];
    // The Webmaster outside the officers group sees both, as an officer does: no lens hides a members passage.
    expect((await api.getItemLinks(as('lone-webmaster'), ready.id)).links.map((l) => l.url).sort()).toEqual(both.sort());
    expect((await api.getItemLinks(as('treasurer'), ready.id)).links.map((l) => l.url).sort()).toEqual(both.sort());
    expect(await refusal(api.approve(as('lone-webmaster'), { itemId: ready.id, contentHash: ready.working!.contentHash }))).toMatchObject({
      reason: '2 links need a sign-in to check (such as Facebook): someone other than the writer must open them and answer yes before this is approved',
    });
  });

  it('shows an officer a passage marked for officers only whole, and the lone Webmaster no hash, no marked link and no Approve', async () => {
    // Its members passage is marked for officers (the redaction lens, REDACT R2a): withheld from anyone outside the officers group.
    const marked = model.seed({ slug: 'officers-only-links', kind: 'announcement', officeId: PRESIDENT.id, state: 'ready', title: 'Marked', markup: `Open [page](https://www.instagram.com/nwfl-sample).\n\n::: members\nPhotos on [our members' group](${FACEBOOK}).\n:::`, officersOnly: true, editors: [PEOPLE['officer']!.sub] });
    const read = await api.getWorkingItem(as('lone-webmaster'), marked.id);
    // P24, as A3b's workflow.ts versionMessage: with anything withheld, no hash and no markup (bodyMarkupWithheld),
    // so the reviewer cannot approve what they do not see whole; the body holds no marked link.
    expect(read.working!.contentHash).toHaveLength(0);
    expect(read.working).toMatchObject({ markup: '', markupWithheld: true });
    expect(JSON.stringify(read)).not.toContain(FACEBOOK);
    // An officer sees it whole, with its hash; the rest of this test posts that hash, as from elsewhere.
    const whole = await api.getWorkingItem(as('treasurer'), marked.id);
    const hash = whole.working!.contentHash;
    expect(hash).toHaveLength(32);
    expect(whole.working).toMatchObject({ markupWithheld: false });
    expect(JSON.stringify(await api.previewWorkingItem(as('lone-webmaster'), marked.id))).not.toContain(FACEBOOK);
    expect(JSON.stringify(await api.previewWorkingItem(as('treasurer'), marked.id))).toContain(FACEBOOK);
    // An officer sees both: both are counted.
    expect(await refusal(api.approve(as('treasurer'), { itemId: marked.id, contentHash: hash }))).toMatchObject({
      reason: '2 links need a sign-in to check (such as Facebook): someone other than the writer must open them and answer yes before this is approved',
    });
    expect((await api.getItemLinks(as('lone-webmaster'), marked.id)).links.map((l) => l.url)).toEqual(['https://www.instagram.com/nwfl-sample']);
    // A3B-HARDEN: the lone Webmaster is refused before the gate (and before the hash), so the gate's
    // OFFICERS_ONLY never reaches them through the text; on the real API it still can through an office
    // event their audience does not see, which the stand-in does not list.
    expect(await refusal(api.approve(as('lone-webmaster'), { itemId: marked.id, contentHash: hash }))).toMatchObject({ reason: WITHHELD('approve it') });
    // A no on the hidden link is named to an officer who sees it whole.
    const all = await api.getItemLinks(as('treasurer'), marked.id);
    await api.confirmLinks(as('treasurer'), { itemId: marked.id, linksSha256: all.linksSha256, answers: [{ url: FACEBOOK, yes: false, note: '' }] });
    expect(await refusal(api.approve(as('webmaster'), { itemId: marked.id, contentHash: hash }))).toMatchObject({ reason: expect.stringContaining(`a reviewer answered no for the link "${FACEBOOK}"`) });
  });

  // A3B-HARDEN (PR #70, requireWholeView): a caller from whom anything is withheld may only send it back.
  it('refuses Approve, break-glass, Publish and ConfirmLinks to a caller with part withheld, before any hash; Send back stays', async () => {
    const markup = `See [the picnic page](https://club.example/picnic).\n\n::: members\nThe gate code is MEMBERS-CANARY.\n:::`;
    const waiting = model.seed({ slug: 'harden-waiting', kind: 'announcement', officeId: PRESIDENT.id, state: 'ready', title: 'Hardened, waiting', markup, officersOnly: true, editors: [PEOPLE['officer']!.sub] });
    const cleared = model.seed({ slug: 'harden-cleared', kind: 'announcement', officeId: PRESIDENT.id, state: 'ready', title: 'Hardened, approved', markup, officersOnly: true, cleared: true });
    const lone = as('lone-webmaster');
    // Neither may: the flags say so.
    expect((await api.getWorkingItem(lone, waiting.id)).working).toMatchObject({ callerMayApprove: false, callerMayPublish: false });
    expect((await api.getWorkingItem(lone, cleared.id)).working).toMatchObject({ callerMayApprove: false, callerMayPublish: false });
    expect((await api.getWorkingItem(as('webmaster'), cleared.id)).working).toMatchObject({ callerMayPublish: true });
    // With the officer's hash (the worst case) and with none at all: the same words, so nothing is told about a hash.
    const hash = (await api.getWorkingItem(as('treasurer'), waiting.id)).working!.contentHash;
    const clearedHash = (await api.getWorkingItem(as('webmaster'), cleared.id)).working!.contentHash;
    const list = await api.getItemLinks(as('treasurer'), waiting.id);
    for (const contentHash of [hash, new Uint8Array(0)]) {
      expect(await refusal(api.approve(lone, { itemId: waiting.id, contentHash }))).toMatchObject({ reason: WITHHELD('approve it') });
      expect(await refusal(api.approve(lone, { itemId: waiting.id, contentHash, breakGlass: { reason: 'Forged' } }))).toMatchObject({ reason: WITHHELD('approve it') });
    }
    for (const contentHash of [clearedHash, new Uint8Array(0)]) {
      expect(await refusal(api.publish(lone, { itemId: cleared.id, contentHash }))).toMatchObject({ reason: WITHHELD('publish it') });
    }
    for (const linksSha256 of [list.linksSha256, new Uint8Array(32)]) {
      const refused = await refusal(api.confirmLinks(lone, { itemId: waiting.id, linksSha256, answers: [{ url: 'https://club.example/picnic', yes: true, note: '' }] }));
      expect(refused).toBeInstanceOf(EditorRefused);
      expect(refused).toMatchObject({ reason: WITHHELD('check its links') });
    }
    // Nothing changed.
    expect((await api.getItemLinks(as('treasurer'), waiting.id)).links.map((l) => l.answeredByLabel)).toEqual(['']);
    expect((await api.getWorkingItem(as('treasurer'), waiting.id)).working?.status).toBe('ready');
    expect((await api.getWorkingItem(as('webmaster'), cleared.id)).working?.status).toBe('cleared');
    // Send back is theirs, as before.
    expect((await api.sendBack(lone, { itemId: waiting.id, note: 'Please check the gate code.' })).working?.status).toBe('draft');
  });

  it('keeps no answer for an address over 2,048 characters, as A3b\'s ConfirmLinks: it is not_in_piece (S2)', async () => {
    const long = `https://club.example/${'z'.repeat(2049 - 'https://club.example/'.length)}`;
    const edge = `https://club.example/${'q'.repeat(2048 - 'https://club.example/'.length)}`;
    const seeded = model.seed({ slug: 'too-long-to-keep', kind: 'announcement', officeId: PRESIDENT.id, state: 'ready', title: 'Too long', markup: `[long](${long}) and [edge](${edge}) and [short](https://club.example/s)`, editors: [PEOPLE['officer']!.sub] });
    const list = await api.getItemLinks(as('treasurer'), seeded.id);
    expect(list.links.map((l) => l.url.length).sort((x, y) => x - y)).toEqual([22, 2048, 2049]);
    const out = await api.confirmLinks(as('treasurer'), { itemId: seeded.id, linksSha256: list.linksSha256, answers: [long, edge, 'https://club.example/s'].map((url) => ({ url, yes: true, note: '' })) });
    expect(out.notInPiece).toEqual([long]);
    expect(out.links.filter((l) => l.accepted).map((l) => l.url.length).sort((x, y) => x - y)).toEqual([22, 2048]);
  });

  it('tells a holder who reviews nothing "not permitted" for a missing item as for another office\'s', async () => {
    expect(await refusal(api.getItemLinks(as('seat-only'), '00000000-0000-4000-8000-000000000000'))).toBeInstanceOf(NotAllowed);
    const ready = await readyItem('Another office\'s');
    expect(await refusal(api.getItemLinks(as('seat-only'), ready.id))).toBeInstanceOf(NotAllowed);
    expect(await refusal(api.getItemLinks(as('officer'), '00000000-0000-4000-8000-000000000000'))).toBeInstanceOf(ApiNotFound);
  });
});

describe('the stand-in workflow: the link list and the E4 seeds, in full', () => {
  it('finds links in headings, lists and members passages, once per place, the first words kept, a mailto never sign-in', async () => {
    const item = await create('officer', 'Every kind of link');
    const fb = 'https://facebook.com/events/1';
    await save('officer', item, `# See [the map](https://club.example/map)\n- [list link](https://club.example/a)\n- https://club.example/a again\n\n::: members\nGate: [code page](${fb}) and :members[inside https://club.example/m]\n:::\nWrite to [us](mailto:club@example.org).`);
    const ready = await api.markReady(as('officer'), { itemId: item.id, targets: WEBSITE });
    const list = await api.getItemLinks(as('treasurer'), ready.id);
    expect(list.links.map((l) => [l.url, l.label, l.loginWalled])).toEqual([
      ['https://club.example/a', 'list link', false],
      ['https://club.example/m', '', false],
      ['https://club.example/map', 'the map', false],
      [fb, 'code page', true],
      ['mailto:club@example.org', 'us', false],
    ]);
    // The office's own seat reads its own items' links; another office's are refused.
    const social = await create('admin', 'For the social chair', SOCIAL.id);
    expect((await api.getItemLinks(as('seat-only'), social.id)).links).toEqual([]);
    expect(await refusal(api.getItemLinks(as('seat-only'), ready.id))).toBeInstanceOf(NotAllowed);
    // A held-back passage stays out of the list for a lens that holds it back.
    const held = model.seed({ slug: 'held-links', kind: 'article', officeId: PRESIDENT.id, state: 'ready', title: 'Held', markup: 'Open [a](https://club.example/open) :members[held https://club.example/held]', withheld: true });
    expect((await api.getItemLinks(as('treasurer'), held.id)).links.map((l) => l.url)).toEqual(['https://club.example/open']);
    // At most 500 answers in one call.
    const many = Array.from({ length: 501 }, (_, i) => ({ url: `https://club.example/${i}`, yes: true, note: '' }));
    expect(await refusal(api.confirmLinks(as('treasurer'), { itemId: ready.id, linksSha256: list.linksSha256, answers: many }))).toMatchObject({ reason: 'at most 500 answers at a time' });
    // An answer for an address not in the piece alone is kept nowhere and audited not at all.
    const before = (await api.listItemHistory(as('officer'), ready.id)).length;
    expect((await api.confirmLinks(as('treasurer'), { itemId: ready.id, linksSha256: list.linksSha256, answers: [{ url: 'https://elsewhere.example/', yes: true, note: '' }] })).notInPiece).toEqual(['https://elsewhere.example/']);
    expect(await api.listItemHistory(as('officer'), ready.id)).toHaveLength(before);
  });

  it('names a long address cut short when a reviewer answered no', async () => {
    const item = await create('officer', 'A long address');
    const long = `https://club.example/${'a'.repeat(80)}`;
    await save('officer', item, `See [it](${long}).`);
    const ready = await api.markReady(as('officer'), { itemId: item.id, targets: WEBSITE });
    const list = await api.getItemLinks(as('treasurer'), ready.id);
    await api.confirmLinks(as('treasurer'), { itemId: ready.id, linksSha256: list.linksSha256, answers: [{ url: long, yes: false, note: '' }] });
    expect(await refusal(api.approve(as('webmaster'), { itemId: ready.id, contentHash: ready.working!.contentHash }))).toMatchObject({
      reason: expect.stringContaining(`"${long.slice(0, 60)}..."`),
    });
  });

  it('seeds a taken-down item with an approved change, who started a piece, and a self-approval', async () => {
    const down = model.seed({ slug: 'seed-down-cleared', kind: 'announcement', officeId: PRESIDENT.id, state: 'withdrawn', title: 'Down', change: 'cleared', approvedAs: 'Member at Large' });
    const read = await api.getWorkingItem(as('webmaster'), down.id);
    expect(read).toMatchObject({ state: 'withdrawn', working: { status: 'cleared', approvedAsLabel: 'Member at Large', callerMayPublish: true } });
    expect((await api.listItemHistory(as('webmaster'), down.id)).map((s) => [s.action, s.actorLabel])).toEqual([['withdraw', 'President']]);
    const typed = model.seed({ slug: 'seed-typed', kind: 'announcement', officeId: PRESIDENT.id, state: 'ready', title: 'Typed', createdBy: { sub: PEOPLE['admin']!.sub, label: 'Admin' } });
    expect((await api.listItemHistory(as('officer'), typed.id)).map((s) => [s.action, s.actorLabel, s.versionNumber])).toEqual([['create', 'Admin', 1]]);
    const self = model.seed({ slug: 'seed-self', kind: 'announcement', officeId: PRESIDENT.id, state: 'ready', title: 'Self', cleared: true, selfApproved: true, approvedBy: PEOPLE['admin']!.sub, approvedAs: 'Admin' });
    expect((await api.getWorkingItem(as('admin'), self.id)).working).toMatchObject({ approvalKindSelf: true, callerMayPublish: false });
    expect((await api.getWorkingItem(as('webmaster'), self.id)).working?.callerMayPublish).toBe(true);
    // Taking down an item with no approved change waiting voids nothing.
    const live = model.seed({ slug: 'seed-live-plain', kind: 'announcement', officeId: PRESIDENT.id, state: 'published', title: 'Live' });
    await api.withdraw(as('webmaster'), live.id);
    expect((await api.listItemHistory(as('officer'), live.id)).map((s) => s.action)).toEqual(['withdraw']);
  });
});

describe('parseMarkup (the stand-in\'s part of the API\'s markup)', () => {
  it('reads bold, links, members spans and blocks, headings and lists', () => {
    const { tree, problems } = parseMarkup('## Title\n**Bold** and [a link](mailto:x@example.org) and :members[secret]\n- a\n- [b](https://b.example)');
    expect(problems).toEqual([]);
    expect(JSON.stringify(tree)).toContain('"bold":true');
    expect(JSON.stringify(tree)).toContain('mailto:x@example.org');
    expect(tree.blocks.map((b: { kind: { case: string } }) => b.kind.case)).toEqual(['heading', 'paragraph', 'list']);
  });

  it("names what the API refuses, in the API's words", () => {
    expect(parseMarkup('a :members[open\n:::\n[x](javascript:alert(1))').problems).toEqual([
      { line: 1, message: 'unclosed :members[' },
      { line: 2, message: 'closing ::: without an opening ::: members' },
      { line: 3, message: 'the link "javascript:alert(1" is not a web address starting with https:// or an email address starting with mailto:' },
    ]);
  });

  // EDITOR E3: A3a's strict URL rule at save (apps/api/src/links/rule.ts), in its words, for the URL problems
  // the edit page lists line by line: a link's address, and a bare address in the text.
  it("names a bad address in a link or in the text, in A3a's words, on its own line", () => {
    expect(parseMarkup('Fine [a](https://a.example) and mailto in [b](mailto:b@example.org).\nSee http://club.example/picnic, then www.club.example.\n[c](https://c.example) and https://ok.example/path.').problems).toEqual([
      { line: 2, message: 'the address "http://club.example/picnic" must start with https://, not http://' },
      { line: 2, message: 'the address "www.club.example" must be written in full, starting with https://' },
    ]);
    expect(parseMarkup('- [x](HTTPS://X.example)\n# A heading with http://h.example').problems).toEqual([
      { line: 1, message: 'the link "HTTPS://X.example" must be written plainly: https:// or mailto: in lower case, and no spaces' },
      { line: 2, message: 'the address "http://h.example" must start with https://, not http://' },
    ]);
  });
});

describe('the stand-in workflow: approved, ready to publish (A1\'s VERSION_STATUS_CLEARED)', () => {
  it('seeds a cleared version, lists it with drafts and ready ones, and reads it as "Approved, ready to publish"', async () => {
    const cleared = model.seed({ slug: 'seed-cleared', kind: 'announcement', officeId: PRESIDENT.id, state: 'ready', title: 'Cleared', cleared: true });
    const read = await api.getWorkingItem(as('officer'), cleared.id);
    expect(read).toMatchObject({ state: 'ready', working: { status: 'cleared' } });
    expect(read.working?.contentHash).toHaveLength(32);
    expect(statusOf(read).label).toBe('Approved, ready to publish');
    expect((await api.listWorkingItems(as('officer'))).map((i) => i.id)).toContain(cleared.id);
    expect((await api.listWorkingItems(as('officer'), { states: ['draft'] })).map((i) => i.id)).not.toContain(cleared.id);
  });

  it('takes an edit of a cleared version back to a draft: the approval no longer counts', async () => {
    const cleared = model.seed({ slug: 'seed-cleared-edit', kind: 'announcement', officeId: PRESIDENT.id, state: 'ready', title: 'Cleared', cleared: true });
    const { item } = await api.saveDraft(as('officer'), { itemId: cleared.id, title: 'Cleared', summary: '', visibility: 'public', markup: 'Changed.' });
    expect(item).toMatchObject({ state: 'draft', working: { status: 'draft' } });
    expect(item.working?.contentHash).toHaveLength(0);
    expect((await api.listItemHistory(as('officer'), cleared.id)).map((h) => h.action)).toEqual(['approval_voided', 'save']);
  });
});

describe('the stand-in workflow: the writers\' list (E3 fix 1)', () => {
  it('lists published and taken-down items by their states, each with when it last changed', async () => {
    const published = model.seed({ slug: 'seed-fix1-published', kind: 'announcement', officeId: PRESIDENT.id, state: 'published', title: 'Live' });
    const changing = model.seed({ slug: 'seed-fix1-changing', kind: 'announcement', officeId: PRESIDENT.id, state: 'published', title: 'Live, changing', change: 'ready' });
    const down = model.seed({ slug: 'seed-fix1-down', kind: 'announcement', officeId: PRESIDENT.id, state: 'withdrawn', title: 'Down' });
    const writing = await create('officer', 'Being written');
    const listed = await api.listWorkingItems(as('officer'), { states: ['published', 'withdrawn'] });
    expect(listed.map((i) => i.id)).toEqual(expect.arrayContaining([published.id, changing.id, down.id]));
    expect(listed.map((i) => i.id)).not.toContain(writing.id);
    expect(statusOf(listed.find((i) => i.id === changing.id) as EditorItem).label).toBe('Published – a change is waiting for approval');
    expect((await api.listWorkingItems(as('officer'))).map((i) => i.id)).toEqual(expect.arrayContaining([writing.id, changing.id]));
    expect((await api.listWorkingItems(as('officer'))).map((i) => i.id)).not.toContain(published.id);
    for (const item of [...listed, writing]) expect(item.lastChangedAt).toBeInstanceOf(Date);
    const saved = await save('officer', writing, 'Changed.');
    expect(saved.item.lastChangedAt!.getTime()).toBeGreaterThan(writing.lastChangedAt!.getTime());
  });
});

describe('the stand-in workflow: A1\'s version_statuses on the list', () => {
  it('lists by the working version\'s status when given, and then reads no item state', async () => {
    const raw = model.handlers(() => PEOPLE['officer'] as never);
    const cleared = model.seed({ slug: 'seed-vs-cleared', kind: 'announcement', officeId: PRESIDENT.id, state: 'ready', title: 'Cleared', cleared: true });
    const published = model.seed({ slug: 'seed-vs-published', kind: 'announcement', officeId: PRESIDENT.id, state: 'published', title: 'Live' });
    const writing = await create('officer', 'Being written');
    const list = async (versionStatuses: VersionStatus[], states: ItemState[] = []) =>
      ((await raw.listWorkingItems({ versionStatuses, states, officeId: '', editionId: '' }, {} as never)) as { items: { id: string }[] }).items.map((i) => i.id);
    expect(await list([VersionStatus.CLEARED])).toEqual([cleared.id]);
    const drafts = await list([VersionStatus.DRAFT], [ItemState.PUBLISHED]);
    expect(drafts).toContain(writing.id);
    expect(drafts).not.toContain(published.id);
    expect(drafts).not.toContain(cleared.id);
  });
});

describe('the stand-in workflow: auto-save with guards (E3 round 2)', () => {
  const put = (who: keyof typeof PEOPLE, item: EditorItem, markup: string, extra: { base?: string; auto?: boolean } = {}) =>
    api.saveDraft(as(who), { itemId: item.id, title: item.working?.title ?? item.live?.title ?? 'T', summary: '', visibility: 'public', markup, ...extra });
  const actions = async (item: EditorItem) => (await api.listItemHistory(as('officer'), item.id)).map((s) => s.action);

  it('gives each version a base, refuses a save from a changed one and writes nothing, and saves from the current one', async () => {
    const item = await create('officer', 'Based');
    const opened = (await api.getWorkingItem(as('officer'), item.id)).working?.base;
    expect(opened).toMatch(/^\d+\.\d{9}$/);
    const theirs = await put('admin', item, 'The Admin was here.', { base: opened! });
    expect(theirs.item.working?.base).not.toBe(opened);
    const before = await actions(item);
    for (const auto of [false, true]) expect(await refusal(put('officer', item, 'Mine.', { base: opened!, auto }))).toBeInstanceOf(DraftChanged);
    expect((await api.getWorkingItem(as('officer'), item.id)).working?.markup).toBe('The Admin was here.');
    expect(await actions(item)).toEqual(before);
    expect((await put('officer', item, 'Mine, on theirs.', { base: theirs.item.working!.base! })).item.working?.markup).toBe('Mine, on theirs.');
    const seeded = model.seed({ slug: 'seed-based-live', kind: 'announcement', officeId: PRESIDENT.id, state: 'published', title: 'Live' });
    const live = await api.getWorkingItem(as('officer'), seeded.id);
    const liveBase = live.live?.base;
    await put('admin', live, 'A change by the Admin.');
    expect(await refusal(put('officer', live, 'Mine.', { base: liveBase! }))).toBeInstanceOf(DraftChanged);
  });

  it('finds no conflict in a save from a stale base that carries what is saved: nothing written, the current base back', async () => {
    const item = await create('officer', 'Landed first');
    const opened = (await api.getWorkingItem(as('officer'), item.id)).working?.base;
    const landed = await put('officer', item, 'Typed, then reloaded.', { base: opened!, auto: true });
    const before = await actions(item);
    const again = await put('officer', item, 'Typed, then reloaded.', { base: opened! });
    expect(again.item.working?.base).toBe(landed.item.working?.base);
    expect(await actions(item)).toEqual(before);
    expect(await refusal(put('officer', item, 'Typed, then reloaded, and more.', { base: opened! }))).toBeInstanceOf(DraftChanged);
  });

  it('saves a draft automatically, one history step for consecutive ones; refuses any other, writing nothing', async () => {
    const item = await create('officer', 'Auto');
    for (const n of [1, 2, 3]) await put('officer', item, `Draft ${n}.`, { auto: true });
    await put('officer', item, 'By hand.');
    await put('officer', item, 'Again.', { auto: true });
    expect(await actions(item)).toEqual(['create', 'autosave', 'save', 'autosave']);
    expect(historySentences(await api.listItemHistory(as('officer'), item.id), { you: PEOPLE['officer']!.sub })[0]?.sentence).toContain('President (you) saved a draft automatically (version 1).');
    const ready = model.seed({ slug: 'seed-auto-ready', kind: 'announcement', officeId: PRESIDENT.id, state: 'ready', title: 'Ready' });
    const cleared = model.seed({ slug: 'seed-auto-cleared', kind: 'announcement', officeId: PRESIDENT.id, state: 'ready', title: 'Cleared', cleared: true });
    const live = model.seed({ slug: 'seed-auto-live', kind: 'announcement', officeId: PRESIDENT.id, state: 'published', title: 'Live' });
    for (const seeded of [ready, cleared, live]) {
      const read = await api.getWorkingItem(as('officer'), seeded.id);
      expect(await refusal(put('officer', read, 'Saved by itself?', { auto: true }))).toMatchObject({ reason: 'an automatic save only saves a draft' });
      const after = await api.getWorkingItem(as('officer'), seeded.id);
      expect(after.working?.status).toBe(read.working?.status);
      expect(after.working?.id).toBe(read.working?.id);
    }
  });
});
