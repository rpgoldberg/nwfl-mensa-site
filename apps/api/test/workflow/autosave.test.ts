// EDITOR E3 round 2: auto-save, with guards, end to end over gRPC against a real Postgres.
//   1. ContentVersion.updated_at on officer reads: the base a form loaded, to the microsecond.
//   2. SaveDraftRequest.base_updated_at: a save from a base someone else has changed since is refused
//      (FailedPrecondition) and writes nothing, manual or automatic. Unset keeps today's last-write-wins.
//   3. SaveDraftRequest.auto: an automatic save saves a draft only. It never voids an approval, never
//      takes a ready version back, never opens a new version; refused, it writes nothing.
//   4. The audit trail stays bounded: consecutive automatic saves by one person on one version within
//      10 minutes are one 'autosave' row (the audit is append-only, so later ones add none), and the
//      item's last change still moves with each.
//   5. Who may save automatically is who may save.
// Made-up people and synthetic text only.
import { type Client, Code } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentKind, ContentService, type ContentItem, ItemVisibility, VersionStatus } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { type Api, MEMBER, as, insertId, startApi } from '../helpers/api.js';
import { live } from '../helpers/pg.js';

const PUB = as('pub-token');
const ADMIN = as('admin-token');
const TREASURER = as('treasurer-token');
const WEBMASTER = as('webmaster-token');
const AGENT = as('agent-token');
const STALE = 'This draft was changed by someone else since you opened it';

