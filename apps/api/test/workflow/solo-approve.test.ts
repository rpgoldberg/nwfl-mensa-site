// SOLO-APPROVE, content: the publishing workflow under each approval rule, over gRPC against a
// migrated database. Under two-person (the default) nothing changes: an approver who edited the
// version is refused, and only the Admin breaks glass. Under one-approver the Admin or the Webmaster
// may approve their own edit, recorded as a single-approver approval; who may approve at all does not
// widen. Every approval records the rule it was made under, and the rule is read again when the
// approval lands, so a flip in between decides it. Every person here is made up.
import pg from 'pg';
import { type Client, Code } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalRule, ApprovalRuleService, ApprovalScope } from '../../src/gen/nwfl/mensa/v1/approval_pb.js';
import { ContentKind, ContentService, type ContentItem, ItemState, ItemVisibility, VersionStatus } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { RedactionPolicyService } from '../../src/gen/nwfl/mensa/v1/redaction_pb.js';
import { LOADER, applyBundle, parseBundle } from '../../src/load/load.js';
import { type Api, as, insertId, startApi } from '../helpers/api.js';
import { APP, APP_PW, live, urlFor } from '../helpers/pg.js';
import { bundleJson } from '../load/bundle.js';

const ADMIN = as('admin-token');
const WEBMASTER = as('webmaster-token');
const PUB = as('pub-token');
const TREASURER = as('treasurer-token');
const OFFICER = as('officer-token');
const ADMIN_GROUPS = ['nwfl-members', 'nwfl-officers', 'nwfl-admin'];

