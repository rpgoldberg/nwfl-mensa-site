// VET (a): sign-up vetting that stops someone using another member's name and number. The verifier
// (nwfl-verifier, on the home box) matches against the offline roster there; the roster never reaches
// this API, which sends it only our own sign-up data and records what it reports.
//   - ListPendingVerifications also gives the email stored on the sign-up (from the verified token),
//     which the verifier compares with the roster's email locally.
//   - Two more outcomes: EMAIL_MISMATCH (number and last name match, the email does not) and
//     DUPLICATE_CLAIM (the verifier's own ledger says another sign-up claimed the number). Neither
//     approves or rejects; an approval of either is on the officer's word, as for NOT_FOUND, never
//     from the verifier's date. Reporting still erases the number and the last name at once.
//   - A duplicate claim may name the earlier sign-up (conflicting_request_id); the approver then sees
//     that sign-up's display name and date, which the site already holds.
//   - ListReleasedClaims: the sign-ups whose claim is released (rejected, reopened, or whose account
//     was removed or deleted), ids and times only, after a stable cursor, for the verifier only.
// Every value here is made up.
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { type Client, Code } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MembershipService, Verification } from '../../src/gen/nwfl/mensa/v1/membership_pb.js';
import { ClaimReleaseKind, MembershipVerifierService, VerificationOutcome } from '../../src/gen/nwfl/mensa/v1/membership_verifier_pb.js';
import { type Api, MEMBER, as, dump, startApi } from '../helpers/api.js';
import { live } from '../helpers/pg.js';

const VERIFIER = as('verifier-token');
const APPROVER = as('approver-token');
const ADMIN = as('admin-token');
const UNKNOWN_ID = '6a1f0c8e-0000-4000-8000-000000000000';

