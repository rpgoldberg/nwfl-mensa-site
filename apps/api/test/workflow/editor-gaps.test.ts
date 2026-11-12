// EDITOR E1: what the officers' editor needs from the API, end to end over gRPC against a real Postgres.
//   1. PreviewWorkingItem: the working version as the public and members will get it once approved,
//      by the approval derivation and each audience's lens (property: it equals the published reads).
//   2. One predicate for the working reads: an officer, the Admin or the Webmaster.
//   3. ContentVersion.body_markup_withheld: the markup is left out, so an edit form must not open.
//   4. ContentVersion.send_back_note: the latest note since the version was last marked ready.
//   5. ContentVersion.caller_edited: whether the caller edited the version.
//   6. HistoryEntry.actor_label: who acted, by role at the time, never by name.
// Made-up people and synthetic text only.
import { type Client, Code } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentKind, ContentService, type ContentItem, ItemVisibility, VersionStatus } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import {
  MarkField,
  MarkSubjectKind,
  RedactionAction,
  RedactionAudience,
  RedactionCategory,
  RedactionChangeStatus,
  RedactionPolicyService,
} from '../../src/gen/nwfl/mensa/v1/redaction_pb.js';
import { WITHHELD } from '../../src/redaction/render.js';
import { type Api, MEMBER, OFFICER, as, dump, insertId, startApi } from '../helpers/api.js';
import { live } from '../helpers/pg.js';

const PUB = as('pub-token');
const ADMIN = as('admin-token');
const LONE_ADMIN = as('lone-admin-token');
const LONE_WEBMASTER = as('lone-webmaster-token');
const WEBMASTER = as('webmaster-token');
const TREASURER = as('treasurer-token');
const AGENT = as('agent-token');
const PHONE = '850-555-0147';
const NAME = 'Avery Madeup';

const VISIBILITY = { public: ItemVisibility.PUBLIC, members: ItemVisibility.MEMBERS, officers: ItemVisibility.OFFICERS } as const;
type Visibility = keyof typeof VISIBILITY;

