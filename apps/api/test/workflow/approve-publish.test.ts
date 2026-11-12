// EDITOR A1: approving and publishing are two steps, over gRPC against a migrated database (0029).
// Any officer (or the Admin or the Webmaster) approves a piece they did not edit, which makes it
// "approved, ready to publish" (CLEARED) and changes nothing the public or members see. The Webmaster,
// or the Admin as backup, then publishes it. Publish re-checks the hash the publisher saw, the
// edition's freeze, the approval rule and a takedown; a self-approved version is published by someone
// else. An edit, a send-back or a withdraw voids an approval waiting to be published. The acting office
// is one the caller holds. Every person here is made up.
import { type Client, Code } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalRule, ApprovalRuleService, ApprovalScope } from '../../src/gen/nwfl/mensa/v1/approval_pb.js';
import { ContentKind, ContentService, type ContentItem, ItemState, ItemVisibility, VersionStatus } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { type Api, as, insertId, startApi } from '../helpers/api.js';
import { live } from '../helpers/pg.js';

const PUB = as('pub-token');
const TREASURER = as('treasurer-token');
const OFFICER = as('officer-token');
const ADMIN = as('admin-token');
const LONE_ADMIN = as('lone-admin-token');
const WEBMASTER = as('webmaster-token');
const AFFILIATE = as('affiliate-token');
const SYSTEM = as('system-token');

