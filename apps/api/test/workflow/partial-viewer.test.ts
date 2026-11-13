// A3B-HARDEN: a reviewer from whom anything in a version is withheld (their lens redacts part of it, as
// the Admin or the Webmaster without the officers group reads at the public's audience) can only send it
// back. Approve (break-glass included), Publish and ConfirmLinks refuse them with FAILED_PRECONDITION
// before any hash is compared, even with the right content hash and links hash, in words that say only
// that parts are withheld; the read flags say they may neither approve nor publish. An officer who sees
// the same version whole goes through. Every person, place and number here is made up.
import { type Client, Code, ConnectError } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentKind, ContentService, type ContentItem, ItemVisibility, VersionStatus } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { MarkField, MarkSubjectKind, RedactionCategory, RedactionPolicyService } from '../../src/gen/nwfl/mensa/v1/redaction_pb.js';
import { type Api, as, insertId, startApi } from '../helpers/api.js';
import { live } from '../helpers/pg.js';

const PUB = as('pub-token');
const TREASURER = as('treasurer-token');
const OFFICER = as('officer-token');
const WEBMASTER = as('webmaster-token');
const LONE_ADMIN = as('lone-admin-token');
const LONE_WEBMASTER = as('lone-webmaster-token');

const PHONE = '850-555-0161';
const FACEBOOK = 'https://www.facebook.com/groups/example-rides';
const WITHHELD_WORDS = /^part of this item is withheld from you; an officer who can see all of it must (approve it|publish it|check its links)$/;

const failure = async (call: Promise<unknown>): Promise<{ code: Code | 'ok'; message: string }> => {
  try {
    await call;
    return { code: 'ok', message: '' };
  } catch (error) {
    const connectError = ConnectError.from(error);
    return { code: connectError.code, message: connectError.rawMessage };
  }
};

