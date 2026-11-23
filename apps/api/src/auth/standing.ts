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
// OFFICER-VERIFY: a member's kind is decided here, on each read, from the
// local group its approved sign-up's check reported (signup_request.local_group,
// the only thing stored), against the chapter's own (CHAPTER_GROUP_NAME, given
// only with OFFICER_VERIFY on): the chapter's own is a chapter member; another
// group, a name the site does not know, or an other-group match with no group
// said is a guest; nothing reported is unconfirmed. With no chapter group (the
// switch off) every member is unconfirmed: there is no guest then.
// Nothing derived is stored, so correcting a wrong setting corrects everyone.
// standing-policy.ts says what each kind may do (membership/local-group.ts
// says the same for what the API shows).
// ============================================================================
import type { Db } from '../db/pool.js';
import { todayIn } from '../events/zone.js';
import type { MemberStanding } from './caller.js';
import type { StandingKind } from './standing-policy.js';

export const VERIFICATION_MONTHS = 13;

export function dbStanding(db: Db, now: () => Date = () => new Date(), chapterGroup: string | null = null): MemberStanding {
  return {
    standingOf: async (subject) => {
      const { rows } = await db.query<{ kind: StandingKind }>(
        `SELECT CASE
                  WHEN a.status NOT IN ('member', 'affiliate') OR a.verified_on IS NULL
                    OR a.verified_on < ($2::date - make_interval(months => $3)) THEN 'none'
                  WHEN a.status = 'affiliate' THEN 'affiliate'
                  WHEN $4::text IS NULL THEN 'unconfirmed'
                  WHEN s.local_group = $4 THEN 'chapter'
                  WHEN s.local_group IS NOT NULL OR s.verification = 'verified_other_group' THEN 'guest'
                  ELSE 'unconfirmed'
                END AS kind
         FROM member_account a
         -- One open sign-up per person (0026 signup_request_one_open_per_sub): the one that was approved.
         LEFT JOIN signup_request s ON s.sub = a.sub AND s.reopened_at IS NULL AND s.decision = 'approved'
         WHERE a.sub = $1`,
        [subject, todayIn(now()), VERIFICATION_MONTHS, chapterGroup],
      );
      return rows[0]?.kind ?? 'none';
    },
  };
}
