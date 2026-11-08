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
//   - Fix 1: approving either warning outcome needs confirmed_warning, enforced here, and the audit
//     records that it was confirmed; an earlier claim since closed is named only as closed; a reported
//     sign-up the owner deletes is released as DELETED; a page is at most 100, the default too; a
//     poller that follows next_cursor alone misses no release, whatever the writers race.
// Every value here is made up.
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { type Client, Code } from '@connectrpc/connect';
import pgLib from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MembershipService, Verification } from '../../src/gen/nwfl/mensa/v1/membership_pb.js';
import { ClaimReleaseKind, MembershipVerifierService, VerificationOutcome } from '../../src/gen/nwfl/mensa/v1/membership_verifier_pb.js';
import { type Api, MEMBER, as, dump, startApi } from '../helpers/api.js';
import { APP, APP_PW, MIGRATOR, MIGRATOR_PW, live, urlFor } from '../helpers/pg.js';

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

  const byName = async (name: string) => (await api.pool.query<{ id: string; sub: string }>(`SELECT id, sub FROM signup_request WHERE display_name = $1`, [name])).rows[0] as { id: string; sub: string };
  const database = async () => (await api.pool.query<{ d: string }>('SELECT current_database() AS d')).rows[0]?.d as string;

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
      expect(second?.earlierClaim?.closed).toBe(false);
      expect(timestampDate(second?.earlierClaim?.signedUpAt as NonNullable<NonNullable<typeof second>['createdAt']>)).toEqual(new Date('2026-09-15T14:00:00Z'));
      expect(by('Kai Unnamed')).toMatchObject({ verification: Verification.DUPLICATE_CLAIM });
      expect(by('Kai Unnamed')?.earlierClaim).toBeUndefined();
      expect(dump(requests)).not.toMatch(/700\d{3}|Vetson/);
    });

    it('names an earlier claim since closed only as closed, with its date: never the name of a rejected or reopened sign-up', async () => {
      // Fix 1 (N2): only the Admin and the Membership Officer see rejected sign-ups' names (ListRejectedSignups).
      const rejected = await signup('Noa Rejectedfirst', new Date('2026-09-01T10:00:00Z'));
      const reopened = await signup('Ola Reopenedfirst', new Date('2026-09-02T10:00:00Z'));
      const approved = await signup('Pia Approvedfirst', new Date('2026-09-03T10:00:00Z'));
      for (const s of [rejected, reopened, approved]) await verifier.reportVerification({ requestId: s.id, outcome: VerificationOutcome.VERIFIED_LOCAL }, VERIFIER);
      await membership.rejectSignup({ requestId: rejected.id }, APPROVER);
      await membership.rejectSignup({ requestId: reopened.id }, APPROVER);
      await membership.reopenSignup({ requestId: reopened.id }, ADMIN);
      await membership.approveSignup({ requestId: approved.id }, APPROVER);
      // Any existing sign-up may still be named.
      for (const [name, earlier] of [['Rex Afterrejected', rejected], ['Sol Afterreopened', reopened], ['Tam Afterapproved', approved]] as const) {
        const s = await signup(name);
        await verifier.reportVerification({ requestId: s.id, outcome: VerificationOutcome.DUPLICATE_CLAIM, conflictingRequestId: earlier.id }, VERIFIER);
      }
      const { requests } = await membership.listSignupRequests({}, APPROVER);
      const claimOf = (name: string) => requests.find((r) => r.displayName === name)?.earlierClaim;
      const dayOf = (claim: ReturnType<typeof claimOf>) => timestampDate(claim?.signedUpAt as NonNullable<NonNullable<typeof claim>['signedUpAt']>);
      expect(claimOf('Rex Afterrejected')).toMatchObject({ displayName: '', closed: true });
      expect(dayOf(claimOf('Rex Afterrejected'))).toEqual(new Date('2026-09-01T10:00:00Z'));
      expect(claimOf('Sol Afterreopened')).toMatchObject({ displayName: '', closed: true });
      expect(dayOf(claimOf('Sol Afterreopened'))).toEqual(new Date('2026-09-02T10:00:00Z'));
      expect(claimOf('Tam Afterapproved')).toMatchObject({ displayName: 'Pia Approvedfirst', closed: false });
      expect(dayOf(claimOf('Tam Afterapproved'))).toEqual(new Date('2026-09-03T10:00:00Z'));
      expect(dump(requests)).not.toMatch(/Rejectedfirst|Reopenedfirst/);
    });

    it.each([
      ['Robin Mismatch', 'the email differs from the roster: confirm with the member, then approve with confirmed_warning'],
      ['Lee Secondclaim', 'another sign-up already claimed this number: resolve the earlier claim, then approve with confirmed_warning'],
    ])('refuses to approve %s unless the approver confirmed the warning, whoever asks, and changes nothing', async (name, message) => {
      const { id, sub } = await byName(name);
      const before = await actions(id);
      for (const [options, confirmedWarning] of [[APPROVER, undefined], [APPROVER, false], [ADMIN, false]] as const) {
        await expect(membership.approveSignup({ requestId: id, ...(confirmedWarning === undefined ? {} : { confirmedWarning }) }, options)).rejects.toMatchObject({
          code: Code.FailedPrecondition,
          rawMessage: message,
        });
      }
      expect(await row(id)).toMatchObject({ decision: 'pending' });
      expect(await account(sub)).toEqual({ status: 'pending', verified_on: null });
      expect(await actions(id)).toEqual(before);
      expect(await actions(sub)).toEqual([]);
    });

    it.each([
      ['Robin Mismatch', 'email_mismatch'],
      ['Lee Secondclaim', 'duplicate_claim'],
    ])('approves %s (%s) once confirmed, only on the officer’s word, as of today, as for NOT_FOUND, and records the confirmation', async (name, verification) => {
      const { id, sub } = await byName(name);
      // A verifier date unlike today, so a local match's path would show.
      await api.pool.query(`UPDATE signup_request SET verified_on = '2026-10-20' WHERE id = $1`, [id]);
      const { account: approved } = await membership.approveSignup({ requestId: id, confirmedWarning: true }, APPROVER);
      expect(approved?.verifiedOn).toEqual(expect.objectContaining({ year: 2026, month: 10, day: 22 }));
      expect(await account(sub)).toEqual({ status: 'member', verified_on: '2026-10-22' });
      expect(await actions(sub)).toEqual(['approve_attested']);
      expect((await actions(id)).slice(-2)).toEqual(['approve', `approve_confirmed_${verification}`]);
    });

    it('approves every other outcome as before, flag or none, and records no confirmation', async () => {
      const local = await signup('Uma Local');
      await verifier.reportVerification({ requestId: local.id, outcome: VerificationOutcome.VERIFIED_LOCAL }, VERIFIER);
      const missing = await signup('Vic Notfound');
      await verifier.reportVerification({ requestId: missing.id, outcome: VerificationOutcome.NOT_FOUND }, VERIFIER);
      const unchecked = await signup('Wren Unchecked');
      await membership.approveSignup({ requestId: local.id, confirmedWarning: true }, APPROVER);
      await membership.approveSignup({ requestId: missing.id }, APPROVER);
      await membership.approveSignup({ requestId: unchecked.id, confirmedWarning: false }, APPROVER);
      for (const s of [local, missing, unchecked]) {
        expect((await account(s.sub))?.status).toBe('member');
        expect((await actions(s.id)).at(-1)).toBe('approve');
      }
      expect(await actions(local.sub)).toEqual(['approve_verified']);
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
    });

    it('caps a page at 100, the default too, when more than 100 are waiting (fix 1, S2)', async () => {
      const { cursor } = await releasedAfter('');
      for (let i = 0; i < 105; i += 1) {
        const s = await signup(`Pagey ${i}`);
        await api.pool.query(`UPDATE signup_request SET decision = 'rejected', decided_at = now(), decided_by_sub = 'officer-page', membership_number = NULL, last_name = NULL WHERE id = $1`, [s.id]);
      }
      expect((await verifier.listReleasedClaims({ after: cursor, pageSize: 500 }, VERIFIER)).released).toHaveLength(100);
      expect((await verifier.listReleasedClaims({ after: cursor, pageSize: 0 }, VERIFIER)).released).toHaveLength(100);
      expect((await verifier.listReleasedClaims({ after: cursor }, VERIFIER)).released).toHaveLength(100);
      expect((await releasedAfter(cursor)).released).toHaveLength(105);
    }, 60_000);

    it('lists a reported sign-up the owner deletes as DELETED, and an unreported one not at all (fix 1, N3)', async () => {
      const { cursor: start } = await releasedAfter('');
      const reported = await signup('Xan Deleted');
      await verifier.reportVerification({ requestId: reported.id, outcome: VerificationOutcome.VERIFIED_LOCAL }, VERIFIER);
      const unreported = await signup('Yu Deletedunchecked');
      const owner = new pgLib.Client({ connectionString: urlFor(MIGRATOR, MIGRATOR_PW, await database()) });
      await owner.connect();
      try {
        for (const s of [reported, unreported]) await owner.query(`DELETE FROM signup_request WHERE id = $1`, [s.id]);
      } finally {
        await owner.end();
      }
      const { released } = await releasedAfter(start);
      expect(released.map((r) => [r.requestId, r.kind])).toEqual([[reported.id, ClaimReleaseKind.DELETED]]);
    });

    it('lets a poller that follows next_cursor alone see every committed release once, while 16 writers race (fix 1, S1)', async () => {
      const WRITERS = 16;
      const ids: string[] = [];
      for (let i = 0; i < WRITERS * 3; i += 1) ids.push((await signup(`Racer ${i}`)).id);
      const { cursor: start } = await releasedAfter('');
      const name = await database();
      const clients = await Promise.all(
        Array.from({ length: WRITERS }, async () => {
          const c = new pgLib.Client({ connectionString: urlFor(APP, APP_PW, name) });
          await c.connect();
          return c;
        }),
      );
      let done = false;
      const seen: string[] = [];
      let cursor = start;
      const follow = async (): Promise<number> => {
        const page = await verifier.listReleasedClaims({ after: cursor }, VERIFIER);
        seen.push(...page.released.map((r) => r.requestId));
        cursor = page.nextCursor;
        return page.released.length;
      };
      const poller = (async () => {
        while (!done) await follow();
      })();
      try {
        // Each writer rejects three sign-ups, one transaction each, holding each open a random 0-60 ms.
        await Promise.all(
          clients.map(async (c, w) => {
            for (let k = 0; k < 3; k += 1) {
              await c.query('BEGIN');
              await c.query(`UPDATE signup_request SET decision = 'rejected', decided_at = now(), decided_by_sub = 'officer-race', membership_number = NULL, last_name = NULL WHERE id = $1`, [ids[w * 3 + k]]);
              await c.query('SELECT pg_sleep($1)', [Math.random() * 0.06]);
              await c.query('COMMIT');
            }
          }),
        );
      } finally {
        done = true;
        await poller;
        await Promise.all(clients.map((c) => c.end()));
      }
      while ((await follow()) > 0);
      expect(seen).toHaveLength(WRITERS * 3);
      expect(new Set(seen)).toEqual(new Set(ids));
    }, 60_000);

    it('is for the verifier only', async () => {
      await expect(verifier.listReleasedClaims({})).rejects.toMatchObject({ code: Code.Unauthenticated });
      for (const options of [MEMBER, APPROVER, ADMIN, as('agent-token')]) {
        await expect(verifier.listReleasedClaims({}, options)).rejects.toMatchObject({ code: Code.PermissionDenied });
      }
    });
  });
});