describe.skipIf(!live)('EDITOR E1: the API the officers\' editor needs', () => {
  let api: Api;
  let content: Client<typeof ContentService>;
  let policy: Client<typeof RedactionPolicyService>;
  const offices: Record<string, string> = {};
  let n = 0;

  beforeAll(async () => {
    api = await startApi('nwfl_editor_e1');
    content = api.client(ContentService);
    policy = api.client(RedactionPolicyService);
    for (const [slug, title] of [
      ['publications', 'Publications Officer'],
      ['treasurer', 'Treasurer'],
      ['webmaster', 'Webmaster'],
      ['editor', 'Newsletter Editor'],
    ] as const) {
      offices[slug] = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ($1, $2, 'appointed') RETURNING id`, [slug, title]);
    }
  });

  afterAll(async () => {
    await api?.close();
  });

  const create = async (options = PUB): Promise<ContentItem> =>
    (await content.createItem({ kind: ContentKind.ARTICLE, officeId: offices['publications'] as string, slug: `e1-item-${(n += 1)}`, title: 'Fall picnic' }, options))
      .item as ContentItem;
  const save = (itemId: string, bodyMarkup: string, options = PUB, visibility: Visibility = 'public') =>
    content.saveDraft({ itemId, title: 'Fall picnic', summary: 'Saturday at noon', visibility: VISIBILITY[visibility], bodyMarkup }, options);
  const ready = async (itemId: string, options = PUB): Promise<Uint8Array> => (await content.markReady({ itemId }, options)).item?.working?.contentHash ?? new Uint8Array();
  const draft = async (markup = 'Noon at the pier.', visibility: Visibility = 'public'): Promise<string> => {
    const item = await create();
    await save(item.id, markup, PUB, visibility);
    return item.id;
  };
  const mark = (itemId: string, quote: string, category: RedactionCategory, field = MarkField.BODY) =>
    policy.addRedactionMark({ subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: itemId, field, quote, category }, OFFICER);
  /** One public policy cell; a loosening waits for a second officer, who approves it here. */
  const setPublic = async (category: RedactionCategory, action: RedactionAction): Promise<void> => {
    const { change } = await policy.proposeRedactionChange({ audience: RedactionAudience.PUBLIC, category, action }, OFFICER);
    if (change?.status === RedactionChangeStatus.PENDING) await policy.approveRedactionChange({ changeId: change.changeId }, PUB);
  };
  const working = async (itemId: string, options = PUB) => (await content.getWorkingItem({ itemId }, options)).item?.working;

  describe('2. one predicate for the working reads: an officer, the Admin or the Webmaster', () => {
    it.each([
      ['the Admin without the officers group', LONE_ADMIN],
      ['the Webmaster without the officers group', LONE_WEBMASTER],
    ])('lets %s list the queue, read an item, its history and its preview', async (_who, options) => {
      const itemId = await draft();
      expect((await content.listWorkingItems({}, options)).items.map((item) => item.id)).toContain(itemId);
      expect((await content.getWorkingItem({ itemId }, options)).item?.id).toBe(itemId);
      expect((await content.listItemHistory({ itemId }, options)).entries.map((entry) => entry.action)).toEqual(['create', 'save']);
      expect((await content.previewWorkingItem({ itemId }, options)).title).toBe('Fall picnic');
    });

    it.each([
      ['a member', MEMBER, Code.PermissionDenied],
      ['the newsletter agent', AGENT, Code.PermissionDenied],
      ['the public', {}, Code.Unauthenticated],
    ])('still refuses %s', async (_who, options, code) => {
      const itemId = await draft();
      await expect(content.listWorkingItems({}, options)).rejects.toMatchObject({ code });
      await expect(content.getWorkingItem({ itemId }, options)).rejects.toMatchObject({ code });
      await expect(content.listItemHistory({ itemId }, options)).rejects.toMatchObject({ code });
      await expect(content.previewWorkingItem({ itemId }, options)).rejects.toMatchObject({ code });
    });
  });

  describe('5. caller_edited', () => {
    it('is true for whoever edited the version and false for everyone else, on each read', async () => {
      const item = await create();
      expect(item.working?.callerEdited).toBe(true);
      const saved = await save(item.id, 'Noon at the pier.', ADMIN);
      expect(saved.item?.working?.callerEdited).toBe(true);
      expect((await working(item.id, PUB))?.callerEdited).toBe(true);
      expect((await working(item.id, ADMIN))?.callerEdited).toBe(true);
      expect((await working(item.id, WEBMASTER))?.callerEdited).toBe(false);
      expect((await working(item.id, TREASURER))?.callerEdited).toBe(false);
      const listed = (await content.listWorkingItems({}, WEBMASTER)).items.find((each) => each.id === item.id);
      expect(listed?.working?.callerEdited).toBe(false);
    });

    it('carries over to the live version for its editors, and a new revision starts with only its own editor', async () => {
      const itemId = await draft();
      const approved = (await content.approve({ itemId, contentHash: await ready(itemId) }, WEBMASTER)).item;
      expect(approved?.live?.callerEdited).toBe(false);
      expect((await content.getWorkingItem({ itemId }, PUB)).item?.live?.callerEdited).toBe(true);
      const revision = await save(itemId, 'Noon at the pier, then lunch.', ADMIN);
      expect(revision.item?.working).toMatchObject({ number: 2, callerEdited: true });
      expect(revision.item?.live?.callerEdited).toBe(false);
      expect((await working(itemId, PUB))?.callerEdited).toBe(false);
    });
  });

  describe('4. send_back_note', () => {
    it('is the latest note since the version was last marked ready, through each step', async () => {
      const itemId = await draft();
      expect((await working(itemId))?.sendBackNote).toBe('');
      await ready(itemId);
      const sent = (await content.sendBack({ itemId, note: '  The time is wrong.  ' }, WEBMASTER)).item?.working;
      expect(sent).toMatchObject({ status: VersionStatus.DRAFT, sendBackNote: 'The time is wrong.' });
      // Still there while the author edits.
      expect((await save(itemId, 'Noon at the pier, 1 pm.')).item?.working?.sendBackNote).toBe('The time is wrong.');
      expect((await working(itemId, WEBMASTER))?.sendBackNote).toBe('The time is wrong.');
      // Gone once it is ready again; the next send-back's note replaces it.
      await ready(itemId);
      expect((await working(itemId))?.sendBackNote).toBe('');
      await content.sendBack({ itemId, note: 'Add the parking.' }, ADMIN);
      expect((await working(itemId))?.sendBackNote).toBe('Add the parking.');
      const hash = await ready(itemId);
      const approved = (await content.approve({ itemId, contentHash: hash }, WEBMASTER)).item;
      expect(approved?.live?.sendBackNote).toBe('');
    });

    it('goes through the caller\'s lens, as the history note does', async () => {
      const itemId = await draft(`Rides from ${NAME}.`);
      await mark(itemId, NAME, RedactionCategory.MEMBER_NAME);
      await ready(itemId);
      await content.sendBack({ itemId, note: `Ask ${NAME} first.` }, WEBMASTER);
      expect((await working(itemId, LONE_ADMIN))?.sendBackNote).toBe(`Ask ${NAME} first.`);
      // The public lens shows names (0022): tightened here, and loosened back after.
      await setPublic(RedactionCategory.MEMBER_NAME, RedactionAction.REDACT);
      try {
        const note = (await working(itemId, LONE_ADMIN))?.sendBackNote;
        expect(note).toBe(`Ask ${WITHHELD} first.`);
        const history = (await content.listItemHistory({ itemId }, LONE_ADMIN)).entries.at(-1);
        expect(history?.note).toBe(note);
      } finally {
        await setPublic(RedactionCategory.MEMBER_NAME, RedactionAction.SHOW);
      }
    });
    it('stays gone once the version is ready again, even when the author then edits it back to draft', async () => {
      const itemId = await draft();
      await ready(itemId);
      await content.sendBack({ itemId, note: 'A stale note.' }, WEBMASTER);
      await ready(itemId);
      // Editing a READY version returns it to draft with a save row and no send-back: the old note must not return.
      await save(itemId, 'Noon at the pier, 2 pm.');
      expect((await working(itemId))?.sendBackNote).toBe('');
    });
  });

  describe('3. body_markup_withheld: the data-loss guard', () => {
    it('is false with the markup and the hash when nothing is withheld', async () => {
      const itemId = await draft(`Call ${PHONE} for rides.`);
      await ready(itemId);
      const version = await working(itemId);
      expect(version).toMatchObject({ bodyMarkupWithheld: false, bodyMarkup: `Call ${PHONE} for rides.` });
      expect(version?.contentHash).toHaveLength(32);
    });

    it('is set, with the markup empty and no hash, whenever the lens withholds anything from the caller', async () => {
      const itemId = await draft(`Call ${PHONE} for rides.`);
      await ready(itemId);
      await mark(itemId, PHONE, RedactionCategory.MEMBER_PHONE);
      // An officer sees the phone; the lone Admin (no officers group, not a member) reads through the public lens.
      expect(await working(itemId, PUB)).toMatchObject({ bodyMarkupWithheld: false, bodyMarkup: `Call ${PHONE} for rides.` });
      const withheld = await working(itemId, LONE_ADMIN);
      expect(withheld).toMatchObject({ bodyMarkupWithheld: true, bodyMarkup: '' });
      expect(withheld?.contentHash).toHaveLength(0);
      expect(dump(withheld)).not.toContain(PHONE);
    });

    it('is set by a withheld on-behalf-of name too, live and working', async () => {
      const item = (await content.createItem({ kind: ContentKind.ARTICLE, officeId: offices['publications'] as string, slug: `e1-item-${(n += 1)}`, title: 'Guest column', onBehalfOf: NAME }, PUB))
        .item as ContentItem;
      await save(item.id, 'A guest column.');
      const hash = await ready(item.id);
      await content.approve({ itemId: item.id, contentHash: hash }, WEBMASTER);
      await save(item.id, 'A guest column, revised.');
      await setPublic(RedactionCategory.MEMBER_NAME, RedactionAction.REDACT);
      try {
        const read = (await content.getWorkingItem({ itemId: item.id }, LONE_ADMIN)).item;
        for (const version of [read?.live, read?.working]) {
          expect(version).toMatchObject({ bodyMarkupWithheld: true, bodyMarkup: '' });
          expect(version?.contentHash).toHaveLength(0);
        }
      } finally {
        await setPublic(RedactionCategory.MEMBER_NAME, RedactionAction.SHOW);
      }
    });

    it('refuses SaveDraft to a caller whose lens withholds part of the item, and keeps the body', async () => {
      const itemId = await draft(`Call ${PHONE} for rides.`);
      await mark(itemId, PHONE, RedactionCategory.MEMBER_PHONE);
      const form = await working(itemId, LONE_ADMIN);
      expect(form).toMatchObject({ bodyMarkupWithheld: true, bodyMarkup: '' });
      // Saving that form back would wipe the body: refused, and nothing is written.
      await expect(save(itemId, form?.bodyMarkup ?? '', LONE_ADMIN)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      expect((await working(itemId, PUB))?.bodyMarkup).toBe(`Call ${PHONE} for rides.`);
      expect((await content.listItemHistory({ itemId }, PUB)).entries.map((entry) => entry.action)).toEqual(['create', 'save']);
      // An officer whose lens withholds nothing still saves the same item.
      const saved = await save(itemId, `Call ${PHONE} for rides, or text.`, PUB);
      expect(saved.item?.working).toMatchObject({ bodyMarkupWithheld: false, bodyMarkup: `Call ${PHONE} for rides, or text.` });
    });

    it('refuses the same caller a new revision of a published item whose live version is withheld, creating none', async () => {
      const itemId = await draft(`Call ${PHONE} for rides.`);
      await content.approve({ itemId, contentHash: await ready(itemId) }, WEBMASTER);
      await mark(itemId, PHONE, RedactionCategory.MEMBER_PHONE);
      await expect(save(itemId, '', LONE_ADMIN)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      const { rows } = await api.pool.query<{ n: number }>(`SELECT n FROM content_version WHERE item_id = $1 ORDER BY n`, [itemId]);
      expect(rows.map((row) => row.n)).toEqual([1]);
    });
  });

  describe('6. actor_label: who acted, by role at the time', () => {
    it('labels each step by the office acted for, the Admin or the Webmaster, and never carries a name', async () => {
      const item = await create(PUB);
      await save(item.id, 'Noon at the pier.', LONE_ADMIN); // the Admin's group alone: on behalf of the office
      await ready(item.id, PUB);
      await content.sendBack({ itemId: item.id, note: 'The time is wrong.' }, WEBMASTER);
      await save(item.id, 'Noon at the pier, 1 pm.', PUB);
      const hash = await ready(item.id, PUB);
      await content.approve({ itemId: item.id, contentHash: hash }, ADMIN);
      await content.withdraw({ itemId: item.id }, PUB);
      const entries = (await content.listItemHistory({ itemId: item.id }, OFFICER)).entries;
      expect(entries.map((entry) => [entry.action, entry.actorLabel])).toEqual([
        ['create', 'Publications Officer'],
        ['save', 'Admin'],
        ['ready', 'Publications Officer'],
        ['send_back', 'Webmaster'],
        ['save', 'Publications Officer'],
        ['ready', 'Publications Officer'],
        ['approve', 'Admin'],
        ['withdraw', 'Publications Officer'],
      ]);
      // The subject stays for "(you)"; the label never repeats it.
      expect(entries[1]?.actorSubject).toBe('sub-lone-admin');
      expect(entries.every((entry) => !entry.actorLabel.includes('sub-'))).toBe(true);
    });

    it('labels the Admin who holds the seat by the office, when they act for it', async () => {
      const item = await create(ADMIN);
      expect((await content.listItemHistory({ itemId: item.id }, ADMIN)).entries.map((entry) => entry.actorLabel)).toEqual(['Publications Officer']);
    });

    it('labels the step by the groups recorded then, not the actor\'s groups now', async () => {
      const itemId = await draft();
      await api.pool.query(
        `INSERT INTO audit_event (actor_kind, actor_sub, actor_groups, action, subject_kind, subject_id, item_id)
         VALUES ('user', 'sub-pub', '{nwfl-officers}', 'note_seen', 'content_item', $1::text, $1::uuid),
                ('agent', 'svc-nwfl-newsletter', '{}', 'export_read', 'content_item', $1::text, $1::uuid),
                ('system', 'system:issue-loader', '{}', 'file_added', 'content_item', $1::text, $1::uuid)`,
        [itemId],
      );
      const labels = (await content.listItemHistory({ itemId }, PUB)).entries.map((entry) => entry.actorLabel);
      expect(labels).toEqual(['Publications Officer', 'Publications Officer', 'Officer', 'Newsletter agent', 'System']);
    });
  });

  describe('1. PreviewWorkingItem', () => {
    const blocks = (document: { blocks: Array<{ kind: { case?: string } }> } | undefined) => document?.blocks.map((block) => block.kind.case);

    it('gives the public body without members passages and the members body with them, and the problems', async () => {
      const itemId = await draft('# Picnic\n\nAt the park :members[pavilion 3, gate 4417].\n\n::: members\nBring a dish.\n:::\n\nSee :members[the map');
      const preview = await content.previewWorkingItem({ itemId }, PUB);
      expect(preview).toMatchObject({ title: 'Fall picnic', summary: 'Saturday at noon' });
      expect(dump(preview.publicBody)).not.toMatch(/4417|Bring a dish/);
      expect(dump(preview.publicBody)).toContain('At the park');
      expect(dump(preview.membersBody)).toMatch(/4417[\s\S]*Bring a dish/);
      expect(preview.problems).toEqual([expect.objectContaining({ line: 9, message: 'unclosed :members[' })]);
    });

    it('gives a members item\'s public body as the one placeholder, and an officers item no body for either', async () => {
      const members = await content.previewWorkingItem({ itemId: await draft('Members only.', 'members') }, PUB);
      expect(blocks(members.publicBody)).toEqual(['redacted']);
      expect(dump(members.membersBody)).toContain('Members only.');
      const officers = await content.previewWorkingItem({ itemId: await draft('Officers only.', 'officers') }, PUB);
      expect(officers.publicBody).toBeUndefined();
      expect(officers.membersBody).toBeUndefined();
      expect(officers.title).toBe('Fall picnic');
    });

    it('applies each audience\'s lens: a marked phone is withheld from the public body only', async () => {
      const itemId = await draft(`Rides: call ${PHONE} by Friday.`);
      await mark(itemId, PHONE, RedactionCategory.MEMBER_PHONE);
      const preview = await content.previewWorkingItem({ itemId }, PUB);
      expect(dump(preview.publicBody)).not.toContain(PHONE);
      expect(dump(preview.publicBody)).toContain(WITHHELD);
      expect(dump(preview.membersBody)).toContain(PHONE);
    });

    it('caps each audience at the caller\'s own: the lone Admin reads the members body through the public lens', async () => {
      const itemId = await draft(`Rides: call ${PHONE} by Friday.`);
      await mark(itemId, PHONE, RedactionCategory.MEMBER_PHONE);
      const preview = await content.previewWorkingItem({ itemId }, LONE_ADMIN);
      expect(dump(preview)).not.toContain(PHONE);
      expect(dump(preview.membersBody)).toContain(WITHHELD);
    });

    it('gives no body for an audience whose lens hides the item, and is not found when the caller\'s own lens hides it', async () => {
      const itemId = await draft('Write to someone@example.org.');
      await mark(itemId, 'someone@example.org', RedactionCategory.MEMBER_EMAIL);
      await setPublic(RedactionCategory.MEMBER_EMAIL, RedactionAction.HIDE);
      try {
        const preview = await content.previewWorkingItem({ itemId }, PUB);
        expect(preview.publicBody).toBeUndefined();
        expect(dump(preview.membersBody)).toContain('someone@example.org');
        await expect(content.previewWorkingItem({ itemId }, LONE_ADMIN)).rejects.toMatchObject({ code: Code.NotFound });
        await expect(content.getWorkingItem({ itemId }, LONE_ADMIN)).rejects.toMatchObject({ code: Code.NotFound });
      } finally {
        await setPublic(RedactionCategory.MEMBER_EMAIL, RedactionAction.REDACT);
      }
    });

    it('previews the live version when there is no working one, and refuses a bad or unknown id', async () => {
      const itemId = await draft('Live text :members[members text].');
      const hash = await ready(itemId);
      await content.approve({ itemId, contentHash: hash }, WEBMASTER);
      const preview = await content.previewWorkingItem({ itemId }, PUB);
      expect(preview.publicBody).toEqual((await content.getPublishedItem({ slug: itemId })).item?.live?.body);
      expect(preview.membersBody).toEqual((await content.getPublishedItem({ slug: itemId }, MEMBER)).item?.live?.body);
      await expect(content.previewWorkingItem({ itemId: 'not-an-id' }, PUB)).rejects.toMatchObject({ code: Code.InvalidArgument });
      await expect(content.previewWorkingItem({ itemId: '00000000-0000-4000-8000-000000000000' }, PUB)).rejects.toMatchObject({ code: Code.NotFound });
    });

    it('writes nothing: no audit row and no state change', async () => {
      const itemId = await draft();
      const count = async () => (await api.pool.query<{ n: string }>(`SELECT count(*) AS n FROM audit_event WHERE item_id = $1`, [itemId])).rows[0]?.n;
      const before = await count();
      await content.previewWorkingItem({ itemId }, PUB);
      expect(await count()).toBe(before);
      expect((await working(itemId))?.status).toBe(VersionStatus.DRAFT);
    });

    it('previews the working revision of a published item, not its live text', async () => {
      const itemId = await draft('Live wording.');
      await content.approve({ itemId, contentHash: await ready(itemId) }, WEBMASTER);
      await content.saveDraft({ itemId, title: 'Fall picnic, moved', summary: 'Sunday at noon', visibility: ItemVisibility.PUBLIC, bodyMarkup: 'Draft wording.' }, PUB);
      const preview = await content.previewWorkingItem({ itemId }, PUB);
      expect(preview).toMatchObject({ title: 'Fall picnic, moved', summary: 'Sunday at noon' });
      expect(dump(preview.publicBody)).toContain('Draft wording.');
      expect(dump(preview)).not.toContain('Live wording.');
    });

    it('gives the title and summary as the public will get them: through the public lens', async () => {
      await setPublic(RedactionCategory.MEMBER_NAME, RedactionAction.REDACT);
      try {
        const item = await create();
        await content.saveDraft({ itemId: item.id, title: `Picnic with ${NAME}`, summary: `Call ${PHONE}`, visibility: ItemVisibility.PUBLIC, bodyMarkup: 'Plain body.' }, PUB);
        await mark(item.id, NAME, RedactionCategory.MEMBER_NAME, MarkField.TITLE);
        await mark(item.id, PHONE, RedactionCategory.MEMBER_PHONE, MarkField.SUMMARY);
        const preview = await content.previewWorkingItem({ itemId: item.id }, PUB);
        expect(preview).toMatchObject({ title: `Picnic with ${WITHHELD}`, summary: `Call ${WITHHELD}` });
        await content.approve({ itemId: item.id, contentHash: await ready(item.id) }, WEBMASTER);
        const published = (await content.getPublishedItem({ slug: item.id })).item?.live;
        expect([preview.title, preview.summary]).toEqual([published?.title, published?.summary]);
      } finally {
        await setPublic(RedactionCategory.MEMBER_NAME, RedactionAction.SHOW);
      }
    });
  });
});
