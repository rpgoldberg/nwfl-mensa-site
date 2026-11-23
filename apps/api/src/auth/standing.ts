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
// OFFICER-VERIFY: a member's kind comes from member_account.chapter_member
// (true chapter, false guest, NULL unconfirmed); standing-policy.ts says what
// each kind may do.
// ============================================================================
import type { Db } from '../db/pool.js';
import { todayIn } from '../events/zone.js';
import type { MemberStanding } from './caller.js';
import type { StandingKind } from './standing-policy.js';

export const VERIFICATION_MONTHS = 13;

export function dbStanding(db: Db, now: () => Date = () => new Date()): MemberStanding {
  return {
    standingOf: async (subject) => {
      const { rows } = await db.query<{ kind: StandingKind }>(
        `SELECT CASE
                  WHEN status NOT IN ('member', 'affiliate') OR verified_on IS NULL
                    OR verified_on < ($2::date - make_interval(months => $3)) THEN 'none'
                  WHEN status = 'affiliate' THEN 'affiliate'
                  WHEN chapter_member THEN 'chapter'
                  WHEN NOT chapter_member THEN 'guest'
                  ELSE 'unconfirmed'
                END AS kind
         FROM member_account WHERE sub = $1`,
        [subject, todayIn(now()), VERIFICATION_MONTHS],
      );
      return rows[0]?.kind ?? 'none';
    },
  };
}