describe.skipIf(!live)('content approval under the approval rule', () => {
  let api: Api;
  let content: Client<typeof ContentService>;
  let rules: Client<typeof ApprovalRuleService>;
  const offices: Record<string, string> = {};
  let n = 0;

  const setContent = (rule: ApprovalRule): Promise<unknown> => rules.setApprovalRule({ scope: ApprovalScope.CONTENT, rule, reason: 'test' }, ADMIN);
  const off = (): Promise<unknown> => setContent(ApprovalRule.ONE_APPROVER);
  const on = (): Promise<unknown> => setContent(ApprovalRule.TWO_PERSON);

  /** A ready item written by `writer` in `office`, and the hash its approver sees. */
  const readyItem = async (writer = PUB, office = 'publications'): Promise<{ item: ContentItem; hash: Uint8Array }> => {
    const item = (await content.createItem({ kind: ContentKind.ARTICLE, officeId: offices[office] as string, slug: `solo-${(n += 1)}`, title: 'Fall picnic' }, writer)).item as ContentItem;
    await content.saveDraft({ itemId: item.id, title: 'Fall picnic', summary: 'Saturday', visibility: ItemVisibility.PUBLIC, bodyMarkup: 'Bring a chair.' }, writer);
    const hash = (await content.markReady({ itemId: item.id }, writer)).item?.working?.contentHash ?? new Uint8Array();
    return { item, hash };
  };
  type Recorded = { approval_kind: string; approval_rule: string; approved_by_sub: string; approval_reason: string | null };
  const recorded = async (itemId: string): Promise<Recorded> =>
    (
      await api.pool.query<Recorded>(
        `SELECT v.approval_kind, v.approval_rule, v.approved_by_sub, v.approval_reason FROM content_item i JOIN content_version v ON v.id = i.live_version_id WHERE i.id = $1`,
        [itemId],
      )
    ).rows[0]!;
  type Audit = { action: string; payload: Record<string, unknown>; note: string | null };
  const lastAudit = async (itemId: string): Promise<Audit> =>
    (await api.pool.query<Audit>(`SELECT action, payload, note FROM audit_event WHERE item_id = $1 ORDER BY id DESC LIMIT 1`, [itemId])).rows[0]!;
  const workingStatus = async (itemId: string): Promise<VersionStatus | undefined> => (await content.getWorkingItem({ itemId }, PUB)).item?.working?.status;

  beforeAll(async () => {
    api = await startApi('nwfl_solo_flow');
    content = api.client(ContentService);
    rules = api.client(ApprovalRuleService);
    for (const slug of ['publications', 'webmaster', 'treasurer', 'editor']) {
      offices[slug] = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ($1, $1, 'appointed') RETURNING id`, [slug]);
    }
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('two-person, the default: as before', () => {
    it('refuses an approver who edited the version, saying a second officer must approve it', async () => {
      const { item, hash } = await readyItem(WEBMASTER, 'webmaster');
      await expect(content.approve({ itemId: item.id, contentHash: hash }, WEBMASTER)).rejects.toMatchObject({
        code: Code.PermissionDenied,
        rawMessage: 'you edited this version; a second officer must approve it',
      });
      expect(await workingStatus(item.id)).toBe(VersionStatus.READY);
      await content.approve({ itemId: item.id, contentHash: hash }, ADMIN);
      expect(await recorded(item.id)).toMatchObject({ approval_kind: 'normal', approval_rule: 'two_person', approved_by_sub: 'sub-admin' });
      expect(await lastAudit(item.id)).toMatchObject({ action: 'approve', payload: { approval_rule: 'two_person' } });
    });

    it('keeps the Admin\'s break-glass, and refuses the Webmaster\'s', async () => {
      const own = await readyItem(WEBMASTER, 'webmaster');
      await expect(content.approve({ itemId: own.item.id, contentHash: own.hash, breakGlass: true, breakGlassReason: 'in a hurry' }, WEBMASTER)).rejects.toMatchObject({
        code: Code.PermissionDenied,
      });
      const { item, hash } = await readyItem(ADMIN);
      await content.approve({ itemId: item.id, contentHash: hash, breakGlass: true, breakGlassReason: 'Webmaster away' }, ADMIN);
      expect(await recorded(item.id)).toEqual({ approval_kind: 'self_breakglass', approval_rule: 'two_person', approved_by_sub: 'sub-admin', approval_reason: 'Webmaster away' });
      expect(await lastAudit(item.id)).toMatchObject({ action: 'approve_self', payload: { approval_rule: 'two_person' }, note: 'Webmaster away' });
    });
  });

  describe('one-approver', () => {
    beforeAll(off);
    afterAll(on);

    it('lets the Webmaster approve their own edit, recorded as a single-approver approval', async () => {
      const { item, hash } = await readyItem(WEBMASTER, 'webmaster');
      expect((await content.approve({ itemId: item.id, contentHash: hash }, WEBMASTER)).item?.state).toBe(ItemState.PUBLISHED);
      expect(await recorded(item.id)).toEqual({ approval_kind: 'self_single', approval_rule: 'one_approver', approved_by_sub: 'sub-webmaster', approval_reason: null });
      expect(await lastAudit(item.id)).toMatchObject({ action: 'approve_single', payload: { approval_rule: 'one_approver' } });
      const history = (await content.listItemHistory({ itemId: item.id }, OFFICER)).entries;
      expect(history.map((e) => e.action)).toEqual(['create', 'save', 'ready', 'approve_single']);
    });

    it('still refuses the Webmaster\'s break-glass, which stays the Admin\'s alone', async () => {
      const { item, hash } = await readyItem(WEBMASTER, 'webmaster');
      await expect(content.approve({ itemId: item.id, contentHash: hash, breakGlass: true, breakGlassReason: 'in a hurry' }, WEBMASTER)).rejects.toMatchObject({
        code: Code.PermissionDenied,
      });
      expect(await workingStatus(item.id)).toBe(VersionStatus.READY);
    });

    it('lets the Admin approve their own edit without break-glass, and records a break-glass with its reason when sent', async () => {
      const plain = await readyItem(ADMIN);
      await content.approve({ itemId: plain.item.id, contentHash: plain.hash }, ADMIN);
      expect(await recorded(plain.item.id)).toMatchObject({ approval_kind: 'self_single', approval_rule: 'one_approver' });

      const glass = await readyItem(ADMIN);
      await expect(content.approve({ itemId: glass.item.id, contentHash: glass.hash, breakGlass: true, breakGlassReason: '  ' }, ADMIN)).rejects.toMatchObject({
        code: Code.InvalidArgument,
      });
      await content.approve({ itemId: glass.item.id, contentHash: glass.hash, breakGlass: true, breakGlassReason: 'Logged anyway' }, ADMIN);
      expect(await recorded(glass.item.id)).toEqual({ approval_kind: 'self_breakglass', approval_rule: 'one_approver', approved_by_sub: 'sub-admin', approval_reason: 'Logged anyway' });
      expect(await lastAudit(glass.item.id)).toMatchObject({ action: 'approve_self', payload: { approval_rule: 'one_approver' } });
    });

    it('marks a second officer\'s approval made while one-approver holds with the rule too', async () => {
      const { item, hash } = await readyItem(PUB);
      await content.approve({ itemId: item.id, contentHash: hash }, WEBMASTER);
      expect(await recorded(item.id)).toMatchObject({ approval_kind: 'normal', approval_rule: 'one_approver' });
      expect(await lastAudit(item.id)).toMatchObject({ action: 'approve', payload: { approval_rule: 'one_approver' } });
    });

    it('does not let any other officer approve', async () => {
      const { item, hash } = await readyItem(PUB);
      for (const who of [TREASURER, PUB, OFFICER]) await expect(content.approve({ itemId: item.id, contentHash: hash }, who)).rejects.toMatchObject({ code: Code.PermissionDenied });
      expect(await workingStatus(item.id)).toBe(VersionStatus.READY);
    });

    it('refuses an approval sent again once the version is approved, as before', async () => {
      const { item, hash } = await readyItem(WEBMASTER, 'webmaster');
      await content.approve({ itemId: item.id, contentHash: hash }, WEBMASTER);
      await expect(content.approve({ itemId: item.id, contentHash: hash }, WEBMASTER)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    });

    it('leaves the publication ledger intact after single-approver approvals', async () => {
      const verified = await api.client(RedactionPolicyService).verifyLedger({}, OFFICER);
      expect(verified.intact).toBe(true);
      expect(verified.rows).toBeGreaterThan(0n);
    });

    it('lets the issue loader approve as before, recording the rule in force', async () => {
      const loaded = await applyBundle(api.pool, parseBundle(await bundleJson({ period: '2026-08', volume: 30, number: 4 })));
      expect(await recorded(loaded.itemId)).toMatchObject({ approval_kind: 'self_breakglass', approval_rule: 'one_approver', approved_by_sub: LOADER });
    });
  });

  describe('a flip between opening and approving', () => {
    it('accepts an editor\'s approval of a version made ready under two-person once one-approver is set', async () => {
      const { item, hash } = await readyItem(WEBMASTER, 'webmaster');
      await off();
      await content.approve({ itemId: item.id, contentHash: hash }, WEBMASTER);
      expect(await recorded(item.id)).toMatchObject({ approval_kind: 'self_single', approval_rule: 'one_approver' });
      await on();
    });

    it('refuses an editor\'s approval opened under one-approver and sent after two-person is back, leaving it ready', async () => {
      await off();
      const { item, hash } = await readyItem(WEBMASTER, 'webmaster');
      await on();
      await expect(content.approve({ itemId: item.id, contentHash: hash }, WEBMASTER)).rejects.toMatchObject({
        code: Code.PermissionDenied,
        rawMessage: 'you edited this version; a second officer must approve it',
      });
      expect(await workingStatus(item.id)).toBe(VersionStatus.READY);
    });

    it('makes an approval wait for a flip in progress, and judges it by the flip', async () => {
      await off();
      const { item, hash } = await readyItem(WEBMASTER, 'webmaster');
      const database = (await api.pool.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db;
      const flipper = new pg.Client({ connectionString: urlFor(APP, APP_PW, database) });
      await flipper.connect();
      try {
        await flipper.query('BEGIN');
        await flipper.query(`SELECT * FROM approval_rule_set('content', 'two_person', 'back on', 'sub-admin', $1, NULL)`, [ADMIN_GROUPS]);
        let settled = false;
        const approving = content.approve({ itemId: item.id, contentHash: hash }, WEBMASTER).finally(() => (settled = true));
        approving.catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(settled).toBe(false);
        await flipper.query('COMMIT');
        await expect(approving).rejects.toMatchObject({ code: Code.PermissionDenied });
      } finally {
        await flipper.end();
      }
      expect(await workingStatus(item.id)).toBe(VersionStatus.READY);
      expect((await rules.getApprovalRules({}, OFFICER)).settings.find((s) => s.scope === ApprovalScope.CONTENT)?.rule).toBe(ApprovalRule.TWO_PERSON);
    });
  });
});
