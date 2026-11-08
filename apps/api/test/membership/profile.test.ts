// PROFILE-ID (Ross, 11-08): what a person typed at sign-up (first name, last name, membership number) is
// kept on the one sign-up row in every state, shown to the approvers and the Admin in the queue and the
// rejections so they can judge it, and, once approved, is the member's profile: the names editable by
// the member, the number never. It reverses A5's erasure. Walked here: every write that ends the wait
// (the verifier's report, an approval, a rejection, an affiliate grant, a removal), and after each the
// WHOLE database the app can read is searched, so the values are seen to stay in that one row and
// nowhere else, the audit included. The API's log never holds the number, and no error gives it back.
// Every value here is made up.
import { randomInt } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { BinaryWriter, WireType } from '@bufbuild/protobuf/wire';
import { Code, type Client } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MembershipService, UpdateMyProfileRequestSchema } from '../../src/gen/nwfl/mensa/v1/membership_pb.js';
import { MembershipVerifierService, VerificationOutcome } from '../../src/gen/nwfl/mensa/v1/membership_verifier_pb.js';
import { type Api, MEMBER, as, dump, startApi } from '../helpers/api.js';
import { live } from '../helpers/pg.js';

const APPROVER = as('approver-token');
const ADMIN = as('admin-token');
const VERIFIER = as('verifier-token');

interface Typed {
  id: string;
  first: string;
  last: string;
  number: string;
}

