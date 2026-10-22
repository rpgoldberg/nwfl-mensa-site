// A4b + PW4: the publishing workflow end to end over gRPC (R11, R25, P15, P18,
// D-P1). Items belong to offices; versions move draft -> ready -> approved;
// approval is bound to the content hash and refused to anyone who edited the
// version, except the Admin's logged break-glass; every step is audited.
import { type Client, Code } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ContentKind,
  ContentService,
  ItemState,
  ItemVisibility,
  type ContentItem,
  VersionStatus,
} from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { type Api, as, dump, insertId, startApi } from '../helpers/api.js';
import { live } from '../helpers/pg.js';

const PUB = as('pub-token');
const ADMIN = as('admin-token');
const WEBMASTER = as('webmaster-token');
const TREASURER = as('treasurer-token');
const MEMBER = as('member-token');
const IMAGE = '7a0d3d4e-1f1b-4c55-9a51-0b8f1c6a2e01';

describe.skipIf(!live)('the publishing workflow', () => {
  let api: Api;
  let content: Client<typeof ContentService>;
  const offices: Record<string, string> = {};
  let editionId: string;
  let n = 0;

  beforeAll(async () => {
    api = await startApi('nwfl_workflow');
    content = api.client(ContentService);
    for (const slug of ['publications', 'treasurer', 'webmaster', 'editor']) {
      offices[slug] = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ($1, $1, 'appointed') RETURNING id`, [slug]);
    }
    editionId = await insertId(
      api.pool,
      `INSERT INTO edition (slug, title, kind, period_start, period_end, status) VALUES ('2026-12', 'December 2026 and January 2027', 'regular', '2026-12-01', '2027-01-31', 'collecting') RETURNING id`,
    );
  });

  afterAll(async () => {
    await api?.close();
  });

  const slug = (): string => `item-${(n += 1)}`;
  const create = async (options = PUB, office = 'publications', extra: Record<string, unknown> = {}): Promise<ContentItem> =>
    (await content.createItem({ kind: ContentKind.ARTICLE, officeId: offices[office] as string, slug: slug(), title: 'Fall picnic', ...extra }, options)).item as ContentItem;
  const save = (itemId: string, bodyMarkup: string, options = PUB, extra: Record<string, unknown> = {}) =>
    content.saveDraft({ itemId, title: 'Fall picnic', summary: 'Saturday at noon', visibility: ItemVisibility.PUBLIC, bodyMarkup, ...extra }, options);
  const ready = async (itemId: string, options = PUB, extra: Record<string, unknown> = {}): Promise<Uint8Array> =>
    ((await content.markReady({ itemId, ...extra }, options)).item?.working?.contentHash ?? new Uint8Array());
  const history = async (itemId: string): Promise<string[]> => (await content.listItemHistory({ itemId }, PUB)).entries.map((e) => e.action);
  /** A published item, written by the Publications Officer and approved by the Webmaster. */
  const published = async (markup = 'Open text :members[the gate code 4417].'): Promise<ContentItem> => {
    const item = await create();
    await save(item.id, markup);
    const hash = await ready(item.id);
    return (await content.approve({ itemId: item.id, contentHash: hash }, WEBMASTER)).item as ContentItem;
  };

  describe('the path to published', () => {
    it('creates, saves, marks ready and approves; the public then sees the filtered tree', async () => {
      const item = await create();
      expect(item).toMatchObject({ state: ItemState.DRAFT, officeId: offices['publications'] });
      expect(item.working).toMatchObject({ number: 1, status: VersionStatus.DRAFT, title: 'Fall picnic' });

      const saved = await save(item.id, '# Picnic\n\nAt the park :members[pavilion 3, gate 4417].');
      expect(saved.problems).toEqual([]);
      expect(saved.item?.working?.bodyMarkup).toContain(':members[pavilion 3');

      const hash = await ready(item.id);
      expect(hash).toHaveLength(32);
      const readied = await content.getWorkingItem({ itemId: item.id }, PUB);
      expect(readied.item).toMatchObject({ state: ItemState.READY });
      expect(readied.item?.working).toMatchObject({ status: VersionStatus.READY, targets: { website: true, newsletter: true, email: false } });

      const approved = (await content.approve({ itemId: item.id, contentHash: hash }, WEBMASTER)).item;
      expect(approved).toMatchObject({ state: ItemState.PUBLISHED });
      expect(approved?.working).toBeUndefined();
      expect(approved?.live).toMatchObject({ status: VersionStatus.APPROVED, number: 1 });

      const publicView = dump((await content.getPublishedItem({ slug: item.slug })).item);
      expect(publicView).toContain('At the park');
      expect(publicView).not.toContain('4417');
      expect(dump((await content.getPublishedItem({ slug: item.slug }, MEMBER)).item)).toContain('4417');
      expect(await history(item.id)).toEqual(['create', 'save', 'ready', 'approve']);
    });

    it('builds both search indexes at approval, the public one without members text', async () => {
      const item = await published('Picnic news :members[secretword].');
      const { rows } = await api.pool.query<{ in_public: boolean; in_members: boolean; has_public_ast: boolean }>(
        `SELECT search_public @@ plainto_tsquery('english', 'secretword') AS in_public,
                search_members @@ plainto_tsquery('english', 'secretword') AS in_members,
                public_ast IS NOT NULL AS has_public_ast
         FROM content_version WHERE id = $1`,
        [item.live?.id],
      );
      expect(rows[0]).toEqual({ in_public: false, in_members: true, has_public_ast: true });
    });

    it('takes a revision through the same steps while the published version stays live, then supersedes it', async () => {
      const item = await published('First version.');
      const revision = await save(item.id, 'Second version.');
      expect(revision.item).toMatchObject({ state: ItemState.PUBLISHED });
      expect(revision.item?.working).toMatchObject({ number: 2, status: VersionStatus.DRAFT });
      expect(dump((await content.getPublishedItem({ slug: item.slug })).item)).toContain('First version.');
      const hash = await ready(item.id);
      const approved = (await content.approve({ itemId: item.id, contentHash: hash }, WEBMASTER)).item;
      expect(approved?.live).toMatchObject({ number: 2 });
      expect(dump((await content.getPublishedItem({ slug: item.slug })).item)).toContain('Second version.');
      const { rows } = await api.pool.query<{ n: number; status: string }>(`SELECT n, status FROM content_version WHERE item_id = $1 ORDER BY n`, [item.id]);
      expect(rows).toEqual([
        { n: 1, status: 'superseded' },
        { n: 2, status: 'approved' },
      ]);
    });

    it('marks a file referenced only inside a members passage as a members file at approval', async () => {
      const item = await create();
      await save(item.id, `Open.\n\n::: members\n![Gate map](file:${IMAGE})\n:::`);
      const version = (await content.getWorkingItem({ itemId: item.id }, PUB)).item?.working?.id as string;
      await api.pool.query(
        `INSERT INTO stored_file (id, version_id, object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ($1, $2, 'k/gate', 'gate.png', 'image/png', 10, $3, 'public')`,
        [IMAGE, version, Buffer.alloc(32, 4)],
      );
      const hash = await ready(item.id);
      await content.approve({ itemId: item.id, contentHash: hash }, WEBMASTER);
      const { rows } = await api.pool.query<{ audience: string }>(`SELECT audience FROM stored_file WHERE id = $1`, [IMAGE]);
      expect(rows[0]?.audience).toBe('members');
    });
  });

  describe('approval is bound to the hash, and to four eyes', () => {
    it('refuses a hash that is not the ready version’s, and one from before an edit', async () => {
      const item = await create();
      await save(item.id, 'Before.');
      const seen = await ready(item.id);
      await expect(content.approve({ itemId: item.id, contentHash: new Uint8Array(32) }, WEBMASTER)).rejects.toMatchObject({ code: Code.Aborted });
      // The author edits after the approver opened the page: back to draft, then ready again.
      await save(item.id, 'After.');
      await ready(item.id);
      await expect(content.approve({ itemId: item.id, contentHash: seen }, WEBMASTER)).rejects.toMatchObject({ code: Code.Aborted });
    });

    it('refuses an approver who edited the version (D-P1)', async () => {
      const item = await create(ADMIN);
      await save(item.id, 'Written by the Admin as Publications Officer.', ADMIN);
      const hash = await ready(item.id, ADMIN);
      await expect(content.approve({ itemId: item.id, contentHash: hash }, ADMIN)).rejects.toMatchObject({ code: Code.PermissionDenied });
      // The other approver signs it off.
      expect((await content.approve({ itemId: item.id, contentHash: hash }, WEBMASTER)).item?.state).toBe(ItemState.PUBLISHED);
    });

    it('lets only the Admin break glass, with a written reason, logged as approve_self', async () => {
      const own = await create(WEBMASTER, 'webmaster');
      await save(own.id, 'The Webmaster’s own page.', WEBMASTER);
      const ownHash = await ready(own.id, WEBMASTER);
      await expect(
        content.approve({ itemId: own.id, contentHash: ownHash, breakGlass: true, breakGlassReason: 'in a hurry' }, WEBMASTER),
      ).rejects.toMatchObject({ code: Code.PermissionDenied });

      const item = await create(ADMIN);
      await save(item.id, 'Urgent notice.', ADMIN);
      const hash = await ready(item.id, ADMIN);
      await expect(content.approve({ itemId: item.id, contentHash: hash, breakGlass: true, breakGlassReason: '  ' }, ADMIN)).rejects.toMatchObject({
        code: Code.InvalidArgument,
      });
      const approved = await content.approve({ itemId: item.id, contentHash: hash, breakGlass: true, breakGlassReason: 'Webmaster away until Monday' }, ADMIN);
      expect(approved.item?.state).toBe(ItemState.PUBLISHED);
      const entries = (await content.listItemHistory({ itemId: item.id }, WEBMASTER)).entries;
      expect(entries.at(-1)).toMatchObject({ action: 'approve_self', actorSubject: 'sub-admin', note: 'Webmaster away until Monday' });
      const { rows } = await api.pool.query<{ approval_kind: string; approval_reason: string }>(`SELECT approval_kind, approval_reason FROM content_version WHERE id = $1`, [
        approved.item?.live?.id,
      ]);
      expect(rows[0]).toEqual({ approval_kind: 'self_breakglass', approval_reason: 'Webmaster away until Monday' });
    });

    it('lets the approver change targets and edition before approving, and logs both', async () => {
      const item = await create();
      await save(item.id, 'Targets.');
      const hash = await ready(item.id);
      const approved = await content.approve({ itemId: item.id, contentHash: hash, targets: { website: true, newsletter: true, email: true }, editionId }, WEBMASTER);
      expect(approved.item?.live).toMatchObject({ targets: { website: true, newsletter: true, email: true }, editionId });
      expect(await history(item.id)).toEqual(['create', 'save', 'ready', 'targets_changed', 'edition_changed', 'approve']);
    });

    it('logs only what the approver changed: the edition alone, or the targets alone', async () => {
      const editionOnly = await create();
      await save(editionOnly.id, 'Edition only.');
      const first = await ready(editionOnly.id);
      await content.approve({ itemId: editionOnly.id, contentHash: first, editionId }, WEBMASTER);
      expect(await history(editionOnly.id)).toEqual(['create', 'save', 'ready', 'edition_changed', 'approve']);
      const targetsOnly = await create();
      await save(targetsOnly.id, 'Targets only.');
      const second = await ready(targetsOnly.id);
      await content.approve({ itemId: targetsOnly.id, contentHash: second, targets: { website: true, newsletter: false, email: false } }, WEBMASTER);
      expect(await history(targetsOnly.id)).toEqual(['create', 'save', 'ready', 'targets_changed', 'approve']);
    });

    it('approves only a ready version, and only for an approver', async () => {
      const item = await create();
      await expect(content.approve({ itemId: item.id, contentHash: new Uint8Array(32) }, WEBMASTER)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      await save(item.id, 'Text.');
      const hash = await ready(item.id);
      await expect(content.approve({ itemId: item.id, contentHash: hash }, TREASURER)).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(content.approve({ itemId: item.id, contentHash: hash })).rejects.toMatchObject({ code: Code.Unauthenticated });
    });
  });

  describe('the own-office rule and "Posting as"', () => {
    it('lets an officer post only as an office they hold; the Admin may post for any, logged as such', async () => {
      await expect(create(TREASURER, 'publications')).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(create(MEMBER, 'publications')).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(create({ headers: {} }, 'publications')).rejects.toMatchObject({ code: Code.Unauthenticated });
      const forTreasurer = await create(ADMIN, 'treasurer');
      expect(forTreasurer.officeId).toBe(offices['treasurer']);
      const { rows } = await api.pool.query<{ payload: unknown; acting_office_id: string }>(
        `SELECT payload, acting_office_id FROM audit_event WHERE item_id = $1 AND action = 'create'`,
        [forTreasurer.id],
      );
      expect(rows[0]).toEqual({ payload: { for_office: true }, acting_office_id: offices['treasurer'] });
    });

    it('keeps another office out of an item’s drafts and steps', async () => {
      const item = await create();
      await expect(save(item.id, 'Not mine.', TREASURER)).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(content.markReady({ itemId: item.id }, TREASURER)).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(content.restore({ itemId: item.id }, TREASURER)).rejects.toMatchObject({ code: Code.PermissionDenied });
    });

    it('refuses an unknown office, kind, item or id, and a taken slug', async () => {
      await expect(content.createItem({ kind: ContentKind.ARTICLE, officeId: '6a1f0c8e-0000-4000-8000-000000000000', slug: slug(), title: 'T' }, PUB)).rejects.toMatchObject({
        code: Code.InvalidArgument,
      });
      await expect(content.createItem({ kind: ContentKind.UNSPECIFIED, officeId: offices['publications'] as string, slug: slug(), title: 'T' }, PUB)).rejects.toMatchObject({
        code: Code.InvalidArgument,
      });
      await expect(content.createItem({ kind: ContentKind.ARTICLE, officeId: offices['publications'] as string, slug: 'Bad Slug', title: 'T' }, PUB)).rejects.toMatchObject({
        code: Code.InvalidArgument,
      });
      await expect(content.createItem({ kind: ContentKind.ARTICLE, officeId: offices['publications'] as string, slug: slug(), title: '  ' }, PUB)).rejects.toMatchObject({
        code: Code.InvalidArgument,
      });
      const item = await create();
      await expect(content.createItem({ kind: ContentKind.ARTICLE, officeId: offices['publications'] as string, slug: item.slug, title: 'T' }, PUB)).rejects.toMatchObject({
        code: Code.AlreadyExists,
      });
      await expect(save('6a1f0c8e-0000-4000-8000-000000000000', 'x')).rejects.toMatchObject({ code: Code.NotFound });
      await expect(save('not-an-id', 'x')).rejects.toMatchObject({ code: Code.InvalidArgument });
    });
  });

  describe('mark ready', () => {
    it('refuses markup with problems, and says so on save', async () => {
      const item = await create();
      const saved = await save(item.id, 'Meet at :members[gate 4417');
      expect(saved.problems.map((p) => p.message)).toEqual(['unclosed :members[']);
      await expect(content.markReady({ itemId: item.id }, PUB)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    });

    it('keeps an officers-only item out of the newsletter and email', async () => {
      const item = await create();
      await save(item.id, 'Bank signatories.', PUB, { visibility: ItemVisibility.OFFICERS });
      await expect(content.markReady({ itemId: item.id, targets: { website: true, newsletter: true, email: false } }, PUB)).rejects.toMatchObject({
        code: Code.InvalidArgument,
        rawMessage: 'an officers-only item cannot go to the newsletter or email',
      });
      await ready(item.id);
      expect((await content.getWorkingItem({ itemId: item.id }, PUB)).item?.working?.targets).toMatchObject({ website: true, newsletter: false, email: false });
    });

    it('refuses an unknown or frozen edition, and a version that is not a draft', async () => {
      const frozen = await insertId(
        api.pool,
        `INSERT INTO edition (slug, title, kind, period_start, period_end, status, frozen_at) VALUES ('2026-10', 'October 2026', 'regular', '2026-10-01', '2026-11-30', 'proof', now()) RETURNING id`,
      );
      const item = await create();
      await save(item.id, 'Text.');
      await expect(content.markReady({ itemId: item.id, editionId: frozen }, PUB)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      await expect(content.markReady({ itemId: item.id, editionId: '6a1f0c8e-0000-4000-8000-000000000000' }, PUB)).rejects.toMatchObject({
        code: Code.FailedPrecondition,
      });
      await ready(item.id, PUB, { editionId });
      await expect(content.markReady({ itemId: item.id }, PUB)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    });

    it('freezes a print-as-is version against edits once ready; send back reopens it', async () => {
      const item = await create();
      await save(item.id, 'RVC column, printed as received.');
      await ready(item.id, PUB, { printAsIs: true });
      await expect(save(item.id, 'Tidied.')).rejects.toMatchObject({ code: Code.FailedPrecondition });
      await content.sendBack({ itemId: item.id, note: 'Please check the date in paragraph two.' }, WEBMASTER);
      expect((await save(item.id, 'Corrected date.')).item?.working?.status).toBe(VersionStatus.DRAFT);
    });

    it('moves a ready version back to draft when its author edits it again', async () => {
      const item = await create();
      await save(item.id, 'One.');
      await ready(item.id);
      const edited = await save(item.id, 'Two.');
      expect(edited.item).toMatchObject({ state: ItemState.DRAFT });
      expect(edited.item?.working?.status).toBe(VersionStatus.DRAFT);
    });
  });

  describe('send back, withdraw and restore', () => {
    it('sends a ready version back with a required note the author can read', async () => {
      const item = await create();
      await save(item.id, 'Text.');
      await expect(content.sendBack({ itemId: item.id, note: 'Fix it.' }, WEBMASTER)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      await ready(item.id);
      await expect(content.sendBack({ itemId: item.id, note: '   ' }, WEBMASTER)).rejects.toMatchObject({ code: Code.InvalidArgument });
      await expect(content.sendBack({ itemId: item.id, note: 'Fix it.' }, PUB)).rejects.toMatchObject({ code: Code.PermissionDenied });
      const sent = await content.sendBack({ itemId: item.id, note: 'The time is wrong.' }, WEBMASTER);
      expect(sent.item).toMatchObject({ state: ItemState.DRAFT });
      const entries = (await content.listItemHistory({ itemId: item.id }, PUB)).entries;
      expect(entries.at(-1)).toMatchObject({ action: 'send_back', note: 'The time is wrong.', fromState: 'ready', toState: 'draft', actorSubject: 'sub-webmaster' });
    });

    it('sends back a revision of a published item, which stays published with its live version', async () => {
      const item = await published('Live text.');
      await save(item.id, 'Revision text.');
      await ready(item.id);
      const sent = await content.sendBack({ itemId: item.id, note: 'Not yet.' }, WEBMASTER);
      expect(sent.item).toMatchObject({ state: ItemState.PUBLISHED, live: { number: 1 }, working: { number: 2, status: VersionStatus.DRAFT } });
      expect(dump((await content.getPublishedItem({ slug: item.slug })).item)).toContain('Live text.');
    });

    it('withdraws a published item at once (410 with the date), by its office or an approver only', async () => {
      const item = await published();
      await expect(content.withdraw({ itemId: item.id }, TREASURER)).rejects.toMatchObject({ code: Code.PermissionDenied });
      const withdrawn = await content.withdraw({ itemId: item.id }, PUB);
      expect(withdrawn.item?.state).toBe(ItemState.WITHDRAWN);
      const publicView = (await content.getPublishedItem({ slug: item.slug })).item;
      expect(publicView?.state).toBe(ItemState.WITHDRAWN);
      expect(publicView?.withdrawnAt).toBeDefined();
      await expect(content.withdraw({ itemId: item.id }, WEBMASTER)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      const draft = await create();
      await expect(content.withdraw({ itemId: draft.id }, PUB)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    });

    it('restores a withdrawn item as a new draft that stays withdrawn until approved', async () => {
      const item = await published('Original.');
      await expect(content.restore({ itemId: item.id }, PUB)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      await content.withdraw({ itemId: item.id }, PUB);
      const restored = await content.restore({ itemId: item.id }, PUB);
      expect(restored.item).toMatchObject({ state: ItemState.WITHDRAWN });
      expect(restored.item?.working).toMatchObject({ number: 2, status: VersionStatus.DRAFT, bodyMarkup: 'Original.' });
      await expect(content.restore({ itemId: item.id }, PUB)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      expect((await content.getPublishedItem({ slug: item.slug })).item?.state).toBe(ItemState.WITHDRAWN);
      const hash = await ready(item.id);
      const approved = await content.approve({ itemId: item.id, contentHash: hash }, WEBMASTER);
      expect(approved.item).toMatchObject({ state: ItemState.PUBLISHED, live: { number: 2 } });
      expect(approved.item?.withdrawnAt).toBeUndefined();
      expect(await history(item.id)).toEqual(['create', 'save', 'ready', 'approve', 'withdraw', 'restore', 'ready', 'approve']);
    });
  });

  describe('officer reads', () => {
    it('lists the working items by status, office and edition, for officers only', async () => {
      const item = await create();
      await save(item.id, 'Queued.');
      await ready(item.id, PUB, { editionId });
      const queue = await content.listWorkingItems({ states: [ItemState.READY], editionId }, WEBMASTER);
      expect(queue.items.map((i) => i.id)).toContain(item.id);
      expect(queue.items.every((i) => i.working?.status === VersionStatus.READY)).toBe(true);
      const drafts = await content.listWorkingItems({ states: [ItemState.DRAFT], officeId: offices['publications'] as string }, PUB);
      expect(drafts.items.map((i) => i.id)).not.toContain(item.id);
      expect((await content.listWorkingItems({}, PUB)).items.map((i) => i.id)).toContain(item.id);
      await expect(content.listWorkingItems({}, MEMBER)).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(content.getWorkingItem({ itemId: item.id }, MEMBER)).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(content.listItemHistory({ itemId: item.id }, MEMBER)).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(content.listItemHistory({ itemId: item.id })).rejects.toMatchObject({ code: Code.Unauthenticated });
      await expect(content.getWorkingItem({ itemId: '6a1f0c8e-0000-4000-8000-000000000000' }, PUB)).rejects.toMatchObject({ code: Code.NotFound });
    });

    it('gives the history its versions, hashes and offices', async () => {
      const item = await published('Text.');
      const entries = (await content.listItemHistory({ itemId: item.id }, PUB)).entries;
      expect(entries.map((e) => [e.action, e.versionNumber, e.actingOfficeId])).toEqual([
        ['create', 1, offices['publications']],
        ['save', 1, offices['publications']],
        ['ready', 1, offices['publications']],
        ['approve', 1, ''],
      ]);
      expect(entries[2]?.contentHash).toHaveLength(32);
    });
  });

  // API-FIX3 notes.
  describe('what a caller can learn, late approvals, and markers outside the body', () => {
    it('answers a caller who cannot see working items the same for an item that exists and one that does not', async () => {
      const item = await published();
      const missing = '6a1f0c8e-0000-4000-8000-000000000000';
      for (const options of [MEMBER, as('joiner-token')]) {
        const answers = await Promise.all(
          [item.id, missing].flatMap((itemId) => [
            content.saveDraft({ itemId, title: 'x', bodyMarkup: 'x' }, options),
            content.markReady({ itemId }, options),
            content.withdraw({ itemId }, options),
            content.restore({ itemId }, options),
          ].map((call) => call.then(() => 'accepted', (e: { code: Code; rawMessage: string }) => `${e.code} ${e.rawMessage}`))),
        );
        expect(new Set(answers)).toEqual(new Set([`${Code.NotFound} item not found`]));
      }
      // An officer of another office sees working items anyway, so it is told why.
      await expect(content.withdraw({ itemId: item.id }, TREASURER)).rejects.toMatchObject({ code: Code.PermissionDenied });
    });

    it('refuses to approve a version whose edition was frozen after it was marked ready, and says to pick an open one', async () => {
      const march = await insertId(
        api.pool,
        `INSERT INTO edition (slug, title, kind, period_start, period_end, status) VALUES ('2027-03', 'March 2027', 'regular', '2027-03-01', '2027-03-31', 'collecting') RETURNING id`,
      );
      const item = await create();
      await save(item.id, 'Late text.');
      const hash = await ready(item.id, PUB, { editionId: march, targets: { website: true, newsletter: true, email: false } });
      await content.freezeEdition({ editionId: march }, ADMIN);
      await expect(content.approve({ itemId: item.id, contentHash: hash }, WEBMASTER)).rejects.toMatchObject({
        code: Code.FailedPrecondition,
        rawMessage: 'March 2027 is already frozen for print: pick an open edition, then approve',
      });
      // Choosing an open edition at approval is the way through.
      expect((await content.approve({ itemId: item.id, contentHash: hash, editionId }, WEBMASTER)).item?.state).toBe(ItemState.PUBLISHED);
    });

    it('refuses members markers in a title or a summary, which are always public', async () => {
      const message = 'a title or summary is always public: put members-only words in the body';
      await expect(create(PUB, 'publications', { title: 'Party, gate :members[4417]' })).rejects.toMatchObject({ code: Code.InvalidArgument, rawMessage: message });
      const item = await create();
      for (const extra of [{ title: 'Party, gate :members[4417]' }, { summary: 'Code :members[4417]' }, { summary: 'Open\n::: members\nHidden\n:::' }]) {
        await expect(save(item.id, 'Body.', PUB, extra)).rejects.toMatchObject({ code: Code.InvalidArgument, rawMessage: message });
      }
      expect((await save(item.id, 'Body.', PUB, { title: 'Party: members welcome', summary: 'Bring a friend [to share]' })).problems).toEqual([]);
    });
  });
});