describe.skipIf(!live)('VET: the vetting contract', () => {
  let api: Api;
  let verifier: Client<typeof MembershipVerifierService>;
  let membership: Client<typeof MembershipService>;
  let n = 0;
  /** What every sign-up here typed or holds: no released-claims answer may carry any of it. */
  const typed: string[] = [];

  /** A numbered, unchecked sign-up waiting for the verifier, with its pending account. */
  const signup = async (name: string, createdAt = new Date(Date.UTC(2026, 9, 21, 12, n))): Promise<{ id: string; sub: string; number: string; last: string; email: string }> => {
    n += 1;
    const sub = `sub-vet-${n}`;
    const number = String(700_100 + n);
    const last = `Vetson${n}`;
    const email = `vet${n}@example.org`;
    const { rows } = await api.pool.query<{ id: string }>(
      `INSERT INTO signup_request (sub, display_name, email, last_name, membership_number, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [sub, name, email, last, number, createdAt],
    );
    await api.pool.query(`INSERT INTO member_account (sub, status, route) VALUES ($1, 'pending', 'signup')`, [sub]);
    typed.push(number, last, email, name);
    return { id: (rows[0] as { id: string }).id, sub, number, last, email };
  };
  const row = async (id: string) =>
    (
      await api.pool.query<{ verification: string; membership_number: string | null; last_name: string | null; conflicting_request_id: string | null; decision: string }>(
        `SELECT verification, membership_number, last_name, conflicting_request_id, decision FROM signup_request WHERE id = $1`,
        [id],
      )
    ).rows[0];
  const account = async (sub: string) =>
    (await api.pool.query<{ status: string; verified_on: string | null }>(`SELECT status, verified_on::text AS verified_on FROM member_account WHERE sub = $1`, [sub])).rows[0];
  const actions = async (subjectId: string) =>
    (await api.pool.query<{ action: string }>(`SELECT action FROM audit_event WHERE subject_id = $1 ORDER BY id`, [subjectId])).rows.map((r) => r.action);
  /** Every release after a cursor, page by page; with the cursor it ends on. */
  const releasedAfter = async (after: string): Promise<{ released: Array<{ requestId: string; kind: ClaimReleaseKind; releasedAt: Date }>; cursor: string }> => {
    const out: Array<{ requestId: string; kind: ClaimReleaseKind; releasedAt: Date }> = [];
    let cursor = after;
    for (;;) {
      const page = await verifier.listReleasedClaims({ after: cursor }, VERIFIER);
      out.push(...page.released.map((r) => ({ requestId: r.requestId, kind: r.kind, releasedAt: timestampDate(r.releasedAt as NonNullable<typeof r.releasedAt>) })));
      if (page.released.length === 0) return { released: out, cursor: page.nextCursor };
      cursor = page.nextCursor;
    }
  };

  beforeAll(async () => {
    api = await startApi('nwfl_vet');
    verifier = api.client(MembershipVerifierService);
    membership = api.client(MembershipService);
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('ListPendingVerifications', () => {
    it('also gives the email stored on the sign-up, for the verifier to compare locally', async () => {
      const s = await signup('Pat Example', new Date('2026-10-01T12:00:00Z'));
      const pending = (await verifier.listPendingVerifications({}, VERIFIER)).pending.find((p) => p.requestId === s.id);
      expect(pending).toEqual(expect.objectContaining({ requestId: s.id, membershipNumber: s.number, lastName: s.last, email: s.email }));
      await verifier.reportVerification({ requestId: s.id, outcome: VerificationOutcome.ERROR }, VERIFIER);
    });
  });

  describe('ReportVerification: the two new outcomes', () => {
    it('records EMAIL_MISMATCH, erasing the number and the last name in the same statement; it neither approves nor rejects', async () => {
      const s = await signup('Robin Mismatch');
      await verifier.reportVerification({ requestId: s.id, outcome: VerificationOutcome.EMAIL_MISMATCH }, VERIFIER);
      expect(await row(s.id)).toEqual({ verification: 'email_mismatch', membership_number: null, last_name: null, conflicting_request_id: null, decision: 'pending' });
      expect(await account(s.sub)).toEqual({ status: 'pending', verified_on: null });
    });

    it('records DUPLICATE_CLAIM with the earlier sign-up it names, erasing the inputs; it neither approves nor rejects', async () => {
      const earlier = await signup('Lee Firstclaim', new Date('2026-09-15T14:00:00Z'));
      await verifier.reportVerification({ requestId: earlier.id, outcome: VerificationOutcome.VERIFIED_LOCAL }, VERIFIER);
      const s = await signup('Lee Secondclaim');
      await verifier.reportVerification({ requestId: s.id, outcome: VerificationOutcome.DUPLICATE_CLAIM, conflictingRequestId: earlier.id }, VERIFIER);
      expect(await row(s.id)).toEqual({ verification: 'duplicate_claim', membership_number: null, last_name: null, conflicting_request_id: earlier.id, decision: 'pending' });
      expect(await account(s.sub)).toEqual({ status: 'pending', verified_on: null });
    });

    it('records DUPLICATE_CLAIM without an earlier sign-up too', async () => {
      const s = await signup('Kai Unnamed');
      await verifier.reportVerification({ requestId: s.id, outcome: VerificationOutcome.DUPLICATE_CLAIM }, VERIFIER);
      expect(await row(s.id)).toMatchObject({ verification: 'duplicate_claim', conflicting_request_id: null, membership_number: null });
    });

    it('refuses an earlier sign-up with any other outcome, a malformed one, this one itself or one that does not exist, and changes nothing', async () => {
      const other = await signup('Sam Elsewhere');
      const s = await signup('Sam Refused');
      for (const outcome of [VerificationOutcome.VERIFIED_LOCAL, VerificationOutcome.VERIFIED_OTHER_GROUP, VerificationOutcome.NOT_FOUND, VerificationOutcome.ERROR, VerificationOutcome.EMAIL_MISMATCH]) {
        await expect(verifier.reportVerification({ requestId: s.id, outcome, conflictingRequestId: other.id }, VERIFIER)).rejects.toMatchObject({ code: Code.InvalidArgument });
      }
      for (const conflictingRequestId of ['nope', s.id, UNKNOWN_ID]) {
        await expect(verifier.reportVerification({ requestId: s.id, outcome: VerificationOutcome.DUPLICATE_CLAIM, conflictingRequestId }, VERIFIER)).rejects.toMatchObject({
          code: Code.InvalidArgument,
        });
      }
      expect(await row(s.id)).toMatchObject({ verification: 'unchecked', membership_number: s.number, last_name: s.last, conflicting_request_id: null });
    });
  });

  describe('the approver', () => {
    it('sees the two outcomes, and the earlier claim by display name and sign-up time only, never a number or a last name', async () => {
      const { requests } = await membership.listSignupRequests({}, APPROVER);
      const by = (name: string) => requests.find((r) => r.displayName === name);
      expect(by('Robin Mismatch')).toMatchObject({ verification: Verification.EMAIL_MISMATCH, verifiedOn: { year: 2026, month: 10, day: 22 } });
      expect(by('Robin Mismatch')?.earlierClaim).toBeUndefined();
      const second = by('Lee Secondclaim');
      expect(second?.verification).toBe(Verification.DUPLICATE_CLAIM);
      expect(second?.earlierClaim?.displayName).toBe('Lee Firstclaim');
      expect(timestampDate(second?.earlierClaim?.signedUpAt as NonNullable<NonNullable<typeof second>['createdAt']>)).toEqual(new Date('2026-09-15T14:00:00Z'));
      expect(by('Kai Unnamed')).toMatchObject({ verification: Verification.DUPLICATE_CLAIM });
      expect(by('Kai Unnamed')?.earlierClaim).toBeUndefined();
      expect(dump(requests)).not.toMatch(/700\d{3}|Vetson/);
    });

    it.each([
      ['Robin Mismatch', 'email_mismatch'],
      ['Lee Secondclaim', 'duplicate_claim'],
    ])('approves %s (%s) only on the officer’s word, as of today, as for NOT_FOUND: never from the verifier’s date', async (name) => {
      const { rows } = await api.pool.query<{ id: string; sub: string }>(`SELECT id, sub FROM signup_request WHERE display_name = $1`, [name]);
      const { id, sub } = rows[0] as { id: string; sub: string };
      // A verifier date unlike today, so a local match's path would show.
      await api.pool.query(`UPDATE signup_request SET verified_on = '2026-10-20' WHERE id = $1`, [id]);
      const { account: approved } = await membership.approveSignup({ requestId: id }, APPROVER);
      expect(approved?.verifiedOn).toEqual(expect.objectContaining({ year: 2026, month: 10, day: 22 }));
      expect(await account(sub)).toEqual({ status: 'member', verified_on: '2026-10-22' });
      expect(await actions(sub)).toEqual(['approve_attested']);
    });
  });

  describe('ListReleasedClaims', () => {
    it('lists each release in order after the cursor: a rejection, a reopening and a removed member’s claim, ids and times only', async () => {
      const { cursor: start } = await releasedAfter('');
      const rejected = await signup('Ari Rejected');
      const removed = await signup('Bo Removed');
      const kept = await signup('Cam Kept');
      await membership.rejectSignup({ requestId: rejected.id }, APPROVER);
      await membership.reopenSignup({ requestId: rejected.id }, ADMIN);
      await membership.approveSignup({ requestId: removed.id }, APPROVER);
      await membership.removeMember({ subject: removed.sub }, APPROVER);
      await membership.approveSignup({ requestId: kept.id }, APPROVER);
      const { released, cursor } = await releasedAfter(start);
      expect(released.map((r) => [r.requestId, r.kind])).toEqual([
        [rejected.id, ClaimReleaseKind.REJECTED],
        [rejected.id, ClaimReleaseKind.REOPENED],
        [removed.id, ClaimReleaseKind.ACCOUNT_DELETED],
      ]);
      for (const r of released) expect(r.releasedAt).toBeInstanceOf(Date);
      expect(cursor).not.toBe(start);
      // Nothing new: the same cursor back, and nothing listed.
      expect(await verifier.listReleasedClaims({ after: cursor }, VERIFIER)).toMatchObject({ released: [], nextCursor: cursor });
      const all = dump(await verifier.listReleasedClaims({}, VERIFIER));
      for (const value of typed) expect(all).not.toContain(value);
      expect(all).not.toContain('@');
    });

    it('releases a pending sign-up rejected with its removed account once, as a rejection', async () => {
      const { cursor: start } = await releasedAfter('');
      const s = await signup('Dee Removedpending');
      await membership.removeMember({ subject: s.sub }, APPROVER);
      expect((await releasedAfter(start)).released.map((r) => [r.requestId, r.kind])).toEqual([[s.id, ClaimReleaseKind.REJECTED]]);
    });

    it('pages by page_size, oldest first, and refuses a negative page size or a cursor that is not one', async () => {
      const first = await verifier.listReleasedClaims({ pageSize: 1 }, VERIFIER);
      expect(first.released).toHaveLength(1);
      const second = await verifier.listReleasedClaims({ after: first.nextCursor, pageSize: 2 }, VERIFIER);
      expect(second.released).toHaveLength(2);
      const both = await verifier.listReleasedClaims({ pageSize: 3 }, VERIFIER);
      expect(both.released.map((r) => [r.requestId, r.kind])).toEqual([...first.released, ...second.released].map((r) => [r.requestId, r.kind]));
      expect(both.nextCursor).toBe(second.nextCursor);
      await expect(verifier.listReleasedClaims({ pageSize: -1 }, VERIFIER)).rejects.toMatchObject({ code: Code.InvalidArgument });
      for (const after of ['x', '-1', '1.5', '01', '1'.repeat(19)]) {
        await expect(verifier.listReleasedClaims({ after }, VERIFIER)).rejects.toMatchObject({ code: Code.InvalidArgument });
      }
      expect((await verifier.listReleasedClaims({ pageSize: 500 }, VERIFIER)).released.length).toBeLessThanOrEqual(100);
    });

    it('is for the verifier only', async () => {
      await expect(verifier.listReleasedClaims({})).rejects.toMatchObject({ code: Code.Unauthenticated });
      for (const options of [MEMBER, APPROVER, ADMIN, as('agent-token')]) {
        await expect(verifier.listReleasedClaims({}, options)).rejects.toMatchObject({ code: Code.PermissionDenied });
      }
    });
  });
});
