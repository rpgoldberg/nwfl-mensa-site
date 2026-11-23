// REOPEN: the Admin or the Membership Officer reopens a rejected sign-up, so a mistaken rejection
// can be fixed. The person can then send the sign-up form again; nothing erased comes back, the
// rejection stays in the history, and the reopening is audited with who did it. Everyone else is
// refused, a sign-up that is not rejected (or already reopened) is refused, and no one reopens
// their own. Every value here is made up.
import { type Client, Code } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TokenVerifier, VerifiedToken } from '../../src/auth/caller.js';
import { MemberStatus, MembershipService, Verification } from '../../src/gen/nwfl/mensa/v1/membership_pb.js';
import { type Api, MEMBER, OFFICER, PEOPLE, as, startApi } from '../helpers/api.js';
import { live } from '../helpers/pg.js';

/** The shared people, plus a membership approver without the seat and the seat without the approvers group. */
const MORE: Record<string, VerifiedToken> = {
  'lone-approver-token': { client: 'site', subject: 'sub-lone-approver', groups: ['nwfl-users', 'nwfl-membership-approvers'], scopes: [] },
  'seat-only-token': { client: 'site', subject: 'sub-seat-only', groups: ['nwfl-officers', 'nwfl-office-membership'], scopes: [] },
  'redo-token': { client: 'site', subject: 'sub-redo', groups: ['nwfl-users'], scopes: [], name: 'Reese Example', email: 'reese@example.org' },
  'redo2-token': { client: 'site', subject: 'sub-redo2', groups: ['nwfl-users'], scopes: [], name: 'Sawyer Sample', email: 'sawyer@example.org' },
  'redo3-token': { client: 'site', subject: 'sub-redo3', groups: ['nwfl-users'], scopes: [], name: 'Emery Placeholder', email: 'emery@example.org' },
  'redo4-token': { client: 'site', subject: 'sub-redo4', groups: ['nwfl-users'], scopes: [], name: 'Finley Example', email: 'finley@example.org' },
  'redo5-token': { client: 'site', subject: 'sub-redo5', groups: ['nwfl-users'], scopes: [], name: 'Hayden Sample', email: 'hayden@example.org' },
};
const verifier: TokenVerifier = {
  verify: (token) => {
    const person = PEOPLE[token] ?? MORE[token];
    return person === undefined ? Promise.reject(new Error('unknown token')) : Promise.resolve(person);
  },
};
const tok = (token: string): { headers: Record<string, string> } => ({ headers: { authorization: `Bearer ${token}` } });

const APPROVER = as('approver-token');
const ADMIN = as('admin-token');
const LONE_APPROVER = tok('lone-approver-token');
const SEAT_ONLY = tok('seat-only-token');
const NUMBER = '50518344';
const LAST = 'Placeholderson';