describe.skipIf(!live)('PROFILE-ID: what a person typed, kept, and shown to its owner and the approvers only', () => {
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

  /** A sign-up with its own names and number, as the given person. */
  const signUp = async (token: Parameters<typeof as>[0]): Promise<Typed> => {
    const number = String(randomInt(100_000_000_000, 999_999_999_999));
    numbers.push(number);
    const first = `First${randomInt(1_000_000, 9_999_999)}`;
    const last = `Last${randomInt(1_000_000, 9_999_999)}`;
    const { requestId } = await membership.submitSignup({ firstName: first, lastName: last, membershipNumber: number }, as(token));
    return { id: requestId, first, last, number };
  };

  /** In the one sign-up row, and nowhere else the app can read. */
  const keptOnce = async (typed: Typed): Promise<void> => {
    expect(await whereIs(typed.number)).toEqual(['signup_request.membership_number']);
    expect(await whereIs(typed.last)).toEqual(['signup_request.last_name']);
    expect(await whereIs(typed.first)).toEqual(['signup_request.first_name']);
  };

  const queued = async (id: string) => (await membership.listSignupRequests({}, APPROVER)).requests.find((r) => r.requestId === id);

  beforeAll(async () => {
    api = await startApi('nwfl_profile');
    membership = api.client(MembershipService);
    verifier = api.client(MembershipVerifierService);
  });

  afterAll(async () => {
    await api?.close();
  });

  let joiner: Typed;
  let rejected: Typed;

  describe('kept in every state, in one place', () => {
    it('through the verifier\'s report, still shown to the approvers as typed', async () => {
      joiner = await signUp('joiner-token');
      await keptOnce(joiner);
      expect(await queued(joiner.id)).toMatchObject({ firstName: joiner.first, lastName: joiner.last, membershipNumber: joiner.number });
      await verifier.reportVerification({ requestId: joiner.id, outcome: VerificationOutcome.NOT_FOUND }, VERIFIER);
      await keptOnce(joiner);
      expect(await queued(joiner.id)).toMatchObject({ firstName: joiner.first, lastName: joiner.last, membershipNumber: joiner.number });
    });

    it('through an approval, as the member\'s profile, which only its owner reads', async () => {
      await membership.approveSignup({ requestId: joiner.id }, APPROVER);
      await keptOnce(joiner);
      expect((await membership.getMyAccount({}, as('joiner-token'))).profile).toMatchObject({ firstName: joiner.first, lastName: joiner.last, membershipNumber: joiner.number });
      // Another member's account: no profile of theirs, and never the joiner's.
      const other = await membership.getMyAccount({}, MEMBER);
      expect(other.profile).toBeUndefined();
      expect(dump(other)).not.toContain(joiner.number);
    });

    it('through a rejection, shown in the rejections to the Admin and the Membership Officer', async () => {
      rejected = await signUp('joiner2-token');
      await membership.rejectSignup({ requestId: rejected.id }, APPROVER);
      await keptOnce(rejected);
      for (const who of [ADMIN, APPROVER]) {
        const listed = (await membership.listRejectedSignups({}, who)).requests.find((r) => r.requestId === rejected.id);
        expect(listed).toMatchObject({ firstName: rejected.first, lastName: rejected.last, membershipNumber: rejected.number });
      }
      // A rejected person has no profile: they are not a member.
      expect((await membership.getMyAccount({}, as('joiner2-token'))).profile).toBeUndefined();
    });

    it('through an affiliate grant that answers the sign-up', async () => {
      const typed = await signUp('affiliate-token');
      await membership.grantAffiliate({ subject: 'sub-affiliate' }, ADMIN);
      await keptOnce(typed);
    });

    it('through a removal while the sign-up is still open, which leaves both queues', async () => {
      const typed = await signUp('racer-token');
      await membership.removeMember({ subject: 'sub-racer' }, APPROVER);
      await keptOnce(typed);
      expect(await queued(typed.id)).toBeUndefined();
      expect((await verifier.listPendingVerifications({}, VERIFIER)).pending.map((p) => p.requestId)).not.toContain(typed.id);
    });
  });

  describe('a duplicate claim', () => {
    it('shows the earlier claim\'s typed names and number beside the later one\'s', async () => {
      const earlier = await signUp('joiner3-token');
      const later = await signUp('invitee-token');
      await verifier.reportVerification({ requestId: later.id, outcome: VerificationOutcome.DUPLICATE_CLAIM, conflictingRequestId: earlier.id }, VERIFIER);
      expect(await queued(later.id)).toMatchObject({
        firstName: later.first,
        lastName: later.last,
        membershipNumber: later.number,
        earlierClaim: { closed: false, firstName: earlier.first, lastName: earlier.last, membershipNumber: earlier.number },
      });
    });

    it('shows none of a claim since closed (VET fix 1: a rejected sign-up stays with the Admin and the Membership Officer)', async () => {
      const earlier = await signUp('spacer-token');
      await membership.rejectSignup({ requestId: earlier.id }, APPROVER);
      const later = await signUp('turned-down-token');
      await verifier.reportVerification({ requestId: later.id, outcome: VerificationOutcome.DUPLICATE_CLAIM, conflictingRequestId: earlier.id }, VERIFIER);
      const claim = (await queued(later.id))?.earlierClaim;
      expect(claim).toMatchObject({ closed: true, displayName: '', firstName: '', lastName: '', membershipNumber: '' });
    });
  });

  describe('the member changes their names, never the number', () => {
    it('saves new names, keeps the number, and audits the change with no payload', async () => {
      await membership.updateMyProfile({ firstName: ' Jamie-Lee ', lastName: ' Example Two ' }, as('joiner-token'));
      expect((await membership.getMyAccount({}, as('joiner-token'))).profile).toMatchObject({ firstName: 'Jamie-Lee', lastName: 'Example Two', membershipNumber: joiner.number });
      const { rows } = await api.pool.query(`SELECT actor_sub, subject_kind, subject_id, payload FROM audit_event WHERE action = 'profile_update'`);
      expect(rows).toEqual([{ actor_sub: 'sub-joiner', subject_kind: 'signup_request', subject_id: joiner.id, payload: {} }]);
    });

    it('refuses a number sent along under any field, changing nothing', async () => {
      const request = create(UpdateMyProfileRequestSchema, { firstName: 'Jamie', lastName: 'Example' });
      request.$unknown = [{ no: 3, wireType: WireType.LengthDelimited, data: new BinaryWriter().string('111222333').finish() }];
      const error = await membership.updateMyProfile(request, as('joiner-token')).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: Code.InvalidArgument, rawMessage: 'only the first and last name can be changed' });
      expect(dump(error)).not.toContain('111222333');
      expect((await membership.getMyAccount({}, as('joiner-token'))).profile).toMatchObject({ firstName: 'Jamie-Lee', membershipNumber: joiner.number });
    });

    it.each([
      ['an empty first name', { firstName: '  ', lastName: 'Example' }, 'a first name is needed'],
      ['an empty last name', { firstName: 'Jamie', lastName: '' }, 'a last name is needed'],
      ['a first name over 80 characters', { firstName: 'F'.repeat(81), lastName: 'Example' }, 'a first name is at most 80 characters'],
      ['a last name over 80 characters', { firstName: 'Jamie', lastName: 'L'.repeat(81) }, 'a last name is at most 80 characters'],
      ['a first name with a hidden character', { firstName: 'Ja\u0000mie', lastName: 'Example' }, 'a first name has a hidden character'],
      ['a last name with a hidden character', { firstName: 'Jamie', lastName: 'Exam\nple' }, 'a last name has a hidden character'],
    ])('refuses %s', async (_case, names, message) => {
      await expect(membership.updateMyProfile(names, as('joiner-token'))).rejects.toMatchObject({ code: Code.InvalidArgument, rawMessage: message });
    });

    it.each([
      ['a pending person', 'joiner3-token'],
      ['a rejected person', 'joiner2-token'],
      ['a member who never signed up', 'member-token'],
    ] as const)('refuses %s, who has no profile', async (_who, token) => {
      await expect(membership.updateMyProfile({ firstName: 'Jamie', lastName: 'Example' }, as(token))).rejects.toMatchObject({
        code: Code.FailedPrecondition,
        rawMessage: 'only an approved member has a profile to change',
      });
    });

    it('refuses the public', async () => {
      await expect(membership.updateMyProfile({ firstName: 'Jamie', lastName: 'Example' }, {})).rejects.toMatchObject({ code: Code.Unauthenticated });
    });
  });

  it('never gives a typed number back in an error', async () => {
    for (const typed of ['123456789x', '1234567890123', '12 34 5x']) {
      const error = await membership.submitSignup({ firstName: 'Lee', lastName: 'Example', membershipNumber: typed }, as('typo-token')).catch((e: unknown) => e);
      expect(dump(error)).not.toContain(typed.replace(/\D/g, '').slice(0, 6));
    }
  });

  it('never logs a number, through every call above', () => {
    expect(numbers.length).toBeGreaterThanOrEqual(8);
    const logged = JSON.stringify(api.logs);
    for (const number of numbers) expect(logged).not.toContain(number);
  });
});
