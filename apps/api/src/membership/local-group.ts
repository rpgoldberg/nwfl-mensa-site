// ============================================================================
// OFFICER-VERIFY: what the membership check's reported local group makes a
// person (Ross 11-23). The site keeps the group string from the report
// (signup_request.local_group) and compares it, exactly, with the chapter's
// own (CHAPTER_GROUP_NAME, auth/config.ts):
//
//   the chapter's own              a chapter member
//   any other name, or none        a guest member ("No group assigned" too)
//   a name not in local-groups.ts  a guest member, flagged for the approvers
//   not reported                   unknown: never approved by the report alone
//
// An approval writes the answer to member_account.chapter_member (true,
// false, or NULL for not reported), which auth/standing.ts reads.
// ============================================================================
import { LocalGroupStanding } from '../gen/nwfl/mensa/v1/membership_pb.js';
import { LOCAL_GROUPS } from './local-groups.js';

/** What a reported local group makes the person, against the chapter's own name (null: none configured). */
export function reportedStanding(localGroup: string | null, chapterGroup: string | null): LocalGroupStanding {
  if (localGroup === null) return LocalGroupStanding.UNSPECIFIED;
  if (localGroup === chapterGroup) return LocalGroupStanding.CHAPTER;
  return LOCAL_GROUPS.has(localGroup) ? LocalGroupStanding.GUEST : LocalGroupStanding.GUEST_UNLISTED;
}

/** An approved account's standing, from member_account.chapter_member and the group its sign-up reported. */
export function accountStanding(chapterMember: boolean | null, localGroup: string | null): LocalGroupStanding {
  if (chapterMember === true) return LocalGroupStanding.CHAPTER;
  if (chapterMember === null) return LocalGroupStanding.UNSPECIFIED;
  return localGroup !== null && !LOCAL_GROUPS.has(localGroup) ? LocalGroupStanding.GUEST_UNLISTED : LocalGroupStanding.GUEST;
}

/**
 * member_account.chapter_member for an approval: by the reported group when there is one; else false when
 * the check found the person in another local group, and NULL (not reported) otherwise.
 */
export function chapterMemberOf(verification: string, localGroup: string | null, chapterGroup: string | null): boolean | null {
  if (localGroup !== null) return reportedStanding(localGroup, chapterGroup) === LocalGroupStanding.CHAPTER;
  return verification === 'verified_other_group' ? false : null;
}