describe.skipIf(!live)('MembershipService: reopening a rejected sign-up (REOPEN)', () => {
  let api: Api;
  let membership: Client<typeof MembershipService>;

  const rows = async (sub: string) =>
    (
      await api.pool.query<{
        id: string;
        decision: string;
        decided_by_sub: string | null;
        last_name: string | null;
        membership_number: string | null;
        reopened_by_sub: string | null;
        reopened: boolean;
      }>(
        `SELECT id, decision, decided_by_sub, last_name, membership_number, reopened_by_sub, reopened_at IS NOT NULL AS reopened
         FROM signup_request WHERE sub = $1 ORDER BY created_at, id`,
        [sub],
      )
    ).rows;
  const accountOf = async (sub: string) => (await api.pool.query<{ status: string }>(`SELECT status FROM member_account WHERE sub = $1`, [sub])).rows[0];
  const audits = async (subjectId: string) =>
    (
      await api.pool.query<{ action: string; subject_kind: string; actor_sub: string; from_state: string | null; to_state: string | null; payload: unknown; note: string | null }>(
        `SELECT action, subject_kind, actor_sub, from_state, to_state, payload, note FROM audit_event WHERE subject_id = $1 ORDER BY id`,
        [subjectId],
      )
    ).rows;
  /** Signs up as `token`, then the Admin rejects it: the account is closed. */
  const turnedDown = async (token: string, by = ADMIN): Promise<string> => {
    const { requestId } = await membership.submitSignup({ lastName: LAST, membershipNumber: NUMBER }, tok(token));
    await membership.rejectSignup({ requestId }, by);
    return requestId;
  };

  beforeAll(async () => {
    api = await startApi('nwfl_reopen', { verifier });
    membership = api.client(MembershipService);
  });

  afterAll(async () => {
    await api?.close();
  });

  it('lets the Membership Officer reopen a rejection: the person can sign up again, nothing erased returns, the history keeps both', async () => {
    const requestId = await turnedDown('redo-token');
    expect((await membership.getMyAccount({}, tok('redo-token'))).account?.status).toBe(MemberStatus.REMOVED);
    await expect(membership.submitSignup({ lastName: LAST, membershipNumber: NUMBER }, tok('redo-token'))).rejects.toMatchObject({ code: Code.AlreadyExists });

    expect(await membership.reopenSignup({ requestId }, APPROVER)).toBeDefined();
    // Gone from the list at once, before any new sign-up.
    expect((await membership.listRejectedSignups({}, APPROVER)).requests.map((r) => r.requestId)).not.toContain(requestId);

    // The rejected row stays as it was, with who reopened it, and what it typed (PROFILE-ID).
    expect(await rows('sub-redo')).toEqual([
      { id: requestId, decision: 'rejected', decided_by_sub: 'sub-admin', last_name: LAST, membership_number: NUMBER, reopened_by_sub: 'sub-approver', reopened: true },
    ]);
    // The closed account is gone, so the person is where they were before signing up.
    expect(await accountOf('sub-redo')).toBeUndefined();
    expect((await membership.getMyAccount({}, tok('redo-token'))).account).toBeUndefined();
    expect(await audits(requestId)).toEqual([
      { action: 'signup', subject_kind: 'signup_request', actor_sub: 'sub-redo', from_state: null, to_state: null, payload: {}, note: null },
      { action: 'reject', subject_kind: 'signup_request', actor_sub: 'sub-admin', from_state: 'pending', to_state: 'rejected', payload: {}, note: null },
      { action: 'reopen', subject_kind: 'signup_request', actor_sub: 'sub-approver', from_state: 'rejected', to_state: 'reopened', payload: {}, note: null },
    ]);
    expect(await audits('sub-redo')).toEqual([
      { action: 'reject', subject_kind: 'member_account', actor_sub: 'sub-admin', from_state: 'pending', to_state: 'removed', payload: {}, note: null },
      { action: 'reopen', subject_kind: 'member_account', actor_sub: 'sub-approver', from_state: 'removed', to_state: null, payload: {}, note: null },
    ]);

    // The same person signs up again: a new sign-up, waiting in the queue, the old row kept beside it.
    const again = await membership.submitSignup({ lastName: LAST, membershipNumber: NUMBER }, tok('redo-token'));
    expect(again.requestId).not.toBe(requestId);
    expect((await membership.getMyAccount({}, tok('redo-token'))).account?.status).toBe(MemberStatus.PENDING);
    expect((await rows('sub-redo')).map((r) => [r.id, r.decision, r.reopened, r.membership_number])).toEqual([
      [requestId, 'rejected', true, NUMBER],
      [again.requestId, 'pending', false, NUMBER],
    ]);
    const queue = (await membership.listSignupRequests({}, APPROVER)).requests.map((r) => r.requestId);
    expect(queue).toContain(again.requestId);
    expect(queue).not.toContain(requestId);
    // A repeat sign-up still gets the one answer.
    await expect(membership.submitSignup({ lastName: LAST, membershipNumber: NUMBER }, tok('redo-token'))).rejects.toMatchObject({ code: Code.AlreadyExists });
  });

  it('lets the Admin reopen too, and the seat without the approvers group; a second rejection can be reopened again', async () => {
    const first = await turnedDown('redo2-token', APPROVER);
    await membership.reopenSignup({ requestId: first }, ADMIN);
    expect((await rows('sub-redo2'))[0]).toMatchObject({ reopened_by_sub: 'sub-admin', reopened: true });
    const second = await turnedDown('redo2-token');
    await membership.reopenSignup({ requestId: second }, SEAT_ONLY);
    expect((await rows('sub-redo2')).map((r) => [r.decision, r.reopened_by_sub])).toEqual([
      ['rejected', 'sub-admin'],
      ['rejected', 'sub-seat-only'],
    ]);
    expect((await membership.getMyAccount({}, tok('redo2-token'))).account).toBeUndefined();
  });

  it('refuses everyone else, changing nothing: a membership approver without the seat, the Webmaster, an officer, a member, a machine, the public', async () => {
    const requestId = await turnedDown('redo3-token');
    const refusals: Array<[{ headers?: Record<string, string> }, Code]> = [
      [LONE_APPROVER, Code.PermissionDenied],
      [as('webmaster-token'), Code.PermissionDenied],
      [OFFICER, Code.PermissionDenied],
      [MEMBER, Code.PermissionDenied],
      [tok('redo3-token'), Code.PermissionDenied],
      [as('verifier-token'), Code.PermissionDenied],
      [{}, Code.Unauthenticated],
    ];
    for (const [who, code] of refusals) {
      await expect(membership.reopenSignup({ requestId }, who)).rejects.toMatchObject({ code });
      await expect(membership.listRejectedSignups({}, who)).rejects.toMatchObject({ code });
      // Who may is decided first: an id that is unknown or not an id tells them nothing more.
      await expect(membership.reopenSignup({ requestId: '00000000-0000-4000-8000-000000000000' }, who)).rejects.toMatchObject({ code });
      await expect(membership.reopenSignup({ requestId: 'not-an-id' }, who)).rejects.toMatchObject({ code });
    }
    expect((await rows('sub-redo3'))[0]).toMatchObject({ decision: 'rejected', reopened: false });
    expect((await accountOf('sub-redo3'))?.status).toBe('removed');
    expect((await audits(requestId)).map((a) => a.action)).toEqual(['signup', 'reject']);
  });

  it('refuses a sign-up that is not rejected, a second reopening, one whose account is no longer closed, and one\'s own', async () => {
    const pending = (await membership.submitSignup({ lastName: LAST, membershipNumber: NUMBER }, tok('redo4-token'))).requestId;
    // In the handler's own words: not the closed-account check, which a pending or approved account also fails.
    await expect(membership.reopenSignup({ requestId: pending }, APPROVER)).rejects.toMatchObject({ code: Code.FailedPrecondition, rawMessage: 'only a rejected sign-up is reopened, and only once' });
    await membership.approveSignup({ requestId: pending }, ADMIN);
    await expect(membership.reopenSignup({ requestId: pending }, APPROVER)).rejects.toMatchObject({ code: Code.FailedPrecondition, rawMessage: 'only a rejected sign-up is reopened, and only once' });

    // A double reopen is refused, not repeated: the first stands, audited once.
    const rejected = await turnedDown('redo5-token');
    await membership.reopenSignup({ requestId: rejected }, APPROVER);
    await expect(membership.reopenSignup({ requestId: rejected }, ADMIN)).rejects.toMatchObject({ code: Code.FailedPrecondition, rawMessage: 'only a rejected sign-up is reopened, and only once' });
    expect((await rows('sub-redo5'))[0]).toMatchObject({ reopened_by_sub: 'sub-approver' });
    expect((await audits(rejected)).filter((a) => a.action === 'reopen')).toHaveLength(1);

    // Rejected while the account was no longer waiting (a member already, as the W-SIGNUP race leaves it): the
    // rejection did not close it, so there is nothing to reopen.
    await api.pool.query(`INSERT INTO signup_request (sub, display_name, email) VALUES ('sub-redo6', 'Indigo Example', 'indigo@example.org')`);
    await api.pool.query(
      `INSERT INTO member_account (sub, status, route, approved_by_sub, approved_at, verified_on) VALUES ('sub-redo6', 'member', 'signup', 'sub-admin', now(), '2026-10-01')`,
    );
    const granted = (await rows('sub-redo6'))[0]?.id as string;
    await membership.rejectSignup({ requestId: granted }, ADMIN);
    await expect(membership.reopenSignup({ requestId: granted }, APPROVER)).rejects.toMatchObject({ code: Code.FailedPrecondition, rawMessage: 'this account is no longer closed by the rejection' });
    expect((await accountOf('sub-redo6'))?.status).toBe('member');
    expect((await rows('sub-redo6'))[0]).toMatchObject({ reopened: false });

    // The Membership Officer's own rejected sign-up: refused to them, reopened by the Admin.
    const { requestId: own } = await membership.submitSignup({ lastName: LAST, membershipNumber: NUMBER }, APPROVER);
    await membership.rejectSignup({ requestId: own }, ADMIN);
    await expect(membership.reopenSignup({ requestId: own }, APPROVER)).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect((await membership.listRejectedSignups({}, APPROVER)).requests.map((r) => r.requestId)).not.toContain(own);
    expect((await membership.listRejectedSignups({}, ADMIN)).requests.map((r) => r.requestId)).toContain(own);
    await membership.reopenSignup({ requestId: own }, ADMIN);
  });

  it('neither lists nor reopens a rejection whose removed account was once checked, approved or granted, and keeps that account', async () => {
    const standing: Array<[string, string]> = [
      ['sub-kept-checked', `INSERT INTO member_account (sub, status, route, verified_on, removed_at) VALUES ('sub-kept-checked', 'removed', 'signup', '2026-10-01', now())`],
      ['sub-kept-approved', `INSERT INTO member_account (sub, status, route, approved_by_sub, approved_at, removed_at) VALUES ('sub-kept-approved', 'removed', 'signup', 'sub-admin', now(), now())`],
      ['sub-kept-granted', `INSERT INTO member_account (sub, status, route, affiliate_granted_by_sub, affiliate_granted_at, removed_at) VALUES ('sub-kept-granted', 'removed', 'admin_grant', 'sub-admin', now(), now())`],
    ];
    for (const [sub, account] of standing) {
      await api.pool.query(`INSERT INTO signup_request (sub, display_name, email) VALUES ($1, 'Kim Example', 'kim@example.org')`, [sub]);
      const id = (await rows(sub))[0]?.id as string;
      await membership.rejectSignup({ requestId: id }, ADMIN);
      await api.pool.query(account);
      expect((await membership.listRejectedSignups({}, APPROVER)).requests.map((r) => r.requestId), sub).not.toContain(id);
      await expect(membership.reopenSignup({ requestId: id }, APPROVER), sub).rejects.toMatchObject({
        code: Code.FailedPrecondition,
        rawMessage: 'this account is no longer closed by the rejection',
      });
      expect((await accountOf(sub))?.status, sub).toBe('removed');
      expect((await rows(sub))[0], sub).toMatchObject({ decision: 'rejected', reopened: false });
    }
  });

  it('reopens a rejected sign-up that never had an account row, with nothing to delete', async () => {
    await api.pool.query(`INSERT INTO signup_request (sub, display_name, email) VALUES ('sub-no-account', 'Kit Example', 'kit@example.org')`);
    const id = (await rows('sub-no-account'))[0]?.id as string;
    await membership.rejectSignup({ requestId: id }, ADMIN);
    expect(await accountOf('sub-no-account')).toBeUndefined();
    expect((await membership.listRejectedSignups({}, APPROVER)).requests.map((r) => r.requestId)).toContain(id);
    await membership.reopenSignup({ requestId: id }, APPROVER);
    expect((await rows('sub-no-account'))[0]).toMatchObject({ decision: 'rejected', reopened: true });
    expect((await audits('sub-no-account')).map((a) => a.action)).toEqual([]);
  });

  it('answers an id it does not have, or cannot read, as such', async () => {
    await expect(membership.reopenSignup({ requestId: '00000000-0000-4000-8000-000000000000' }, APPROVER)).rejects.toMatchObject({ code: Code.NotFound });
    await expect(membership.reopenSignup({ requestId: 'not-an-id' }, APPROVER)).rejects.toMatchObject({ code: Code.InvalidArgument });
  });

  describe('ListRejectedSignups', () => {
    it('lists the rejections that can be reopened, newest first, with the check, the day and what was typed (PROFILE-ID)', async () => {
      const older = await turnedDown('joiner-token');
      const { requestId: newer } = await membership.submitSignup({ lastName: LAST, membershipNumber: NUMBER }, as('joiner2-token'));
      await api.pool.query(`UPDATE signup_request SET verification = 'not_found', verified_on = '2026-10-20' WHERE id = $1`, [newer]);
      await membership.rejectSignup({ requestId: newer }, APPROVER);
      const listed = await membership.listRejectedSignups({}, APPROVER);
      const mine = listed.requests.filter((r) => [older, newer].includes(r.requestId));
      expect(mine.map((r) => r.requestId)).toEqual([newer, older]);
      expect(mine[0]).toMatchObject({ displayName: 'Robin Sample', email: 'robin@example.org', verification: Verification.NOT_FOUND, verifiedOn: { year: 2026, month: 10, day: 20 } });
      expect(mine[0]?.rejectedAt).toBeDefined();
      expect(mine[1]).toMatchObject({ displayName: 'Jamie Example', verification: Verification.UNCHECKED });
      expect(mine[1]?.verifiedOn).toBeUndefined();
      for (const r of mine) expect(r).toMatchObject({ lastName: LAST, membershipNumber: NUMBER, firstName: '' });
    });

    it('leaves out a reopened sign-up, a pending or approved one, and one whose account is no longer closed', async () => {
      const ids = (await membership.listRejectedSignups({}, ADMIN)).requests.map((r) => r.requestId);
      const reopened = (await rows('sub-redo'))[0]?.id;
      const granted = (await rows('sub-redo6'))[0]?.id;
      const approved = (await rows('sub-redo4'))[0]?.id;
      const pending = (await rows('sub-redo'))[1]?.id;
      for (const id of [reopened, granted, approved, pending]) expect(ids).not.toContain(id);
      expect(ids).toContain((await rows('sub-redo3'))[0]?.id);
    });
  });

  describe('the records around a reopened person', () => {
    it('lists a reopened person who signed up again and was approved once in the member list, by name', async () => {
      const pending = (await rows('sub-redo'))[1]?.id as string;
      await membership.approveSignup({ requestId: pending }, ADMIN);
      const named = (await membership.listMembers({}, APPROVER)).members.filter((m) => m.subject === 'sub-redo');
      expect(named).toHaveLength(1);
      expect(named[0]).toMatchObject({ displayName: 'Reese Example', status: MemberStatus.MEMBER });
    });

    it('grants affiliate standing on the open sign-up, never the reopened one', async () => {
      const again = await membership.submitSignup({ lastName: LAST, membershipNumber: NUMBER }, tok('redo5-token'));
      await api.pool.query(`UPDATE signup_request SET verification = 'verified_other_group', verified_on = '2026-10-21' WHERE id = $1`, [again.requestId]);
      const { account } = await membership.grantAffiliate({ subject: 'sub-redo5' }, ADMIN);
      expect(account).toMatchObject({ status: MemberStatus.AFFILIATE, verifiedOn: { year: 2026, month: 10, day: 21 } });
      expect((await rows('sub-redo5')).map((r) => [r.decision, r.reopened])).toEqual([
        ['rejected', true],
        ['approved', false],
      ]);
    });
  });
});
