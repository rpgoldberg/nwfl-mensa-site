// ============================================================================
// An approved sign-up's account (membership/service.ts ApproveSignup, and
// OFFICER-VERIFY's approval by the membership check, verifier.ts, switched on
// only): a member from `verifiedOn`, approved by `by`. Only an account waiting
// (pending) or lapsed becomes one; otherwise nothing changes and the answer is
// undefined. Nothing about the local group is written here: a chapter or guest
// standing is decided when read (auth/standing.ts).
// ============================================================================
import type { TxClient } from '../db/tx.js';

export interface ApprovedAccount {
  status: string;
  route: string;
  verified_on: string | null;
}

export async function approveAccount(client: TxClient, account: { sub: string; by: string; verifiedOn: string }): Promise<ApprovedAccount | undefined> {
  const { rows } = await client.query<ApprovedAccount>(
    `INSERT INTO member_account (sub, status, route, approved_by_sub, approved_at, verified_on) VALUES ($1, 'member', 'signup', $2, now(), $3)
     ON CONFLICT (sub) DO UPDATE SET status = 'member', approved_by_sub = EXCLUDED.approved_by_sub, approved_at = now(),
       verified_on = EXCLUDED.verified_on, updated_at = now()
     WHERE member_account.status IN ('pending', 'lapsed')
     RETURNING status, route, verified_on::text AS verified_on`,
    [account.sub, account.by, account.verifiedOn],
  );
  return rows[0];
}
