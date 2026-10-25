// REDACT R1: RedactionPolicyService and the 0012 policy tables. Officers read
// the policy and propose changes. A change that loosens the public audience
// waits for a second, different officer; a tightening, or a change for members
// or officers, applies at once. Every change and approval is audit-logged, and
// a missing cell reads as HIDE. Every person here is made up.
import { type Client, Code } from '@connectrpc/connect';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RedactionAction as Action,
  RedactionAudience as Audience,
  RedactionCategory as Category,
  RedactionChangeStatus as Status,
  RedactionPolicyService,
} from '../../src/gen/nwfl/mensa/v1/redaction_pb.js';
import { type Api, MEMBER, OFFICER, as, startApi } from '../helpers/api.js';
import { live, sqlstate, url } from '../helpers/pg.js';

const SECOND = as('pub-token');
const ADMIN = as('admin-token');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe.skipIf(!live)('RedactionPolicyService', () => {
  let api: Api;
  let policy: Client<typeof RedactionPolicyService>;

  const cell = async (audience: string, category: string) =>
    (
      await api.pool.query<{ tenant_id: string; action: string; updated_by_sub: string | null }>(
        `SELECT tenant_id, action, updated_by_sub FROM redaction_policy WHERE audience = $1 AND category = $2`,
        [audience, category],
      )
    ).rows[0];
  const audits = async (subjectId: string) =>
    (
      await api.pool.query<{ action: string; subject_kind: string; actor_sub: string; from_state: string | null; to_state: string | null; payload: unknown }>(
        `SELECT action, subject_kind, actor_sub, from_state, to_state, payload FROM audit_event WHERE subject_id = $1 ORDER BY id`,
        [subjectId],
      )
    ).rows;
  const action = async (audience: Audience, category: Category): Promise<Action | undefined> =>
    (await policy.getRedactionPolicy({}, OFFICER)).cells.find((c) => c.audience === audience && c.category === category)?.action;
  /** The same database as the superuser, for what the app role may not do. */
  const asOwner = async <T>(fn: (client: pg.Client) => Promise<T>): Promise<T> => {
    const target = new URL(url as string);
    target.pathname = new URL((api.pool as unknown as { options: { connectionString: string } }).options.connectionString).pathname;
    const client = new pg.Client({ connectionString: target.toString() });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  };

  beforeAll(async () => {
    api = await startApi('nwfl_redaction');
    policy = api.client(RedactionPolicyService);
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('the defaults', () => {
    it('seeds every cell for this group: public redacts member contacts and home venues, and shows business venues', async () => {
      const { cells, pending } = await policy.getRedactionPolicy({}, OFFICER);
      expect(pending).toEqual([]);
      expect(cells).toHaveLength(24);
      const grid = Object.fromEntries(cells.map((c) => [`${Audience[c.audience]}/${Category[c.category]}`, Action[c.action]]));
      expect(grid).toEqual({
        'PUBLIC/MEMBER_NAME': 'REDACT',
        'PUBLIC/MEMBER_ADDRESS': 'REDACT',
        'PUBLIC/MEMBER_PHONE': 'REDACT',
        'PUBLIC/MEMBER_EMAIL': 'REDACT',
        'PUBLIC/PRIVATE_VENUE': 'REDACT',
        'PUBLIC/BUSINESS_VENUE': 'SHOW',
        'PUBLIC/OFFICER_CONTACT': 'REDACT',
        'PUBLIC/IMAGE': 'BLUR',
        'MEMBERS/MEMBER_NAME': 'SHOW',
        'MEMBERS/MEMBER_ADDRESS': 'REDACT',
        'MEMBERS/MEMBER_PHONE': 'SHOW',
        'MEMBERS/MEMBER_EMAIL': 'SHOW',
        'MEMBERS/PRIVATE_VENUE': 'SHOW',
        'MEMBERS/BUSINESS_VENUE': 'SHOW',
        'MEMBERS/OFFICER_CONTACT': 'SHOW',
        'MEMBERS/IMAGE': 'SHOW',
        'OFFICERS/MEMBER_NAME': 'SHOW',
        'OFFICERS/MEMBER_ADDRESS': 'SHOW',
        'OFFICERS/MEMBER_PHONE': 'SHOW',
        'OFFICERS/MEMBER_EMAIL': 'SHOW',
        'OFFICERS/PRIVATE_VENUE': 'SHOW',
        'OFFICERS/BUSINESS_VENUE': 'SHOW',
        'OFFICERS/OFFICER_CONTACT': 'SHOW',
        'OFFICERS/IMAGE': 'SHOW',
      });
      expect(await cell('public', 'member_phone')).toMatchObject({ tenant_id: 'nwflorida', updated_by_sub: null });
    });
  });

  describe('who may call', () => {
    const calls: Array<[string, (options: { headers?: Record<string, string> }) => Promise<unknown>]> = [
      ['GetRedactionPolicy', (o) => policy.getRedactionPolicy({}, o)],
      ['ProposeRedactionChange', (o) => policy.proposeRedactionChange({ audience: Audience.PUBLIC, category: Category.MEMBER_PHONE, action: Action.HIDE }, o)],
      ['ApproveRedactionChange', (o) => policy.approveRedactionChange({ changeId: '00000000-0000-4000-8000-000000000000' }, o)],
    ];

    it.each(calls)('refuses %s to the public, a member and a machine client', async (_name, call) => {
      await expect(call({})).rejects.toMatchObject({ code: Code.Unauthenticated });
      await expect(call(MEMBER)).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(call(as('affiliate-token'))).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(call(as('agent-token'))).rejects.toMatchObject({ code: Code.PermissionDenied });
    });

    it('leaves the policy unchanged after the refusals', async () => {
      expect((await cell('public', 'member_phone'))?.action).toBe('redact');
    });
  });

  describe('tightening', () => {
    it('applies at once, records the change and audits it', async () => {
      const { change } = await policy.proposeRedactionChange({ audience: Audience.PUBLIC, category: Category.BUSINESS_VENUE, action: Action.REDACT }, OFFICER);
      expect(change).toMatchObject({
        audience: Audience.PUBLIC,
        category: Category.BUSINESS_VENUE,
        fromAction: Action.SHOW,
        toAction: Action.REDACT,
        status: Status.APPLIED,
        proposedBy: 'sub-officer',
        approvedBy: '',
      });
      expect(change?.changeId).toMatch(UUID);
      expect(await cell('public', 'business_venue')).toMatchObject({ action: 'redact', updated_by_sub: 'sub-officer' });
      expect(await audits('nwflorida:public:business_venue')).toEqual([
        {
          action: 'redaction_set',
          subject_kind: 'redaction_policy',
          actor_sub: 'sub-officer',
          from_state: 'show',
          to_state: 'redact',
          payload: { change_id: change?.changeId },
        },
      ]);
    });

    it('applies a blur-to-hide on images at once', async () => {
      const { change } = await policy.proposeRedactionChange({ audience: Audience.PUBLIC, category: Category.IMAGE, action: Action.HIDE }, OFFICER);
      expect(change?.status).toBe(Status.APPLIED);
      expect(await action(Audience.PUBLIC, Category.IMAGE)).toBe(Action.HIDE);
    });

    it('applies a loosening for members or officers at once: only the public audience needs a second officer', async () => {
      const { change } = await policy.proposeRedactionChange({ audience: Audience.MEMBERS, category: Category.MEMBER_ADDRESS, action: Action.SHOW }, OFFICER);
      expect(change?.status).toBe(Status.APPLIED);
      expect(await action(Audience.MEMBERS, Category.MEMBER_ADDRESS)).toBe(Action.SHOW);
    });
  });

  describe('loosening the public audience', () => {
    let changeId: string;

    it('waits for a second officer, leaving the policy as it was, and audits the proposal', async () => {
      const { change } = await policy.proposeRedactionChange({ audience: Audience.PUBLIC, category: Category.MEMBER_PHONE, action: Action.SHOW }, OFFICER);
      expect(change).toMatchObject({ fromAction: Action.REDACT, toAction: Action.SHOW, status: Status.PENDING, proposedBy: 'sub-officer', approvedBy: '' });
      changeId = change?.changeId as string;
      expect(await cell('public', 'member_phone')).toMatchObject({ action: 'redact' });
      expect(await action(Audience.PUBLIC, Category.MEMBER_PHONE)).toBe(Action.REDACT);
      const { pending } = await policy.getRedactionPolicy({}, SECOND);
      expect(pending.map((p) => p.changeId)).toEqual([changeId]);
      expect(await audits(changeId)).toEqual([
        {
          action: 'redaction_propose',
          subject_kind: 'redaction_change',
          actor_sub: 'sub-officer',
          from_state: 'redact',
          to_state: 'show',
          payload: { tenant: 'nwflorida', audience: 'public', category: 'member_phone' },
        },
      ]);
    });

    it('refuses a second proposal for the same cell while one waits', async () => {
      await expect(
        policy.proposeRedactionChange({ audience: Audience.PUBLIC, category: Category.MEMBER_PHONE, action: Action.SHOW }, SECOND),
      ).rejects.toMatchObject({ code: Code.FailedPrecondition });
    });

    it('refuses the proposer’s own approval', async () => {
      await expect(policy.approveRedactionChange({ changeId }, OFFICER)).rejects.toMatchObject({ code: Code.PermissionDenied });
      expect((await cell('public', 'member_phone'))?.action).toBe('redact');
      expect((await audits(changeId)).map((a) => a.action)).toEqual(['redaction_propose']);
    });

    it('takes effect when a different officer approves, and audits the approval and the change', async () => {
      const { change } = await policy.approveRedactionChange({ changeId }, SECOND);
      expect(change).toMatchObject({ changeId, status: Status.APPLIED, proposedBy: 'sub-officer', approvedBy: 'sub-pub' });
      expect(change?.approvedAt).toBeDefined();
      expect(await cell('public', 'member_phone')).toMatchObject({ action: 'show', updated_by_sub: 'sub-pub' });
      expect(await audits(changeId)).toEqual([
        expect.objectContaining({ action: 'redaction_propose', actor_sub: 'sub-officer' }),
        { action: 'redaction_approve', subject_kind: 'redaction_change', actor_sub: 'sub-pub', from_state: 'pending', to_state: 'applied', payload: {} },
      ]);
      expect(await audits('nwflorida:public:member_phone')).toEqual([
        { action: 'redaction_set', subject_kind: 'redaction_policy', actor_sub: 'sub-pub', from_state: 'redact', to_state: 'show', payload: { change_id: changeId } },
      ]);
      expect((await policy.getRedactionPolicy({}, OFFICER)).pending).toEqual([]);
    });

    it('refuses to approve a change twice', async () => {
      await expect(policy.approveRedactionChange({ changeId }, ADMIN)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    });

    it('holds a hide-to-blur on public images too', async () => {
      const { change } = await policy.proposeRedactionChange({ audience: Audience.PUBLIC, category: Category.IMAGE, action: Action.BLUR }, OFFICER);
      expect(change?.status).toBe(Status.PENDING);
      expect(await action(Audience.PUBLIC, Category.IMAGE)).toBe(Action.HIDE);
    });

    it('lets a tightening of the same cell apply at once and supersede the waiting loosening', async () => {
      const { change: waiting } = await policy.proposeRedactionChange({ audience: Audience.PUBLIC, category: Category.MEMBER_EMAIL, action: Action.SHOW }, OFFICER);
      expect(waiting?.status).toBe(Status.PENDING);
      const { change } = await policy.proposeRedactionChange({ audience: Audience.PUBLIC, category: Category.MEMBER_EMAIL, action: Action.HIDE }, SECOND);
      expect(change).toMatchObject({ fromAction: Action.REDACT, toAction: Action.HIDE, status: Status.APPLIED });
      expect(await action(Audience.PUBLIC, Category.MEMBER_EMAIL)).toBe(Action.HIDE);
      const superseded = waiting?.changeId as string;
      expect((await audits(superseded)).map((a) => [a.action, a.actor_sub, a.to_state])).toEqual([
        ['redaction_propose', 'sub-officer', 'show'],
        ['redaction_supersede', 'sub-pub', 'superseded'],
      ]);
      await expect(policy.approveRedactionChange({ changeId: superseded }, ADMIN)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      expect(await action(Audience.PUBLIC, Category.MEMBER_EMAIL)).toBe(Action.HIDE);
    });
  });

  describe('requests it refuses', () => {
    it.each([
      ['no audience', { category: Category.MEMBER_NAME, action: Action.HIDE }],
      ['no category', { audience: Audience.PUBLIC, action: Action.HIDE }],
      ['no action', { audience: Audience.PUBLIC, category: Category.MEMBER_NAME }],
      ['an unknown audience', { audience: 99 as Audience, category: Category.MEMBER_NAME, action: Action.HIDE }],
      ['blur on text', { audience: Audience.PUBLIC, category: Category.MEMBER_NAME, action: Action.BLUR }],
      ['redact on an image', { audience: Audience.PUBLIC, category: Category.IMAGE, action: Action.REDACT }],
    ])('refuses a proposal with %s', async (_case, request) => {
      await expect(policy.proposeRedactionChange(request, OFFICER)).rejects.toMatchObject({ code: Code.InvalidArgument });
    });

    it('refuses a proposal that changes nothing', async () => {
      await expect(
        policy.proposeRedactionChange({ audience: Audience.OFFICERS, category: Category.MEMBER_NAME, action: Action.SHOW }, OFFICER),
      ).rejects.toMatchObject({ code: Code.FailedPrecondition });
    });

    it('refuses an approval for a malformed or unknown change id', async () => {
      await expect(policy.approveRedactionChange({ changeId: 'not-a-uuid' }, OFFICER)).rejects.toMatchObject({ code: Code.InvalidArgument });
      await expect(policy.approveRedactionChange({ changeId: '00000000-0000-4000-8000-000000000000' }, OFFICER)).rejects.toMatchObject({ code: Code.NotFound });
    });
  });

  describe('failing closed', () => {
    it('reads a missing cell as HIDE, and treats moving off it as a loosening', async () => {
      await asOwner((client) => client.query(`DELETE FROM redaction_policy WHERE audience = 'public' AND category = 'officer_contact'`));
      expect(await action(Audience.PUBLIC, Category.OFFICER_CONTACT)).toBe(Action.HIDE);
      const { change } = await policy.proposeRedactionChange({ audience: Audience.PUBLIC, category: Category.OFFICER_CONTACT, action: Action.REDACT }, OFFICER);
      expect(change).toMatchObject({ fromAction: Action.HIDE, status: Status.PENDING });
      await policy.approveRedactionChange({ changeId: change?.changeId as string }, SECOND);
      expect(await cell('public', 'officer_contact')).toMatchObject({ tenant_id: 'nwflorida', action: 'redact' });
    });
  });

  describe('the tables, as the application role (challenge A1-A4)', () => {
    const asApp = (text: string, values: unknown[] = []): Promise<string> => sqlstate(api.pool as unknown as pg.Client, text, values);
    let applied: string;

    beforeAll(async () => {
      const { change } = await policy.proposeRedactionChange({ audience: Audience.MEMBERS, category: Category.BUSINESS_VENUE, action: Action.HIDE }, OFFICER);
      applied = change?.changeId as string;
    });

    it('never lets the app role delete a cell or a change, or touch the tenant list', async () => {
      expect(await asApp(`DELETE FROM redaction_policy`)).toBe('42501');
      expect(await asApp(`DELETE FROM redaction_change`)).toBe('42501');
      expect(await asApp(`INSERT INTO tenant (id, name) VALUES ('other', 'Other')`)).toBe('42501');
    });

    it('A1: refuses a direct write to a policy cell, which would leave no change row and no audit row', async () => {
      expect(await asApp(`UPDATE redaction_policy SET action = 'show' WHERE audience = 'public' AND category = 'member_name'`)).toBe('42501');
      expect(await asApp(`INSERT INTO redaction_policy (audience, category, action) VALUES ('public', 'member_name', 'show') ON CONFLICT DO NOTHING`)).toBe('42501');
      expect((await cell('public', 'member_name'))?.action).not.toBe('show');
    });

    it('A2: refuses an applied public loosening inserted directly, approver or not', async () => {
      expect(
        await asApp(
          `INSERT INTO redaction_change (audience, category, from_action, to_action, status, proposed_by_sub, approved_by_sub, approved_at, decided_at)
           VALUES ('public', 'member_name', 'redact', 'show', 'applied', 'sub-officer', 'ghost', now(), now())`,
        ),
      ).toBe('42501');
      expect(await asApp(`INSERT INTO redaction_change (audience, category, from_action, to_action, status, proposed_by_sub) VALUES ('public', 'member_name', 'redact', 'show', 'pending', 'sub-officer')`)).toBe('42501');
    });

    it('A3: refuses a rewrite of an applied change’s proposer, approver or action', async () => {
      expect(await asApp(`UPDATE redaction_change SET proposed_by_sub = 'alice', approved_by_sub = 'bob', to_action = 'hide' WHERE id = $1`, [applied])).toBe('42501');
    });

    it('A4: refuses to set an applied change back to pending', async () => {
      expect(await asApp(`UPDATE redaction_change SET status = 'pending', decided_at = NULL WHERE id = $1`, [applied])).toBe('42501');
    });

    it('keeps the change history immutable for the owner too: no rewrite, no reopening, no delete', async () => {
      await asOwner(async (owner) => {
        expect(await sqlstate(owner, `UPDATE redaction_change SET proposed_by_sub = 'alice' WHERE id = $1`, [applied])).toBe('55000');
        expect(await sqlstate(owner, `UPDATE redaction_change SET status = 'pending', decided_at = NULL WHERE id = $1`, [applied])).toBe('55000');
        expect(await sqlstate(owner, `DELETE FROM redaction_change WHERE id = $1`, [applied])).toBe('55000');
      });
      expect((await api.pool.query(`SELECT status, proposed_by_sub FROM redaction_change WHERE id = $1`, [applied])).rows[0]).toEqual({ status: 'applied', proposed_by_sub: 'sub-officer' });
    });

    it('holds four-eyes in the narrow path itself, whatever the app role passes it', async () => {
      const proposed = (
        await api.pool.query<{ id: string; status: string }>(
          `SELECT id, status FROM redaction_propose('nwflorida', 'public', 'member_name', 'show', 'sub-officer', '{nwfl-officers}', NULL)`,
        )
      ).rows[0];
      expect(proposed?.status).toBe('pending');
      expect((await cell('public', 'member_name'))?.action).toBe('redact');
      expect(await asApp(`SELECT redaction_approve($1, 'sub-officer', '{nwfl-officers}', NULL)`, [proposed?.id])).toBe('42501');
      expect(await asApp(`SELECT redaction_approve($1, '', '{nwfl-officers}', NULL)`, [proposed?.id])).toBe('42501');
      // The cell no longer matches the change's from_action: the approval is refused.
      await asOwner((owner) => owner.query(`UPDATE redaction_policy SET action = 'hide' WHERE audience = 'public' AND category = 'member_name'`));
      expect(await asApp(`SELECT redaction_approve($1, 'sub-pub', '{nwfl-officers}', NULL)`, [proposed?.id])).toBe('55000');
      expect((await cell('public', 'member_name'))?.action).toBe('hide');
      expect((await audits(proposed?.id as string)).map((a) => [a.action, a.actor_sub])).toEqual([['redaction_propose', 'sub-officer']]);
    });

    it('refuses an action the category does not allow, even from the owner', async () => {
      await asOwner(async (owner) => {
        expect(await sqlstate(owner, `UPDATE redaction_policy SET action = 'blur' WHERE audience = 'members' AND category = 'member_name'`)).toBe('23514');
        expect(await sqlstate(owner, `UPDATE redaction_policy SET action = 'redact' WHERE audience = 'members' AND category = 'image'`)).toBe('23514');
      });
    });

    it('refuses a self-approved change, and an applied public loosening with no approver, even from the owner', async () => {
      await asOwner(async (owner) => {
        const insert = (status: string, from: string, to: string, approver: string | null): Promise<string> =>
          sqlstate(
            owner,
            `INSERT INTO redaction_change (audience, category, from_action, to_action, status, proposed_by_sub, approved_by_sub, approved_at, decided_at)
             VALUES ('public', 'member_address', $1, $2, $3, 'sub-officer', $4::text, CASE WHEN $4::text IS NULL THEN NULL ELSE now() END, now())`,
            [from, to, status, approver],
          );
        expect(await insert('applied', 'redact', 'show', 'sub-officer')).toBe('23514');
        expect(await insert('applied', 'redact', 'show', null)).toBe('23514');
        expect(await insert('applied', 'hide', 'redact', null)).toBe('23514');
        expect(await insert('applied', 'show', 'hide', null)).toBe('ok');
        expect(await insert('applied', 'redact', 'show', 'sub-pub')).toBe('ok');
      });
    });
  });

  describe('concurrency (challenge SHOULD)', () => {
    const APPROVERS = ['pub-token', 'treasurer-token', 'webmaster-token', 'admin-token'] as const;
    const outcome = (call: Promise<{ change?: { status: Status } }>): Promise<Status | Code> =>
      call.then(
        (response) => response.change?.status ?? Status.UNSPECIFIED,
        (error: { code: Code }) => error.code,
      );

    it.each([Category.MEMBER_ADDRESS, Category.PRIVATE_VENUE, Category.MEMBER_EMAIL])(
      'four officers approving one proposal at once give one applied change and one approval row (category %i)',
      async (category) => {
        const { change } = await policy.proposeRedactionChange({ audience: Audience.PUBLIC, category, action: Action.SHOW }, OFFICER);
        expect(change?.status).toBe(Status.PENDING);
        const id = change?.changeId as string;
        const results = await Promise.all(APPROVERS.map((token) => outcome(policy.approveRedactionChange({ changeId: id }, as(token)))));
        expect(results.filter((r) => r === Status.APPLIED)).toHaveLength(1);
        expect(results.filter((r) => r === Code.FailedPrecondition)).toHaveLength(3);
        const rows = await api.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_event WHERE subject_id = $1 AND action = 'redaction_approve'`, [id]);
        expect(rows.rows[0]?.n).toBe(1);
        const sets = await api.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_event WHERE action = 'redaction_set' AND payload->>'change_id' = $1`, [id]);
        expect(sets.rows[0]?.n).toBe(1);
      },
    );

    it('an approval racing a tightening of the same cell never ends at show', async () => {
      for (let round = 0; round < 6; round += 1) {
        // Start each round at redact, the default, through the path itself.
        const now = (await cell('public', 'officer_contact'))?.action;
        if (now !== 'redact') {
          const { change } = await policy.proposeRedactionChange({ audience: Audience.PUBLIC, category: Category.OFFICER_CONTACT, action: Action.REDACT }, OFFICER);
          if (change?.status === Status.PENDING) await policy.approveRedactionChange({ changeId: change.changeId }, SECOND);
        }
        const { change } = await policy.proposeRedactionChange({ audience: Audience.PUBLIC, category: Category.OFFICER_CONTACT, action: Action.SHOW }, OFFICER);
        const [approved, tightened] = await Promise.all([
          outcome(policy.approveRedactionChange({ changeId: change?.changeId as string }, SECOND)),
          outcome(policy.proposeRedactionChange({ audience: Audience.PUBLIC, category: Category.OFFICER_CONTACT, action: Action.HIDE }, as('treasurer-token'))),
        ]);
        expect(tightened, `round ${round}`).toBe(Status.APPLIED);
        expect([Status.APPLIED, Code.FailedPrecondition], `round ${round}`).toContain(approved);
        expect((await cell('public', 'officer_contact'))?.action, `round ${round}`).toBe('hide');
      }
    });
  });
});
