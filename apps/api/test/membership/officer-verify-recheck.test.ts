// OFFICER-VERIFY fix round 3, switched ON (switched off is officer-verify-off.test.ts):
//   B1  A check that did not confirm the person never makes a chapter member: the local group and the
//       first-name answer are kept only with an outcome that confirms the number and the last name, and
//       hand approval makes no such outcome. So a person approved on an approver's word and later given
//       a power group holds no power.
//   S1  An officer power needs the first name confirmed too (Ross 11-23: "confirm their membership
//       number, last name, first name"), whenever the person joined.
//   S2  No dead ends: an approved member or affiliate whose tools wait asks for a fresh check by sending
//       their details again (SubmitSignup); a confirming report opens the tools. A confirmed guest
//       member's tools open on an Admin's affiliate grant (Ross: "officer tools if admin grants"), and
//       never for someone the check did not confirm.
// Every name here is made up; local group names are public.
import { Code, ConnectError } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TokenVerifier, VerifiedToken } from '../../src/auth/caller.js';
import { dbStanding } from '../../src/auth/standing.js';
import { LocalGroupStanding, MemberStatus, MembershipService, OfficerCheck, OfficerTools, Verification } from '../../src/gen/nwfl/mensa/v1/membership_pb.js';
import { MembershipVerifierService, VerificationOutcome as O } from '../../src/gen/nwfl/mensa/v1/membership_verifier_pb.js';
import { type Api, NOW, startApi } from '../helpers/api.js';
import { live } from '../helpers/pg.js';
import { seedAccount } from '../helpers/standing.js';

const CHAPTER = 'Northwest Florida Mensa';
const POWERS = ['nwfl-members', 'nwfl-officers', 'nwfl-admin', 'nwfl-webmaster', 'nwfl-membership-approvers', 'nwfl-office-membership'];
const person = (subject: string, groups: string[]): VerifiedToken => ({ client: 'site', subject, groups, scopes: [], name: `Sam ${subject}`, email: `${subject}@example.org` });
const PEOPLE: Record<string, VerifiedToken> = {
  verifier: { client: 'verifier', subject: 'svc-nwfl-verifier', groups: [], scopes: ['membership.verify'] },
  // Both fully checked chapter members (seeded below).
  approver: person('sub-ovr-approver', ['nwfl-members', 'nwfl-officers', 'nwfl-office-membership', 'nwfl-membership-approvers']),
  admin: person('sub-ovr-admin', ['nwfl-members', 'nwfl-admin', 'nwfl-webmaster', 'nwfl-officers']),
};
const verifier: TokenVerifier = {
  verify: (token) => {
    const known = PEOPLE[token];
    if (known !== undefined) return Promise.resolve(known);
    // joiner.<n> signs up with no power; promoted.<n> is the same person, later given every power group.
    // officer.<n> holds the powers from the start.
    const [kind, n] = token.split('.');
    if (kind === 'joiner') return Promise.resolve(person(`sub-ovr-person-${n}`, ['nwfl-pending']));
    if (kind === 'promoted') return Promise.resolve(person(`sub-ovr-person-${n}`, POWERS));
    if (kind === 'officer') return Promise.resolve(person(`sub-ovr-officer-${n}`, POWERS));
    return Promise.reject(new Error('unknown token'));
  },
};
const as = (token: string): { headers: Record<string, string> } => ({ headers: { authorization: `Bearer ${token}` } });
const code = async (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => 'ok',
    (error: unknown) => Code[ConnectError.from(error).code],
  );
type Extra = { firstNameMatched?: boolean; localGroup?: string; conflictingRequestId?: string };

