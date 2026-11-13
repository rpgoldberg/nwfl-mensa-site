// EDITOR E3 fix 1: what the writers' list ("Our news", S2) needs from ListWorkingItems, end to end over
// gRPC against a real Postgres.
//   1. States PUBLISHED and WITHDRAWN list items in that state, with or without a change being written,
//      so an officer can find a published piece to correct it. With no states the list is as before:
//      drafts and ready ones only. Who may list is unchanged.
//   2. ContentItem.last_changed_at: when the item last changed, by its latest audited step (a read,
//      such as an export, is no change), on every officer read of an item.
// Made-up people and synthetic text only.
import { type Client, Code } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentKind, ContentService, type ContentItem, ItemState, ItemVisibility, VersionStatus } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { type Api, MEMBER, as, insertId, startApi } from '../helpers/api.js';
import { live } from '../helpers/pg.js';

const PUB = as('pub-token');
const TREASURER = as('treasurer-token');
const WEBMASTER = as('webmaster-token');
const LONE_ADMIN = as('lone-admin-token');
const AGENT = as('agent-token');

describe.skipIf(!live)('EDITOR E3: the writers\' list', () => {
  let api: Api;
  let content: Client<typeof ContentService>;
  const offices: Record<string, string> = {};
  let n = 0;

  beforeAll(async () => {
    api = await startApi('nwfl_editor_e3');
    content = api.client(ContentService);
    for (const [slug, title] of [
      ['publications', 'Publications Officer'],
      ['treasurer', 'Treasurer'],
    ] as const) {
      offices[slug] = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ($1, $2, 'appointed') RETURNING id`, [slug, title]);
    }
  });

  afterAll(async () => {
    await api?.close();
  });

  const draft = async (options = PUB, office = 'publications'): Promise<string> => {
    const item = (await content.createItem({ kind: ContentKind.ARTICLE, officeId: offices[office] as string, slug: `e3-item-${(n += 1)}`, title: 'Fall picnic' }, options)).item as ContentItem;
    await content.saveDraft({ itemId: item.id, title: 'Fall picnic', summary: 'Saturday', visibility: ItemVisibility.PUBLIC, bodyMarkup: 'Noon at the pier.' }, options);
    return item.id;
  };
  /** EDITOR A1: ready, approved (cleared), then published by the Webmaster. */
  const publish = async (itemId: string, options = PUB): Promise<void> => {
    const hash = (await content.markReady({ itemId }, options)).item?.working?.contentHash as Uint8Array;
    await content.approve({ itemId, contentHash: hash }, WEBMASTER);
    await content.publish({ itemId, contentHash: hash }, WEBMASTER);
  };
  const ids = (items: ContentItem[]) => items.map((item) => item.id);
  /** When an item last changed, in microseconds since the epoch: exact (a Date would round it). */
  const lastChanged = (item: ContentItem | undefined) =>
    item?.lastChangedAt === undefined ? undefined : (item.lastChangedAt.seconds * 1000000n + BigInt(item.lastChangedAt.nanos / 1000)).toString();
  /** The latest audited change of an item, as the database has it, in microseconds. */
  const latestStep = async (itemId: string): Promise<string> =>
    ((await api.pool.query<{ us: string }>(`SELECT (extract(epoch FROM max(at)) * 1000000)::bigint::text AS us FROM audit_event WHERE item_id = $1`, [itemId])).rows[0] as { us: string }).us;

  describe('1. published and taken-down items, by state', () => {
    it('lists a published item, with or without a change being written, and a taken-down one, by their states', async () => {
      const published = await draft();
      await publish(published);
      const changing = await draft();
      await publish(changing);
      await content.saveDraft({ itemId: changing, title: 'Fall picnic, moved', summary: '', visibility: ItemVisibility.PUBLIC, bodyMarkup: 'Noon at the park.' }, PUB);
      const down = await draft();
      await publish(down);
      await content.withdraw({ itemId: down }, PUB);
      const writing = await draft();

      const listed = (await content.listWorkingItems({ states: [ItemState.PUBLISHED, ItemState.WITHDRAWN] }, PUB)).items;
      expect(ids(listed)).toEqual(expect.arrayContaining([published, changing, down]));
      expect(ids(listed)).not.toContain(writing);
      expect(listed.find((i) => i.id === published)).toMatchObject({ state: ItemState.PUBLISHED });
      expect(listed.find((i) => i.id === published)?.working).toBeUndefined();
      expect(listed.find((i) => i.id === changing)?.working?.title).toBe('Fall picnic, moved');
      expect(listed.find((i) => i.id === down)).toMatchObject({ state: ItemState.WITHDRAWN });
      expect(listed.find((i) => i.id === down)?.withdrawnAt).toBeDefined();

      expect(ids((await content.listWorkingItems({ states: [ItemState.WITHDRAWN] }, PUB)).items)).toContain(down);
      expect(ids((await content.listWorkingItems({ states: [ItemState.WITHDRAWN] }, PUB)).items)).not.toContain(published);
      // Draft and published together: the draft, and the published item whose change is a draft, once each.
      const both = ids((await content.listWorkingItems({ states: [ItemState.DRAFT, ItemState.PUBLISHED] }, PUB)).items);
      expect(both).toEqual(expect.arrayContaining([writing, published, changing]));
      expect(both.filter((id) => id === changing)).toHaveLength(1);
    });

    it('lists, with no states, the items being written only, as before', async () => {
      const published = await draft();
      await publish(published);
      const writing = await draft();
      const listed = ids((await content.listWorkingItems({}, PUB)).items);
      expect(listed).toContain(writing);
      expect(listed).not.toContain(published);
    });

    it('reads no item state once version_statuses is given (A1): those name the working version only', async () => {
      const published = await draft();
      await publish(published);
      const writing = await draft();
      const listed = ids((await content.listWorkingItems({ versionStatuses: [VersionStatus.DRAFT], states: [ItemState.PUBLISHED] }, PUB)).items);
      expect(listed).toContain(writing);
      expect(listed).not.toContain(published);
    });

    it('lists a published item whose change is approved and waiting to be published, once', async () => {
      const itemId = await draft();
      await publish(itemId);
      await content.saveDraft({ itemId, title: 'Fall picnic, moved', summary: '', visibility: ItemVisibility.PUBLIC, bodyMarkup: 'Noon at the park.' }, PUB);
      const hash = (await content.markReady({ itemId }, PUB)).item?.working?.contentHash as Uint8Array;
      await content.approve({ itemId, contentHash: hash }, WEBMASTER);
      const listed = (await content.listWorkingItems({ states: [ItemState.PUBLISHED] }, PUB)).items.filter((i) => i.id === itemId);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.working?.status).toBe(VersionStatus.CLEARED);
      expect(ids((await content.listWorkingItems({}, PUB)).items)).toContain(itemId);
    });

    it('filters published items by office, and by the edition of what is live', async () => {
      const ours = await draft();
      await publish(ours);
      const theirs = await draft(TREASURER, 'treasurer');
      await publish(theirs, TREASURER);
      const byOffice = ids((await content.listWorkingItems({ states: [ItemState.PUBLISHED], officeId: offices['treasurer'] as string }, PUB)).items);
      expect(byOffice).toContain(theirs);
      expect(byOffice).not.toContain(ours);
      expect((await content.listWorkingItems({ states: [ItemState.PUBLISHED], editionId: '00000000-0000-4000-8000-0000000000e1' }, PUB)).items).toEqual([]);
    });

    it('lets the same people list them as before: any officer, the Admin, the Webmaster; never a member, the agent or the public', async () => {
      const theirs = await draft(TREASURER, 'treasurer');
      await publish(theirs, TREASURER);
      for (const who of [PUB, LONE_ADMIN, WEBMASTER]) expect(ids((await content.listWorkingItems({ states: [ItemState.PUBLISHED] }, who)).items)).toContain(theirs);
      for (const [who, code] of [
        [MEMBER, Code.PermissionDenied],
        [AGENT, Code.PermissionDenied],
        [{}, Code.Unauthenticated],
      ] as const) {
        await expect(content.listWorkingItems({ states: [ItemState.PUBLISHED] }, who)).rejects.toMatchObject({ code });
      }
    });
  });

  describe('2. last_changed_at', () => {
    it('is the latest audited step, on the list and on each officer read', async () => {
      const itemId = await draft();
      const created = await latestStep(itemId);
      expect(lastChanged((await content.getWorkingItem({ itemId }, PUB)).item)).toBe(created);
      await publish(itemId);
      const approved = await latestStep(itemId);
      expect(BigInt(approved)).toBeGreaterThanOrEqual(BigInt(created));
      const listed = (await content.listWorkingItems({ states: [ItemState.PUBLISHED] }, PUB)).items.find((i) => i.id === itemId);
      expect(lastChanged(listed)).toBe(approved);
      const withdrawn = (await content.withdraw({ itemId }, PUB)).item;
      expect(lastChanged(withdrawn)).toBe(await latestStep(itemId));
    });

    it('counts no read as a change: an export read leaves it where it was', async () => {
      const itemId = await draft();
      const before = lastChanged((await content.getWorkingItem({ itemId }, PUB)).item);
      await api.pool.query(
        `INSERT INTO audit_event (actor_kind, action, subject_kind, subject_id, item_id) VALUES ('agent', 'export_read', 'content_item', $1::text, $1::uuid)`,
        [itemId],
      );
      expect(lastChanged((await content.getWorkingItem({ itemId }, PUB)).item)).toBe(before);
    });

    it('orders the list newest change first', async () => {
      const older = await draft();
      const newer = await draft();
      await content.saveDraft({ itemId: older, title: 'Fall picnic', summary: '', visibility: ItemVisibility.PUBLIC, bodyMarkup: 'Changed last.' }, PUB);
      const listed = ids((await content.listWorkingItems({ officeId: offices['publications'] as string }, PUB)).items);
      expect(listed.indexOf(older)).toBeLessThan(listed.indexOf(newer));
    });
  });
});
