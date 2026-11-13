// ============================================================================
// Roles from the verified token's groups (R10, R25, R33), for the write
// handlers (A4b, A5) to check before they act. A person can hold several.
// The names below are the INTERNAL ones: the caller gate keeps only the
// token's groups under the chapter's SITE_GROUP_PREFIX and renames
// <prefix><role> to nwfl-<role> (groups.ts), so with mensa-nwfl- a
// mensa-nwfl-officers group arrives here as nwfl-officers.
//
//   nwfl-admin                  Admin: reviews content and publishes it as the
//                               Webmaster's backup; acts for any office,
//                               recorded as on behalf of it; approves members
//                               while the Membership seat is vacant; alone
//                               switches the approval rule (SOLO-APPROVE)
//   nwfl-webmaster              Webmaster: reviews content and publishes it
//   nwfl-officers               every officeholder: reads drafts, and reviews
//                               (approves or sends back) content (EDITOR A1)
//   nwfl-office-<slug>          holds that seat: writes as that office; the
//                               Membership Officer's seat (nwfl-office-membership)
//                               and the Admin alone reopen a rejected sign-up (REOPEN)
//   nwfl-membership-approvers   approves sign-ups
//   nwfl-affiliates, nwfl-role-<x>  affiliated officers (the RVC)
//
// Member-level READING is not a role: it comes from member_account
// (auth/standing.ts). Errors: no token is UNAUTHENTICATED; a machine caller
// or a user without the role is PERMISSION_DENIED.
// ============================================================================
import { Code, ConnectError } from '@connectrpc/connect';
import type { Caller } from './caller.js';

export interface Roles {
  admin: boolean;
  webmaster: boolean;
  officer: boolean;
  membershipApprover: boolean;
  affiliate: boolean;
  /** Office slugs from nwfl-office-<slug>. */
  offices: string[];
  /** Role names from nwfl-role-<name>. */
  roles: string[];
}

const suffixes = (groups: readonly string[], prefix: string): string[] =>
  groups.filter((group) => group.startsWith(prefix) && group.length > prefix.length).map((group) => group.slice(prefix.length));

/** Only the groups are read, so an audit row's recorded groups give the roles of that time (content/actor-label.ts). */
export function rolesOf(caller: Pick<Caller, 'groups'>): Roles {
  const { groups } = caller;
  return {
    admin: groups.includes('nwfl-admin'),
    webmaster: groups.includes('nwfl-webmaster'),
    officer: groups.includes('nwfl-officers'),
    membershipApprover: groups.includes('nwfl-membership-approvers'),
    affiliate: groups.includes('nwfl-affiliates'),
    offices: suffixes(groups, 'nwfl-office-'),
    roles: suffixes(groups, 'nwfl-role-'),
  };
}

const denied = (): ConnectError => new ConnectError('not permitted', Code.PermissionDenied);

/** A signed-in person: not anonymous, not a machine client. */
export function requireUser(caller: Caller): Roles {
  if (caller.kind === 'anonymous') throw new ConnectError('sign in first', Code.Unauthenticated);
  if (caller.kind !== 'user') throw denied();
  return rolesOf(caller);
}

/** The own-office rule: a holder writes as their office; the Admin may write for any office, on its behalf. */
export function requireOffice(caller: Caller, officeSlug: string): { onBehalfOf: boolean } {
  const roles = requireUser(caller);
  if (roles.offices.includes(officeSlug)) return { onBehalfOf: false };
  if (roles.admin) return { onBehalfOf: true };
  throw denied();
}

export function requireOfficer(caller: Caller): void {
  if (!requireUser(caller).officer) throw denied();
}

/**
 * Who reads working items (EDITOR E1): the queue, an item, its history and its preview. An officer,
 * or an approver without the officers group: the Admin or the Webmaster, who approve what they read.
 */
export function requireEditorReader(caller: Caller): void {
  const roles = requireUser(caller);
  if (!roles.officer && !roles.admin && !roles.webmaster) throw denied();
}

/** An officer, or the Admin without the officers group (SOLO-APPROVE: who reads the approval setting). */
export function requireOfficerOrAdmin(caller: Caller): void {
  const roles = requireUser(caller);
  if (!roles.officer && !roles.admin) throw denied();
}

/** The Admin alone (SOLO-APPROVE: the approval switch). */
export function requireAdmin(caller: Caller): void {
  if (!requireUser(caller).admin) throw denied();
}

/**
 * EDITOR A1: who reviews content, approving it (not publishing it) or sending it back: every officer,
 * the Admin and the Webmaster, the readers of working items (requireEditorReader). Not an affiliate.
 * Whether this reviewer edited the version is the workflow's check, not this one.
 */
export function requireReviewer(caller: Caller): Roles {
  const roles = requireUser(caller);
  if (!roles.officer && !roles.admin && !roles.webmaster) throw denied();
  return roles;
}

/** EDITOR A1: who publishes approved content: the Webmaster, or the Admin as backup. */
export function requirePublisher(caller: Caller): Roles {
  const roles = requireUser(caller);
  if (!roles.admin && !roles.webmaster) throw denied();
  return roles;
}

export function requireMembershipApprover(caller: Caller): void {
  const roles = requireUser(caller);
  if (!roles.membershipApprover && !roles.admin) throw denied();
}

/** The Membership Officer's seat: the office slug its holders' nwfl-office-<slug> group carries. */
export const MEMBERSHIP_OFFICE = 'membership';

/**
 * REOPEN: who may reopen a rejected sign-up: the Admin, or the holder of the Membership Officer's
 * seat. Not every membership approver: approving is a group of its own (nwfl-membership-approvers),
 * which a person can hold without the seat.
 */
export function requireSignupReopener(caller: Caller): void {
  const roles = requireUser(caller);
  if (!roles.admin && !roles.offices.includes(MEMBERSHIP_OFFICE)) throw denied();
}

/** Who may grant affiliate standing (R33): the Admin or the Webmaster. Its own rule: who publishes may change, who grants does not. */
export function requireGrantor(caller: Caller): void {
  const roles = requireUser(caller);
  if (!roles.admin && !roles.webmaster) throw denied();
}

/** A machine client's scope, beyond the one its client config already requires. */
export function requireScope(caller: Caller, scope: string): void {
  if (caller.kind === 'anonymous') throw new ConnectError('a token is required', Code.Unauthenticated);
  if (!caller.scopes.includes(scope)) throw denied();
}
