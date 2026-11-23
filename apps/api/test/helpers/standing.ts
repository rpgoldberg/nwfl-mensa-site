// OFFICER-VERIFY: an account with member standing, and (optionally) the approved sign-up whose check
// reported its local group and confirmed its first name (fix round 3: an officer power needs both). The site stores only the group as reported; chapter or guest is decided when
// it is read (auth/standing.ts), against CHAPTER_GROUP_NAME. Every subject and name is made up.
import type pg from 'pg';

export interface Seeded {
  sub: string;
  status?: 'member' | 'affiliate' | 'lapsed' | 'removed' | 'pending';
  verifiedOn?: string | null;
  route?: 'signup' | 'invite' | 'admin_grant';
  /** The approved sign-up's check: its outcome and the local group it reported (undefined: no sign-up). */
  check?: { verification?: string; localGroup?: string | null; firstNameMatched?: boolean | null };
}

export async function seedAccount(pool: pg.Pool, account: Seeded): Promise<void> {
  const status = account.status ?? 'member';
  const verifiedOn = account.verifiedOn === undefined ? '2026-10-01' : account.verifiedOn;
  const decided = ['member', 'lapsed', 'removed'].includes(status);
  await pool.query(
    `INSERT INTO member_account (sub, status, route, approved_by_sub, approved_at, verified_on, affiliate_granted_by_sub, affiliate_granted_at, removed_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $4::text IS NULL THEN NULL ELSE now() END, $5::date, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE now() END,
             CASE WHEN $2 = 'removed' THEN now() END)`,
    [account.sub, status, account.route ?? 'signup', decided ? 'sub-approver' : null, verifiedOn, status === 'affiliate' ? 'sub-admin' : null],
  );
  if (account.check === undefined) return;
  const verification = account.check.verification ?? 'verified_local';
  // A check that confirmed the number and the last name confirmed the first name too, unless the test says not.
  const confirming = ['verified_local', 'verified_other_group', 'email_mismatch'].includes(verification);
  const firstNameMatched = account.check.firstNameMatched === undefined ? (confirming ? true : null) : account.check.firstNameMatched;
  await pool.query(
    `INSERT INTO signup_request (sub, display_name, email, first_name, last_name, membership_number, verification, verified_on, local_group, first_name_matched,
       decision, decided_at, decided_by_sub)
     VALUES ($1, 'Pat Madeup', $1 || '@example.org', 'Pat', 'Madeup', '5550001', $2, CASE WHEN $2 <> 'unchecked' THEN '2026-10-01'::date END, $3, $4, 'approved', now(), 'sub-approver')`,
    [account.sub, verification, account.check.localGroup ?? null, firstNameMatched],
  );
}
