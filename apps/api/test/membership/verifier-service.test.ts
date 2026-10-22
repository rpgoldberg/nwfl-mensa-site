// A5: MembershipVerifierService (R33). Only the verifier client gets in. It
// reads the pending, unchecked sign-ups that typed a number, oldest first, ten
// at most; it reports an outcome, which records the outcome and the date and
// erases the number and the last name in the same statement. A local match
// does not approve: an officer still does (R24). Every value here is made up.
import { type Client, Code } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MembershipService, Verification } from '../../src/gen/nwfl/mensa/v1/membership_pb.js';
import { MembershipVerifierService, VerificationOutcome } from '../../src/gen/nwfl/mensa/v1/membership_verifier_pb.js';
import { type Api, MEMBER, as, startApi } from '../helpers/api.js';
import { live } from '../helpers/pg.js';

const VERIFIER = as('verifier-token');
const APPROVER = as('approver-token');

describe.skipIf(!live)('MembershipVerifierService', () => {
  let api: Api;
  let verifier: Client<typeof MembershipVerifierService>;
  const ids: string[] = [];

  const row = async (id: string) =>
    (
      await api.pool.query<{ verification: string; verified_on: string | null; membership_number: string | null; last_name: string | null; decision: string }>(
        `SELECT verification, verified_on::text AS verified_on, membership_number, last_name, decision FROM signup_request WHERE id = $1`,
        [id],
      )
    ).rows[0];

  beforeAll(async () => {
    api = await startApi('nwfl_verifier');
    verifier = api.client(MembershipVerifierService);
    // Twelve numbered sign-ups a minute apart, one without a number, one already decided.
    for (let n = 0; n < 12; n += 1) {
      const { rows } = await api.pool.query<{ id: string }>(
        `INSERT INTO signup_request (sub, display_name, email, last_name, membership_number, created_at)
         VALUES ($1, 'Pat Example', 'pat@example.org', $2, $3, $4) RETURNING id`,
        [`sub-v${n}`, `Example${n}`, String(500100 + n), new Date(Date.UTC(2026, 9, 21, 12, n))],
      );
      ids.push((rows[0] as { id: string }).id);
    }
    await api.pool.query(`INSERT INTO signup_request (sub, display_name, email, created_at) VALUES ('sub-nonumber', 'Robin Sample', 'robin@example.org', '2026-10-20T12:00:00Z')`);
    await api.pool.query(
      `INSERT INTO signup_request (sub, display_name, email, decision, decided_at, decided_by_sub, created_at) VALUES ('sub-decided', 'Lee Example', 'lee@example.org', 'rejected', now(), 'sub-admin', '2026-10-19T12:00:00Z')`,
    );
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('ListPendingVerifications', () => {
    it('lists the oldest ten numbered, unchecked, undecided sign-ups: id, number and last name only', async () => {
      const { pending } = await verifier.listPendingVerifications({}, VERIFIER);
      expect(pending.map((p) => p.requestId)).toEqual(ids.slice(0, 10));
      expect(pending[0]).toMatchObject({ membershipNumber: '500100', lastName: 'Example0' });
      expect((await verifier.listPendingVerifications({ pageSize: 50 }, VERIFIER)).pending).toHaveLength(10);
      expect((await verifier.listPendingVerifications({ pageSize: 3 }, VERIFIER)).pending.map((p) => p.requestId)).toEqual(ids.slice(0, 3));
      await expect(verifier.listPendingVerifications({ pageSize: -1 }, VERIFIER)).rejects.toMatchObject({ code: Code.InvalidArgument });
    });

    it('records each read of a number in the audit log, with no payload', async () => {
      const { rows } = await api.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_event WHERE action = 'verification_listed' AND subject_kind = 'signup_request' AND actor_kind = 'verifier' AND payload = '{}'::jsonb AND subject_id = $1`,
        [ids[0]],
      );
      expect(rows[0]?.n).toBeGreaterThanOrEqual(1);
    });

    it('is for the verifier only', async () => {
      await expect(verifier.listPendingVerifications({})).rejects.toMatchObject({ code: Code.Unauthenticated });
      for (const options of [MEMBER, APPROVER, as('admin-token'), as('agent-token')]) {
        await expect(verifier.listPendingVerifications({}, options)).rejects.toMatchObject({ code: Code.PermissionDenied });
      }
    });
  });

  describe('ReportVerification', () => {
    it('records the outcome and the date and erases the number and the last name, and the sign-up leaves the list', async () => {
      const id = ids[0] as string;
      await verifier.reportVerification({ requestId: id, outcome: VerificationOutcome.VERIFIED_LOCAL }, VERIFIER);
      expect(await row(id)).toEqual({ verification: 'verified_local', verified_on: '2026-10-22', membership_number: null, last_name: null, decision: 'pending' });
      expect((await verifier.listPendingVerifications({}, VERIFIER)).pending.map((p) => p.requestId)).toEqual(ids.slice(1, 11));
      const { rows } = await api.pool.query<{ action: string; to_state: string; payload: unknown; actor_sub: string }>(
        `SELECT action, to_state, payload, actor_sub FROM audit_event WHERE subject_id = $1 AND action = 'verification_report'`,
        [id],
      );
      expect(rows).toEqual([{ action: 'verification_report', to_state: 'verified_local', payload: {}, actor_sub: 'svc-nwfl-verifier' }]);
    });

    it('does not approve a local match: the approver sees the outcome and still decides', async () => {
      const listed = (await api.client(MembershipService).listSignupRequests({}, APPROVER)).requests.find((r) => r.requestId === ids[0]);
      expect(listed).toMatchObject({ verification: Verification.VERIFIED_LOCAL, verifiedOn: { year: 2026, month: 10, day: 22 } });
      const { rows } = await api.pool.query(`SELECT 1 FROM member_account WHERE sub = 'sub-v0'`);
      expect(rows).toEqual([]);
    });

    it.each([
      [VerificationOutcome.VERIFIED_OTHER_GROUP, 'verified_other_group'],
      [VerificationOutcome.NOT_FOUND, 'not_found'],
      [VerificationOutcome.ERROR, 'error'],
    ])('records outcome %i as %s, erasing the inputs', async (outcome, stored) => {
      const id = ids[outcome] as string;
      await verifier.reportVerification({ requestId: id, outcome }, VERIFIER);
      expect(await row(id)).toMatchObject({ verification: stored, membership_number: null, last_name: null });
    });

    it('reports a sign-up once, and refuses no outcome, an unknown id and a malformed one', async () => {
      await expect(verifier.reportVerification({ requestId: ids[0] as string, outcome: VerificationOutcome.NOT_FOUND }, VERIFIER)).rejects.toMatchObject({
        code: Code.FailedPrecondition,
      });
      expect((await row(ids[0] as string))?.verification).toBe('verified_local');
      await expect(verifier.reportVerification({ requestId: ids[5] as string, outcome: VerificationOutcome.UNSPECIFIED }, VERIFIER)).rejects.toMatchObject({
        code: Code.InvalidArgument,
      });
      await expect(verifier.reportVerification({ requestId: '6a1f0c8e-0000-4000-8000-000000000000', outcome: VerificationOutcome.ERROR }, VERIFIER)).rejects.toMatchObject({
        code: Code.NotFound,
      });
      await expect(verifier.reportVerification({ requestId: 'nope', outcome: VerificationOutcome.ERROR }, VERIFIER)).rejects.toMatchObject({ code: Code.InvalidArgument });
      await expect(verifier.reportVerification({ requestId: ids[5] as string, outcome: VerificationOutcome.ERROR }, APPROVER)).rejects.toMatchObject({
        code: Code.PermissionDenied,
      });
    });

    it('refuses a report on a sign-up with no number or one already decided', async () => {
      const { rows } = await api.pool.query<{ id: string; sub: string }>(`SELECT id, sub FROM signup_request WHERE sub IN ('sub-nonumber', 'sub-decided') ORDER BY sub`);
      for (const r of rows) {
        await expect(verifier.reportVerification({ requestId: r.id, outcome: VerificationOutcome.ERROR }, VERIFIER)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      }
    });
  });
});
