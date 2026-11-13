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
import { ContentService } from '../src/gen/nwfl/mensa/v1/content_pb.js';
import { ApiNotFound } from '../src/lib/api/client';
import { EditorRefused, type EditorApi, type EditorItem, NotAllowed, SlugTaken, VersionChanged, grpcEditor } from '../src/lib/api/editor';
import { editFormFor } from '../src/lib/editor/form';
import { historySentences } from '../src/lib/editor/history';
import { createWithSlug } from '../src/lib/editor/slug';
import { statusOf } from '../src/lib/editor/status';

const OFFICES = [
  { id: '11111111-1111-4111-8111-111111111111', slug: 'president', title: 'President' },
  { id: '22222222-2222-4222-8222-222222222222', slug: 'social', title: 'Social Chair' },
];
const [PRESIDENT, SOCIAL] = OFFICES as [(typeof OFFICES)[0], (typeof OFFICES)[0]];

/** The test provider's people (e2e/idp.mjs), by the bearer each sends here. */
const PEOPLE: Record<string, { sub: string; groups: string[] }> = {
  officer: { sub: '00000000-0000-4000-8000-0000000000a1', groups: ['nwfl-members', 'nwfl-officers', 'nwfl-office-president'] },
  admin: { sub: '00000000-0000-4000-8000-0000000000ad', groups: ['nwfl-members', 'nwfl-officers', 'nwfl-office-publications', 'nwfl-admin'] },
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

describe('the stand-in workflow: approving', () => {
  it('sends back with a note only, which the writer reads, and clears it once ready again', async () => {
    const ready = await readyItem('Sent back once');
    expect(await refusal(api.sendBack(as('webmaster'), { itemId: ready.id, note: '  ' }))).toMatchObject({ reason: 'a note for the author is required' });
    expect(await refusal(api.sendBack(as('webmaster'), { itemId: ready.id, note: 'x'.repeat(2001) }))).toBeInstanceOf(EditorRefused);
    expect(await refusal(api.sendBack(as('officer'), { itemId: ready.id, note: 'mine' }))).toBeInstanceOf(NotAllowed);
    const back = await api.sendBack(as('webmaster'), { itemId: ready.id, note: 'Please add the time.' });
    expect(back).toMatchObject({ state: 'draft', working: { status: 'draft', sendBackNote: 'Please add the time.' } });
    expect(statusOf(back).label).toBe('Sent back – please read the note');
    expect(await refusal(api.sendBack(as('webmaster'), { itemId: ready.id, note: 'again' }))).toMatchObject({ reason: 'only a ready version can be sent back' });
    const again = await api.markReady(as('officer'), { itemId: ready.id, targets: WEBSITE });
    expect(again.working?.sendBackNote).toBe('');
  });

  it('approves by the hash seen, and refuses one that changed', async () => {
    const ready = await readyItem('Approved by the webmaster');
    expect(await refusal(api.approve(as('webmaster'), { itemId: ready.id, contentHash: new Uint8Array(32) }))).toBeInstanceOf(VersionChanged);
    expect(await refusal(api.approve(as('officer'), { itemId: ready.id, contentHash: ready.working!.contentHash }))).toBeInstanceOf(NotAllowed);
    const published = await api.approve(as('webmaster'), { itemId: ready.id, contentHash: ready.working!.contentHash });
    expect(published).toMatchObject({ state: 'published', live: { status: 'approved', number: 1 } });
    expect(published.working).toBeUndefined();
    expect(published.live?.approvedAt).toBeInstanceOf(Date);
    expect(statusOf(published).label).toBe('Published');
    expect(await refusal(api.approve(as('webmaster'), { itemId: ready.id, contentHash: ready.working!.contentHash }))).toMatchObject({ reason: 'only a ready version can be approved' });
  });

  it('marks what the approver edited, and refuses their own approval but by break-glass (the Admin) or one approver set', async () => {
    const ready = await readyItem('The Admin wrote this', 'admin');
    expect(ready.working?.callerEdited).toBe(true);
    expect((await api.getWorkingItem(as('webmaster'), ready.id)).working?.callerEdited).toBe(false);
    const hash = ready.working!.contentHash;
    expect(await refusal(api.approve(as('admin'), { itemId: ready.id, contentHash: hash }))).toBeInstanceOf(NotAllowed);
    expect(await refusal(api.approve(as('admin'), { itemId: ready.id, contentHash: hash, breakGlass: { reason: ' ' } }))).toMatchObject({ reason: 'a break-glass approval needs a written reason' });
    const published = await api.approve(as('admin'), { itemId: ready.id, contentHash: hash, breakGlass: { reason: 'The Webmaster is away' } });
    expect(published.state).toBe('published');
    const steps = await api.listItemHistory(as('admin'), ready.id);
    expect(steps.at(-1)).toMatchObject({ action: 'approve_self', note: 'The Webmaster is away', actorLabel: 'Admin' });

    rule = 'one_approver';
    const solo = await readyItem('One approver set', 'admin');
    expect((await api.approve(as('admin'), { itemId: solo.id, contentHash: solo.working!.contentHash })).state).toBe('published');
    expect((await api.listItemHistory(as('officer'), solo.id)).at(-1)?.action).toBe('approve_single');
  });

  it("refuses break-glass to anyone but the Admin, for their own edit", async () => {
    // The Webmaster edits as no office, so the Admin writes it and the Webmaster cannot have edited it:
    // seed one with the Webmaster among its editors instead.
    const seeded = model.seed({ slug: 'webmaster-edited', kind: 'announcement', officeId: PRESIDENT.id, state: 'ready', title: 'Webmaster edited', editors: [PEOPLE['webmaster']!.sub] });
    const item = await api.getWorkingItem(as('webmaster'), seeded.id);
    expect(item.working?.callerEdited).toBe(true);
    expect(await refusal(api.approve(as('webmaster'), { itemId: item.id, contentHash: item.working!.contentHash, breakGlass: { reason: 'Away' } }))).toBeInstanceOf(NotAllowed);
    expect(await refusal(api.approve(as('webmaster'), { itemId: item.id, contentHash: item.working!.contentHash }))).toBeInstanceOf(NotAllowed);
  });

  it('logs a change of targets or edition at approval, and keeps an officers item off the newsletter', async () => {
    const ready = await readyItem('Targets change');
    const published = await api.approve(as('webmaster'), { itemId: ready.id, contentHash: ready.working!.contentHash, targets: { website: true, newsletter: true, email: false }, editionId: 'e0000000-0000-4000-8000-000000000001' });
    expect(published.live).toMatchObject({ targets: { website: true, newsletter: true, email: false }, editionId: 'e0000000-0000-4000-8000-000000000001' });
    expect((await api.listItemHistory(as('officer'), ready.id)).map((s) => s.action)).toEqual(['create', 'save', 'ready', 'targets_changed', 'edition_changed', 'approve']);
    const officers = await create('officer', 'Officers only item');
    await save('officer', officers, 'x', 'officers');
    const offReady = await api.markReady(as('officer'), { itemId: officers.id, targets: WEBSITE });
    expect(await refusal(api.approve(as('webmaster'), { itemId: offReady.id, contentHash: offReady.working!.contentHash, targets: { website: true, newsletter: true, email: false } }))).toBeInstanceOf(EditorRefused);
  });

  it('edits a published item as a new version, shown as a change waiting, and supersedes the old one on approval', async () => {
    const ready = await readyItem('Published then changed');
    await api.approve(as('webmaster'), { itemId: ready.id, contentHash: ready.working!.contentHash });
    const changed = await save('officer', ready, 'Version two.');
    expect(changed.item).toMatchObject({ state: 'published', live: { number: 1 }, working: { number: 2, status: 'draft', markup: 'Version two.' } });
    expect(statusOf(changed.item).label).toBe('Published');
    const waiting = await api.markReady(as('officer'), { itemId: ready.id, targets: WEBSITE });
    expect(statusOf(waiting).label).toBe('Published – a change is waiting for approval');
    const back = await api.sendBack(as('webmaster'), { itemId: ready.id, note: 'Not yet.' });
    expect(statusOf(back).label).toBe('Sent back – please read the note');
    const again = await api.markReady(as('officer'), { itemId: ready.id, targets: WEBSITE });
    const two = await api.approve(as('webmaster'), { itemId: ready.id, contentHash: again.working!.contentHash });
    expect(two).toMatchObject({ state: 'published', live: { number: 2, markup: 'Version two.' } });
  });

  it('takes a published item down, by its office, the Webmaster or the Admin only', async () => {
    const ready = await readyItem('Taken down');
    expect(await refusal(api.withdraw(as('officer'), ready.id))).toMatchObject({ reason: 'only a published item can be withdrawn' });
    await api.approve(as('webmaster'), { itemId: ready.id, contentHash: ready.working!.contentHash });
    expect(await refusal(api.withdraw(as('officer-only'), ready.id))).toBeInstanceOf(NotAllowed);
    const down = await api.withdraw(as('officer'), ready.id);
    expect(down).toMatchObject({ state: 'withdrawn' });
    expect(statusOf(down).label).toBe('Taken down on November 17, 2026');
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
    const ready = await readyItem('Live preview');
    await api.approve(as('webmaster'), { itemId: ready.id, contentHash: ready.working!.contentHash });
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

describe('the stand-in workflow: approved, ready to publish (A1, until its proto lands)', () => {
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
