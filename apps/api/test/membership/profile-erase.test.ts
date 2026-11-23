// PROFILE-ERASE (Ross, 11-22), through the API as each person:
//   REMOVE   EraseSignup, the Admin's alone: after it, the WHOLE database the app can read is searched
//            and holds the person's names, number and email nowhere, the audit included; the date and
//            the decision stay. On every decided state: approved, rejected, reopened, already removed.
//   CORRECT  CorrectMembershipNumber, the Admin's alone: the number is checked as at sign-up, and the
//            audit row holds who, when and the reason as one of three fixed codes, never the old or the
//            new number and no free text. A number already on another live sign-up is refused.
//   REMOVAL  RemoveMember (an approver's) erases the member's first name, last name and number with the
//            removal, on every decided sign-up of theirs; its audit rows name the acting officer alone.
//            That person cannot sign up again. A person removed while still waiting keeps what they typed.
//            The privacy page's sentence is held to this outcome.
// The API's log never holds a number, and no error gives one back. Every value here is made up.
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Code, type Client } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CorrectionReason, MemberStatus, MembershipService, SignupDecision } from '../../src/gen/nwfl/mensa/v1/membership_pb.js';
import { MembershipVerifierService, VerificationOutcome } from '../../src/gen/nwfl/mensa/v1/membership_verifier_pb.js';
import { type Api, PEOPLE, as, dump, startApi } from '../helpers/api.js';
import { live } from '../helpers/pg.js';

const APPROVER = as('approver-token');
const ADMIN = as('admin-token');
const VERIFIER = as('verifier-token');
const NO_ID = '00000000-0000-4000-8000-000000000000';
/** The privacy page's sentence on a removal (apps/web src/pages/privacy.astro). */
const REMOVAL_SENTENCE = "If an officer removes a member's account, we erase their first name, last name and membership number.";

type Token = Parameters<typeof as>[0];

interface Typed {
  token: Token;
  sub: string;
  id: string;
  first: string;
  last: string;
  number: string;
  name: string;
  email: string;
}

/** Everyone who is not the Admin: each is refused. The sign-up's own person is added per call. */
const NOT_ADMIN: [string, Token][] = [
  ['the Membership Officer, an approver', 'approver-token'],
  ['the Webmaster', 'webmaster-token'],
  ['the Webmaster without the officers group', 'lone-webmaster-token'],
  ['an officer', 'officer-token'],
  ['the Publications Officer', 'pub-token'],
  ['a member', 'member-token'],
  ['someone whose groups only look like the Admin\'s', 'stray-admin-token'],
  ['the membership verifier (a machine)', 'verifier-token'],
  ['the newsletter agent (a machine)', 'agent-token'],
  ['the link checker (a machine)', 'linkcheck-token'],
];

