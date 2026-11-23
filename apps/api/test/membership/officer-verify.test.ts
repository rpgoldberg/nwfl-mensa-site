// OFFICER-VERIFY, the membership side:
//   - The invite route: the invited group, or any officer power (held or withheld), opens the account
//     with the invite route, and the first name is then required.
//   - GetMyAccount says whether the caller's officer tools are open or wait for the membership check.
//   - The verifier is given the typed first name and reports whether it matched and the member's local
//     group (Ross 11-23). The site keeps both and tells a chapter member (CHAPTER_GROUP_NAME) from a guest.
//   - An invited sign-up whose report is a full match in the chapter's own group is approved by the
//     report itself, as the verifier; anything else waits for an approver.
//   - By hand, an invited sign-up is approved only once the number and the last name were confirmed and
//     no first-name mismatch was reported; an other-group sign-up is approved as a guest member.
//   - GetSignupRequest: where one sign-up stands, for the approvers.
// Every name here is made up; local group names are public.
import { Code, ConnectError } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TokenVerifier, VerifiedToken } from '../../src/auth/caller.js';
import { ApprovalRuleService } from '../../src/gen/nwfl/mensa/v1/approval_pb.js';
import { AccountRoute, LocalGroupStanding, MembershipService, OfficerTools, SignupDecision } from '../../src/gen/nwfl/mensa/v1/membership_pb.js';
import { MembershipVerifierService, VerificationOutcome } from '../../src/gen/nwfl/mensa/v1/membership_verifier_pb.js';
import { type Api, startApi } from '../helpers/api.js';
import { live } from '../helpers/pg.js';

const CHAPTER = 'Northwest Florida Mensa';
const person = (subject: string, groups: string[]): VerifiedToken => ({ client: 'site', subject, groups, scopes: [], name: `Sam ${subject}`, email: `${subject}@example.org` });
const OFFICER = ['nwfl-members', 'nwfl-officers'];
const PEOPLE: Record<string, VerifiedToken> = {
  verifier: { client: 'verifier', subject: 'svc-nwfl-verifier', groups: [], scopes: ['membership.verify'] },
  // The approver, a verified chapter member (seeded below).
  approver: person('sub-ovm-approver', ['nwfl-members', 'nwfl-officers', 'nwfl-office-membership', 'nwfl-membership-approvers']),
  member: person('sub-ovm-member', ['nwfl-members']),
};
const verifier: TokenVerifier = {
  verify: (token) => {
    const known = PEOPLE[token];
    if (known !== undefined) return Promise.resolve(known);
    // officer:<n>, invitee:<n>, joiner:<n>: a fresh person per test.
    const [kind, n] = token.split('.');
    if (kind === 'officer') return Promise.resolve(person(`sub-ovm-officer-${n}`, OFFICER));
    if (kind === 'invitee') return Promise.resolve(person(`sub-ovm-invitee-${n}`, ['nwfl-users', 'nwfl-invited']));
    if (kind === 'joiner') return Promise.resolve(person(`sub-ovm-joiner-${n}`, ['nwfl-pending']));
    return Promise.reject(new Error('unknown token'));
  },
};
const as = (token: string): { headers: Record<string, string> } => ({ headers: { authorization: `Bearer ${token}` } });
const code = async (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => 'ok',
    (error: unknown) => Code[ConnectError.from(error).code],
  );

