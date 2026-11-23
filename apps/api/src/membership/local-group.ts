// ============================================================================
// OFFICER-VERIFY: what the membership check's reported local group makes a
// person (Ross 11-23), as the API shows it, and what an approver may then do
// by hand. Only the group string from the report is stored
// (signup_request.local_group); this is decided each time it is read, by the
// one rule the caller gate reads too (auth/standing-policy.ts groupStanding),
// against the chapter's own name (CHAPTER_GROUP_NAME, auth/config.ts), so a
// missing or wrong setting never fixes anyone as a guest:
//
//   the chapter's own              a chapter member
//   any other name                 a guest member ("No group assigned" too)
//   a name not in local-groups.ts  a guest member, flagged for the approvers
//   none, on an other-group match  a guest member
//   none otherwise                 not reported
//
// Only a check whose outcome confirmed the person says any of it (fix round 3,
// B1): beside not found, an error or a duplicate claim a group says nothing.
// Switched off (no chapter group, fix round 1) there is no standing and no
// rule here: the site is as before.
// ============================================================================
import type { OfficerVerify } from '../auth/config.js';
import { confirmsMember, groupStanding } from '../auth/standing-policy.js';
import { HandApproval, LocalGroupStanding } from '../gen/nwfl/mensa/v1/membership_pb.js';
import { LOCAL_GROUPS } from './local-groups.js';

/** What a reported local group makes the person, against the chapter's own name (null: switched off). */
export function localStanding(localGroup: string | null, verification: string, chapterGroup: string | null): LocalGroupStanding {
  if (chapterGroup === null) return LocalGroupStanding.UNSPECIFIED;
  const standing = groupStanding({ verification, localGroup }, chapterGroup);
  if (standing === 'chapter') return LocalGroupStanding.CHAPTER;
  if (standing === 'unreported') return LocalGroupStanding.UNSPECIFIED;
  return localGroup !== null && !LOCAL_GROUPS.has(localGroup.trim()) ? LocalGroupStanding.GUEST_UNLISTED : LocalGroupStanding.GUEST;
}

export interface DecidedBy {
  /** The account's route: invite (an invitation, or an officer power), or a plain sign-up. */
  route: string | null;
  verification: string;
  firstNameMatched: boolean | null;
  localGroup: string | null;
}

/**
 * Whether an approver may approve a sign-up by hand (ApproveSignup enforces it; the queue shows it), switched
 * on: an invited sign-up (an officer's among them) only once the check confirmed its number and last name
 * (standing-policy.ts confirmsMember) and reported no first-name mismatch, the orchestrator's
 * ruling B on Ross's "the officer needs to also pass the verifier"; anyone who is not the chapter's own as a
 * guest (ruling G). Switched off it says nothing, and the rule is as before.
 */
export function handApproval(signup: DecidedBy, officerVerify: OfficerVerify | null): HandApproval {
  if (officerVerify === null) return HandApproval.UNSPECIFIED;
  if (signup.route === 'invite' && (!confirmsMember(signup.verification) || signup.firstNameMatched === false)) return HandApproval.NEEDS_CHECK;
  const standing = localStanding(signup.localGroup, signup.verification, officerVerify.chapterGroup);
  return standing === LocalGroupStanding.GUEST || standing === LocalGroupStanding.GUEST_UNLISTED ? HandApproval.AS_GUEST : HandApproval.OPEN;
}
