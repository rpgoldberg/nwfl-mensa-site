// OFFICER-VERIFY, the switch OFF (the orchestrator's rule, fix round 1): with OFFICER_VERIFY off or unset,
// every behaviour equals develop's, whatever CHAPTER_GROUP_NAME says (set, or unset). The challenger's
// three blockers, each from what a caller sees:
//   1. no guest standing: a member whose check reported another local group, or the chapter's own with no
//      chapter group configured, reads as a member, events too;
//   2. (the web's routing, src/lib/signup.test.ts) the API says an officer's tools are open;
//   3. the sign-up and approval rules are develop's: no first name needed, an invited sign-up approved on
//      the approver's word, an other-group match refused; the report's new answers are not kept, nothing is
//      approved by a report, and the verifier is given no first name.
// Fix round 3: none of its routes exists while switched off: no fresh check for an approved account, none
// listed to the verifier or answered, no grant for an approved guest member, and no officer_check said.
// Every name here is made up; local group names are public.
import { Code, ConnectError } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TokenVerifier, VerifiedToken } from '../../src/auth/caller.js';
import { ContentService } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { EventService, EventVisibility, OccurrenceStatus } from '../../src/gen/nwfl/mensa/v1/event_pb.js';
import { HandApproval, LocalGroupStanding, MembershipService, OfficerCheck, OfficerTools } from '../../src/gen/nwfl/mensa/v1/membership_pb.js';
import { MembershipVerifierService, PendingVerificationSchema, VerificationOutcome } from '../../src/gen/nwfl/mensa/v1/membership_verifier_pb.js';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { type Api, insertId, startApi } from '../helpers/api.js';
import { membersSpan, paragraph, publishItem } from '../helpers/content.js';
import { live } from '../helpers/pg.js';
import { seedAccount } from '../helpers/standing.js';

const CHAPTER = 'Northwest Florida Mensa';
const person = (subject: string, groups: string[]): VerifiedToken => ({ client: 'site', subject, groups, scopes: [], name: `Sam ${subject}`, email: `${subject}@example.org` });
const PEOPLE: Record<string, VerifiedToken> = {
  verifier: { client: 'verifier', subject: 'svc-nwfl-verifier', groups: [], scopes: ['membership.verify'] },
  approver: person('sub-off-approver', ['nwfl-members', 'nwfl-officers', 'nwfl-office-membership', 'nwfl-office-publications', 'nwfl-membership-approvers']),
  powerless: person('sub-off-powerless', ['nwfl-members']),
  admin: person('sub-off-admin', ['nwfl-members', 'nwfl-admin', 'nwfl-webmaster']),
};
let n = 0;
const next = (): number => (n += 1);
const verifier: TokenVerifier = {
  verify: (token) => {
    const known = PEOPLE[token];
    if (known !== undefined) return Promise.resolve(known);
    const [kind, i] = token.split('.');
    if (kind === 'officer') return Promise.resolve(person(`sub-off-officer-${i}`, ['nwfl-members', 'nwfl-officers']));
    if (kind === 'invitee') return Promise.resolve(person(`sub-off-invitee-${i}`, ['nwfl-users', 'nwfl-invited']));
    if (kind === 'joiner') return Promise.resolve(person(`sub-off-joiner-${i}`, ['nwfl-pending']));
    return Promise.reject(new Error('unknown token'));
  },
};
const as = (token: string): { headers: Record<string, string> } => ({ headers: { authorization: `Bearer ${token}` } });
const code = async (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => 'ok',
    (error: unknown) => Code[ConnectError.from(error).code],
  );

