// ============================================================================
// OFFICER-VERIFY: what each kind of member standing (standing.ts) allows.
//
//   chapter      a member whose reported local group is this chapter's
//   affiliate    Admin- or Webmaster-granted standing (R33)
//   unconfirmed  a member approved with no local group reported (before
//                OFFICER-VERIFY, or on a report that did not say)
//   guest        a member of another local group, or of none (Ross 11-23)
//   none         no standing: pending, lapsed, removed, past 13 months, no row
//
// Reading at member level: every kind but none (a guest by the guest policy),
// and the same for events alone (a guest by its own flag). An officer power
// (when OFFICER_VERIFY is on, caller.ts): chapter and affiliate only (a guest
// by the guest policy); an unconfirmed member never, so a power always rests
// on a reported local group or an Admin's grant. Submitting an article
// (MEMBER-SUBMIT, not built yet): chapter members, and guests by the policy.
//
// Guests follow ONE policy, guestPolicy(). Ross decided it 11-23 (desk GUEST):
// "public pages and events only, ability to create/submit an article, and
// officer tools if admin grants". So a guest reads as the public except
// events, which they read as members do (eventsAsMember, one flag while that
// part is confirmed with him); no officer power but through an Admin-granted
// affiliate standing; and may submit an article.
// ============================================================================

export type StandingKind = 'chapter' | 'affiliate' | 'unconfirmed' | 'guest' | 'none';

export interface GuestPolicy {
  /** Members-only pages, news and newsletters. */
  readsAsMember: boolean;
  /** Events, members-only ones included. */
  eventsAsMember: boolean;
  officerPower: boolean;
  /** MEMBER-SUBMIT: not used yet. */
  canSubmitArticle: boolean;
}

/** What a guest member may do: Ross's ruling, desk GUEST, 11-23. */
export function guestPolicy(): GuestPolicy {
  return { readsAsMember: false, eventsAsMember: true, officerPower: false, canSubmitArticle: true };
}

/** Whether this standing reads at member level. */
export function readsAsMember(kind: StandingKind, guests: GuestPolicy = guestPolicy()): boolean {
  if (kind === 'guest') return guests.readsAsMember;
  return kind !== 'none';
}

/** Whether this standing reads events at member level. */
export function readsEventsAsMember(kind: StandingKind, guests: GuestPolicy = guestPolicy()): boolean {
  if (kind === 'guest') return guests.eventsAsMember;
  return readsAsMember(kind, guests);
}

/** MEMBER-SUBMIT (not built yet): whether this standing may submit an article. */
export function canSubmitArticle(kind: StandingKind, guests: GuestPolicy = guestPolicy()): boolean {
  if (kind === 'guest') return guests.canSubmitArticle;
  return kind === 'chapter';
}

/** Whether this standing may hold an officer power (with OFFICER_VERIFY on). */
export function holdsOfficerPower(kind: StandingKind, guests: GuestPolicy = guestPolicy()): boolean {
  if (kind === 'guest') return guests.officerPower;
  return kind === 'chapter' || kind === 'affiliate';
}