describe.skipIf(!live)('EDITOR E3 round 2: auto-save', () => {
  let api: Api;
  let content: Client<typeof ContentService>;
  const offices: Record<string, string> = {};
  let n = 0;

  beforeAll(async () => {
    api = await startApi('nwfl_editor_e3_autosave');
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

  type Save = { markup?: string; base?: ContentItem['working']; auto?: boolean };
  const save = (itemId: string, who: { headers?: Record<string, string> } = PUB, { markup = 'Noon at the pier.', base, auto = false }: Save = {}) =>
    content.saveDraft(
      { itemId, title: 'Fall picnic', summary: 'Saturday', visibility: ItemVisibility.PUBLIC, bodyMarkup: markup, auto, ...(base?.updatedAt ? { baseUpdatedAt: base.updatedAt } : {}) },
      who,
    );
  const draft = async (): Promise<string> => {
    const item = (await content.createItem({ kind: ContentKind.ARTICLE, officeId: offices['publications'] as string, slug: `e3-auto-${(n += 1)}`, title: 'Fall picnic' }, PUB)).item as ContentItem;
    await save(item.id);
    return item.id;
  };
  const read = async (itemId: string) => (await content.getWorkingItem({ itemId }, PUB)).item as ContentItem;
  const ready = async (itemId: string): Promise<Uint8Array> => (await content.markReady({ itemId }, PUB)).item?.working?.contentHash as Uint8Array;
  const published = async (): Promise<string> => {
    const itemId = await draft();
    const hash = await ready(itemId);
    await content.approve({ itemId, contentHash: hash }, WEBMASTER);
    await content.publish({ itemId, contentHash: hash }, WEBMASTER);
    return itemId;
  };
  /** The item's audit rows, oldest first. */
  const steps = async (itemId: string) =>
    (await api.pool.query<{ action: string; actor_sub: string }>(`SELECT action, actor_sub FROM audit_event WHERE item_id = $1 ORDER BY id`, [itemId])).rows;
  /** The working version's updated_at to the microsecond, as the database has it. */
  const micros = async (versionId: string): Promise<string> =>
    ((await api.pool.query<{ us: string }>(`SELECT (extract(epoch FROM updated_at) * 1000000)::bigint::text AS us FROM content_version WHERE id = $1`, [versionId])).rows[0] as { us: string }).us;
  const microsOf = (version: ContentItem['working']) => (version?.updatedAt ? (version.updatedAt.seconds * 1000000n + BigInt(version.updatedAt.nanos / 1000)).toString() : undefined);

  describe('1. updated_at', () => {
    it('is on the officer reads of the working and the live version, to the microsecond, and moves on each save', async () => {
      const itemId = await draft();
      const first = (await read(itemId)).working;
      expect(microsOf(first)).toBe(await micros(first?.id as string));
      const saved = (await save(itemId, PUB, { markup: 'Changed.', base: first })).item?.working;
      expect(microsOf(saved)).toBe(await micros(saved?.id as string));
      expect(BigInt(microsOf(saved) as string)).toBeGreaterThan(BigInt(microsOf(first) as string));
      const live = (await read(await published())).live;
      expect(microsOf(live)).toBe(await micros(live?.id as string));
    });
  });

  describe('2. base_updated_at', () => {
    it.each([
      ['a manual save', false],
      ['an automatic save', true],
    ])('refuses %s from a base someone else has changed since, and writes nothing', async (_what, auto) => {
      const itemId = await draft();
      const opened = (await read(itemId)).working;
      await save(itemId, ADMIN, { markup: 'The Admin was here.', base: opened });
      const before = { item: await read(itemId), steps: await steps(itemId) };
      await expect(save(itemId, PUB, { markup: 'Mine.', base: opened, auto })).rejects.toMatchObject({ code: Code.FailedPrecondition, rawMessage: STALE });
      const after = await read(itemId);
      expect(after.working?.bodyMarkup).toBe('The Admin was here.');
      expect(microsOf(after.working)).toBe(microsOf(before.item.working));
      expect(await steps(itemId)).toEqual(before.steps);
    });

    it('refuses a save from a published item\'s live version once someone has started a change of it', async () => {
      const itemId = await published();
      const opened = (await read(itemId)).live;
      await save(itemId, ADMIN, { markup: 'A change by the Admin.' });
      await expect(save(itemId, PUB, { markup: 'Mine.', base: opened })).rejects.toMatchObject({ code: Code.FailedPrecondition, rawMessage: STALE });
      expect((await read(itemId)).working?.bodyMarkup).toBe('A change by the Admin.');
    });

    it('saves from the current base, and from a published item\'s live version when nobody has started a change', async () => {
      const itemId = await draft();
      const saved = await save(itemId, PUB, { markup: 'Fresh.', base: (await read(itemId)).working });
      expect(saved.item?.working?.bodyMarkup).toBe('Fresh.');
      const again = await save(itemId, PUB, { markup: 'Fresher.', base: saved.item?.working });
      expect(again.item?.working?.bodyMarkup).toBe('Fresher.');
      const live = await published();
      expect((await save(live, PUB, { markup: 'A correction.', base: (await read(live)).live })).item?.working).toMatchObject({ number: 2, bodyMarkup: 'A correction.' });
    });

    it.each([
      ['a manual save', false],
      ['an automatic save', true],
    ])('finds no conflict in %s from a stale base that carries what is already saved (its own save, landed first): nothing written, the current base back', async (_what, auto) => {
      const itemId = await draft();
      const opened = (await read(itemId)).working;
      // The page's own save, sent as it was left (kept alive), lands after the next page was read.
      const landed = (await save(itemId, PUB, { markup: 'Typed, then reloaded.', base: opened, auto: true })).item?.working;
      const before = await steps(itemId);
      const again = await save(itemId, PUB, { markup: 'Typed, then reloaded.', base: opened, auto });
      expect(microsOf(again.item?.working)).toBe(microsOf(landed));
      expect(await steps(itemId)).toEqual(before);
      // Anything else from that base is still someone else's change to keep.
      await expect(save(itemId, PUB, { markup: 'Typed, then reloaded, and more.', base: opened, auto })).rejects.toMatchObject({ code: Code.FailedPrecondition, rawMessage: STALE });
    });

    it('still refuses an automatic save of an item no longer a draft, even one that carries what is saved', async () => {
      const itemId = await draft();
      const opened = (await read(itemId)).working;
      await ready(itemId);
      await expect(save(itemId, PUB, { base: opened, auto: true })).rejects.toMatchObject({ code: Code.FailedPrecondition, rawMessage: 'an automatic save only saves a draft' });
    });

    it('keeps the last write winning with no base, as before', async () => {
      const itemId = await draft();
      await save(itemId, ADMIN, { markup: 'First.' });
      expect((await save(itemId, PUB, { markup: 'Second.' })).item?.working?.bodyMarkup).toBe('Second.');
    });
  });

  describe('3. auto', () => {
    it('saves a draft, as an autosave', async () => {
      const itemId = await draft();
      const saved = await save(itemId, PUB, { markup: 'Typed, saved by itself.', auto: true, base: (await read(itemId)).working });
      expect(saved.item?.working).toMatchObject({ status: VersionStatus.DRAFT, bodyMarkup: 'Typed, saved by itself.' });
      expect((await steps(itemId)).map((s) => s.action)).toEqual(['create', 'save', 'autosave']);
    });

    it.each([
      ['ready', async () => {
        const itemId = await draft();
        await ready(itemId);
        return itemId;
      }],
      ['approved and waiting to be published', async () => {
        const itemId = await draft();
        await content.approve({ itemId, contentHash: await ready(itemId) }, WEBMASTER);
        return itemId;
      }],
      ['published, with no change started', published],
      ['taken down', async () => {
        const itemId = await published();
        await content.withdraw({ itemId }, PUB);
        return itemId;
      }],
    ])('refuses an item %s, and writes nothing', async (_what, make) => {
      const itemId = await make();
      const before = { item: await read(itemId), steps: await steps(itemId) };
      await expect(save(itemId, PUB, { markup: 'Saved by itself?', auto: true })).rejects.toMatchObject({ code: Code.FailedPrecondition });
      const after = await read(itemId);
      expect(after.working?.status).toBe(before.item.working?.status);
      expect(after.working?.id).toBe(before.item.working?.id);
      expect(after.state).toBe(before.item.state);
      expect(await steps(itemId)).toEqual(before.steps);
    });
  });

  describe('4. a bounded audit trail', () => {
    it('keeps 30 automatic saves in a row by one person to one row, and the last change moves with each', async () => {
      const itemId = await draft();
      let base = (await read(itemId)).working;
      for (let i = 1; i <= 30; i += 1) base = (await save(itemId, PUB, { markup: `Draft ${i}.`, auto: true, base })).item?.working;
      const item = await read(itemId);
      expect(item.working?.bodyMarkup).toBe('Draft 30.');
      expect((await steps(itemId)).map((s) => s.action)).toEqual(['create', 'save', 'autosave']);
      expect(microsOf({ updatedAt: item.lastChangedAt } as ContentItem['working'])).toBe(microsOf(item.working));
    });

    it('orders the list by the last change, an automatic save that added no row too', async () => {
      const first = await draft();
      await save(first, PUB, { markup: 'One.', auto: true });
      const second = await draft();
      await save(first, PUB, { markup: 'Two.', auto: true });
      expect((await steps(first)).map((s) => s.action)).toEqual(['create', 'save', 'autosave']);
      const listed = (await content.listWorkingItems({ officeId: offices['publications'] as string }, PUB)).items.map((i) => i.id);
      expect(listed.indexOf(first)).toBeLessThan(listed.indexOf(second));
    });

    it('starts a new row after a manual save, or for another person', async () => {
      const itemId = await draft();
      await save(itemId, PUB, { markup: 'One.', auto: true });
      await save(itemId, PUB, { markup: 'Two.', auto: true });
      await save(itemId, PUB, { markup: 'Three.' });
      await save(itemId, PUB, { markup: 'Four.', auto: true });
      await save(itemId, ADMIN, { markup: 'Five.', auto: true });
      await save(itemId, ADMIN, { markup: 'Six.', auto: true });
      expect((await steps(itemId)).map((s) => `${s.action}:${s.actor_sub}`)).toEqual([
        'create:sub-pub',
        'save:sub-pub',
        'autosave:sub-pub',
        'save:sub-pub',
        'autosave:sub-pub',
        'autosave:sub-admin',
      ]);
    });
  });

  describe('5. who may save automatically', () => {
    it('is who may save, refused alike: the office\'s holder and the Admin; never another office, a member, the agent or the public', async () => {
      for (const who of [PUB, ADMIN]) await expect(save(await draft(), who, { auto: true })).resolves.toBeDefined();
      for (const who of [TREASURER, MEMBER, AGENT, {}]) {
        const itemId = await draft();
        const refusal = (auto: boolean) =>
          save(itemId, who, { auto }).then(
            () => 'saved',
            (error: { code: Code }) => error.code,
          );
        const manual = await refusal(false);
        expect([Code.PermissionDenied, Code.NotFound, Code.Unauthenticated]).toContain(manual);
        expect(await refusal(true)).toBe(manual);
      }
    });
  });
});
