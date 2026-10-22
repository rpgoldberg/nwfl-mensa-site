// A4b: edition setup and the freeze for print (R25). Moving an edition to
// proof pins the live version of each approved newsletter item in it; a
// revision approved afterwards does not change the printed issue.
import { type Client, Code } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentKind, ContentService } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { EditionKind, EditionStatus } from '../../src/gen/nwfl/mensa/v1/edition_pb.js';
import { type Api, as, insertId, startApi } from '../helpers/api.js';
import { live } from '../helpers/pg.js';

const PUB = as('pub-token');
const ADMIN = as('admin-token');
const WEBMASTER = as('webmaster-token');
const TREASURER = as('treasurer-token');
const MEMBER = as('member-token');

describe.skipIf(!live)('editions and the freeze', () => {
  let api: Api;
  let content: Client<typeof ContentService>;
  let publications: string;
  let n = 0;

  beforeAll(async () => {
    api = await startApi('nwfl_editions');
    content = api.client(ContentService);
    publications = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
  });

  afterAll(async () => {
    await api?.close();
  });

  const edition = (slug: string, extra: Record<string, unknown> = {}) => ({
    slug,
    title: `Issue ${slug}`,
    kind: EditionKind.REGULAR,
    periodStart: { year: 2027, month: 2, day: 1 },
    periodEnd: { year: 2027, month: 3, day: 31 },
    calendarRanges: [{ start: { year: 2027, month: 2, day: 1 }, end: { year: 2027, month: 3, day: 31 } }],
    ...extra,
  });

  /** An approved item, targeting the newsletter or not, in an edition or not. */
  const approved = async (editionId: string, newsletter = true): Promise<{ id: string; version: string }> => {
    const item = (await content.createItem({ kind: ContentKind.ARTICLE, officeId: publications, slug: `pin-${(n += 1)}`, title: 'Item' }, PUB)).item;
    const itemId = item?.id as string;
    await content.saveDraft({ itemId, title: 'Item', bodyMarkup: `Text ${n}.` }, PUB);
    const hash = (await content.markReady({ itemId, editionId, targets: { website: true, newsletter, email: false } }, PUB)).item?.working?.contentHash as Uint8Array;
    const live = (await content.approve({ itemId, contentHash: hash }, WEBMASTER)).item?.live?.id as string;
    return { id: itemId, version: live };
  };

  it('lets the Editor or the Admin set up an edition, and nobody else', async () => {
    const created = (await content.saveEdition({ edition: edition('2027-02') }, ADMIN)).edition;
    expect(created).toMatchObject({ slug: '2027-02', status: EditionStatus.PLANNING, kind: EditionKind.REGULAR });
    expect(created?.calendarRanges).toHaveLength(1);
    const edited = (await content.saveEdition({ edition: { ...edition('2027-02'), id: created?.id as string, status: EditionStatus.COLLECTING, volume: 31, issueNumber: 1 } }, ADMIN)).edition;
    expect(edited).toMatchObject({ status: EditionStatus.COLLECTING, volume: 31, issueNumber: 1 });
    await expect(content.saveEdition({ edition: edition('2027-04') }, TREASURER)).rejects.toMatchObject({ code: Code.PermissionDenied });
    await expect(content.saveEdition({ edition: edition('2027-04') }, MEMBER)).rejects.toMatchObject({ code: Code.PermissionDenied });
    await expect(content.saveEdition({ edition: edition('2027-04') })).rejects.toMatchObject({ code: Code.Unauthenticated });
  });

  it.each([
    ['a slug that is not a period', { slug: 'Spring issue' }, Code.InvalidArgument],
    ['no kind', { kind: EditionKind.UNSPECIFIED }, Code.InvalidArgument],
    ['proof set by hand', { status: EditionStatus.PROOF }, Code.InvalidArgument],
    ['no period', { periodStart: undefined }, Code.InvalidArgument],
    ['a date the calendar does not have', { periodEnd: { year: 2027, month: 2, day: 30 } }, Code.InvalidArgument],
    ['an unknown id', { id: '6a1f0c8e-0000-4000-8000-000000000000' }, Code.NotFound],
  ])('refuses %s', async (_label, change, code) => {
    await expect(content.saveEdition({ edition: { ...edition('2027-06'), ...change } }, ADMIN)).rejects.toMatchObject({ code });
  });

  it('pins exactly the approved newsletter items of the edition, and freezes it', async () => {
    const target = (await content.saveEdition({ edition: edition('2027-08') }, ADMIN)).edition?.id as string;
    const other = (await content.saveEdition({ edition: edition('2027-10') }, ADMIN)).edition?.id as string;
    const a = await approved(target);
    const b = await approved(target);
    await approved(target, false);
    await approved(other);
    // Ready but not approved: never pinned.
    const pending = (await content.createItem({ kind: ContentKind.ARTICLE, officeId: publications, slug: `pin-${(n += 1)}`, title: 'Pending' }, PUB)).item?.id as string;
    await content.saveDraft({ itemId: pending, title: 'Pending', bodyMarkup: 'Later.' }, PUB);
    await content.markReady({ itemId: pending, editionId: target }, PUB);

    await expect(content.freezeEdition({ editionId: target }, TREASURER)).rejects.toMatchObject({ code: Code.PermissionDenied });
    const frozen = await content.freezeEdition({ editionId: target }, ADMIN);
    expect(frozen.pinnedItems).toBe(2);
    expect(frozen.edition).toMatchObject({ status: EditionStatus.PROOF });
    expect(frozen.edition?.frozenAt).toBeDefined();
    const { rows } = await api.pool.query<{ item_id: string; version_id: string }>(`SELECT item_id, version_id FROM edition_item WHERE edition_id = $1 ORDER BY pinned_at, item_id`, [target]);
    expect(rows.map((r) => [r.item_id, r.version_id]).sort()).toEqual([[a.id, a.version], [b.id, b.version]].sort());

    // Frozen: no new items for it, no edits to it, no second freeze.
    const late = (await content.createItem({ kind: ContentKind.ARTICLE, officeId: publications, slug: `pin-${(n += 1)}`, title: 'Late' }, PUB)).item?.id as string;
    await content.saveDraft({ itemId: late, title: 'Late', bodyMarkup: 'Too late.' }, PUB);
    await expect(content.markReady({ itemId: late, editionId: target }, PUB)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    await expect(content.saveEdition({ edition: { ...edition('2027-08'), id: target } }, ADMIN)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    await expect(content.freezeEdition({ editionId: target }, ADMIN)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    await expect(content.freezeEdition({ editionId: '6a1f0c8e-0000-4000-8000-000000000000' }, ADMIN)).rejects.toMatchObject({ code: Code.NotFound });

    // A revision approved after the freeze does not change the printed issue.
    await content.saveDraft({ itemId: a.id, title: 'Item', bodyMarkup: 'Revised after print.' }, PUB);
    const hash = (await content.markReady({ itemId: a.id }, PUB)).item?.working?.contentHash as Uint8Array;
    const revised = (await content.approve({ itemId: a.id, contentHash: hash }, WEBMASTER)).item?.live?.id;
    expect(revised).not.toBe(a.version);
    const pinned = await api.pool.query<{ version_id: string }>(`SELECT version_id FROM edition_item WHERE edition_id = $1 AND item_id = $2`, [target, a.id]);
    expect(pinned.rows[0]?.version_id).toBe(a.version);
    const audited = await api.pool.query<{ action: string; payload: unknown }>(`SELECT action, payload FROM audit_event WHERE subject_kind = 'edition' AND subject_id = $1 ORDER BY id`, [target]);
    expect(audited.rows.map((r) => r.action)).toEqual(['create', 'freeze']);
    expect(audited.rows[1]?.payload).toEqual({ pinned_items: 2 });
  });
});
