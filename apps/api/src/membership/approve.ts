// ============================================================================
// An approved sign-up's account (membership/service.ts ApproveSignup, and
// OFFICER-VERIFY's approval by the membership check, verifier.ts): a member
// from `verifiedOn`, approved by `by`, a chapter member or a guest by the
// reported local group (local-group.ts). Only an account waiting (pending) or
// lapsed becomes one; otherwise nothing changes and the answer is undefined.
// ============================================================================
import type { TxClient } from '../db/tx.js';

export interface ApprovedAccount {
  status: string;
  route: string;
  verified_on: string | null;
  chapter_member: boolean | null;
}

export async function approveAccount(
  client: TxClient,
  account: { sub: string; by: string; verifiedOn: string; chapterMember: boolean | null },
): Promise<ApprovedAccount | undefined> {
  const { rows } = await client.query<ApprovedAccount>(
    `INSERT INTO member_account (sub, status, route, approved_by_sub, approved_at, verified_on, chapter_member) VALUES ($1, 'member', 'signup', $2, now(), $3, $4)
     ON CONFLICT (sub) DO UPDATE SET status = 'member', approved_by_sub = EXCLUDED.approved_by_sub, approved_at = now(),
       verified_on = EXCLUDED.verified_on, chapter_member = EXCLUDED.chapter_member, updated_at = now()
     WHERE member_account.status IN ('pending', 'lapsed')
     RETURNING status, route, verified_on::text AS verified_on, chapter_member`,
    [account.sub, account.by, account.verifiedOn, account.chapterMember],
  );
  return rows[0];
}
