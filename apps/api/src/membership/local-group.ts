// ============================================================================
// OFFICER-VERIFY: what the membership check's reported local group makes a
// person (Ross 11-23), and what an approver may then do by hand. Only the
// group string from the report is stored (signup_request.local_group); this
// is decided each time it is read, against the chapter's own name
// (CHAPTER_GROUP_NAME, auth/config.ts), so a missing or wrong setting never
// fixes anyone as a guest:
//
//   the chapter's own              a chapter member
//   any other name                 a guest member ("No group assigned" too)
//   a name not in local-groups.ts  a guest member, flagged for the approvers
//   none, on an other-group match  a guest member
//   none otherwise                 not reported
//
// auth/standing.ts decides the same in SQL for the caller gate. Switched off
// (no chapter group, fix round 1) there is no standing and no rule here: the
// site is as before.
// ============================================================================
import type { OfficerVerify } from '../auth/config.js';
import { HandApproval, LocalGroupStanding } from '../gen/nwfl/mensa/v1/membership_pb.js';
import { LOCAL_GROUPS } from './local-groups.js';

/** What a reported local group makes the person, against the chapter's own name (null: switched off). */
export function localStanding(localGroup: string | null, verification: string, chapterGroup: string | null): LocalGroupStanding {
  if (chapterGroup === null) return LocalGroupStanding.UNSPECIFIED;
  if (localGroup === chapterGroup) return LocalGroupStanding.CHAPTER;
  if (localGroup !== null) return LOCAL_GROUPS.has(localGroup) ? LocalGroupStanding.GUEST : LocalGroupStanding.GUEST_UNLISTED;
  return verification === 'verified_other_group' ? LocalGroupStanding.GUEST : LocalGroupStanding.UNSPECIFIED;
}

/**
 * The outcomes that confirm an invited sign-up's number and last name, so an approver may approve it by hand
 * (with no first-name mismatch reported; an email mismatch still needs the approver's confirmation).
 */
const CONFIRMED_BY_CHECK = new Set(['verified_local', 'verified_other_group', 'email_mismatch']);

export interface DecidedBy {
  /** The account's route: invite (an invitation, or an officer power), or a plain sign-up. */
  route: string | null;
  verification: string;
  firstNameMatched: boolean | null;
  localGroup: string | null;
}

/**
 * Whether an approver may approve a sign-up by hand (ApproveSignup enforces it; the queue shows it), switched
 * on: an invited sign-up (an officer's among them) only once the check confirmed it, the orchestrator's
 * ruling B on Ross's "the officer needs to also pass the verifier"; anyone who is not the chapter's own as a
 * guest (ruling G). Switched off it says nothing, and the rule is as before.
 */
export function handApproval(signup: DecidedBy, officerVerify: OfficerVerify | null): HandApproval {
  if (officerVerify === null) return HandApproval.UNSPECIFIED;
  if (signup.route === 'invite' && (!CONFIRMED_BY_CHECK.has(signup.verification) || signup.firstNameMatched === false)) return HandApproval.NEEDS_CHECK;
  const standing = localStanding(signup.localGroup, signup.verification, officerVerify.chapterGroup);
  return standing === LocalGroupStanding.GUEST || standing === LocalGroupStanding.GUEST_UNLISTED ? HandApproval.AS_GUEST : HandApproval.OPEN;
}