describe.skipIf(!live)('EDITOR A1: approve, then publish', () => {
  let api: Api;
  let content: Client<typeof ContentService>;
  let rules: Client<typeof ApprovalRuleService>;
  const offices: Record<string, string> = {};
  let n = 0;

  const setRule = (rule: ApprovalRule): Promise<unknown> => rules.setApprovalRule({ scope: ApprovalScope.CONTENT, rule, reason: 'test' }, ADMIN);

  /** A ready item written by `writer` for `office`, and the hash its reviewer sees. */
  const readyItem = async (
    writer = PUB,
    office = 'publications',
    ready: { editionId?: string; targets?: { website: boolean; newsletter: boolean; email: boolean }; printAsIs?: boolean } = {},
  ): Promise<{ itemId: string; hash: Uint8Array }> => {
    const item = (await content.createItem({ kind: ContentKind.ARTICLE, officeId: offices[office] as string, slug: `ap-${(n += 1)}`, title: 'Fall picnic' }, writer)).item as ContentItem;
    await content.saveDraft({ itemId: item.id, title: 'Fall picnic', summary: 'Saturday', visibility: ItemVisibility.PUBLIC, bodyMarkup: `Bring a chair ${n}.` }, writer);
    const hash = (await content.markReady({ itemId: item.id, ...ready }, writer)).item?.working?.contentHash ?? new Uint8Array();
    return { itemId: item.id, hash };
  };
  /** A ready item approved by the Treasurer: cleared, waiting to be published. */
  const clearedItem = async (writer = PUB, office = 'publications'): Promise<{ itemId: string; hash: Uint8Array }> => {
    const ready = await readyItem(writer, office);
    await content.approve({ itemId: ready.itemId, contentHash: ready.hash }, TREASURER);
    return ready;
  };
  /** A published item: written by the Publications Officer, approved by the Treasurer, published by the Webmaster. */
  const publishedItem = async (): Promise<string> => {
    const { itemId, hash } = await clearedItem();
    await content.publish({ itemId, contentHash: hash }, WEBMASTER);
    return itemId;
  };
  /** A new revision of a published item, ready, and its hash. */
  const revise = async (itemId: string, body: string, writer = PUB): Promise<Uint8Array> => {
    await content.saveDraft({ itemId, title: 'Fall picnic', summary: 'Saturday', visibility: ItemVisibility.PUBLIC, bodyMarkup: body }, writer);
    return (await content.markReady({ itemId }, writer)).item?.working?.contentHash as Uint8Array;
  };
  const working = async (itemId: string, who = PUB) => (await content.getWorkingItem({ itemId }, who)).item as ContentItem;
  type Row = { status: string; approved_by_sub: string | null; approval_kind: string | null; approval_rule: string | null; public_ast: unknown; published_by_sub: string | null };
  const versionRow = async (itemId: string, which: 'working' | 'live' = 'working'): Promise<Row> =>
    (
      await api.pool.query<Row>(
        `SELECT v.status, v.approved_by_sub, v.approval_kind, v.approval_rule, v.public_ast, v.published_by_sub FROM content_item i JOIN content_version v ON v.id = i.${which}_version_id WHERE i.id = $1`,
        [itemId],
      )
    ).rows[0] as Row;
  type Audit = { action: string; acting_office_id: string | null; from_state: string | null; to_state: string | null; payload: Record<string, unknown>; note: string | null };
  const audits = async (itemId: string): Promise<Audit[]> =>
    (await api.pool.query<Audit>(`SELECT action, acting_office_id, from_state, to_state, payload, note FROM audit_event WHERE item_id = $1 ORDER BY id`, [itemId])).rows;
  const lastAudit = async (itemId: string): Promise<Audit> => (await audits(itemId)).at(-1) as Audit;
  const publicRead = async (itemId: string): Promise<boolean> => {
    const slug = (await api.pool.query<{ slug: string }>(`SELECT slug FROM content_item WHERE id = $1`, [itemId])).rows[0]?.slug as string;
    // A withdrawn item answers with its takedown and no version (410 at the edge).
    return content.getPublishedItem({ slug }).then(
      (response) => response.item?.state === ItemState.PUBLISHED && response.item.live !== undefined,
      () => false,
    );
  };
  const ledgerRows = async (itemId: string): Promise<number> =>
    Number(
      (await api.pool.query<{ n: string }>(`SELECT count(*) AS n FROM publication_ledger WHERE subject_kind = 'content_version' AND subject_id IN (SELECT id FROM content_version WHERE item_id = $1)`, [itemId]))
        .rows[0]?.n,
    );

  beforeAll(async () => {
    api = await startApi('nwfl_approve_publish');
    content = api.client(ContentService);
    rules = api.client(ApprovalRuleService);
    for (const [slug, title] of [
      ['publications', 'Publications Officer'],
      ['treasurer', 'Treasurer'],
      ['webmaster', 'Webmaster'],
      ['editor', 'Newsletter Editor'],
    ]) {
      offices[slug as string] = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ($1, $2, 'appointed') RETURNING id`, [slug, title]);
    }
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('Approve: any reviewer who did not edit it; nothing goes live', () => {
    it('makes the version approved, ready to publish, and the item stays as it was: not on the site, not in the ledger', async () => {
      const { itemId, hash } = await readyItem();
      const approved = (await content.approve({ itemId, contentHash: hash }, TREASURER)).item as ContentItem;
      expect(approved.state).toBe(ItemState.READY);
      expect(approved.live).toBeUndefined();
      expect(approved.working).toMatchObject({ status: VersionStatus.CLEARED, approvedAsLabel: 'Treasurer', approvalKindSelf: false, callerMayPublish: false, callerMayApprove: false });
      expect(approved.working?.approvedAt).toBeDefined();
      expect(approved.working?.publishedAt).toBeUndefined();
      expect(await versionRow(itemId)).toMatchObject({ status: 'cleared', approved_by_sub: 'sub-treasurer', approval_kind: 'normal', approval_rule: 'two_person', published_by_sub: null });
      const { public_ast: tree } = await versionRow(itemId);
      expect(Array.isArray((tree as { blocks?: unknown }).blocks)).toBe(true);
      expect(await lastAudit(itemId)).toMatchObject({ action: 'approve', acting_office_id: offices['treasurer'], from_state: 'ready', to_state: 'cleared', payload: { approval_rule: 'two_person' } });
      expect(await publicRead(itemId)).toBe(false);
      expect(await ledgerRows(itemId)).toBe(0);
    });

    it('lets every officer review: an officer who holds no office approves with no acting office, labelled "Officer"', async () => {
      const { itemId, hash } = await readyItem();
      const approved = (await content.approve({ itemId, contentHash: hash }, OFFICER)).item as ContentItem;
      expect(approved.working).toMatchObject({ status: VersionStatus.CLEARED, approvedAsLabel: 'Officer' });
      expect(await lastAudit(itemId)).toMatchObject({ action: 'approve', acting_office_id: null });
    });

    it('refuses an affiliate, and a reviewer who edited the version, writing nothing', async () => {
      const { itemId, hash } = await readyItem();
      await expect(content.approve({ itemId, contentHash: hash }, AFFILIATE)).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(content.approve({ itemId, contentHash: hash }, PUB)).rejects.toMatchObject({ code: Code.PermissionDenied, rawMessage: 'you edited this version; a second officer must approve it' });
      expect(await versionRow(itemId)).toMatchObject({ status: 'ready', approved_by_sub: null });
    });

    it('refuses an approval of a version already approved, and one the reviewer did not see', async () => {
      const { itemId, hash } = await clearedItem();
      await expect(content.approve({ itemId, contentHash: hash }, OFFICER)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      const other = await readyItem();
      await expect(content.approve({ itemId: other.itemId, contentHash: new Uint8Array(32) }, OFFICER)).rejects.toMatchObject({ code: Code.Aborted });
    });
  });

  describe('the acting office: one the caller holds', () => {
    it('defaults to the one office a reviewer holds, and refuses an office they do not hold, writing nothing', async () => {
      const { itemId, hash } = await readyItem();
      await expect(content.approve({ itemId, contentHash: hash, actingAsOfficeId: offices['publications'] as string }, TREASURER)).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(content.approve({ itemId, contentHash: hash, actingAsOfficeId: '00000000-0000-4000-8000-000000000000' }, TREASURER)).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(content.approve({ itemId, contentHash: hash, actingAsOfficeId: 'not-an-id' }, TREASURER)).rejects.toMatchObject({ code: Code.InvalidArgument });
      expect(await versionRow(itemId)).toMatchObject({ status: 'ready' });
      await content.approve({ itemId, contentHash: hash, actingAsOfficeId: offices['treasurer'] as string }, TREASURER);
      expect(await lastAudit(itemId)).toMatchObject({ action: 'approve', acting_office_id: offices['treasurer'] });
    });

    it('records no office for a caller holding two who names none, the one they name, and refuses the Admin an office they do not hold', async () => {
      const first = await readyItem(TREASURER, 'treasurer');
      await expect(content.approve({ itemId: first.itemId, contentHash: first.hash, actingAsOfficeId: offices['treasurer'] as string }, ADMIN)).rejects.toMatchObject({
        code: Code.PermissionDenied,
      });
      const named = (await content.approve({ itemId: first.itemId, contentHash: first.hash, actingAsOfficeId: offices['editor'] as string }, ADMIN)).item as ContentItem;
      expect(named.working?.approvedAsLabel).toBe('Newsletter Editor');
      expect(await lastAudit(first.itemId)).toMatchObject({ action: 'approve', acting_office_id: offices['editor'] });
      const second = await readyItem(TREASURER, 'treasurer');
      const unnamed = (await content.approve({ itemId: second.itemId, contentHash: second.hash }, ADMIN)).item as ContentItem;
      expect(unnamed.working?.approvedAsLabel).toBe('Admin');
      expect(await lastAudit(second.itemId)).toMatchObject({ action: 'approve', acting_office_id: null });
    });

    it('records the acting office on a send-back, checked the same way', async () => {
      const { itemId } = await readyItem();
      await expect(content.sendBack({ itemId, note: 'Check the date.', actingAsOfficeId: offices['editor'] as string }, TREASURER)).rejects.toMatchObject({ code: Code.PermissionDenied });
      await content.sendBack({ itemId, note: 'Check the date.' }, TREASURER);
      expect(await lastAudit(itemId)).toMatchObject({ action: 'send_back', acting_office_id: offices['treasurer'], from_state: 'ready', to_state: 'draft', note: 'Check the date.' });
    });
  });

  describe('Publish: the Webmaster, or the Admin as backup', () => {
    it('makes the approved version live, records the publisher, audits it and records the ledger', async () => {
      const { itemId, hash } = await clearedItem();
      const published = (await content.publish({ itemId, contentHash: hash }, WEBMASTER)).item as ContentItem;
      expect(published.state).toBe(ItemState.PUBLISHED);
      expect(published.working).toBeUndefined();
      expect(published.live).toMatchObject({ status: VersionStatus.APPROVED, approvedAsLabel: 'Treasurer', callerMayPublish: false });
      expect(published.live?.publishedAt).toBeDefined();
      expect(await versionRow(itemId, 'live')).toMatchObject({ status: 'approved', approved_by_sub: 'sub-treasurer', published_by_sub: 'sub-webmaster' });
      expect(await lastAudit(itemId)).toMatchObject({ action: 'publish', acting_office_id: null, from_state: 'cleared', to_state: 'approved', payload: { backup: false } });
      expect(await publicRead(itemId)).toBe(true);
      expect(await ledgerRows(itemId)).toBeGreaterThan(0);
    });

    it('lets the Admin publish as backup, saying so', async () => {
      const { itemId, hash } = await clearedItem();
      await content.publish({ itemId, contentHash: hash }, LONE_ADMIN);
      expect(await lastAudit(itemId)).toMatchObject({ action: 'publish', payload: { backup: true } });
    });

    it('supersedes the version it replaces', async () => {
      const itemId = await publishedItem();
      const before = (await working(itemId)).live?.id as string;
      const hash = await revise(itemId, 'Bring two chairs.');
      await content.approve({ itemId, contentHash: hash }, OFFICER);
      expect((await working(itemId)).state).toBe(ItemState.PUBLISHED);
      await content.publish({ itemId, contentHash: hash }, WEBMASTER);
      const after = await working(itemId);
      expect(after.live?.id).not.toBe(before);
      expect((await api.pool.query(`SELECT status FROM content_version WHERE id = $1`, [before])).rows[0]).toEqual({ status: 'superseded' });
    });

    it('refuses every officer who is not a publisher, writing nothing', async () => {
      const { itemId, hash } = await clearedItem();
      for (const who of [PUB, TREASURER, OFFICER, AFFILIATE]) {
        await expect(content.publish({ itemId, contentHash: hash }, who)).rejects.toMatchObject({ code: Code.PermissionDenied });
      }
      await expect(content.publish({ itemId, contentHash: hash })).rejects.toMatchObject({ code: Code.Unauthenticated });
      expect(await versionRow(itemId)).toMatchObject({ status: 'cleared' });
    });

    it('refuses a hash the publisher did not see, a version not yet approved, and a second publish', async () => {
      const { itemId, hash } = await clearedItem();
      await expect(content.publish({ itemId, contentHash: new Uint8Array(32) }, WEBMASTER)).rejects.toMatchObject({ code: Code.Aborted });
      await expect(content.publish({ itemId, contentHash: new Uint8Array() }, WEBMASTER)).rejects.toMatchObject({ code: Code.Aborted });
      const ready = await readyItem();
      await expect(content.publish({ itemId: ready.itemId, contentHash: ready.hash }, WEBMASTER)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      await content.publish({ itemId, contentHash: hash }, WEBMASTER);
      await expect(content.publish({ itemId, contentHash: hash }, WEBMASTER)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      await expect(content.publish({ itemId, contentHash: hash }, LONE_ADMIN)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      expect((await audits(itemId)).filter((row) => row.action === 'publish')).toHaveLength(1);
      await expect(content.publish({ itemId: 'not-an-id', contentHash: hash }, WEBMASTER)).rejects.toMatchObject({ code: Code.InvalidArgument });
      await expect(content.publish({ itemId: '00000000-0000-4000-8000-000000000000', contentHash: hash }, WEBMASTER)).rejects.toMatchObject({ code: Code.NotFound });
    });

    it('refuses a newsletter piece whose edition was frozen after it was approved', async () => {
      const editionId = await insertId(
        api.pool,
        `INSERT INTO edition (slug, title, kind, period_start, period_end) VALUES ('2027-06', 'June-July 2027', 'regular', '2027-06-01', '2027-07-31') RETURNING id`,
      );
      const { itemId, hash } = await readyItem(PUB, 'publications', { editionId, targets: { website: true, newsletter: true, email: false } });
      await content.approve({ itemId, contentHash: hash }, TREASURER);
      await api.pool.query(`UPDATE edition SET status = 'proof', frozen_at = now() WHERE id = $1`, [editionId]);
      await expect(content.publish({ itemId, contentHash: hash }, WEBMASTER)).rejects.toMatchObject({
        code: Code.FailedPrecondition,
        rawMessage: 'June-July 2027 is already frozen for print: send it back to pick an open edition',
      });
      expect(await versionRow(itemId)).toMatchObject({ status: 'cleared' });
    });

    it('refuses to put a taken-down item back on the site unless the publisher says so', async () => {
      const itemId = await publishedItem();
      await content.withdraw({ itemId }, PUB);
      await content.restore({ itemId }, PUB);
      const hash = await revise(itemId, 'Back on, corrected.');
      await content.approve({ itemId, contentHash: hash }, OFFICER);
      expect((await working(itemId)).state).toBe(ItemState.WITHDRAWN);
      await expect(content.publish({ itemId, contentHash: hash }, WEBMASTER)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      expect(await publicRead(itemId)).toBe(false);
      const back = (await content.publish({ itemId, contentHash: hash, republishWithdrawn: true }, WEBMASTER)).item as ContentItem;
      expect(back.state).toBe(ItemState.PUBLISHED);
      expect(await lastAudit(itemId)).toMatchObject({ action: 'publish', from_state: 'cleared', payload: { backup: false, republished_withdrawn: true } });
      expect(await publicRead(itemId)).toBe(true);
    });
  });

  describe('the two-person rule across both steps', () => {
    it("refuses the Admin publishing their own break-glass approval; the Webmaster publishes it", async () => {
      const { itemId, hash } = await readyItem(ADMIN, 'publications');
      const approved = (await content.approve({ itemId, contentHash: hash, breakGlass: true, breakGlassReason: 'Everyone else is away' }, ADMIN)).item as ContentItem;
      expect(approved.working).toMatchObject({ status: VersionStatus.CLEARED, approvalKindSelf: true, callerMayPublish: false });
      expect(await lastAudit(itemId)).toMatchObject({ action: 'approve_self', to_state: 'cleared', note: 'Everyone else is away' });
      await expect(content.publish({ itemId, contentHash: hash }, ADMIN)).rejects.toMatchObject({ code: Code.PermissionDenied, rawMessage: 'you approved your own change; someone else must publish it' });
      expect((await working(itemId, WEBMASTER)).working?.callerMayPublish).toBe(true);
      await content.publish({ itemId, contentHash: hash }, WEBMASTER);
      expect(await versionRow(itemId, 'live')).toMatchObject({ approved_by_sub: 'sub-admin', published_by_sub: 'sub-webmaster', approval_kind: 'self_breakglass' });
    });

    it('keeps break-glass for the Admin alone', async () => {
      const { itemId, hash } = await readyItem(WEBMASTER, 'webmaster');
      await expect(content.approve({ itemId, contentHash: hash, breakGlass: true, breakGlassReason: 'Away' }, WEBMASTER)).rejects.toMatchObject({ code: Code.PermissionDenied });
    });

    it('under one approver, lets only a publisher approve their own edit, and someone else publishes it', async () => {
      await setRule(ApprovalRule.ONE_APPROVER);
      try {
        const officer = await readyItem(PUB);
        expect((await working(officer.itemId)).working?.callerMayApprove).toBe(false);
        await expect(content.approve({ itemId: officer.itemId, contentHash: officer.hash }, PUB)).rejects.toMatchObject({
          code: Code.PermissionDenied,
          rawMessage: 'you edited this version; a second officer must approve it',
        });
        const own = await readyItem(WEBMASTER, 'webmaster');
        expect((await working(own.itemId, WEBMASTER)).working?.callerMayApprove).toBe(true);
        await content.approve({ itemId: own.itemId, contentHash: own.hash }, WEBMASTER);
        expect(await versionRow(own.itemId)).toMatchObject({ status: 'cleared', approval_kind: 'self_single', approval_rule: 'one_approver' });
        await expect(content.publish({ itemId: own.itemId, contentHash: own.hash }, WEBMASTER)).rejects.toMatchObject({ code: Code.PermissionDenied });
        await content.publish({ itemId: own.itemId, contentHash: own.hash }, ADMIN);
        expect(await versionRow(own.itemId, 'live')).toMatchObject({ approved_by_sub: 'sub-webmaster', published_by_sub: 'sub-admin' });
      } finally {
        await setRule(ApprovalRule.TWO_PERSON);
      }
    });

    it('refuses to publish a single-approver approval once the rule is back to two-person: send it back', async () => {
      await setRule(ApprovalRule.ONE_APPROVER);
      let item: { itemId: string; hash: Uint8Array };
      try {
        item = await readyItem(WEBMASTER, 'webmaster');
        await content.approve({ itemId: item.itemId, contentHash: item.hash }, WEBMASTER);
      } finally {
        await setRule(ApprovalRule.TWO_PERSON);
      }
      expect((await working(item.itemId, ADMIN)).working?.callerMayPublish).toBe(false);
      await expect(content.publish({ itemId: item.itemId, contentHash: item.hash }, ADMIN)).rejects.toMatchObject({
        code: Code.FailedPrecondition,
        rawMessage: 'the approval rule changed; send it back',
      });
      await content.sendBack({ itemId: item.itemId, note: 'Needs a second officer now.' }, ADMIN);
      expect(await versionRow(item.itemId)).toMatchObject({ status: 'draft', approval_kind: null });
    });

    it('lets a publisher publish a piece they wrote, or approved, when someone else approved it or it was a normal approval', async () => {
      const written = await readyItem(WEBMASTER, 'webmaster');
      await content.approve({ itemId: written.itemId, contentHash: written.hash }, TREASURER);
      await content.publish({ itemId: written.itemId, contentHash: written.hash }, WEBMASTER);
      const approvedByMe = await readyItem();
      await content.approve({ itemId: approvedByMe.itemId, contentHash: approvedByMe.hash }, WEBMASTER);
      await content.publish({ itemId: approvedByMe.itemId, contentHash: approvedByMe.hash }, WEBMASTER);
      expect(await versionRow(approvedByMe.itemId, 'live')).toMatchObject({ approved_by_sub: 'sub-webmaster', published_by_sub: 'sub-webmaster', approval_kind: 'normal' });
    });

    it('refuses a token naming the issue loader, at every step', async () => {
      const { itemId, hash } = await readyItem();
      await expect(content.approve({ itemId, contentHash: hash }, SYSTEM)).rejects.toMatchObject({ code: Code.Unauthenticated });
      await content.approve({ itemId, contentHash: hash }, TREASURER);
      await expect(content.publish({ itemId, contentHash: hash }, SYSTEM)).rejects.toMatchObject({ code: Code.Unauthenticated });
      await expect(content.listWorkingItems({}, SYSTEM)).rejects.toMatchObject({ code: Code.Unauthenticated });
    });
  });

  describe('an approval waiting to be published is voided by an edit, a send-back or a withdraw', () => {
    it('voids it on an edit: back to draft, the approval gone, audited with the item office', async () => {
      const { itemId } = await clearedItem();
      await content.saveDraft({ itemId, title: 'Fall picnic', summary: 'Saturday', visibility: ItemVisibility.PUBLIC, bodyMarkup: 'Bring a blanket.' }, PUB);
      expect(await versionRow(itemId)).toMatchObject({ status: 'draft', approved_by_sub: null, approval_kind: null, approval_rule: null, public_ast: null });
      const rows = await audits(itemId);
      expect(rows.at(-2)).toMatchObject({ action: 'approval_voided', acting_office_id: offices['publications'], from_state: 'cleared', to_state: 'draft', payload: { cause: 'edit' } });
      expect(rows.at(-1)).toMatchObject({ action: 'save', from_state: 'cleared', to_state: 'draft' });
      expect((await working(itemId)).state).toBe(ItemState.DRAFT);
      // It needs approving again, by a reviewer who did not edit it.
      const hash = (await content.markReady({ itemId }, PUB)).item?.working?.contentHash as Uint8Array;
      await content.approve({ itemId, contentHash: hash }, OFFICER);
      expect(await versionRow(itemId)).toMatchObject({ status: 'cleared', approved_by_sub: 'sub-officer' });
    });

    it('never lets a print-as-is version be edited, approved or not', async () => {
      const { itemId, hash } = await readyItem(PUB, 'publications', { printAsIs: true });
      await content.approve({ itemId, contentHash: hash }, TREASURER);
      await expect(content.saveDraft({ itemId, title: 'Fall picnic', summary: '', visibility: ItemVisibility.PUBLIC, bodyMarkup: 'x' }, PUB)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      expect(await versionRow(itemId)).toMatchObject({ status: 'cleared' });
    });

    it('lets any reviewer send it back, with the approval gone', async () => {
      const { itemId } = await clearedItem();
      await content.sendBack({ itemId, note: 'One more look.' }, OFFICER);
      expect(await versionRow(itemId)).toMatchObject({ status: 'draft', approved_by_sub: null, approval_rule: null });
      expect(await lastAudit(itemId)).toMatchObject({ action: 'send_back', from_state: 'cleared', to_state: 'draft' });
      expect((await working(itemId)).working?.sendBackNote).toBe('One more look.');
      await expect(content.sendBack({ itemId, note: 'Again.' }, OFFICER)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    });

    it('voids it on a withdraw of the item, so Publish cannot quietly undo the takedown', async () => {
      const itemId = await publishedItem();
      const hash = await revise(itemId, 'A correction.');
      await content.approve({ itemId, contentHash: hash }, OFFICER);
      await content.withdraw({ itemId }, WEBMASTER);
      expect(await versionRow(itemId)).toMatchObject({ status: 'draft', approved_by_sub: null });
      const rows = await audits(itemId);
      expect(rows.at(-2)).toMatchObject({ action: 'withdraw' });
      // The Webmaster holds the Webmaster's office, not the item's, so no office is recorded.
      expect(rows.at(-1)).toMatchObject({ action: 'approval_voided', acting_office_id: null, from_state: 'cleared', to_state: 'draft', payload: { cause: 'withdraw' } });
      await expect(content.publish({ itemId, contentHash: hash, republishWithdrawn: true }, WEBMASTER)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      expect(await publicRead(itemId)).toBe(false);
    });

    it("records the item's office on a withdraw by its own office", async () => {
      const itemId = await publishedItem();
      const hash = await revise(itemId, 'Another correction.');
      await content.approve({ itemId, contentHash: hash }, OFFICER);
      await content.withdraw({ itemId }, PUB);
      expect(await lastAudit(itemId)).toMatchObject({ action: 'approval_voided', acting_office_id: offices['publications'], payload: { cause: 'withdraw' } });
    });

    it('leaves a ready revision alone on a withdraw, as before', async () => {
      const itemId = await publishedItem();
      await revise(itemId, 'Waiting.');
      await content.withdraw({ itemId }, PUB);
      expect(await versionRow(itemId)).toMatchObject({ status: 'ready' });
      expect((await audits(itemId)).map((row) => row.action)).not.toContain('approval_voided');
    });
  });

  describe('the queue and what officers read', () => {
    it('lists draft, ready and approved-not-published pieces by default, and filters on the working version status', async () => {
      const draft = (await content.createItem({ kind: ContentKind.ARTICLE, officeId: offices['editor'] as string, slug: `ap-${(n += 1)}`, title: 'Draft' }, ADMIN)).item?.id as string;
      const ready = (await readyItem(ADMIN, 'editor')).itemId;
      const cleared = (await clearedItem(ADMIN, 'editor')).itemId;
      const filter = { officeId: offices['editor'] as string };
      const ids = async (request: Record<string, unknown>): Promise<string[]> => (await content.listWorkingItems({ ...filter, ...request }, OFFICER)).items.map((item) => item.id).sort();
      expect(await ids({})).toEqual([draft, ready, cleared].sort());
      expect(await ids({ versionStatuses: [VersionStatus.CLEARED] })).toEqual([cleared]);
      expect(await ids({ versionStatuses: [VersionStatus.DRAFT, VersionStatus.READY] })).toEqual([draft, ready].sort());
      // A status no working version has matches nothing, as the item-state filter does; the item-state filter is
      // not read when the version filter is set.
      expect(await ids({ versionStatuses: [VersionStatus.APPROVED] })).toEqual([]);
      expect(await ids({ versionStatuses: [VersionStatus.CLEARED], states: [ItemState.DRAFT] })).toEqual([cleared]);
      // The old item-state filter, as before.
      expect(await ids({ states: [ItemState.READY] })).toEqual([ready]);
    });

    it('tells each caller whether they may approve or publish it', async () => {
      const { itemId, hash } = await readyItem();
      expect((await working(itemId, PUB)).working).toMatchObject({ callerMayApprove: false, callerMayPublish: false, approvedAsLabel: '', approvalKindSelf: false });
      expect((await working(itemId, TREASURER)).working).toMatchObject({ callerMayApprove: true, callerMayPublish: false });
      expect((await working(itemId, WEBMASTER)).working).toMatchObject({ callerMayApprove: true, callerMayPublish: false });
      await content.approve({ itemId, contentHash: hash }, TREASURER);
      expect((await working(itemId, TREASURER)).working).toMatchObject({ callerMayApprove: false, callerMayPublish: false });
      expect((await working(itemId, WEBMASTER)).working).toMatchObject({ callerMayApprove: false, callerMayPublish: true });
      expect((await working(itemId, LONE_ADMIN)).working).toMatchObject({ callerMayPublish: true });
    });
  });
});
