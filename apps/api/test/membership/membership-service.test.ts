// A5: MembershipService (R24, R33, MT-19). A signed-in person signs up with the
// name and email their token carries, plus the last name and membership number
// they type; approvers decide; the Admin or Webmaster grants affiliates. The
// number and the last name never leave the sign-up row except to the verifier,
// and every decision erases them in the same statement. Membership audit rows
// carry no payload and no note. Every value here is made up.
import { type Client, Code } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountRoute, MemberStatus, MembershipService, Verification } from '../../src/gen/nwfl/mensa/v1/membership_pb.js';
import { type Api, MEMBER, NOW, as, dump, startApi } from '../helpers/api.js';
import { live } from '../helpers/pg.js';

const JOINER = as('joiner-token');
const JOINER2 = as('joiner2-token');
const JOINER3 = as('joiner3-token');
const APPROVER = as('approver-token');
const ADMIN = as('admin-token');
const WEBMASTER = as('webmaster-token');
const NUMBER = '40417233';
const LAST = 'Examplesson';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe.skipIf(!live)('MembershipService', () => {
  let api: Api;
  let membership: Client<typeof MembershipService>;

  const signupRow = async (sub: string) =>
    (
      await api.pool.query<{ id: string; display_name: string; email: string; last_name: string | null; membership_number: string | null; decision: string; decided_by_sub: string | null }>(
        `SELECT id, display_name, email, last_name, membership_number, decision, decided_by_sub FROM signup_request WHERE sub = $1`,
        [sub],
      )
    ).rows[0];
  const account = async (sub: string) =>
    (
      await api.pool.query<{ status: string; route: string; approved_by_sub: string | null; verified_on: string | null; affiliate_granted_by_sub: string | null }>(
        `SELECT status, route, approved_by_sub, verified_on::text AS verified_on, affiliate_granted_by_sub FROM member_account WHERE sub = $1`,
        [sub],
      )
    ).rows[0];
  const audits = async (subjectId: string) =>
    (
      await api.pool.query<{ action: string; subject_kind: string; actor_sub: string; payload: unknown; note: string | null; to_state: string | null }>(
        `SELECT action, subject_kind, actor_sub, payload, note, to_state FROM audit_event WHERE subject_id = $1 ORDER BY id`,
        [subjectId],
      )
    ).rows;
  const report = (id: string, outcome: string): Promise<unknown> =>
    api.pool.query(
      `UPDATE signup_request SET verification = $2, verified_on = '2026-10-20', membership_number = NULL, last_name = NULL WHERE id = $1`,
      [id, outcome],
    );

  beforeAll(async () => {
    api = await startApi('nwfl_membership');
    membership = api.client(MembershipService);
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('SubmitSignup', () => {
    it('records the sign-up with the name and email from the token and the last name and number typed', async () => {
      const { requestId } = await membership.submitSignup({ lastName: ` ${LAST} `, membershipNumber: ` ${NUMBER} ` }, JOINER);
      expect(requestId).toMatch(UUID);
      expect(await signupRow('sub-joiner')).toMatchObject({
        id: requestId,
        display_name: 'Jamie Example',
        email: 'jamie@example.org',
        last_name: LAST,
        membership_number: NUMBER,
        decision: 'pending',
      });
      expect(await account('sub-joiner')).toMatchObject({ status: 'pending', route: 'signup' });
      expect(await audits(requestId)).toEqual([{ action: 'signup', subject_kind: 'signup_request', actor_sub: 'sub-joiner', payload: {}, note: null, to_state: null }]);
      expect((await membership.getMyAccount({}, JOINER)).account).toMatchObject({ status: MemberStatus.PENDING, route: AccountRoute.SIGNUP });
    });

    it('takes a sign-up without a number, for officer approval, and keeps no last name without one', async () => {
      await membership.submitSignup({ lastName: LAST }, JOINER2);
      expect(await signupRow('sub-joiner2')).toMatchObject({ last_name: null, membership_number: null, decision: 'pending' });
    });

    it('gives a repeat sign-up, an account already decided and an existing member the same answer, so it tells nothing', async () => {
      const answers = await Promise.all(
        [JOINER, MEMBER].map((options) => membership.submitSignup({ lastName: LAST, membershipNumber: NUMBER }, options).then(() => 'accepted', (error: unknown) => error)),
      );
      expect(answers).toEqual([
        expect.objectContaining({ code: Code.AlreadyExists, rawMessage: 'a sign-up is already on file for this account' }),
        expect.objectContaining({ code: Code.AlreadyExists, rawMessage: 'a sign-up is already on file for this account' }),
      ]);
    });

    it.each([
      ['a number without a last name', { membershipNumber: NUMBER }, Code.InvalidArgument, 'a last name is needed with a membership number'],
      ['a number with a letter', { lastName: LAST, membershipNumber: `${NUMBER}x` }, Code.InvalidArgument, 'a membership number is 1 to 12 digits'],
      ['a number of 13 digits', { lastName: LAST, membershipNumber: '1234567890123' }, Code.InvalidArgument, 'a membership number is 1 to 12 digits'],
      ['a last name over 80 characters', { lastName: 'L'.repeat(81), membershipNumber: NUMBER }, Code.InvalidArgument, 'a last name is at most 80 characters'],
    ])('refuses %s, without echoing it', async (_label, request, code, message) => {
      const error = await membership.submitSignup(request, JOINER3).then(
        () => undefined,
        (e: unknown) => e as { code: Code; rawMessage: string },
      );
      expect(error).toMatchObject({ code, rawMessage: message });
      expect(await signupRow('sub-joiner3')).toBeUndefined();
    });

    it('needs a signed-in person whose token carries a name and an email address', async () => {
      await expect(membership.submitSignup({})).rejects.toMatchObject({ code: Code.Unauthenticated });
      await expect(membership.submitSignup({}, as('noprofile-token'))).rejects.toMatchObject({ code: Code.FailedPrecondition, rawMessage: 'add your name and email to your account first' });
      await expect(membership.submitSignup({}, as('bademail-token'))).rejects.toMatchObject({ code: Code.FailedPrecondition, rawMessage: 'the email on your account is not an address' });
    });

    it('gives a sign-up that races another for the same account the same one answer, after waiting for it', async () => {
      const other = await api.pool.connect();
      try {
        await other.query('BEGIN');
        await other.query(`INSERT INTO signup_request (sub, display_name, email) VALUES ('sub-racer', 'Quinn Example', 'quinn@example.org')`);
        const racing = membership.submitSignup({}, as('racer-token')).then(
          () => 'accepted',
          (e: unknown) => e as { code: Code; rawMessage: string },
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        await other.query('COMMIT');
        expect(await racing).toMatchObject({ code: Code.AlreadyExists, rawMessage: 'a sign-up is already on file for this account' });
      } finally {
        other.release();
      }
    });
  });

  describe('ListSignupRequests', () => {
    it('shows approvers the pending sign-ups, oldest first, with route and verification, never the number or the last name', async () => {
      const { requests } = await membership.listSignupRequests({}, APPROVER);
      expect(requests.map((r) => [r.displayName, r.email, r.route, r.verification])).toEqual([
        ['Jamie Example', 'jamie@example.org', AccountRoute.SIGNUP, Verification.UNCHECKED],
        ['Robin Sample', 'robin@example.org', AccountRoute.SIGNUP, Verification.UNCHECKED],
        ['Quinn Example', 'quinn@example.org', AccountRoute.SIGNUP, Verification.UNCHECKED],
      ]);
      expect(dump(requests)).not.toContain(NUMBER);
      expect(dump(requests)).not.toContain(LAST);
      expect((await membership.listSignupRequests({}, ADMIN)).requests).toHaveLength(3);
    });

    it('is for approvers and the Admin only', async () => {
      for (const options of [MEMBER, as('officer-token'), WEBMASTER, JOINER]) {
        await expect(membership.listSignupRequests({}, options)).rejects.toMatchObject({ code: Code.PermissionDenied });
      }
      await expect(membership.listSignupRequests({})).rejects.toMatchObject({ code: Code.Unauthenticated });
    });
  });

  describe('ApproveSignup and RejectSignup', () => {
    it('approves a locally verified sign-up: a member from the verifier’s date, with the inputs already erased', async () => {
      const row = await signupRow('sub-joiner');
      await report(row?.id as string, 'verified_local');
      const listed = (await membership.listSignupRequests({}, APPROVER)).requests.find((r) => r.requestId === row?.id);
      expect(listed).toMatchObject({ verification: Verification.VERIFIED_LOCAL, verifiedOn: { year: 2026, month: 10, day: 20 } });
      const { account: approved } = await membership.approveSignup({ requestId: row?.id as string }, APPROVER);
      expect(approved).toMatchObject({ status: MemberStatus.MEMBER, route: AccountRoute.SIGNUP, verifiedOn: { year: 2026, month: 10, day: 20 } });
      expect(await signupRow('sub-joiner')).toMatchObject({ decision: 'approved', decided_by_sub: 'sub-approver', last_name: null, membership_number: null });
      expect(await account('sub-joiner')).toMatchObject({ status: 'member', approved_by_sub: 'sub-approver', verified_on: '2026-10-20' });
      expect((await audits(row?.id as string)).map((a) => [a.action, a.payload, a.note])).toEqual([
        ['signup', {}, null],
        ['approve', {}, null],
      ]);
      expect((await audits('sub-joiner')).map((a) => [a.action, a.subject_kind, a.payload])).toEqual([['approve_verified', 'member_account', {}]]);
    });

    it('approves an unverified sign-up on the officer’s word, as of today, erasing the number in the same statement', async () => {
      await membership.submitSignup({ lastName: LAST, membershipNumber: '7' }, JOINER3);
      const row = await signupRow('sub-joiner3');
      expect(row?.membership_number).toBe('7');
      await membership.approveSignup({ requestId: row?.id as string }, ADMIN);
      expect(await signupRow('sub-joiner3')).toMatchObject({ decision: 'approved', membership_number: null, last_name: null });
      expect(await account('sub-joiner3')).toMatchObject({ status: 'member', approved_by_sub: 'sub-admin', verified_on: '2026-10-22' });
      expect((await audits('sub-joiner3')).map((a) => a.action)).toEqual(['approve_attested']);
    });

    it('lets no one decide their own sign-up, and lets another approver do it', async () => {
      const { requestId } = await membership.submitSignup({ lastName: LAST, membershipNumber: NUMBER }, APPROVER);
      await expect(membership.approveSignup({ requestId }, APPROVER)).rejects.toMatchObject({ code: Code.PermissionDenied, rawMessage: 'no one decides their own sign-up' });
      await expect(membership.rejectSignup({ requestId }, APPROVER)).rejects.toMatchObject({ code: Code.PermissionDenied });
      await membership.rejectSignup({ requestId }, ADMIN);
      expect(await signupRow('sub-approver')).toMatchObject({ decision: 'rejected', decided_by_sub: 'sub-admin', membership_number: null, last_name: null });
      expect(await account('sub-approver')).toMatchObject({ status: 'pending' });
      expect((await audits(requestId)).map((a) => [a.action, a.payload])).toEqual([
        ['signup', {}],
        ['reject', {}],
      ]);
    });

    it('does not approve an other-group match as a member: it is rejected or granted as an affiliate', async () => {
      await membership.submitSignup({ lastName: LAST, membershipNumber: NUMBER }, as('affiliate-token'));
      const row = await signupRow('sub-affiliate');
      await report(row?.id as string, 'verified_other_group');
      await expect(membership.approveSignup({ requestId: row?.id as string }, APPROVER)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      expect(await signupRow('sub-affiliate')).toMatchObject({ decision: 'pending' });
    });

    it('does not approve a sign-up whose account was removed meanwhile, and changes nothing', async () => {
      const { requestId } = await membership.submitSignup({}, as('racer-token')).catch(() => ({ requestId: '' }));
      expect(requestId).toBe('');
      const row = await signupRow('sub-racer');
      await api.pool.query(`INSERT INTO member_account (sub, status, route, removed_at) VALUES ('sub-racer', 'removed', 'signup', now())`);
      await expect(membership.approveSignup({ requestId: row?.id as string }, APPROVER)).rejects.toMatchObject({ code: Code.FailedPrecondition, rawMessage: 'this account is not waiting for approval' });
      expect(await signupRow('sub-racer')).toMatchObject({ decision: 'pending' });
    });

    it('decides a sign-up once, and refuses an id it does not have or cannot read', async () => {
      const decided = (await signupRow('sub-joiner'))?.id as string;
      await expect(membership.approveSignup({ requestId: decided }, APPROVER)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      await expect(membership.rejectSignup({ requestId: decided }, APPROVER)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      await expect(membership.approveSignup({ requestId: '6a1f0c8e-0000-4000-8000-000000000000' }, APPROVER)).rejects.toMatchObject({ code: Code.NotFound });
      await expect(membership.approveSignup({ requestId: 'nope' }, APPROVER)).rejects.toMatchObject({ code: Code.InvalidArgument });
      await expect(membership.approveSignup({ requestId: decided }, MEMBER)).rejects.toMatchObject({ code: Code.PermissionDenied });
    });
  });

  describe('GrantAffiliate', () => {
    it('grants an other-group match affiliate standing from the verifier’s date, closing its sign-up', async () => {
      await expect(membership.grantAffiliate({ subject: 'sub-affiliate' }, APPROVER)).rejects.toMatchObject({ code: Code.PermissionDenied });
      const { account: granted } = await membership.grantAffiliate({ subject: 'sub-affiliate' }, WEBMASTER);
      expect(granted).toMatchObject({ status: MemberStatus.AFFILIATE, verifiedOn: { year: 2026, month: 10, day: 20 } });
      expect(await account('sub-affiliate')).toMatchObject({ status: 'affiliate', affiliate_granted_by_sub: 'sub-webmaster', verified_on: '2026-10-20' });
      expect(await signupRow('sub-affiliate')).toMatchObject({ decision: 'approved', decided_by_sub: 'sub-webmaster' });
      expect((await audits('sub-affiliate')).map((a) => [a.action, a.payload])).toEqual([['grant_affiliate_verified', {}]]);
    });

    it('grants an invited affiliate with no verifier result on the grantor’s attestation, as of today', async () => {
      const { account: granted } = await membership.grantAffiliate({ subject: 'sub-invited-rvc' }, ADMIN);
      expect(granted).toMatchObject({ status: MemberStatus.AFFILIATE, route: AccountRoute.ADMIN_GRANT, verifiedOn: { year: 2026, month: 10, day: 22 } });
      expect((await audits('sub-invited-rvc')).map((a) => [a.action, a.actor_sub, a.payload])).toEqual([['grant_affiliate_attested', 'sub-admin', {}]]);
    });

    it('refuses a member, an affiliate, a removed account and a malformed subject', async () => {
      await expect(membership.grantAffiliate({ subject: 'sub-member' }, ADMIN)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      await expect(membership.grantAffiliate({ subject: 'sub-affiliate' }, ADMIN)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      await expect(membership.grantAffiliate({ subject: 'sub-admin' }, ADMIN)).rejects.toMatchObject({ code: Code.PermissionDenied, rawMessage: 'no one grants themselves' });
      await expect(membership.grantAffiliate({ subject: '' }, ADMIN)).rejects.toMatchObject({ code: Code.InvalidArgument });
      await expect(membership.grantAffiliate({ subject: 's'.repeat(256) }, ADMIN)).rejects.toMatchObject({ code: Code.InvalidArgument });
    });
  });

  describe('ListMembers and RemoveMember', () => {
    it('lists accounts with member-level standing for approvers, with the re-check flag past 12 months', async () => {
      await api.pool.query(
        `INSERT INTO member_account (sub, status, route, approved_by_sub, approved_at, verified_on) VALUES ('sub-old', 'member', 'invite', 'sub-admin', now(), '2025-10-01'), ('sub-grace', 'member', 'invite', 'sub-admin', now(), '2025-10-22')`,
      );
      // An affiliate granted before grants recorded a date: due at once.
      await api.pool.query(
        `INSERT INTO member_account (sub, status, route, affiliate_granted_by_sub, affiliate_granted_at) VALUES ('sub-undated', 'affiliate', 'admin_grant', 'sub-admin', now())`,
      );
      const { members } = await membership.listMembers({}, APPROVER);
      const bySubject = new Map(members.map((m) => [m.subject, m]));
      expect(bySubject.get('sub-joiner')).toMatchObject({ displayName: 'Jamie Example', email: 'jamie@example.org', status: MemberStatus.MEMBER, recheckDue: false });
      expect(bySubject.get('sub-affiliate')).toMatchObject({ status: MemberStatus.AFFILIATE });
      expect(bySubject.get('sub-old')).toMatchObject({ displayName: '', route: AccountRoute.INVITE, recheckDue: true });
      expect(bySubject.get('sub-grace')).toMatchObject({ recheckDue: false });
      expect(bySubject.get('sub-undated')).toMatchObject({ recheckDue: true });
      expect(bySubject.get('sub-undated')?.verifiedOn).toBeUndefined();
      expect(bySubject.has('sub-joiner2')).toBe(false);
      expect((await membership.listMembers({ recheckDueOnly: true }, ADMIN)).members.map((m) => m.subject)).toEqual(['sub-old', 'sub-undated']);
      expect(dump(members)).not.toContain(NUMBER);
      await expect(membership.listMembers({}, WEBMASTER)).rejects.toMatchObject({ code: Code.PermissionDenied });
    });

    it('removes a member, who then reads at public level, with an audit row and no payload', async () => {
      expect((await membership.getMyAccount({}, JOINER)).account?.status).toBe(MemberStatus.MEMBER);
      await membership.removeMember({ subject: 'sub-joiner' }, APPROVER);
      expect(await account('sub-joiner')).toMatchObject({ status: 'removed' });
      expect((await audits('sub-joiner')).map((a) => [a.action, a.payload]).at(-1)).toEqual(['remove', {}]);
      await expect(membership.removeMember({ subject: 'sub-joiner' }, APPROVER)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      await expect(membership.removeMember({ subject: 'sub-nobody' }, APPROVER)).rejects.toMatchObject({ code: Code.NotFound });
      await expect(membership.removeMember({ subject: 'sub-old' }, MEMBER)).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(membership.grantAffiliate({ subject: 'sub-joiner' }, ADMIN)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    });
  });

  describe('GetMyAccount', () => {
    it('answers a signed-in person with no account with no account, and an anonymous caller not at all', async () => {
      expect((await membership.getMyAccount({}, as('pub-token'))).account).toBeUndefined();
      await expect(membership.getMyAccount({})).rejects.toMatchObject({ code: Code.Unauthenticated });
    });
  });

  it('writes no note and no payload on any membership audit row, and the number and last name nowhere in the log', async () => {
    const { rows } = await api.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_event WHERE subject_kind IN ('member_account', 'signup_request') AND (payload <> '{}'::jsonb OR note IS NOT NULL)`,
    );
    expect(rows[0]?.n).toBe(0);
    const { rows: all } = await api.pool.query<{ text: string }>(`SELECT coalesce(string_agg(audit_event::text, ' '), '') AS text FROM audit_event`);
    expect(all[0]?.text).not.toContain(NUMBER);
    expect(all[0]?.text).not.toContain(LAST);
    expect(JSON.stringify(api.logs)).not.toContain(NUMBER);
    expect(JSON.stringify(api.logs)).not.toContain(LAST);
    expect(NOW.toISOString()).toBe('2026-10-22T15:00:00.000Z');
  });
});
