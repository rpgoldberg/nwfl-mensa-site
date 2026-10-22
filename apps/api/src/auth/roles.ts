// ============================================================================
// Roles from the verified token's nwfl- groups (R10, R25, R33), for the write
// handlers (A4b, A5) to check before they act. A person can hold several.
//
//   nwfl-admin                  Admin: approves content; acts for any office,
//                               recorded as on behalf of it; approves members
//                               while the Membership seat is vacant
//   nwfl-webmaster              Webmaster: approves content
//   nwfl-officers               every officeholder: reads drafts
//   nwfl-office-<slug>          holds that seat: writes as that office
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

export function rolesOf(caller: Caller): Roles {
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

export function requireContentApprover(caller: Caller): void {
  const roles = requireUser(caller);
  if (!roles.admin && !roles.webmaster) throw denied();
}

export function requireMembershipApprover(caller: Caller): void {
  const roles = requireUser(caller);
  if (!roles.membershipApprover && !roles.admin) throw denied();
}

/** Who may grant affiliate standing (R33): the Admin or the Webmaster. */
export function requireGrantor(caller: Caller): void {
  requireContentApprover(caller);
}

/** A machine client's scope, beyond the one its client config already requires. */
export function requireScope(caller: Caller, scope: string): void {
  if (caller.kind === 'anonymous') throw new ConnectError('a token is required', Code.Unauthenticated);
  if (!caller.scopes.includes(scope)) throw denied();
}
