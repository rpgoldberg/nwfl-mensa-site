// OFFICER-VERIFY: an account with member standing, and (optionally) the approved sign-up whose check
// reported its local group. The site stores only the group as reported; chapter or guest is decided when
// it is read (auth/standing.ts), against CHAPTER_GROUP_NAME. Every subject and name is made up.
import type pg from 'pg';

export interface Seeded {
  sub: string;
  status?: 'member' | 'affiliate' | 'lapsed' | 'removed' | 'pending';
  verifiedOn?: string | null;
  route?: 'signup' | 'invite' | 'admin_grant';
  /** The approved sign-up's check: its outcome and the local group it reported (undefined: no sign-up). */
  check?: { verification?: string; localGroup?: string | null };
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
  await pool.query(
    `INSERT INTO signup_request (sub, display_name, email, verification, verified_on, local_group, decision, decided_at, decided_by_sub)
     VALUES ($1, 'Pat Madeup', $1 || '@example.org', $2, '2026-10-01', $3, 'approved', now(), 'sub-approver')`,
    [account.sub, account.check.verification ?? 'verified_local', account.check.localGroup ?? null],
  );
}