describe.skipIf(!live)('A3B-HARDEN: a reviewer who cannot see the whole version can only send it back', () => {
  let api: Api;
  let content: Client<typeof ContentService>;
  let marks: Client<typeof RedactionPolicyService>;
  let office: string;
  let n = 0;

  /** A ready piece written by `writer` with a member's phone in it, then marked so the public's lens withholds it. */
  const markedPiece = async (writer = PUB): Promise<{ itemId: string; hash: Uint8Array }> => {
    const item = (await content.createItem({ kind: ContentKind.ARTICLE, officeId: office, slug: `pv-${(n += 1)}`, title: 'Rides' }, writer)).item as ContentItem;
    await content.saveDraft({ itemId: item.id, title: 'Rides', summary: '', visibility: ItemVisibility.PUBLIC, bodyMarkup: `Call ${PHONE} for a ride, or see [the group](${FACEBOOK}).` }, writer);
    const hash = (await content.markReady({ itemId: item.id }, writer)).item?.working?.contentHash as Uint8Array;
    await marks.addRedactionMark({ subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: item.id, field: MarkField.BODY, quote: PHONE, category: RedactionCategory.MEMBER_PHONE }, OFFICER);
    return { itemId: item.id, hash };
  };
  const answers = async (itemId: string): Promise<number> => Number((await api.pool.query<{ n: string }>(`SELECT count(*) AS n FROM content_link_check WHERE item_id = $1`, [itemId])).rows[0]?.n);
  const status = async (itemId: string): Promise<string> =>
    (await api.pool.query<{ status: string }>(`SELECT v.status FROM content_item i JOIN content_version v ON v.id = i.working_version_id WHERE i.id = $1`, [itemId])).rows[0]?.status as string;

  beforeAll(async () => {
    api = await startApi('nwfl_partial_viewer');
    content = api.client(ContentService);
    marks = api.client(RedactionPolicyService);
    office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
  });

  afterAll(async () => {
    await api?.close();
  });

  it('refuses ConfirmLinks with the officer\'s links hash or their own, stores nothing; an officer answers', async () => {
    const { itemId } = await markedPiece();
    const officerHash = (await content.getItemLinks({ itemId }, TREASURER)).linksSha256;
    const ownHash = (await content.getItemLinks({ itemId }, LONE_WEBMASTER)).linksSha256;
    for (const [who, linksSha256] of [
      [LONE_WEBMASTER, officerHash],
      [LONE_WEBMASTER, ownHash],
      [LONE_ADMIN, officerHash],
    ] as const) {
      const refused = await failure(content.confirmLinks({ itemId, linksSha256, answers: [{ url: FACEBOOK, yes: true }] }, who));
      expect(refused.code).toBe(Code.FailedPrecondition);
      expect(refused.message).toBe('part of this item is withheld from you; an officer who can see all of it must check its links');
    }
    // Refused before the hash: a wrong hash gets the same answer, so the refusal is no oracle for it.
    expect((await failure(content.confirmLinks({ itemId, linksSha256: new Uint8Array(32), answers: [{ url: FACEBOOK, yes: true }] }, LONE_WEBMASTER))).message).toMatch(WITHHELD_WORDS);
    expect(await answers(itemId)).toBe(0);
    expect((await failure(content.confirmLinks({ itemId, linksSha256: officerHash, answers: [{ url: FACEBOOK, yes: true }] }, TREASURER))).code).toBe('ok');
    expect(await answers(itemId)).toBe(1);
  });

  it('refuses Approve with the right content hash, and a wrong one alike; an officer approves the same version', async () => {
    const { itemId, hash } = await markedPiece();
    await content.confirmLinks({ itemId, linksSha256: (await content.getItemLinks({ itemId }, TREASURER)).linksSha256, answers: [{ url: FACEBOOK, yes: true }] }, TREASURER);
    for (const who of [LONE_ADMIN, LONE_WEBMASTER]) {
      for (const contentHash of [hash, new Uint8Array(32)]) {
        const refused = await failure(content.approve({ itemId, contentHash }, who));
        expect(refused.code).toBe(Code.FailedPrecondition);
        expect(refused.message).toBe('part of this item is withheld from you; an officer who can see all of it must approve it');
        expect(refused.message).not.toContain(PHONE);
      }
    }
    expect(await status(itemId)).toBe('ready');
    expect(((await content.approve({ itemId, contentHash: hash }, OFFICER)).item as ContentItem).working?.status).toBe(VersionStatus.CLEARED);
  });

  it("refuses the Admin's break-glass on a version they wrote once part of it is withheld from them", async () => {
    const { itemId, hash } = await markedPiece(LONE_ADMIN);
    await content.confirmLinks({ itemId, linksSha256: (await content.getItemLinks({ itemId }, TREASURER)).linksSha256, answers: [{ url: FACEBOOK, yes: true }] }, TREASURER);
    const refused = await failure(content.approve({ itemId, contentHash: hash, breakGlass: true, breakGlassReason: 'Deadline tonight' }, LONE_ADMIN));
    expect(refused).toEqual({ code: Code.FailedPrecondition, message: 'part of this item is withheld from you; an officer who can see all of it must approve it' });
    expect(await status(itemId)).toBe('ready');
  });

  it('refuses Publish with the right content hash; the Webmaster who sees it whole publishes', async () => {
    const { itemId, hash } = await markedPiece();
    await content.confirmLinks({ itemId, linksSha256: (await content.getItemLinks({ itemId }, TREASURER)).linksSha256, answers: [{ url: FACEBOOK, yes: true }] }, TREASURER);
    await content.approve({ itemId, contentHash: hash }, TREASURER);
    for (const who of [LONE_ADMIN, LONE_WEBMASTER]) {
      for (const contentHash of [hash, new Uint8Array(32)]) {
        expect(await failure(content.publish({ itemId, contentHash }, who))).toEqual({
          code: Code.FailedPrecondition,
          message: 'part of this item is withheld from you; an officer who can see all of it must publish it',
        });
      }
    }
    expect(await status(itemId)).toBe('cleared');
    expect((await failure(content.publish({ itemId, contentHash: hash }, WEBMASTER))).code).toBe('ok');
  });

  it('tells such a reviewer they may neither approve nor publish; an officer the same item may', async () => {
    const ready = await markedPiece();
    for (const who of [LONE_ADMIN, LONE_WEBMASTER]) {
      const working = (await content.getWorkingItem({ itemId: ready.itemId }, who)).item?.working;
      expect(working?.bodyMarkupWithheld).toBe(true);
      expect(working?.callerMayApprove).toBe(false);
    }
    expect((await content.getWorkingItem({ itemId: ready.itemId }, TREASURER)).item?.working?.callerMayApprove).toBe(true);
    const cleared = await markedPiece();
    await content.confirmLinks({ itemId: cleared.itemId, linksSha256: (await content.getItemLinks({ itemId: cleared.itemId }, TREASURER)).linksSha256, answers: [{ url: FACEBOOK, yes: true }] }, TREASURER);
    await content.approve({ itemId: cleared.itemId, contentHash: cleared.hash }, TREASURER);
    for (const who of [LONE_ADMIN, LONE_WEBMASTER]) expect((await content.getWorkingItem({ itemId: cleared.itemId }, who)).item?.working?.callerMayPublish).toBe(false);
    expect((await content.getWorkingItem({ itemId: cleared.itemId }, WEBMASTER)).item?.working?.callerMayPublish).toBe(true);
  });

  it('still lets them send it back, from ready and from approved-not-yet-published', async () => {
    const ready = await markedPiece();
    expect((await failure(content.sendBack({ itemId: ready.itemId, note: 'Please check the phone number.' }, LONE_ADMIN))).code).toBe('ok');
    expect(await status(ready.itemId)).toBe('draft');
    const cleared = await markedPiece();
    await content.confirmLinks({ itemId: cleared.itemId, linksSha256: (await content.getItemLinks({ itemId: cleared.itemId }, TREASURER)).linksSha256, answers: [{ url: FACEBOOK, yes: true }] }, TREASURER);
    await content.approve({ itemId: cleared.itemId, contentHash: cleared.hash }, TREASURER);
    expect((await failure(content.sendBack({ itemId: cleared.itemId, note: 'Hold this one.' }, LONE_WEBMASTER))).code).toBe('ok');
    expect(await status(cleared.itemId)).toBe('draft');
  });
});
