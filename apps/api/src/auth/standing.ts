// ============================================================================
// Member standing (AC6 b): whether an account reads at member level comes from
// member_account on every request, not from the token's groups, which a
// 30-day session can leave a month stale. An approval or a removal therefore
// takes effect on the next call.
//
//   member, affiliate  standing while verified within the last 13 months (R24:
//                      accounts unverified for 13 months fall back to public
//                      access; STACK-FIX ruling: an affiliate, granted by an
//                      Admin or Webmaster (R33), lapses the same way)
//   pending, lapsed, removed, no row: none
//
// OFFICER-VERIFY: a member's kind is decided on each read, by the one rule in
// standing-policy.ts (standingKind), from what its approved sign-up's check
// said (signup_request: the outcome, the first-name answer and the reported
// local group, the only things stored) against the chapter's own group
// (CHAPTER_GROUP_NAME, given only with OFFICER_VERIFY on). With no chapter
// group (the switch off) every member is unconfirmed: there is no guest then.
// Nothing derived is stored, so correcting a wrong setting corrects everyone.
// ============================================================================
import type { Db } from '../db/pool.js';
import { todayIn } from '../events/zone.js';
import type { MemberStanding } from './caller.js';
import { standingKind } from './standing-policy.js';

export const VERIFICATION_MONTHS = 13;

export function dbStanding(db: Db, now: () => Date = () => new Date(), chapterGroup: string | null = null): MemberStanding {
  return {
    standingOf: async (subject) => {
      const { rows } = await db.query<{ live: boolean; affiliate: boolean; verification: string | null; first_name_matched: boolean | null; local_group: string | null }>(
        `SELECT a.status IN ('member', 'affiliate') AND a.verified_on IS NOT NULL
                  AND a.verified_on >= ($2::date - make_interval(months => $3)) AS live,
                a.status = 'affiliate' AS affiliate, s.verification, s.first_name_matched, s.local_group
         FROM member_account a
         -- One open sign-up per person (0026 signup_request_one_open_per_sub): the one that was approved.
         LEFT JOIN signup_request s ON s.sub = a.sub AND s.reopened_at IS NULL AND s.decision = 'approved'
         WHERE a.sub = $1`,
        [subject, todayIn(now()), VERIFICATION_MONTHS],
      );
      const row = rows[0];
      if (row === undefined) return 'none';
      return standingKind(row, { verification: row.verification, firstNameMatched: row.first_name_matched, localGroup: row.local_group }, chapterGroup);
    },
  };
}