describe.skipIf(!live)('PROFILE-ERASE: erase on request, correct a number, erase on removal', () => {
  let api: Api;
  let membership: Client<typeof MembershipService>;
  let verifier: Client<typeof MembershipVerifierService>;
  const numbers: string[] = [];

  /** Where in the database a value appears, as table.column, over every table the app role can read. */
  const whereIs = async (value: string): Promise<string[]> => {
    const { rows: columns } = await api.pool.query<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND has_table_privilege(format('%I.%I', c.table_schema, c.table_name), 'SELECT')
       ORDER BY 1, 2`,
    );
    const found: string[] = [];
    for (const { table_name: table, column_name: column } of columns) {
      const { rows } = await api.pool.query(`SELECT 1 FROM "${table}" WHERE "${column}"::text LIKE '%' || $1 || '%' LIMIT 1`, [value]);
      if (rows.length > 0) found.push(`${table}.${column}`);
    }
    return found;
  };

  const newNumber = (): string => {
    const number = String(randomInt(100_000_000_000, 999_999_999_999));
    numbers.push(number);
    return number;
  };

  /** A sign-up with its own names and number, as the given person. */
  const signUp = async (token: Token): Promise<Typed> => {
    const number = newNumber();
    const first = `First${randomInt(1_000_000, 9_999_999)}`;
    const last = `Last${randomInt(1_000_000, 9_999_999)}`;
    const { requestId } = await membership.submitSignup({ firstName: first, lastName: last, membershipNumber: number }, as(token));
    const person = PEOPLE[token] as { subject: string; name: string; email: string };
    return { token, sub: person.subject, id: requestId, first, last, number, name: person.name, email: person.email };
  };
  const member = async (token: Token): Promise<Typed> => {
    const typed = await signUp(token);
    await membership.approveSignup({ requestId: typed.id }, APPROVER);
    return typed;
  };

  /** Held nowhere the app can read: not the names, the number, nor the name and email of the sign-in. */
  const heldNowhere = async (typed: Typed, values: (keyof Typed)[] = ['first', 'last', 'number', 'name', 'email']): Promise<void> => {
    for (const key of values) expect(await whereIs(typed[key]), key).toEqual([]);
  };
  const stored = async (id: string) =>
    (
      await api.pool.query<Record<string, unknown>>(
        `SELECT display_name, email, first_name, last_name, membership_number, decision, created_at IS NOT NULL AS created, decided_at IS NOT NULL AS decided,
                erased_at IS NOT NULL AS erased, erased_by_sub FROM signup_request WHERE id = $1`,
        [id],
      )
    ).rows[0] as Record<string, unknown>;
  const ERASED = { display_name: null, email: null, first_name: null, last_name: null, membership_number: null, created: true, decided: true, erased: true, erased_by_sub: 'sub-admin' };
  const auditSince = async (after: number): Promise<Record<string, unknown>[]> =>
    (
      await api.pool.query<Record<string, unknown>>(
        `SELECT action, actor_sub, subject_kind, subject_id, from_state, to_state, note, payload FROM audit_event WHERE id > $1 ORDER BY id`,
        [after],
      )
    ).rows;
  const auditMark = async (): Promise<number> => Number((await api.pool.query<{ max: string | null }>(`SELECT max(id) AS max FROM audit_event`)).rows[0]?.max ?? 0);
  const records = async () => (await membership.listSignupRecords({}, ADMIN)).records;
  const refusal = async (call: Promise<unknown>): Promise<Code | 'ok'> =>
    call.then(
      () => 'ok' as const,
      (error: unknown) => (error as { code: Code }).code,
    );

  beforeAll(async () => {
    api = await startApi('nwfl_profile_erase');
    membership = api.client(MembershipService);
    verifier = api.client(MembershipVerifierService);
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('only the Admin', () => {
    let target: Typed;

    beforeAll(async () => {
      target = await member('joiner-token');
    });

    it.each(NOT_ADMIN)('refuses %s: listing, erasing and correcting', async (_who, token) => {
      expect(await refusal(membership.listSignupRecords({}, as(token)))).toBe(Code.PermissionDenied);
      expect(await refusal(membership.eraseSignup({ requestId: target.id }, as(token)))).toBe(Code.PermissionDenied);
      expect(await refusal(membership.correctMembershipNumber({ requestId: target.id, membershipNumber: '123', reason: CorrectionReason.TYPED_WRONG }, as(token)))).toBe(Code.PermissionDenied);
    });

    it('refuses the person themself, on their own sign-up', async () => {
      expect(await refusal(membership.listSignupRecords({}, as(target.token)))).toBe(Code.PermissionDenied);
      expect(await refusal(membership.eraseSignup({ requestId: target.id }, as(target.token)))).toBe(Code.PermissionDenied);
      expect(await refusal(membership.correctMembershipNumber({ requestId: target.id, membershipNumber: '123', reason: CorrectionReason.TYPED_WRONG }, as(target.token)))).toBe(Code.PermissionDenied);
    });

    it('refuses the public', async () => {
      expect(await refusal(membership.listSignupRecords({}, {}))).toBe(Code.Unauthenticated);
      expect(await refusal(membership.eraseSignup({ requestId: target.id }, {}))).toBe(Code.Unauthenticated);
      expect(await refusal(membership.correctMembershipNumber({ requestId: target.id, membershipNumber: '123', reason: CorrectionReason.TYPED_WRONG }, {}))).toBe(Code.Unauthenticated);
    });

    it('changed nothing through every refusal', async () => {
      expect(await stored(target.id)).toMatchObject({ display_name: target.name, email: target.email, first_name: target.first, last_name: target.last, membership_number: target.number, erased: false });
    });

    it('lists the decided sign-ups for the Admin, with or without the officers group, with what they typed', async () => {
      for (const who of [ADMIN, as('lone-admin-token')]) {
        const listed = (await membership.listSignupRecords({}, who)).records.find((r) => r.requestId === target.id);
        expect(listed).toMatchObject({
          displayName: target.name,
          email: target.email,
          firstName: target.first,
          lastName: target.last,
          membershipNumber: target.number,
          decision: SignupDecision.APPROVED,
          accountStatus: MemberStatus.MEMBER,
        });
        expect(listed?.decidedAt).toBeDefined();
      }
    });

    it('never lists a pending sign-up', async () => {
      const pending = await signUp('spacer-token');
      expect((await records()).map((r) => r.requestId)).not.toContain(pending.id);
      // And it is not erased while it waits: it is decided first.
      await expect(membership.eraseSignup({ requestId: pending.id }, ADMIN)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      expect(await stored(pending.id)).toMatchObject({ display_name: pending.name, erased: false });
    });

    it('lets the Admin without the officers group erase', async () => {
      const mark = await auditMark();
      expect(await membership.eraseSignup({ requestId: target.id }, as('lone-admin-token'))).toMatchObject({ erased: 1, accessEnded: true });
      expect(await stored(target.id)).toMatchObject({ erased: true, erased_by_sub: 'sub-lone-admin', decision: 'approved' });
      await heldNowhere(target);
      expect((await auditSince(mark)).map((r) => [r.action, r.actor_sub])).toEqual([
        ['erase', 'sub-lone-admin'],
        ['remove', 'sub-lone-admin'],
      ]);
    });
  });

  describe('REMOVE: the Admin erases a record when the person asks', () => {
    it('an approved member\'s: nothing of theirs is held anywhere, the date and the decision stay, and member access ends', async () => {
      const typed = await member('joiner2-token');
      expect(await whereIs(typed.name)).toEqual(['signup_request.display_name']);
      expect(await whereIs(typed.email)).toEqual(['signup_request.email']);
      const mark = await auditMark();
      expect(await membership.eraseSignup({ requestId: typed.id }, ADMIN)).toMatchObject({ erased: 1, accessEnded: true });
      await heldNowhere(typed);
      expect(await stored(typed.id)).toEqual({ ...ERASED, decision: 'approved' });
      // The person reads as removed, with no profile; the officers' lists hold them no more.
      const mine = await membership.getMyAccount({}, as(typed.token));
      expect(mine.account?.status).toBe(MemberStatus.REMOVED);
      expect(mine.profile).toBeUndefined();
      expect((await membership.listMembers({}, APPROVER)).members.map((m) => m.subject)).not.toContain(typed.sub);
      expect((await records()).map((r) => r.requestId)).not.toContain(typed.id);
      // The audit: who (the Admin) and what, by ids; no note, no payload.
      expect(await auditSince(mark)).toEqual([
        { action: 'erase', actor_sub: 'sub-admin', subject_kind: 'signup_request', subject_id: typed.id, from_state: 'approved', to_state: 'erased', note: null, payload: {} },
        { action: 'remove', actor_sub: 'sub-admin', subject_kind: 'member_account', subject_id: typed.sub, from_state: 'member', to_state: 'removed', note: null, payload: {} },
      ]);
      // The claim on the number is released to the verifier, as for any removal.
      expect((await verifier.listReleasedClaims({}, VERIFIER)).released.map((r) => r.requestId)).toContain(typed.id);
    });

    it('a second time: nothing more is written', async () => {
      const typed = await signUp('joiner3-token');
      await membership.rejectSignup({ requestId: typed.id }, APPROVER);
      expect(await membership.eraseSignup({ requestId: typed.id }, ADMIN)).toMatchObject({ erased: 1, accessEnded: false });
      const mark = await auditMark();
      expect(await membership.eraseSignup({ requestId: typed.id }, ADMIN)).toMatchObject({ erased: 0, accessEnded: false });
      expect(await auditSince(mark)).toEqual([]);
      expect(await stored(typed.id)).toEqual({ ...ERASED, decision: 'rejected' });
      await heldNowhere(typed);
    });

    it('a rejected sign-up\'s: it leaves the rejections, and can still be reopened so the person signs up again', async () => {
      const typed = await signUp('racer-token');
      await membership.rejectSignup({ requestId: typed.id }, APPROVER);
      expect((await membership.listRejectedSignups({}, ADMIN)).requests.map((r) => r.requestId)).toContain(typed.id);
      await membership.eraseSignup({ requestId: typed.id }, ADMIN);
      await heldNowhere(typed);
      expect(await stored(typed.id)).toEqual({ ...ERASED, decision: 'rejected' });
      expect((await membership.listRejectedSignups({}, ADMIN)).requests.map((r) => r.requestId)).not.toContain(typed.id);
      // Erased, the same sign-in still has a sign-up on file, until the Admin reopens it.
      await expect(membership.submitSignup({ firstName: 'Quinn', lastName: 'Example', membershipNumber: newNumber() }, as(typed.token))).rejects.toMatchObject({ code: Code.AlreadyExists });
      await membership.reopenSignup({ requestId: typed.id }, ADMIN);
      expect(await stored(typed.id)).toEqual({ ...ERASED, decision: 'rejected' });
      const again = await signUp(typed.token);
      expect(again.id).not.toBe(typed.id);
      // The new sign-up is pending, so the old record is not erased again until it is decided.
      await expect(membership.eraseSignup({ requestId: typed.id }, ADMIN)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    });

    it('a reopened sign-up\'s, and with it the person\'s later one', async () => {
      const first = await signUp('turned-down-token');
      await membership.rejectSignup({ requestId: first.id }, APPROVER);
      await membership.reopenSignup({ requestId: first.id }, ADMIN);
      const second = await member('turned-down-token');
      const listed = await records();
      expect(listed.find((r) => r.requestId === first.id)).toMatchObject({ decision: SignupDecision.REOPENED, firstName: first.first, accountStatus: MemberStatus.UNSPECIFIED });
      expect(listed.find((r) => r.requestId === second.id)).toMatchObject({ decision: SignupDecision.APPROVED, accountStatus: MemberStatus.MEMBER });
      expect(await membership.eraseSignup({ requestId: first.id }, ADMIN)).toMatchObject({ erased: 2, accessEnded: true });
      for (const typed of [first, second]) await heldNowhere(typed, ['first', 'last', 'number']);
      await heldNowhere(second, ['name', 'email']);
      expect(await stored(first.id)).toEqual({ ...ERASED, decision: 'rejected' });
      expect(await stored(second.id)).toEqual({ ...ERASED, decision: 'approved' });
    });

    it('an account already removed', async () => {
      const typed = await member('invitee-token');
      await membership.removeMember({ subject: typed.sub }, APPROVER);
      // The removal erased the profile; the sign-up's own name and email wait for the request.
      await heldNowhere(typed, ['first', 'last', 'number']);
      expect(await whereIs(typed.name)).toEqual(['signup_request.display_name']);
      expect((await records()).find((r) => r.requestId === typed.id)).toMatchObject({ displayName: typed.name, firstName: '', lastName: '', membershipNumber: '', accountStatus: MemberStatus.REMOVED });
      expect(await membership.eraseSignup({ requestId: typed.id }, ADMIN)).toMatchObject({ erased: 1, accessEnded: false });
      await heldNowhere(typed);
      expect(await stored(typed.id)).toEqual({ ...ERASED, decision: 'approved' });
    });

    it('shows a duplicate claim\'s earlier sign-up as closed once it is erased, by its date alone', async () => {
      const earlier = await member('affiliate-token');
      const later = await signUp('claimant-token');
      await verifier.reportVerification({ requestId: later.id, outcome: VerificationOutcome.DUPLICATE_CLAIM, conflictingRequestId: earlier.id }, VERIFIER);
      await membership.eraseSignup({ requestId: earlier.id }, ADMIN);
      const claim = (await membership.listSignupRequests({}, APPROVER)).requests.find((r) => r.requestId === later.id)?.earlierClaim;
      expect(claim).toMatchObject({ closed: true, displayName: '', firstName: '', lastName: '', membershipNumber: '' });
      expect(claim?.signedUpAt).toBeDefined();
      await membership.rejectSignup({ requestId: later.id }, APPROVER);
    });

    it('refuses an id that is not one, and a sign-up that does not exist', async () => {
      await expect(membership.eraseSignup({ requestId: 'not-an-id' }, ADMIN)).rejects.toMatchObject({ code: Code.InvalidArgument, rawMessage: 'request_id is not an id' });
      await expect(membership.eraseSignup({ requestId: NO_ID }, ADMIN)).rejects.toMatchObject({ code: Code.NotFound, rawMessage: 'sign-up not found' });
    });

    it('refuses the Admin\'s own sign-up', async () => {
      const { rows } = await api.pool.query<{ id: string }>(
        `INSERT INTO signup_request (sub, display_name, email, first_name, last_name, membership_number, decision, decided_at, decided_by_sub)
         VALUES ('sub-admin', 'Dana Placeholder', 'dana@example.org', 'Dana', 'Placeholder', '424242', 'rejected', now(), 'sub-approver') RETURNING id`,
      );
      const own = (rows[0] as { id: string }).id;
      await expect(membership.eraseSignup({ requestId: own }, ADMIN)).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(membership.correctMembershipNumber({ requestId: own, membershipNumber: '424243', reason: CorrectionReason.TYPED_WRONG }, ADMIN)).rejects.toMatchObject({ code: Code.PermissionDenied });
      expect((await records()).map((r) => r.requestId)).not.toContain(own);
      expect(await stored(own)).toMatchObject({ display_name: 'Dana Placeholder', membership_number: '424242', erased: false });
      // The other Admin may.
      expect(await membership.eraseSignup({ requestId: own }, as('lone-admin-token'))).toMatchObject({ erased: 1 });
    });
  });

  describe('CORRECT: the Admin corrects a wrong membership number', () => {
    let typed: Typed;
    const REASON = CorrectionReason.CARD_DIFFERS;

    beforeAll(async () => {
      typed = await member('typo-token');
    });

    it('takes the number as sign-up does (spaces and dashes dropped), and audits who, when and the reason as its code, never a number', async () => {
      const corrected = newNumber();
      const mark = await auditMark();
      await membership.correctMembershipNumber({ requestId: typed.id, membershipNumber: ` ${corrected.slice(0, 4)} ${corrected.slice(4, 8)}-${corrected.slice(8)} `, reason: REASON }, ADMIN);
      // The member's profile shows it; the names are untouched.
      expect((await membership.getMyAccount({}, as('typo-token'))).profile).toMatchObject({ firstName: typed.first, lastName: typed.last, membershipNumber: corrected });
      expect(await whereIs(corrected)).toEqual(['signup_request.membership_number']);
      expect(await whereIs(typed.number)).toEqual([]);
      const { rows } = await api.pool.query<Record<string, unknown>>(
        `SELECT action, actor_sub, actor_groups, subject_kind, subject_id, from_state, to_state, note, payload, at > now() - interval '1 minute' AS just_now FROM audit_event WHERE id > $1`,
        [mark],
      );
      expect(rows).toEqual([
        {
          action: 'correct_number',
          actor_sub: 'sub-admin',
          actor_groups: PEOPLE['admin-token']?.groups,
          subject_kind: 'signup_request',
          subject_id: typed.id,
          from_state: null,
          to_state: 'card_differs',
          note: null,
          payload: {},
          just_now: true,
        },
      ]);
      expect(dump(rows)).not.toContain(corrected);
      expect(dump(rows)).not.toContain(typed.number);
      typed = { ...typed, number: corrected };
    });

    it('keeps each of the three reasons as its own code', async () => {
      const mark = await auditMark();
      for (const reason of [CorrectionReason.TYPED_WRONG, CorrectionReason.NEW_NUMBER]) {
        const corrected = newNumber();
        await membership.correctMembershipNumber({ requestId: typed.id, membershipNumber: corrected, reason }, ADMIN);
        typed = { ...typed, number: corrected };
      }
      expect((await auditSince(mark)).map((r) => [r.to_state, r.note])).toEqual([
        ['typed_wrong', null],
        ['new_number', null],
      ]);
    });

    it.each([
      ['letters in it', '12345a789', 'a membership number is 1 to 12 digits'],
      ['thirteen digits', '1234567890123', 'a membership number is 1 to 12 digits'],
      ['a full-width digit', '12345６', 'a membership number is 1 to 12 digits'],
      ['nothing', '   ', 'a membership number is needed'],
    ])('refuses a number with %s, as sign-up does, and never gives it back', async (_what, number, message) => {
      const error = await membership.correctMembershipNumber({ requestId: typed.id, membershipNumber: number, reason: REASON }, ADMIN).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: Code.InvalidArgument, rawMessage: message });
      expect(dump(error)).not.toContain(number.replace(/\D/g, '').slice(0, 5) || 'no-digits');
      expect((await stored(typed.id))['membership_number']).toBe(typed.number);
    });

    // Before F5 the reason was free text held to "no digits"; the cases below replace those (a reason holding the
    // old number, the new one, spaced, full-width or circled digits, a date, nothing, spaces, no word, 501
    // characters, a hidden character): the wire now carries only one of three codes, so no text can be sent.
    it.each([
      ['no reason', CorrectionReason.UNSPECIFIED],
      ['a reason the API does not know', 99 as CorrectionReason],
      ['a negative reason', -1 as CorrectionReason],
    ])('refuses %s, changes nothing and audits nothing', async (_what, reason) => {
      const mark = await auditMark();
      await expect(membership.correctMembershipNumber({ requestId: typed.id, membershipNumber: '100200300400', reason }, ADMIN)).rejects.toMatchObject({
        code: Code.InvalidArgument,
        rawMessage: 'choose one of the three reasons',
      });
      expect((await stored(typed.id))['membership_number']).toBe(typed.number);
      expect(await auditSince(mark)).toEqual([]);
    });

    // Before F5: "refuses a reason only the database finds fault with". The database is still the backstop: free
    // text sent to its function by hand, the Admin's groups and all, is refused.
    it('refuses free text sent straight to the database function, in fixed words', async () => {
      const error = await api.pool
        .query(`SELECT signup_request_correct_number($1, '100200300400', 'Two digits were swapped', 'sub-admin', $2, NULL)`, [typed.id, PEOPLE['admin-token']?.groups])
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: '22023' });
      expect((await stored(typed.id))['membership_number']).toBe(typed.number);
    });

    it('refuses a number already on another live sign-up, pending or approved, without naming whose (F7)', async () => {
      const holder = await member('holder-token');
      const waiting = await signUp('pender-token');
      const mark = await auditMark();
      for (const number of [holder.number, waiting.number]) {
        const error = await membership.correctMembershipNumber({ requestId: typed.id, membershipNumber: number, reason: REASON }, ADMIN).catch((e: unknown) => e);
        expect(error).toMatchObject({ code: Code.AlreadyExists, rawMessage: 'that number is already on another sign-up' });
        for (const value of [number, holder.name, holder.last, waiting.name, waiting.last]) expect(dump(error)).not.toContain(value);
      }
      expect((await stored(typed.id))['membership_number']).toBe(typed.number);
      expect(await auditSince(mark)).toEqual([]);
    });

    it('refuses the number already on the profile, an id that is not one, and a sign-up that does not exist', async () => {
      await expect(membership.correctMembershipNumber({ requestId: typed.id, membershipNumber: typed.number, reason: REASON }, ADMIN)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      await expect(membership.correctMembershipNumber({ requestId: 'x', membershipNumber: '123', reason: REASON }, ADMIN)).rejects.toMatchObject({ code: Code.InvalidArgument, rawMessage: 'request_id is not an id' });
      await expect(membership.correctMembershipNumber({ requestId: NO_ID, membershipNumber: '123', reason: REASON }, ADMIN)).rejects.toMatchObject({ code: Code.NotFound, rawMessage: 'sign-up not found' });
    });

    it('refuses a sign-up that is not an approved member\'s: pending, rejected, removed or erased', async () => {
      const { rows } = await api.pool.query<{ id: string; decision: string; erased: boolean }>(
        `SELECT s.id, s.decision, s.erased_at IS NOT NULL AS erased FROM signup_request s LEFT JOIN member_account a ON a.sub = s.sub
         WHERE s.sub <> 'sub-admin' AND (s.decision <> 'approved' OR a.status = 'removed')`,
      );
      expect([...new Set(rows.map((r) => `${r.decision}${r.erased ? ' erased' : ''}`))].sort()).toEqual(['approved erased', 'pending', 'rejected', 'rejected erased']);
      for (const row of rows) {
        await expect(membership.correctMembershipNumber({ requestId: row.id, membershipNumber: '123', reason: REASON }, ADMIN)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      }
    });

    it('still leaves the member no way to change the number themself', async () => {
      await membership.updateMyProfile({ firstName: 'Lee', lastName: 'Typo' }, as('typo-token'));
      expect((await membership.getMyAccount({}, as('typo-token'))).profile).toMatchObject({ firstName: 'Lee', lastName: 'Typo', membershipNumber: typed.number });
      await expect(api.pool.query(`UPDATE signup_request SET membership_number = '5' WHERE id = $1`, [typed.id])).rejects.toMatchObject({ code: '55000' });
    });
  });

  describe('REMOVAL: an officer removes a member', () => {
    let typed: Typed;
    let mark: number;

    beforeAll(async () => {
      typed = await member('leaver-token');
      mark = await auditMark();
      await membership.removeMember({ subject: typed.sub }, APPROVER);
    });

    it('erases the first name, the last name and the number with the removal', async () => {
      await heldNowhere(typed, ['first', 'last', 'number']);
      expect(await stored(typed.id)).toMatchObject({ first_name: null, last_name: null, membership_number: null, decision: 'approved', created: true, decided: true, erased: false });
      expect((await membership.getMyAccount({}, as(typed.token))).account?.status).toBe(MemberStatus.REMOVED);
      expect((await membership.getMyAccount({}, as(typed.token))).profile).toBeUndefined();
    });

    it('audits it by ids alone: the acting officer is the only person named', async () => {
      const rows = await auditSince(mark);
      expect(rows).toEqual([
        { action: 'remove', actor_sub: 'sub-approver', subject_kind: 'member_account', subject_id: typed.sub, from_state: 'member', to_state: 'removed', note: null, payload: {} },
        { action: 'erase_profile', actor_sub: 'sub-approver', subject_kind: 'signup_request', subject_id: typed.id, from_state: 'approved', to_state: 'profile_erased', note: null, payload: {} },
      ]);
      for (const value of [typed.first, typed.last, typed.number, typed.name, typed.email]) expect(dump(rows)).not.toContain(value);
    });

    it('keeps the sign-up\'s own record (the sign-in\'s name and email, the date, the decision) until the person asks', async () => {
      expect(await stored(typed.id)).toMatchObject({ display_name: typed.name, email: typed.email, decision: 'approved' });
    });

    it('puts no number back: a removed account\'s number is not corrected', async () => {
      await expect(membership.correctMembershipNumber({ requestId: typed.id, membershipNumber: '123', reason: CorrectionReason.TYPED_WRONG }, ADMIN)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      expect(await stored(typed.id)).toMatchObject({ membership_number: null });
    });

    it('takes no second sign-up from that person, and has no reopening for it', async () => {
      await expect(membership.submitSignup({ firstName: 'Blake', lastName: 'Example', membershipNumber: newNumber() }, as(typed.token))).rejects.toMatchObject({
        code: Code.AlreadyExists,
        rawMessage: 'a sign-up is already on file for this account',
      });
      await expect(membership.reopenSignup({ requestId: typed.id }, ADMIN)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      expect((await membership.listRejectedSignups({}, ADMIN)).requests.map((r) => r.requestId)).not.toContain(typed.id);
      // Erased on request as well, it is the same: the account id stays on file, removed.
      await membership.eraseSignup({ requestId: typed.id }, ADMIN);
      await expect(membership.submitSignup({ firstName: 'Blake', lastName: 'Example', membershipNumber: newNumber() }, as(typed.token))).rejects.toMatchObject({ code: Code.AlreadyExists });
      await expect(membership.reopenSignup({ requestId: typed.id }, ADMIN)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    });

    it('frees the number for another sign-up: the claim is released to the verifier', async () => {
      const released = (await verifier.listReleasedClaims({}, VERIFIER)).released.filter((r) => r.requestId === typed.id);
      expect(released).toHaveLength(1);
    });

    it('erases the profile from every decided sign-up of the member, a reopened earlier one included, and audits each by its id (F2)', async () => {
      const first = await signUp('returner-token');
      await membership.rejectSignup({ requestId: first.id }, APPROVER);
      await membership.reopenSignup({ requestId: first.id }, ADMIN);
      const second = await member('returner-token');
      const before = await auditMark();
      await membership.removeMember({ subject: second.sub }, APPROVER);
      for (const typed of [first, second]) await heldNowhere(typed, ['first', 'last', 'number']);
      expect(await stored(first.id)).toMatchObject({ first_name: null, last_name: null, membership_number: null, display_name: first.name, email: first.email, decision: 'rejected', erased: false });
      const rows = await auditSince(before);
      expect(rows).toEqual([
        { action: 'remove', actor_sub: 'sub-approver', subject_kind: 'member_account', subject_id: second.sub, from_state: 'member', to_state: 'removed', note: null, payload: {} },
        { action: 'erase_profile', actor_sub: 'sub-approver', subject_kind: 'signup_request', subject_id: first.id, from_state: 'reopened', to_state: 'profile_erased', note: null, payload: {} },
        { action: 'erase_profile', actor_sub: 'sub-approver', subject_kind: 'signup_request', subject_id: second.id, from_state: 'approved', to_state: 'profile_erased', note: null, payload: {} },
      ]);
      for (const value of [first.first, first.last, first.number, second.first, second.last, second.number]) expect(dump(rows)).not.toContain(value);
      // The Admin's list shows the earlier row with nothing typed left.
      expect((await records()).find((r) => r.requestId === first.id)).toMatchObject({ firstName: '', lastName: '', membershipNumber: '', decision: SignupDecision.REOPENED });
    });

    it('keeps what a person still waiting typed when an officer removes them: their sign-up is rejected, not erased (F3)', async () => {
      const waiting = await signUp('waiter-token');
      const before = await auditMark();
      await membership.removeMember({ subject: waiting.sub }, APPROVER);
      expect(await stored(waiting.id)).toMatchObject({ first_name: waiting.first, last_name: waiting.last, membership_number: waiting.number, decision: 'rejected', erased: false });
      expect((await auditSince(before)).map((r) => r.action)).not.toContain('erase_profile');
    });

    it('is what the privacy page says a removal does, for a member, whatever sign-ups they had (F6)', async () => {
      // The sentence, as the page has it ...
      const page = readFileSync(new URL('../../../web/src/pages/privacy.astro', import.meta.url), 'utf8');
      expect(page).toContain(REMOVAL_SENTENCE);
      // ... is the outcome: after a removal, no first name, last name or number of the member is held on any of their sign-ups.
      const { rows } = await api.pool.query<{ sub: string; held: number }>(
        `SELECT a.sub, count(*) FILTER (WHERE num_nonnulls(s.first_name, s.last_name, s.membership_number) > 0)::int AS held
         FROM member_account a JOIN signup_request s ON s.sub = a.sub
         WHERE a.status = 'removed' AND EXISTS (SELECT 1 FROM signup_request x WHERE x.sub = a.sub AND x.decision = 'approved')
         GROUP BY a.sub ORDER BY a.sub`,
      );
      // Removed members, by RemoveMember and by EraseSignup, from the tests above: each holds nothing typed.
      expect(rows.map((r) => r.sub)).toEqual(expect.arrayContaining(['sub-leaver', 'sub-returner', 'sub-invitee']));
      for (const row of rows) expect(row, row.sub).toEqual({ sub: row.sub, held: 0 });
    });

    it('audits nothing more when the account had no profile to erase', async () => {
      const before = await auditMark();
      await membership.removeMember({ subject: 'sub-member' }, APPROVER);
      expect((await auditSince(before)).map((r) => r.action)).toEqual(['remove']);
    });
  });

  it('never logs a number, a name typed at sign-up or a reason, through every call above', () => {
    expect(numbers.length).toBeGreaterThanOrEqual(10);
    const logged = JSON.stringify(api.logs);
    for (const number of numbers) expect(logged).not.toContain(number);
    expect(logged).not.toContain('Two digits were swapped');
  });
});
