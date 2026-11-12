// ============================================================================
// Who acted on an item, in words (EDITOR E1, HistoryEntry.actor_label), from
// the audit row alone: the groups it recorded as they were at the time, and
// the office acted for. Never a person's name, and no subject->name store:
//   the office acted for, when the actor held its seat   "Publications Officer"
//   the Admin (also acting for an office they do not hold) "Admin"
//   the Webmaster                                          "Webmaster"
//   a holder of the item's own office                      its title
//   any other officer                                      "Officer"
//   a machine caller                                       "Newsletter agent", "Membership verifier", "System"
// ============================================================================
import { rolesOf } from '../auth/roles.js';

export interface Office {
  slug: string;
  title: string;
}

export interface ActorRow {
  /** audit_event.actor_kind: user, agent, verifier or system. */
  kind: string;
  /** audit_event.actor_groups: the actor's nwfl- groups when the row was written. */
  groups: readonly string[];
  /** The office the row says the actor acted for, if any. */
  actingOffice: Office | null;
}

const MACHINES: Record<string, string> = { agent: 'Newsletter agent', verifier: 'Membership verifier' };

export function actorLabel(row: ActorRow, itemOffice: Office): string {
  if (row.kind !== 'user') return MACHINES[row.kind] ?? 'System';
  const roles = rolesOf({ groups: row.groups });
  if (row.actingOffice !== null && roles.offices.includes(row.actingOffice.slug)) return row.actingOffice.title;
  if (roles.admin) return 'Admin';
  if (roles.webmaster) return 'Webmaster';
  if (roles.offices.includes(itemOffice.slug)) return itemOffice.title;
  return roles.officer ? 'Officer' : 'Someone';
}
