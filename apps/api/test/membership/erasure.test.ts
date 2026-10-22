// A5 erasure: a membership number and a last name live in exactly one place,
// the undecided sign-up row, and only until the verifier reports or an officer
// decides. Every write RPC that ends that wait is walked here, and after each
// the WHOLE database the app can read, and the API's log, are searched for
// them. Every value here is made up.
import { randomInt } from 'node:crypto';
import { type Client } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MembershipService } from '../../src/gen/nwfl/mensa/v1/membership_pb.js';
import { MembershipVerifierService, VerificationOutcome } from '../../src/gen/nwfl/mensa/v1/membership_verifier_pb.js';
import { type Api, as, startApi } from '../helpers/api.js';
import { live } from '../helpers/pg.js';

const APPROVER = as('approver-token');
const VERIFIER = as('verifier-token');

describe.skipIf(!live)('erasure of the verifier inputs', () => {
  let api: Api;
  let membership: Client<typeof MembershipService>;
  let verifier: Client<typeof MembershipVerifierService>;

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

  /** A sign-up with its own number and last name, as the given person. */
  const signUp = async (token: Parameters<typeof as>[0]): Promise<{ id: string; number: string; last: string }> => {
    const number = String(randomInt(100_000_000_000, 999_999_999_999));
    const last = `Erasure${randomInt(1_000_000, 9_999_999)}`;
    const { requestId } = await membership.submitSignup({ lastName: last, membershipNumber: number }, as(token));
    return { id: requestId, number, last };
  };

  const gone = async (inputs: { number: string; last: string }): Promise<void> => {
    expect(await whereIs(inputs.number)).toEqual([]);
    expect(await whereIs(inputs.last)).toEqual([]);
    expect(JSON.stringify(api.logs)).not.toContain(inputs.number);
    expect(JSON.stringify(api.logs)).not.toContain(inputs.last);
  };

  beforeAll(async () => {
    api = await startApi('nwfl_erasure');
    membership = api.client(MembershipService);
    verifier = api.client(MembershipVerifierService);
  });

  afterAll(async () => {
    await api?.close();
  });

  it('keeps a submitted number and last name in the undecided sign-up row only', async () => {
    const inputs = await signUp('joiner-token');
    expect(await whereIs(inputs.number)).toEqual(['signup_request.membership_number']);
    expect(await whereIs(inputs.last)).toEqual(['signup_request.last_name']);
    // The verifier's read is the one place they leave the row.
    expect((await verifier.listPendingVerifications({}, VERIFIER)).pending).toEqual([expect.objectContaining({ membershipNumber: inputs.number, lastName: inputs.last })]);
    await verifier.reportVerification({ requestId: inputs.id, outcome: VerificationOutcome.NOT_FOUND }, VERIFIER);
    await gone(inputs);
  });

  it('erases them when an approver approves before the verifier reports', async () => {
    const inputs = await signUp('joiner2-token');
    await membership.approveSignup({ requestId: inputs.id }, APPROVER);
    await gone(inputs);
  });

  it('erases them when an approver rejects', async () => {
    const inputs = await signUp('joiner3-token');
    await membership.rejectSignup({ requestId: inputs.id }, APPROVER);
    await gone(inputs);
  });

  it('erases them when an affiliate grant answers the sign-up', async () => {
    const inputs = await signUp('affiliate-token');
    await membership.grantAffiliate({ subject: 'sub-affiliate' }, as('admin-token'));
    await gone(inputs);
  });

  it('erases them when the account is removed while its sign-up is still open, and the sign-up leaves both queues', async () => {
    const inputs = await signUp('racer-token');
    await membership.removeMember({ subject: 'sub-racer' }, APPROVER);
    await gone(inputs);
    expect((await membership.listSignupRequests({}, APPROVER)).requests.map((r) => r.requestId)).not.toContain(inputs.id);
    expect((await verifier.listPendingVerifications({}, VERIFIER)).pending).toEqual([]);
  });
});