// Off with the chapter group set (as fc-infra will set it) and off with it unset: both must be develop.
describe.skipIf(!live).each([
  ['set', CHAPTER],
  ['unset', null],
] as const)('OFFICER-VERIFY switched off, CHAPTER_GROUP_NAME %s: everything as develop', (_label, chapterGroup) => {
  let api: Api;

  beforeAll(async () => {
    api = await startApi(`nwfl_ov_off_${chapterGroup === null ? 'unset' : 'set'}`, { verifier, chapterGroup });
    const office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
    await publishItem(api.pool, { slug: 'members-note', officeId: office, visibility: 'members', title: 'Members note', body: { blocks: [paragraph(membersSpan('Members only line.'))] } });
    await api.client(EventService).saveOccurrence(
      {
        occurrence: {
          title: 'Members dinner',
          startsAt: timestampFromDate(new Date('2026-11-21T23:00:00Z')),
          status: OccurrenceStatus.SCHEDULED,
          visibility: EventVisibility.MEMBERS,
          ownerOfficeId: office,
        },
      },
      as('approver'),
    );
  });

  afterAll(async () => {
    await api?.close();
  });

  const membership = () => api.client(MembershipService);
  const signUp = async (token: string, firstName = 'Sam'): Promise<string> =>
    (await membership().submitSignup({ membershipNumber: String(5000000 + next()), lastName: 'Madeup', firstName }, as(token))).requestId;
  const report = (requestId: string, outcome: VerificationOutcome, extra: { firstNameMatched?: boolean; localGroup?: string } = {}) =>
    api.client(MembershipVerifierService).reportVerification({ requestId, outcome, ...extra }, as('verifier'));
  const row = async (id: string) =>
    (
      await api.pool.query<{ decision: string; first_name_matched: boolean | null; local_group: string | null; route: string; status: string }>(
        `SELECT s.decision, s.first_name_matched, s.local_group, a.route, a.status FROM signup_request s JOIN member_account a ON a.sub = s.sub WHERE s.id = $1`,
        [id],
      )
    ).rows[0];
  const reads = async (token: string) => {
    const items = JSON.stringify(await api.client(ContentService).listPublishedItems({}, as(token)), (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
    const range = { from: { year: 2026, month: 11, day: 1 }, to: { year: 2026, month: 11, day: 30 } };
    const events = (await api.client(EventService).listOccurrences(range, as(token))).occurrences.map((o) => o.title);
    return { members: items.includes('Members only line.'), events: events.includes('Members dinner') };
  };

  describe('BLOCKER-1: no guest standing', () => {
    it.each([
      ['another local group', 'Boston Mensa'],
      ['the chapter\'s own group', CHAPTER],
      ['a group the site does not know', 'Atlantis Mensa'],
    ])('a member whose check reported %s reads as a member, events too', async (_why, localGroup) => {
      const token = `joiner.${next()}`;
      const id = await signUp(token);
      await report(id, VerificationOutcome.VERIFIED_LOCAL, { firstNameMatched: true, localGroup });
      expect(await code(membership().approveSignup({ requestId: id }, as('approver')))).toBe('ok');
      expect(await reads(token)).toEqual({ members: true, events: true });
      expect(await reads('powerless')).toEqual({ members: false, events: false });
    });

    it('says nothing of a local group in GetMyAccount', async () => {
      const token = `joiner.${next()}`;
      const id = await signUp(token);
      await report(id, VerificationOutcome.VERIFIED_LOCAL, { localGroup: 'Boston Mensa' });
      await membership().approveSignup({ requestId: id }, as('approver'));
      const mine = await membership().getMyAccount({}, as(token));
      expect(mine.account?.localGroupStanding).toBe(LocalGroupStanding.UNSPECIFIED);
      expect(mine.profile?.localGroup).toBe('');
    });
  });

  describe('BLOCKER-2 (API side): the officer tools', () => {
    it('are open for every officer power holder, with or without an account', async () => {
      expect((await membership().getMyAccount({}, as(`officer.${next()}`))).officerTools).toBe(OfficerTools.OPEN);
      expect((await membership().getMyAccount({}, as('approver'))).officerTools).toBe(OfficerTools.OPEN);
      expect((await membership().getMyAccount({}, as('powerless'))).officerTools).toBe(OfficerTools.UNSPECIFIED);
    });
  });

  describe('BLOCKER-3: develop\'s sign-up and approval rules', () => {
    it('takes an officer\'s sign-up with no first name, on the plain sign-up route', async () => {
      const id = await signUp(`officer.${next()}`, '');
      expect(await row(id)).toMatchObject({ route: 'signup', decision: 'pending' });
    });

    it('takes an invited sign-up with no first name, and approves it unchecked on the approver\'s word', async () => {
      const id = await signUp(`invitee.${next()}`, '');
      expect(await row(id)).toMatchObject({ route: 'invite' });
      expect(await code(membership().approveSignup({ requestId: id }, as('approver')))).toBe('ok');
    });

    it('approves an invited sign-up whose first name did not match, on the approver\'s word', async () => {
      const id = await signUp(`invitee.${next()}`);
      await report(id, VerificationOutcome.NOT_FOUND, { firstNameMatched: false });
      expect(await code(membership().approveSignup({ requestId: id }, as('approver')))).toBe('ok');
    });

    it('refuses an other-group match, as develop does', async () => {
      const id = await signUp(`joiner.${next()}`);
      await report(id, VerificationOutcome.VERIFIED_OTHER_GROUP, { localGroup: 'Boston Mensa' });
      await expect(membership().approveSignup({ requestId: id }, as('approver'))).rejects.toMatchObject({
        code: Code.FailedPrecondition,
        rawMessage: 'an other-group member is rejected or granted affiliate standing, not approved',
      });
      const listed = (await membership().listSignupRequests({}, as('approver'))).requests.find((r) => r.requestId === id);
      expect(listed?.handApproval).toBe(HandApproval.UNSPECIFIED);
    });

    it('lists no check answer and no local group to the approvers', async () => {
      const id = await signUp(`joiner.${next()}`);
      await report(id, VerificationOutcome.VERIFIED_LOCAL, { firstNameMatched: true, localGroup: CHAPTER });
      const listed = (await membership().listSignupRequests({}, as('approver'))).requests.find((r) => r.requestId === id);
      expect(listed).toMatchObject({ localGroup: '', localGroupStanding: LocalGroupStanding.UNSPECIFIED, handApproval: HandApproval.UNSPECIFIED });
      expect(listed?.firstNameMatched).toBeUndefined();
    });

    it('keeps neither of the report\'s new answers, refuses neither, and approves nothing by a report', async () => {
      const full = await signUp(`invitee.${next()}`);
      await report(full, VerificationOutcome.VERIFIED_LOCAL, { firstNameMatched: true, localGroup: CHAPTER });
      expect(await row(full)).toMatchObject({ decision: 'pending', status: 'pending', first_name_matched: null, local_group: null });
      const odd = await signUp(`joiner.${next()}`, '');
      expect(await code(report(odd, VerificationOutcome.VERIFIED_LOCAL, { firstNameMatched: true, localGroup: 'M'.repeat(121) }))).toBe('ok');
      expect(await row(odd)).toMatchObject({ first_name_matched: null, local_group: null });
    });

    // After a rollback (switched on, then off again): answers the check reported while on stay stored, unused.
    describe('after a rollback, answers stored while switched on', () => {
      const seeded = async (decision: 'pending' | 'approved') => {
        const token = `joiner.${next()}`;
        const sub = (await verifier.verify(token)).subject;
        const { rows } = await api.pool.query<{ id: string }>(
          `INSERT INTO signup_request (sub, display_name, email, first_name, verification, verified_on, first_name_matched, local_group, decision, decided_at, decided_by_sub)
           VALUES ($1, 'Pat Madeup', $1 || '@example.org', 'Pat', 'verified_local', '2026-10-01', true, 'Boston Mensa', $2,
                   CASE WHEN $2 = 'approved' THEN now() END, CASE WHEN $2 = 'approved' THEN 'sub-off-approver' END) RETURNING id`,
          [sub, decision],
        );
        await api.pool.query(
          decision === 'approved'
            ? `INSERT INTO member_account (sub, status, route, approved_by_sub, approved_at, verified_on) VALUES ($1, 'member', 'signup', 'sub-off-approver', now(), '2026-10-01')`
            : `INSERT INTO member_account (sub, status, route) VALUES ($1, 'pending', 'invite')`,
          [sub],
        );
        return { token, id: rows[0]!.id };
      };

      it('shows none of them to the member', async () => {
        const { token } = await seeded('approved');
        const mine = await membership().getMyAccount({}, as(token));
        expect(mine.account?.localGroupStanding).toBe(LocalGroupStanding.UNSPECIFIED);
        expect(mine.profile?.localGroup).toBe('');
        expect(await reads(token)).toEqual({ members: true, events: true });
      });

      it('shows none of them to the approvers, and says nothing of approving by hand', async () => {
        const { id } = await seeded('pending');
        const listed = (await membership().listSignupRequests({}, as('approver'))).requests.find((r) => r.requestId === id);
        expect(listed).toMatchObject({ localGroup: '', localGroupStanding: LocalGroupStanding.UNSPECIFIED, handApproval: HandApproval.UNSPECIFIED });
        expect(listed?.firstNameMatched).toBeUndefined();
      });

      it('answers the same report again OK, as before, whatever answers it stored', async () => {
        const { id } = await seeded('pending');
        expect(await code(report(id, VerificationOutcome.VERIFIED_LOCAL))).toBe('ok');
        expect(await code(report(id, VerificationOutcome.NOT_FOUND))).toBe('FailedPrecondition');
      });
    });

    // Fix round 3: the fresh check and the guest's grant are the switched-on site's. Switched off, an approved
    // officer's second sign-up gets the one answer, a fresh check asked for before a rollback is neither listed
    // nor answered, and an approved member is not granted affiliate standing, as on develop.
    describe('fix round 3: no fresh check and no guest grant', () => {
      const approvedOfficer = async (verification: string, group: string | null, asked: boolean) => {
        const token = `officer.${next()}`;
        const sub = (await verifier.verify(token)).subject;
        const { rows } = await api.pool.query<{ id: string }>(
          `INSERT INTO signup_request (sub, display_name, email, first_name, last_name, membership_number, verification, verified_on, first_name_matched, local_group,
             decision, decided_at, decided_by_sub, recheck_requested_at)
           VALUES ($1, 'Pat Madeup', $1 || '@example.org', 'Pat', 'Madeup', $2, $3, '2026-10-01', false, $4, 'approved', now(), 'sub-off-approver', CASE WHEN $5 THEN now() END)
           RETURNING id`,
          [sub, String(5900000 + next()), verification, group, asked],
        );
        await api.pool.query(`INSERT INTO member_account (sub, status, route, approved_by_sub, approved_at, verified_on) VALUES ($1, 'member', 'invite', 'sub-off-approver', now(), '2026-10-01')`, [sub]);
        return { token, sub, id: rows[0]!.id };
      };

      it('gives an approved officer\'s second sign-up the one answer, and says no officer_check', async () => {
        const { token, id } = await approvedOfficer('verified_local', CHAPTER, false);
        await expect(membership().submitSignup({ membershipNumber: '', lastName: 'Madeup', firstName: 'Pat' }, as(token))).rejects.toMatchObject({
          code: Code.AlreadyExists,
          rawMessage: 'a sign-up is already on file for this account',
        });
        const mine = await membership().getMyAccount({}, as(token));
        expect(mine.officerTools).toBe(OfficerTools.OPEN);
        expect(mine.officerCheck).toBe(OfficerCheck.UNSPECIFIED);
        expect((await api.pool.query(`SELECT recheck_requested_at FROM signup_request WHERE id = $1`, [id])).rows).toEqual([{ recheck_requested_at: null }]);
      });

      it('neither lists nor answers a fresh check asked for before a rollback', async () => {
        const { id } = await approvedOfficer('verified_local', CHAPTER, true);
        const { pending } = await api.client(MembershipVerifierService).listPendingVerifications({ pageSize: 100 }, as('verifier'));
        expect(pending.find((p) => p.requestId === id)).toBeUndefined();
        // As develop answers a report for a sign-up already decided: the same outcome again OK, another refused.
        expect(await code(report(id, VerificationOutcome.VERIFIED_LOCAL, { firstNameMatched: true, localGroup: CHAPTER }))).toBe('ok');
        expect(await code(report(id, VerificationOutcome.NOT_FOUND))).toBe('FailedPrecondition');
        expect((await api.pool.query(`SELECT first_name_matched, recheck_requested_at IS NOT NULL AS asked, recheck_outcome FROM signup_request WHERE id = $1`, [id])).rows).toEqual([
          { first_name_matched: false, asked: true, recheck_outcome: null },
        ]);
      });

      it('refuses affiliate standing for an approved member, a confirmed guest member too, as develop does', async () => {
        for (const [verification, group] of [['verified_other_group', 'Boston Mensa'], ['verified_local', 'Boston Mensa'], ['verified_local', CHAPTER]] as const) {
          const { sub } = await approvedOfficer(verification, group, false);
          await expect(membership().grantAffiliate({ subject: sub }, as('admin'))).rejects.toMatchObject({
            code: Code.FailedPrecondition,
            rawMessage: 'this account cannot be granted affiliate standing',
          });
        }
      });

      it('grants, as develop does, a pending sign-up whose check found only an email mismatch, and a lapsed member of the chapter (fix round 4)', async () => {
        const id = await signUp(`joiner.${next()}`);
        await report(id, VerificationOutcome.EMAIL_MISMATCH, { firstNameMatched: true, localGroup: CHAPTER });
        const sub = (await api.pool.query<{ sub: string }>(`SELECT sub FROM signup_request WHERE id = $1`, [id])).rows[0]!.sub;
        expect(await code(membership().grantAffiliate({ subject: sub }, as('admin')))).toBe('ok');
        expect(await row(id)).toMatchObject({ decision: 'approved', status: 'affiliate' });
        const lapsed = `sub-off-lapsed-${next()}`;
        await seedAccount(api.pool, { sub: lapsed, status: 'lapsed', check: { localGroup: CHAPTER } });
        expect(await code(membership().grantAffiliate({ subject: lapsed }, as('admin')))).toBe('ok');
      });

      it('keeps what a report carries beside an outcome that did not confirm out of the row, as every other answer', async () => {
        const id = await signUp(`joiner.${next()}`);
        await report(id, VerificationOutcome.NOT_FOUND, { firstNameMatched: true, localGroup: CHAPTER });
        expect(await row(id)).toMatchObject({ first_name_matched: null, local_group: null });
        expect(await code(report(id, VerificationOutcome.NOT_FOUND))).toBe('ok');
      });
    });

    // (V), fix round 2: what goes to the verifier is develop's payload, byte for byte (PROFILE-ID: never a first
    // name until the flip), and nothing it reports beyond develop's fields is stored or used.
    it('sends the verifier develop\'s pending payload, byte for byte: id, number, last name and email, never a first name', async () => {
      const id = await signUp(`joiner.${next()}`, 'Robin');
      const { pending } = await api.client(MembershipVerifierService).listPendingVerifications({ pageSize: 100 }, as('verifier'));
      const item = pending.find((p) => p.requestId === id);
      expect(item?.firstName).toBe('');
      const develop = create(PendingVerificationSchema, { requestId: id, membershipNumber: item?.membershipNumber ?? '', lastName: 'Madeup', email: item?.email ?? '' });
      expect(Buffer.from(toBinary(PendingVerificationSchema, item!)).toString('hex')).toBe(Buffer.from(toBinary(PendingVerificationSchema, develop)).toString('hex'));
      expect(JSON.stringify(pending)).not.toContain('Robin');
      await report(id, VerificationOutcome.NOT_FOUND);
    });

    it('stores and uses neither the first-name answer nor the local group a report carries', async () => {
      const token = `invitee.${next()}`;
      const id = await signUp(token);
      await report(id, VerificationOutcome.VERIFIED_LOCAL, { firstNameMatched: true, localGroup: 'Boston Mensa' });
      expect(await row(id)).toMatchObject({ decision: 'pending', status: 'pending', first_name_matched: null, local_group: null });
      // Not used either: approved by hand, the person reads as a member, as on develop.
      expect(await code(membership().approveSignup({ requestId: id }, as('approver')))).toBe('ok');
      expect(await reads(token)).toEqual({ members: true, events: true });
    });
  });
});