describe.skipIf(!live)('OFFICER-VERIFY: membership', () => {
  let on: Api;
  let off: Api;
  let unnamed: Api;
  let n = 0;
  const next = (): number => (n += 1);

  beforeAll(async () => {
    on = await startApi('nwfl_ovm_on', { verifier, officerVerify: true });
    off = await startApi('nwfl_ovm_off', { verifier });
    // A deployment with no CHAPTER_GROUP_NAME: no one is a chapter member, so nothing is approved alone.
    unnamed = await startApi('nwfl_ovm_unnamed', { verifier, chapterGroup: null });
    for (const api of [on, off, unnamed]) {
      await api.pool.query(
        `INSERT INTO member_account (sub, status, route, approved_by_sub, approved_at, verified_on, chapter_member) VALUES ('sub-ovm-approver', 'member', 'invite', 'svc-nwfl-verifier', now(), '2026-10-01', true)`,
      );
    }
  });

  afterAll(async () => {
    await on?.close();
    await off?.close();
    await unnamed?.close();
  });

  const signUp = async (api: Api, token: string, firstName = 'Sam'): Promise<string> =>
    (await api.client(MembershipService).submitSignup({ membershipNumber: String(4000000 + next()), lastName: 'Madeup', firstName }, as(token))).requestId;
  const report = (api: Api, requestId: string, outcome: VerificationOutcome, extra: { firstNameMatched?: boolean; localGroup?: string } = {}) =>
    api.client(MembershipVerifierService).reportVerification({ requestId, outcome, ...extra }, as('verifier'));
  const signupRow = async (api: Api, id: string) =>
    (
      await api.pool.query<{ decision: string; decided_by_sub: string | null; first_name_matched: boolean | null; local_group: string | null; route: string; status: string; chapter_member: boolean | null; approved_by_sub: string | null; verified_on: string | null }>(
        `SELECT s.decision, s.decided_by_sub, s.first_name_matched, s.local_group, a.route, a.status, a.chapter_member, a.approved_by_sub, a.verified_on::text AS verified_on
         FROM signup_request s JOIN member_account a ON a.sub = s.sub WHERE s.id = $1`,
        [id],
      )
    ).rows[0];

  describe('the invite route', () => {
    it('opens with the invite route for the invited group, and for an officer power, withheld (on) or held (off)', async () => {
      for (const [api, token] of [
        [on, `invitee.${next()}`],
        [on, `officer.${next()}`],
        [off, `officer.${next()}`],
      ] as const) {
        expect((await signupRow(api, await signUp(api, token)))?.route).toBe('invite');
      }
      expect((await signupRow(on, await signUp(on, `joiner.${next()}`)))?.route).toBe('signup');
    });

    it('needs the first name on the invite route, and not on a plain sign-up', async () => {
      const client = on.client(MembershipService);
      for (const token of [`invitee.${next()}`, `officer.${next()}`]) {
        await expect(client.submitSignup({ membershipNumber: '4100001', lastName: 'Madeup', firstName: '  ' }, as(token))).rejects.toMatchObject({
          code: Code.InvalidArgument,
          rawMessage: 'a first name is needed',
        });
      }
      expect(await code(client.submitSignup({ membershipNumber: '4100002', lastName: 'Madeup', firstName: '' }, as(`joiner.${next()}`)))).toBe('ok');
    });
  });

  describe('GetMyAccount: the officer tools', () => {
    it('are open for a verified officer, wait for the check for an unverified one (on), and are open for any officer (off)', async () => {
      const tools = async (api: Api, token: string) => (await api.client(MembershipService).getMyAccount({}, as(token))).officerTools;
      expect(await tools(on, 'approver')).toBe(OfficerTools.OPEN);
      expect(await tools(on, `officer.${next()}`)).toBe(OfficerTools.AWAITING_CHECK);
      expect(await tools(off, `officer.${next()}`)).toBe(OfficerTools.OPEN);
      expect(await tools(on, 'member')).toBe(OfficerTools.UNSPECIFIED);
      expect(await tools(on, `invitee.${next()}`)).toBe(OfficerTools.UNSPECIFIED);
    });
  });

  describe('the membership check', () => {
    it('is given the typed first name (empty when none was typed)', async () => {
      const named = await signUp(on, `invitee.${next()}`, 'Robin');
      const plain = await signUp(on, `joiner.${next()}`, '');
      const { pending } = await on.client(MembershipVerifierService).listPendingVerifications({ pageSize: 10 }, as('verifier'));
      expect(pending.find((p) => p.requestId === named)?.firstName).toBe('Robin');
      expect(pending.find((p) => p.requestId === plain)?.firstName).toBe('');
      // Leave the list for the tests below.
      await report(on, named, VerificationOutcome.NOT_FOUND);
      await report(on, plain, VerificationOutcome.NOT_FOUND);
    });

    it('keeps the first-name answer and the local group with the report, trimmed; not said is NULL', async () => {
      const a = await signUp(on, `joiner.${next()}`);
      await report(on, a, VerificationOutcome.VERIFIED_OTHER_GROUP, { firstNameMatched: false, localGroup: '  Boston Mensa ' });
      expect(await signupRow(on, a)).toMatchObject({ first_name_matched: false, local_group: 'Boston Mensa', decision: 'pending' });
      const b = await signUp(on, `joiner.${next()}`);
      await report(on, b, VerificationOutcome.VERIFIED_LOCAL);
      expect(await signupRow(on, b)).toMatchObject({ first_name_matched: null, local_group: null });
    });

    it('refuses a bad local group, and a first-name answer for a sign-up that typed none', async () => {
      const id = await signUp(on, `joiner.${next()}`, '');
      for (const extra of [{ localGroup: 'M'.repeat(121) }, { localGroup: 'Boston\u0007Mensa' }, { firstNameMatched: true }]) {
        expect(await code(report(on, id, VerificationOutcome.VERIFIED_LOCAL, extra))).toBe('InvalidArgument');
      }
      expect(await signupRow(on, id)).toMatchObject({ first_name_matched: null, local_group: null });
    });

    it('answers a retried report OK only when everything matches, the new answers included', async () => {
      const id = await signUp(on, `joiner.${next()}`);
      await report(on, id, VerificationOutcome.VERIFIED_LOCAL, { firstNameMatched: true, localGroup: 'Boston Mensa' });
      expect(await code(report(on, id, VerificationOutcome.VERIFIED_LOCAL, { firstNameMatched: true, localGroup: 'Boston Mensa' }))).toBe('ok');
      expect(await code(report(on, id, VerificationOutcome.VERIFIED_LOCAL, { firstNameMatched: false, localGroup: 'Boston Mensa' }))).toBe('FailedPrecondition');
      expect(await code(report(on, id, VerificationOutcome.VERIFIED_LOCAL, { firstNameMatched: true, localGroup: CHAPTER }))).toBe('FailedPrecondition');
    });
  });

  describe('approval by the report itself', () => {
    it('approves an invited officer on a full match in the chapter\'s group, as the verifier, and the officer tools open', async () => {
      const token = `officer.${next()}`;
      const id = await signUp(on, token);
      await expect(on.client(ApprovalRuleService).getApprovalRules({}, as(token))).rejects.toMatchObject({ code: Code.PermissionDenied });
      await report(on, id, VerificationOutcome.VERIFIED_LOCAL, { firstNameMatched: true, localGroup: CHAPTER });
      expect(await signupRow(on, id)).toEqual({
        decision: 'approved',
        decided_by_sub: 'svc-nwfl-verifier',
        first_name_matched: true,
        local_group: CHAPTER,
        route: 'invite',
        status: 'member',
        chapter_member: true,
        approved_by_sub: 'svc-nwfl-verifier',
        verified_on: '2026-10-22',
      });
      const { rows } = await on.pool.query<{ action: string; actor_kind: string; subject_kind: string }>(
        `SELECT action, actor_kind, subject_kind FROM audit_event WHERE action LIKE 'approve%' AND (subject_id = $1 OR subject_id = $2) ORDER BY id`,
        [id, `sub-ovm-officer-${token.split('.')[1]}`],
      );
      expect(rows).toEqual([
        { action: 'approve_auto', actor_kind: 'verifier', subject_kind: 'signup_request' },
        { action: 'approve_verified', actor_kind: 'verifier', subject_kind: 'member_account' },
      ]);
      expect(await code(on.client(ApprovalRuleService).getApprovalRules({}, as(token)))).toBe('ok');
      expect((await on.client(MembershipService).getMyAccount({}, as(token))).officerTools).toBe(OfficerTools.OPEN);
      // The same report again is answered OK, and changes nothing.
      expect(await code(report(on, id, VerificationOutcome.VERIFIED_LOCAL, { firstNameMatched: true, localGroup: CHAPTER }))).toBe('ok');
    });

    it.each<[string, VerificationOutcome, { firstNameMatched?: boolean; localGroup?: string }, 'invitee' | 'joiner']>([
      ['a plain sign-up', VerificationOutcome.VERIFIED_LOCAL, { firstNameMatched: true, localGroup: CHAPTER }, 'joiner'],
      ['a first-name mismatch', VerificationOutcome.VERIFIED_LOCAL, { firstNameMatched: false, localGroup: CHAPTER }, 'invitee'],
      ['no first-name answer', VerificationOutcome.VERIFIED_LOCAL, { localGroup: CHAPTER }, 'invitee'],
      ['another local group', VerificationOutcome.VERIFIED_LOCAL, { firstNameMatched: true, localGroup: 'Boston Mensa' }, 'invitee'],
      ['no local group reported', VerificationOutcome.VERIFIED_LOCAL, { firstNameMatched: true }, 'invitee'],
      ['an email mismatch', VerificationOutcome.EMAIL_MISMATCH, { firstNameMatched: true, localGroup: CHAPTER }, 'invitee'],
      ['an other-group match', VerificationOutcome.VERIFIED_OTHER_GROUP, { firstNameMatched: true, localGroup: CHAPTER }, 'invitee'],
    ])('leaves %s for an approver', async (_why, outcome, extra, kind) => {
      const id = await signUp(on, `${kind}.${next()}`);
      await report(on, id, outcome, extra);
      expect(await signupRow(on, id)).toMatchObject({ decision: 'pending', status: 'pending' });
    });

    it('approves nothing alone where no chapter group is configured', async () => {
      const id = await signUp(unnamed, `invitee.${next()}`);
      await report(unnamed, id, VerificationOutcome.VERIFIED_LOCAL, { firstNameMatched: true, localGroup: CHAPTER });
      expect(await signupRow(unnamed, id)).toMatchObject({ decision: 'pending', local_group: CHAPTER });
    });
  });

  describe('approval by hand', () => {
    const approve = (api: Api, requestId: string, confirmedWarning = false) => code(api.client(MembershipService).approveSignup({ requestId, confirmedWarning }, as('approver')));

    it.each<[string, VerificationOutcome | null, { firstNameMatched?: boolean; localGroup?: string }]>([
      ['unchecked', null, {}],
      ['not found', VerificationOutcome.NOT_FOUND, {}],
      ['a check error', VerificationOutcome.ERROR, {}],
      ['a duplicate claim', VerificationOutcome.DUPLICATE_CLAIM, {}],
      ['a first-name mismatch', VerificationOutcome.VERIFIED_LOCAL, { firstNameMatched: false, localGroup: 'Boston Mensa' }],
    ])('refuses an invited sign-up whose check is %s, even confirmed: reject or reopen it', async (_why, outcome, extra) => {
      const id = await signUp(on, `invitee.${next()}`);
      if (outcome !== null) await report(on, id, outcome, extra);
      await expect(on.client(MembershipService).approveSignup({ requestId: id, confirmedWarning: true }, as('approver'))).rejects.toMatchObject({
        code: Code.FailedPrecondition,
        rawMessage: expect.stringMatching(/^an invited sign-up is approved only once the membership check confirmed/) as unknown,
      });
      expect(await signupRow(on, id)).toMatchObject({ decision: 'pending' });
      expect(await code(on.client(MembershipService).rejectSignup({ requestId: id }, as('approver')))).toBe('ok');
    });

    it('approves an invited sign-up the check confirmed: a local match with no first-name answer, and an email mismatch once confirmed', async () => {
      const local = await signUp(on, `invitee.${next()}`);
      await report(on, local, VerificationOutcome.VERIFIED_LOCAL, { localGroup: CHAPTER });
      expect(await approve(on, local)).toBe('ok');
      expect(await signupRow(on, local)).toMatchObject({ decision: 'approved', chapter_member: true });
      const mismatch = await signUp(on, `invitee.${next()}`);
      await report(on, mismatch, VerificationOutcome.EMAIL_MISMATCH, { firstNameMatched: true, localGroup: CHAPTER });
      expect(await approve(on, mismatch)).toBe('FailedPrecondition');
      expect(await approve(on, mismatch, true)).toBe('ok');
    });

    it('still approves a plain sign-up the check did not confirm, on the approver\'s word', async () => {
      const id = await signUp(on, `joiner.${next()}`);
      await report(on, id, VerificationOutcome.NOT_FOUND);
      expect(await approve(on, id)).toBe('ok');
      expect(await signupRow(on, id)).toMatchObject({ decision: 'approved', chapter_member: null });
    });

    it('approves an other-group sign-up as a guest member, who holds no officer power', async () => {
      const token = `officer.${next()}`;
      const id = await signUp(on, token);
      await report(on, id, VerificationOutcome.VERIFIED_OTHER_GROUP, { firstNameMatched: true });
      expect(await approve(on, id)).toBe('ok');
      expect(await signupRow(on, id)).toMatchObject({ decision: 'approved', status: 'member', chapter_member: false });
      const account = await on.client(MembershipService).getMyAccount({}, as(token));
      expect(account.account?.localGroupStanding).toBe(LocalGroupStanding.GUEST);
      expect(account.officerTools).toBe(OfficerTools.AWAITING_CHECK);
      await expect(on.client(ApprovalRuleService).getApprovalRules({}, as(token))).rejects.toMatchObject({ code: Code.PermissionDenied });
    });

    it('marks the account by the reported group: the chapter\'s, another, or one not among the known groups', async () => {
      for (const [group, chapter, standing] of [
        [CHAPTER, true, LocalGroupStanding.CHAPTER],
        ['Boston Mensa', false, LocalGroupStanding.GUEST],
        ['No group assigned', false, LocalGroupStanding.GUEST],
        ['Atlantis Mensa', false, LocalGroupStanding.GUEST_UNLISTED],
      ] as const) {
        const token = `joiner.${next()}`;
        const id = await signUp(on, token);
        await report(on, id, VerificationOutcome.VERIFIED_LOCAL, { firstNameMatched: false, localGroup: group });
        const listed = (await on.client(MembershipService).listSignupRequests({}, as('approver'))).requests.find((r) => r.requestId === id);
        expect(listed).toMatchObject({ firstNameMatched: false, localGroup: group, localGroupStanding: standing, route: AccountRoute.SIGNUP });
        expect(await approve(on, id)).toBe('ok');
        expect(await signupRow(on, id)).toMatchObject({ chapter_member: chapter });
        const mine = await on.client(MembershipService).getMyAccount({}, as(token));
        expect(mine.account?.localGroupStanding).toBe(standing);
        expect(mine.profile?.localGroup).toBe(group);
      }
    });
  });

  describe('GetSignupRequest', () => {
    const decision = async (requestId: string, token = 'approver') => (await on.client(MembershipService).getSignupRequest({ requestId }, as(token))).decision;

    it('says where one sign-up stands: pending, approved, rejected, reopened', async () => {
      const pending = await signUp(on, `joiner.${next()}`);
      expect(await decision(pending)).toBe(SignupDecision.PENDING);
      const approved = await signUp(on, `joiner.${next()}`);
      await on.client(MembershipService).approveSignup({ requestId: approved }, as('approver'));
      expect(await decision(approved)).toBe(SignupDecision.APPROVED);
      const rejected = await signUp(on, `joiner.${next()}`);
      await on.client(MembershipService).rejectSignup({ requestId: rejected }, as('approver'));
      expect(await decision(rejected)).toBe(SignupDecision.REJECTED);
      await on.client(MembershipService).reopenSignup({ requestId: rejected }, as('approver'));
      expect(await decision(rejected)).toBe(SignupDecision.REOPENED);
    });

    it('is NOT_FOUND for no such sign-up, INVALID_ARGUMENT for a malformed id, and for the approvers only', async () => {
      const client = on.client(MembershipService);
      expect(await code(client.getSignupRequest({ requestId: '0b6c1e5a-3d2f-4a8b-9c7d-1e2f3a4b5c6d' }, as('approver')))).toBe('NotFound');
      expect(await code(client.getSignupRequest({ requestId: 'approved' }, as('approver')))).toBe('InvalidArgument');
      const id = await signUp(on, `joiner.${next()}`);
      expect(await code(client.getSignupRequest({ requestId: id }, as('member')))).toBe('PermissionDenied');
      expect(await code(client.getSignupRequest({ requestId: id }, as(`officer.${next()}`)))).toBe('PermissionDenied');
      expect(await code(client.getSignupRequest({ requestId: id }))).toBe('Unauthenticated');
    });
  });
});
