// ============================================================================
// Member standing (AC6 b): whether an account reads at member level comes from
// member_account on every request, not from the token's groups, which a
// 30-day session can leave a month stale. An approval or a removal therefore
// takes effect on the next call.
//
//   member, affiliate  yes, while verified within the last 13 months (R24:
//                      accounts unverified for 13 months fall back to public
//                      access; STACK-FIX ruling: an affiliate, granted by an
//                      Admin or Webmaster (R33), lapses the same way)
//   pending, lapsed, removed, no row: no
// ============================================================================
import type { Db } from '../db/pool.js';
import { todayIn } from '../events/zone.js';
import type { MemberStanding } from './caller.js';

export const VERIFICATION_MONTHS = 13;

export function dbStanding(db: Db, now: () => Date = () => new Date()): MemberStanding {
  return {
    isMember: async (subject) => {
      const { rows } = await db.query<{ member: boolean }>(
        `SELECT status IN ('member', 'affiliate') AND verified_on >= ($2::date - make_interval(months => $3)) AS member
         FROM member_account WHERE sub = $1`,
        [subject, todayIn(now()), VERIFICATION_MONTHS],
      );
      return rows[0]?.member === true;
    },
  };
}