describe.skipIf(!live)('OFFICER-VERIFY fix round 3: a confirmed check for every power, and no dead ends', () => {
  let on: Api;
  let n = 0;
  const next = (): number => (n += 1);

  beforeAll(async () => {
    on = await startApi('nwfl_ovr_on', { verifier, officerVerify: true });
    await seedAccount(on.pool, { sub: 'sub-ovr-approver', route: 'invite', check: { localGroup: CHAPTER } });
    await seedAccount(on.pool, { sub: 'sub-ovr-admin', route: 'invite', check: { localGroup: CHAPTER } });
  });

  afterAll(async () => {
    await on?.close();
  });

  const m = () => on.client(MembershipService);
  const v = () => on.client(MembershipVerifierService);
  const numberOf = (i: number): string => String(6000000 + i);
  /** Signs up as `<kind>.<i>`; the number is 6000000 + i. */
  const signUp = async (kind: 'joiner' | 'officer', firstName = 'Sam'): Promise<{ i: number; id: string; sub: string }> => {
    const i = next();
    const { requestId } = await m().submitSignup({ membershipNumber: numberOf(i), lastName: 'Madeup', firstName }, as(`${kind}.${i}`));
    return { i, id: requestId, sub: `sub-ovr-${kind === 'officer' ? 'officer' : 'person'}-${i}` };
  };
  const report = (id: string, outcome: O, extra: Extra = {}) => v().reportVerification({ requestId: id, outcome, ...extra }, as('verifier'));
  const approve = (id: string) => code(m().approveSignup({ requestId: id, confirmedWarning: true }, as('approver')));
  const kindOf = (sub: string) => dbStanding(on.pool, () => NOW, CHAPTER).standingOf(sub);
  const mine = (token: string) => m().getMyAccount({}, as(token));
  /** An approver's power, as the API gives it to this token. */
  const power = (token: string) => code(m().listSignupRequests({}, as(token)));
  const row = async (id: string) =>
    (
      await on.pool.query<{
        verification: string;
        first_name_matched: boolean | null;
        local_group: string | null;
        decision: string;
        first_name: string | null;
        last_name: string | null;
        membership_number: string | null;
        status: string;
      }>(
        `SELECT s.verification, s.first_name_matched, s.local_group, s.decision, s.first_name, s.last_name, s.membership_number, a.status
         FROM signup_request s JOIN member_account a ON a.sub = s.sub WHERE s.id = $1`,
        [id],
      )
    ).rows[0];
  const pendingIds = async () => (await v().listPendingVerifications({ pageSize: 10 }, as('verifier'))).pending;
  const audits = async (subjectId: string) => (await on.pool.query<{ action: string }>(`SELECT action FROM audit_event WHERE subject_id = $1 ORDER BY id`, [subjectId])).rows.map((r) => r.action);
  /** A joiner approved by hand after this report, then given every power group (promoted.<i>). */
  const joined = async (outcome: O, extra: Extra = {}, firstName = 'Sam') => {
    const person = await signUp('joiner', firstName);
    await report(person.id, outcome, extra);
    expect(await approve(person.id)).toBe('ok');
    return { ...person, token: `promoted.${person.i}` };
  };
  /** An officer approved by hand after this report (officer.<i>). */
  const officer = async (outcome: O, extra: Extra = {}) => {
    const person = await signUp('officer');
    await report(person.id, outcome, extra);
    expect(await approve(person.id)).toBe('ok');
    return { ...person, token: `officer.${person.i}` };
  };

  describe('B1: a check that did not confirm the person', () => {
    it.each<[string, O, Extra]>([
      ['not found', O.NOT_FOUND, { localGroup: CHAPTER }],
      ['a check error', O.ERROR, { localGroup: CHAPTER, firstNameMatched: true }],
      ['a duplicate claim', O.DUPLICATE_CLAIM, { localGroup: CHAPTER, firstNameMatched: true }],
    ])('%s, reported with the chapter\'s group: nothing of it is kept, and hand approval and a power group later give no power', async (_why, outcome, extra) => {
      const person = await signUp('joiner');
      await report(person.id, outcome, extra);
      expect(await row(person.id)).toMatchObject({ local_group: null, first_name_matched: null });
      const queued = (await m().listSignupRequests({}, as('approver'))).requests.find((r) => r.requestId === person.id);
      expect(queued).toMatchObject({ localGroup: '', localGroupStanding: LocalGroupStanding.UNSPECIFIED });
      expect(queued?.firstNameMatched).toBeUndefined();
      // The same report again is still answered OK.
      expect(await code(report(person.id, outcome, extra))).toBe('ok');
      expect(await approve(person.id)).toBe('ok');
      expect(await kindOf(person.sub)).toBe('unconfirmed');
      const token = `promoted.${person.i}`;
      expect((await mine(token)).officerTools).toBe(OfficerTools.AWAITING_CHECK);
      expect(await power(token)).toBe('PermissionDenied');
      expect(await code(m().listMembers({}, as(token)))).toBe('PermissionDenied');
    });

    it('a confirmed local match in the chapter\'s group, first name too, holds the power once given the groups (control)', async () => {
      const person = await joined(O.VERIFIED_LOCAL, { localGroup: CHAPTER, firstNameMatched: true });
      expect(await kindOf(person.sub)).toBe('chapter');
      expect((await mine(person.token)).officerTools).toBe(OfficerTools.OPEN);
      expect(await power(person.token)).toBe('ok');
    });
  });

  describe('S1: the first name is part of the check', () => {
    it.each<[string, Extra, string]>([
      ['a first-name mismatch', { localGroup: CHAPTER, firstNameMatched: false }, 'Sam'],
      ['no first-name answer', { localGroup: CHAPTER }, 'Sam'],
      ['no first name typed', { localGroup: CHAPTER }, ''],
    ])('a chapter member who joined earlier with %s, later given a power group, waits for the check', async (_why, extra, firstName) => {
      const person = await joined(O.VERIFIED_LOCAL, extra, firstName);
      expect(await kindOf(person.sub)).toBe('chapter_partial');
      const account = await mine(person.token);
      expect(account.officerTools).toBe(OfficerTools.AWAITING_CHECK);
      expect(account.officerCheck).toBe(OfficerCheck.CONFIRM_DETAILS);
      // Still a chapter member, reading as one.
      expect(account.account?.localGroupStanding).toBe(LocalGroupStanding.CHAPTER);
      expect(await power(person.token)).toBe('PermissionDenied');
    });

    it('an invited officer approved by hand on a local match with no first-name answer waits too', async () => {
      const person = await officer(O.VERIFIED_LOCAL, { localGroup: CHAPTER });
      expect((await mine(person.token)).officerTools).toBe(OfficerTools.AWAITING_CHECK);
      expect(await power(person.token)).toBe('PermissionDenied');
    });
  });

  describe('S2a: a fresh check through the site', () => {
    it('sends the details again, is checked again under the same id, and a full match opens the tools', async () => {
      const person = await joined(O.VERIFIED_LOCAL, { localGroup: CHAPTER, firstNameMatched: false }, 'Sammy');
      const before = await on.pool.query(`SELECT * FROM member_account WHERE sub = $1`, [person.sub]);
      const again = await m().submitSignup({ membershipNumber: '', lastName: 'Madeup-Example', firstName: 'Samuel' }, as(person.token));
      expect(again.requestId).toBe(person.id);
      // The names are theirs to change; the number and the decision are not touched; the earlier answers stand meanwhile.
      expect(await row(person.id)).toEqual({
        verification: 'verified_local',
        first_name_matched: false,
        local_group: CHAPTER,
        decision: 'approved',
        first_name: 'Samuel',
        last_name: 'Madeup-Example',
        membership_number: numberOf(person.i),
        status: 'member',
      });
      expect(await kindOf(person.sub)).toBe('chapter_partial');
      expect((await mine(person.token)).officerCheck).toBe(OfficerCheck.RUNNING);
      // One fresh check at a time.
      expect(await code(m().submitSignup({ membershipNumber: '', lastName: 'Madeup', firstName: 'Samuel' }, as(person.token)))).toBe('AlreadyExists');
      // The verifier is given it again, with the names as they are now; the approvers' queue is not.
      expect((await pendingIds()).find((p) => p.requestId === person.id)).toMatchObject({ firstName: 'Samuel', lastName: 'Madeup-Example', membershipNumber: numberOf(person.i) });
      expect((await m().listSignupRequests({}, as('approver'))).requests.find((r) => r.requestId === person.id)).toBeUndefined();
      await report(person.id, O.VERIFIED_LOCAL, { localGroup: CHAPTER, firstNameMatched: true });
      expect(await row(person.id)).toMatchObject({ verification: 'verified_local', first_name_matched: true, local_group: CHAPTER, decision: 'approved', status: 'member' });
      expect(await kindOf(person.sub)).toBe('chapter');
      const account = await mine(person.token);
      expect(account.officerTools).toBe(OfficerTools.OPEN);
      expect(account.officerCheck).toBe(OfficerCheck.UNSPECIFIED);
      expect(await power(person.token)).toBe('ok');
      // It left the list, the same report again is OK, and the account itself was never touched.
      expect((await pendingIds()).find((p) => p.requestId === person.id)).toBeUndefined();
      expect(await code(report(person.id, O.VERIFIED_LOCAL, { localGroup: CHAPTER, firstNameMatched: true }))).toBe('ok');
      expect((await on.pool.query(`SELECT * FROM member_account WHERE sub = $1`, [person.sub])).rows).toEqual(before.rows);
      expect((await audits(person.id)).filter((action) => action !== 'verification_listed')).toEqual(['signup', 'verification_report', 'approve', 'recheck_requested', 'recheck_report']);
      expect((await on.pool.query(`SELECT actor_kind, from_state, to_state FROM audit_event WHERE subject_id = $1 AND action = 'recheck_report'`, [person.id])).rows).toEqual([
        { actor_kind: 'verifier', from_state: 'asked', to_state: 'verified_local' },
      ]);
      // With the tools open there is nothing to check again.
      expect(await code(m().submitSignup({ membershipNumber: '', lastName: 'Madeup', firstName: 'Samuel' }, as(person.token)))).toBe('AlreadyExists');
    });

    it('opens the tools of an officer approved by hand with no group reported, once a fresh check reports the chapter\'s (case 3a)', async () => {
      const person = await officer(O.VERIFIED_LOCAL, { firstNameMatched: true });
      expect(await kindOf(person.sub)).toBe('unconfirmed');
      expect((await mine(person.token)).officerCheck).toBe(OfficerCheck.CONFIRM_DETAILS);
      expect(await code(m().submitSignup({ membershipNumber: numberOf(person.i), lastName: 'Madeup', firstName: 'Sam' }, as(person.token)))).toBe('ok');
      await report(person.id, O.VERIFIED_LOCAL, { localGroup: CHAPTER, firstNameMatched: true });
      expect((await mine(person.token)).officerTools).toBe(OfficerTools.OPEN);
      expect(await power(person.token)).toBe('ok');
    });

    it.each<[string, O, Extra]>([
      ['not found', O.NOT_FOUND, {}],
      ['a check error', O.ERROR, { localGroup: CHAPTER, firstNameMatched: true }],
      ['a duplicate claim', O.DUPLICATE_CLAIM, { localGroup: CHAPTER, firstNameMatched: true }],
    ])('a fresh check that is %s changes nothing but says so, and may be asked again', async (_why, outcome, extra) => {
      const person = await joined(O.VERIFIED_LOCAL, { localGroup: CHAPTER, firstNameMatched: false });
      await m().submitSignup({ membershipNumber: '', lastName: 'Madeup', firstName: 'Samuel' }, as(person.token));
      await report(person.id, outcome, extra);
      expect(await row(person.id)).toMatchObject({ verification: 'verified_local', first_name_matched: false, local_group: CHAPTER, decision: 'approved', status: 'member' });
      expect(await kindOf(person.sub)).toBe('chapter_partial');
      const account = await mine(person.token);
      expect(account.officerTools).toBe(OfficerTools.AWAITING_CHECK);
      expect(account.officerCheck).toBe(OfficerCheck.NOT_CONFIRMED);
      // The same report again is OK; another outcome is refused, and so is a late full match with no fresh check asked.
      expect(await code(report(person.id, outcome, extra))).toBe('ok');
      expect(await code(report(person.id, outcome === O.NOT_FOUND ? O.ERROR : O.NOT_FOUND))).toBe('FailedPrecondition');
      expect(await code(report(person.id, O.VERIFIED_LOCAL, { localGroup: CHAPTER, firstNameMatched: true }))).toBe('FailedPrecondition');
      expect(await power(person.token)).toBe('PermissionDenied');
      expect((await pendingIds()).find((p) => p.requestId === person.id)).toBeUndefined();
      expect(await code(m().submitSignup({ membershipNumber: '', lastName: 'Madeup', firstName: 'Sam' }, as(person.token)))).toBe('ok');
      expect((await mine(person.token)).officerCheck).toBe(OfficerCheck.RUNNING);
    });

    it('never raises a guest\'s reading by a fresh check that fails, and makes a guest of a member the check now finds elsewhere', async () => {
      const guest = await officer(O.VERIFIED_OTHER_GROUP, { localGroup: 'Boston Mensa' });
      expect(await kindOf(guest.sub)).toBe('guest');
      expect((await mine(guest.token)).officerCheck).toBe(OfficerCheck.CONFIRM_DETAILS);
      await m().submitSignup({ membershipNumber: '', lastName: 'Madeup', firstName: 'Sam' }, as(guest.token));
      expect(await kindOf(guest.sub)).toBe('guest');
      await report(guest.id, O.NOT_FOUND);
      expect(await kindOf(guest.sub)).toBe('guest');
      const moved = await joined(O.VERIFIED_LOCAL, { localGroup: CHAPTER });
      await m().submitSignup({ membershipNumber: '', lastName: 'Madeup', firstName: 'Sam' }, as(moved.token));
      await report(moved.id, O.VERIFIED_OTHER_GROUP, { localGroup: 'Boston Mensa', firstNameMatched: true });
      expect(await kindOf(moved.sub)).toBe('guest');
      expect((await mine(moved.token)).officerCheck).toBe(OfficerCheck.NEEDS_GRANT);
    });

    it('keeps the membership number, and needs both names', async () => {
      const person = await joined(O.VERIFIED_LOCAL, { localGroup: CHAPTER });
      const send = (membershipNumber: string, lastName: string, firstName: string) => m().submitSignup({ membershipNumber, lastName, firstName }, as(person.token));
      await expect(send('6999999', 'Madeup', 'Sam')).rejects.toMatchObject({ code: Code.InvalidArgument, rawMessage: 'the membership number on your account cannot be changed here' });
      await expect(send('', 'Madeup', ' ')).rejects.toMatchObject({ code: Code.InvalidArgument, rawMessage: 'a first name is needed' });
      await expect(send('', '', 'Sam')).rejects.toMatchObject({ code: Code.InvalidArgument, rawMessage: 'a last name is needed' });
      expect((await mine(person.token)).officerCheck).toBe(OfficerCheck.CONFIRM_DETAILS);
      // The number as typed on a card, with its spaces, is the one on file.
      const spaced = numberOf(person.i).replace(/^(\d{3})/, '$1 ');
      expect(await code(send(spaced, 'Madeup', 'Sam'))).toBe('ok');
      expect((await row(person.id))?.membership_number).toBe(numberOf(person.i));
    });

    it('is for those whose officer tools wait on an approved account, and for no one else', async () => {
      const again = (token: string) => code(m().submitSignup({ membershipNumber: '', lastName: 'Madeup', firstName: 'Sam' }, as(token)));
      // A plain member with no power group, whatever their check said.
      const plain = await signUp('joiner');
      await report(plain.id, O.NOT_FOUND);
      await approve(plain.id);
      expect(await again(`joiner.${plain.i}`)).toBe('AlreadyExists');
      expect((await mine(`joiner.${plain.i}`)).officerCheck).toBe(OfficerCheck.UNSPECIFIED);
      // An officer still waiting for a first decision.
      const waiting = await signUp('officer');
      expect(await again(`officer.${waiting.i}`)).toBe('AlreadyExists');
      expect((await mine(`officer.${waiting.i}`)).officerCheck).toBe(OfficerCheck.UNSPECIFIED);
      expect(await code(report(waiting.id, O.NOT_FOUND))).toBe('ok');
      // One whose account was removed since.
      const removed = await joined(O.VERIFIED_LOCAL, { localGroup: CHAPTER });
      await m().removeMember({ subject: removed.sub }, as('approver'));
      expect(await again(removed.token)).toBe('AlreadyExists');
      expect((await mine(removed.token)).officerCheck).toBe(OfficerCheck.UNSPECIFIED);
      // One removed while their fresh check ran: it is not given to the verifier.
      const gone = await joined(O.VERIFIED_LOCAL, { localGroup: CHAPTER });
      expect(await again(gone.token)).toBe('ok');
      await m().removeMember({ subject: gone.sub }, as('approver'));
      expect((await pendingIds()).find((p) => p.requestId === gone.id)).toBeUndefined();
      // The approver, whose tools are open.
      expect(await again('approver')).toBe('AlreadyExists');
    });

    it('does not offer a fresh check to a member past the 13 months: an approver confirms them first', async () => {
      const person = await joined(O.VERIFIED_LOCAL, { localGroup: CHAPTER });
      await on.pool.query(`UPDATE member_account SET verified_on = '2025-09-21' WHERE sub = $1`, [person.sub]);
      expect(await kindOf(person.sub)).toBe('none');
      const account = await mine(person.token);
      expect(account.officerTools).toBe(OfficerTools.AWAITING_CHECK);
      expect(account.officerCheck).toBe(OfficerCheck.UNSPECIFIED);
    });
  });

  describe('S2b: an Admin\'s grant for a guest member', () => {
    const grant = (sub: string) => code(m().grantAffiliate({ subject: sub }, as('admin')));

    it('opens the officer tools of an approved guest the check confirmed, first name too (case 3b)', async () => {
      const guest = await officer(O.VERIFIED_OTHER_GROUP, { localGroup: 'Boston Mensa', firstNameMatched: true });
      expect(await kindOf(guest.sub)).toBe('guest');
      const waiting = await mine(guest.token);
      expect(waiting.officerTools).toBe(OfficerTools.AWAITING_CHECK);
      expect(waiting.officerCheck).toBe(OfficerCheck.NEEDS_GRANT);
      expect(await power(guest.token)).toBe('PermissionDenied');
      const { account } = await m().grantAffiliate({ subject: guest.sub }, as('admin'));
      expect(account?.status).toBe(MemberStatus.AFFILIATE);
      expect(await kindOf(guest.sub)).toBe('affiliate');
      const open = await mine(guest.token);
      expect(open.officerTools).toBe(OfficerTools.OPEN);
      expect(open.officerCheck).toBe(OfficerCheck.UNSPECIFIED);
      expect(await power(guest.token)).toBe('ok');
      expect(await audits(guest.sub)).toContain('grant_affiliate_verified');
    });

    it('takes a guest in a group of none said, or found on an email mismatch, on the grantor\'s word for the date', async () => {
      const unsaid = await officer(O.VERIFIED_OTHER_GROUP, { firstNameMatched: true });
      expect(await grant(unsaid.sub)).toBe('ok');
      expect(await power(unsaid.token)).toBe('ok');
      const mismatch = await officer(O.EMAIL_MISMATCH, { localGroup: 'Boston Mensa', firstNameMatched: true });
      expect(await grant(mismatch.sub)).toBe('ok');
      expect(await power(mismatch.token)).toBe('ok');
      expect(await audits(mismatch.sub)).toContain('grant_affiliate_attested');
    });

    it('is refused for an approved member who is no confirmed guest: not confirmed at all, or the chapter\'s own', async () => {
      const unconfirmed = await joined(O.NOT_FOUND, { localGroup: 'Boston Mensa' });
      expect(await grant(unconfirmed.sub)).toBe('FailedPrecondition');
      expect(await power(unconfirmed.token)).toBe('PermissionDenied');
      const chapter = await joined(O.VERIFIED_LOCAL, { localGroup: CHAPTER });
      expect(await grant(chapter.sub)).toBe('FailedPrecondition');
      expect(await kindOf(chapter.sub)).toBe('chapter_partial');
      const full = await joined(O.VERIFIED_LOCAL, { localGroup: CHAPTER, firstNameMatched: true });
      expect(await grant(full.sub)).toBe('FailedPrecondition');
    });

    it('gives a person the check did not confirm member reading as before, and never the officer tools', async () => {
      for (const outcome of [O.NOT_FOUND, O.ERROR, null]) {
        const person = await signUp('officer');
        if (outcome !== null) await report(person.id, outcome, { localGroup: CHAPTER, firstNameMatched: true });
        expect(await grant(person.sub)).toBe('ok');
        expect(await kindOf(person.sub)).toBe('affiliate_partial');
        const account = await mine(`officer.${person.i}`);
        expect(account.account?.status).toBe(MemberStatus.AFFILIATE);
        expect(account.officerTools).toBe(OfficerTools.AWAITING_CHECK);
        expect(account.officerCheck).toBe(OfficerCheck.CONFIRM_DETAILS);
        expect(await power(`officer.${person.i}`)).toBe('PermissionDenied');
      }
      // An affiliate granted with no sign-up at all: nothing to check again here.
      await m().grantAffiliate({ subject: 'sub-ovr-officer-9001' }, as('admin'));
      expect(await kindOf('sub-ovr-officer-9001')).toBe('affiliate_partial');
      const bare = await mine('officer.9001');
      expect(bare.officerTools).toBe(OfficerTools.AWAITING_CHECK);
      expect(bare.officerCheck).toBe(OfficerCheck.UNSPECIFIED);
    });

    it('opens a granted guest\'s tools only once the first name is confirmed too: by a fresh check', async () => {
      const guest = await officer(O.VERIFIED_OTHER_GROUP, { localGroup: 'Boston Mensa' });
      expect(await grant(guest.sub)).toBe('ok');
      expect(await kindOf(guest.sub)).toBe('affiliate_partial');
      expect((await mine(guest.token)).officerCheck).toBe(OfficerCheck.CONFIRM_DETAILS);
      expect(await power(guest.token)).toBe('PermissionDenied');
      await m().submitSignup({ membershipNumber: '', lastName: 'Madeup', firstName: 'Sam' }, as(guest.token));
      await report(guest.id, O.VERIFIED_OTHER_GROUP, { localGroup: 'Boston Mensa', firstNameMatched: true });
      expect(await kindOf(guest.sub)).toBe('affiliate');
      expect(await power(guest.token)).toBe('ok');
    });
  });

  // The orchestrator's ruling (3): an email-only mismatch never opens officer tools by itself, on a fresh check
  // as on a first sign-up (ruling B). It waits in the approvers' queue for an approver's confirmation.
  describe('a fresh check that finds an email mismatch', () => {
    const fresh = async () => {
      const person = await joined(O.VERIFIED_LOCAL, { localGroup: CHAPTER, firstNameMatched: false });
      await m().submitSignup({ membershipNumber: '', lastName: 'Madeup', firstName: 'Samuel' }, as(person.token));
      await report(person.id, O.EMAIL_MISMATCH, { localGroup: CHAPTER, firstNameMatched: true });
      return person;
    };
    const queued = async (id: string) => (await m().listSignupRequests({}, as('approver'))).requests.find((r) => r.requestId === id);

    it('does not open the tools: the earlier answers stand, the officer is told an approver confirms it, and the approvers see it', async () => {
      const person = await fresh();
      expect(await row(person.id)).toMatchObject({ verification: 'verified_local', first_name_matched: false, local_group: CHAPTER, decision: 'approved', status: 'member' });
      expect(await kindOf(person.sub)).toBe('chapter_partial');
      const account = await mine(person.token);
      expect(account.officerTools).toBe(OfficerTools.AWAITING_CHECK);
      expect(account.officerCheck).toBe(OfficerCheck.AWAITING_APPROVER);
      expect(await power(person.token)).toBe('PermissionDenied');
      expect(await queued(person.id)).toMatchObject({ freshCheck: true, verification: Verification.EMAIL_MISMATCH, firstNameMatched: true, localGroup: CHAPTER, localGroupStanding: LocalGroupStanding.CHAPTER, firstName: 'Samuel' });
      // The same report again is OK; it is not theirs to ask again while an approver has it; the verifier is not given it.
      expect(await code(report(person.id, O.EMAIL_MISMATCH, { localGroup: CHAPTER, firstNameMatched: true }))).toBe('ok');
      expect(await code(report(person.id, O.EMAIL_MISMATCH, { localGroup: CHAPTER, firstNameMatched: false }))).toBe('FailedPrecondition');
      expect(await code(m().submitSignup({ membershipNumber: '', lastName: 'Madeup', firstName: 'Sam' }, as(person.token)))).toBe('AlreadyExists');
      expect((await pendingIds()).find((p) => p.requestId === person.id)).toBeUndefined();
    });

    it('opens them once an approver confirms the warning, and only then', async () => {
      const person = await fresh();
      const before = await on.pool.query(`SELECT * FROM member_account WHERE sub = $1`, [person.sub]);
      await expect(m().approveSignup({ requestId: person.id }, as('approver'))).rejects.toMatchObject({ code: Code.FailedPrecondition });
      expect(await power(person.token)).toBe('PermissionDenied');
      // Never their own, and never by one whose own powers wait.
      expect(await code(m().approveSignup({ requestId: person.id, confirmedWarning: true }, as(person.token)))).toBe('PermissionDenied');
      expect(await code(m().approveSignup({ requestId: person.id, confirmedWarning: true }, as('approver')))).toBe('ok');
      expect(await row(person.id)).toMatchObject({ verification: 'email_mismatch', first_name_matched: true, local_group: CHAPTER, decision: 'approved', status: 'member' });
      expect(await kindOf(person.sub)).toBe('chapter');
      const account = await mine(person.token);
      expect(account.officerTools).toBe(OfficerTools.OPEN);
      expect(account.officerCheck).toBe(OfficerCheck.UNSPECIFIED);
      expect(await power(person.token)).toBe('ok');
      expect(await queued(person.id)).toBeUndefined();
      expect((await on.pool.query(`SELECT * FROM member_account WHERE sub = $1`, [person.sub])).rows).toEqual(before.rows);
      expect((await audits(person.id)).slice(-2)).toEqual(['recheck_report', 'recheck_confirmed_email_mismatch']);
      // Done: a second confirmation is refused, and the verifier's retry is still answered OK.
      expect(await code(m().approveSignup({ requestId: person.id, confirmedWarning: true }, as('approver')))).toBe('FailedPrecondition');
      expect(await code(report(person.id, O.EMAIL_MISMATCH, { localGroup: CHAPTER, firstNameMatched: true }))).toBe('ok');
    });

    it('is declined by an approver without touching the account, and may then be asked again', async () => {
      const person = await fresh();
      expect(await code(m().rejectSignup({ requestId: person.id }, as(person.token)))).toBe('PermissionDenied');
      expect(await code(m().rejectSignup({ requestId: person.id }, as('approver')))).toBe('ok');
      expect(await row(person.id)).toMatchObject({ verification: 'verified_local', first_name_matched: false, local_group: CHAPTER, decision: 'approved', status: 'member' });
      expect(await kindOf(person.sub)).toBe('chapter_partial');
      expect(await queued(person.id)).toBeUndefined();
      expect((await mine(person.token)).officerCheck).toBe(OfficerCheck.NOT_CONFIRMED);
      expect((await audits(person.id)).at(-1)).toBe('recheck_declined');
      expect(await code(m().approveSignup({ requestId: person.id, confirmedWarning: true }, as('approver')))).toBe('FailedPrecondition');
      expect(await code(m().rejectSignup({ requestId: person.id }, as('approver')))).toBe('FailedPrecondition');
      expect(await code(m().submitSignup({ membershipNumber: '', lastName: 'Madeup', firstName: 'Sam' }, as(person.token)))).toBe('ok');
    });

    it('confirmed for a guest, keeps them a guest: an email mismatch in another group', async () => {
      const guest = await officer(O.VERIFIED_OTHER_GROUP, { localGroup: 'Boston Mensa' });
      await m().submitSignup({ membershipNumber: '', lastName: 'Madeup', firstName: 'Sam' }, as(guest.token));
      await report(guest.id, O.EMAIL_MISMATCH, { localGroup: 'Boston Mensa', firstNameMatched: true });
      expect(await kindOf(guest.sub)).toBe('guest');
      expect(await queued(guest.id)).toMatchObject({ freshCheck: true, localGroupStanding: LocalGroupStanding.GUEST });
      expect(await code(m().approveSignup({ requestId: guest.id, confirmedWarning: true }, as('approver')))).toBe('ok');
      expect(await kindOf(guest.sub)).toBe('guest');
      expect((await mine(guest.token)).officerCheck).toBe(OfficerCheck.NEEDS_GRANT);
    });
  });
});
