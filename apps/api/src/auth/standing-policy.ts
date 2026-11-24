// ============================================================================
// OFFICER-VERIFY: what each kind of member standing (standing.ts) allows, and
// the ONE rule that makes a kind from an account and its sign-up's membership
// check (standingKind below: the caller gate, the queue, the account page and
// the grant all read it, so they cannot drift).
//
//   chapter            a member the check confirmed in full (number, last name
//                      and first name) in this chapter's own local group
//   chapter_partial    the same, but the first name was not confirmed
//   affiliate          Admin-granted standing (Webmaster too while switched off,
//                      R33), with a check that confirmed number, last name and
//                      first name, in a group that is not the chapter's own (a
//                      check naming the chapter's group stands as chapter)
//   affiliate_partial  granted standing with no such check
//   unconfirmed        a member whose check did not confirm them, or reported
//                      no local group (approved on an approver's word, or
//                      before OFFICER-VERIFY)
//   guest              a member the check confirmed in another local group, or
//                      in none (Ross 11-23)
//   none               no standing: pending, lapsed, removed, past 13 months,
//                      no row
//
// A check CONFIRMS a person only by its outcome: a local or other-group match,
// or an email mismatch (the number and the last name matched). Not found, an
// error, a duplicate claim and unchecked confirm nothing, whatever else the
// report carried, and an approver's hand approval never makes one (fix round
// 3, B1). The chapter's name is compared exactly, after trimming.
//
// Reading at member level: every kind but none (a guest by the guest policy),
// and the same for events alone (a guest by its own flag). An officer power
// (when OFFICER_VERIFY is on, caller.ts): chapter and affiliate only, so a
// power always rests on a check that confirmed the number, the last name AND
// the first name (Ross 11-23: "confirm their membership number, last name,
// first name"), in the chapter's own group or with an Admin's grant. Submitting
// an article (MEMBER-SUBMIT, not built yet): chapter members, and guests by the
// policy.
//
// Guests follow ONE policy, guestPolicy(). Ross decided it 11-23 (desk GUEST):
// "public pages and events only, ability to create/submit an article, and
// officer tools if admin grants". So a guest reads as the public except
// events, which they read as members do (eventsAsMember, one flag while that
// part is confirmed with him); no officer power but through an Admin-granted
// affiliate standing; and may submit an article.
// ============================================================================

export type StandingKind = 'chapter' | 'chapter_partial' | 'affiliate' | 'affiliate_partial' | 'unconfirmed' | 'guest' | 'none';

/** The outcomes that confirm a sign-up's number and last name. */
const CONFIRMING: ReadonlySet<string> = new Set(['verified_local', 'verified_other_group', 'email_mismatch']);

/** Whether a check's outcome confirmed the person (their number and last name) at all. */
export function confirmsMember(verification: string | null): boolean {
  return verification !== null && CONFIRMING.has(verification);
}

/** What a sign-up's membership check said, as stored (0033); all null with no sign-up. */
export interface MembershipCheck {
  verification: string | null;
  firstNameMatched: boolean | null;
  localGroup: string | null;
}

/** Whether the check confirmed the number, the last name and the first name: what every officer power needs. */
export function fullyChecked(check: Pick<MembershipCheck, 'verification' | 'firstNameMatched'>): boolean {
  return confirmsMember(check.verification) && check.firstNameMatched === true;
}

/**
 * Whose member a confirming check makes the person: the chapter's own, a guest (another group, or an
 * other-group match that named none), or not said. A check that did not confirm them says nothing.
 */
export function groupStanding(check: Pick<MembershipCheck, 'verification' | 'localGroup'>, chapterGroup: string): 'chapter' | 'guest' | 'unreported' {
  if (!confirmsMember(check.verification)) return 'unreported';
  if (check.verification === 'verified_other_group') return 'guest';
  const group = (check.localGroup ?? '').trim();
  if (group === '') return 'unreported';
  return group === chapterGroup ? 'chapter' : 'guest';
}

/**
 * The standing of an account: `live` is a member or an affiliate verified within the 13 months
 * (standing.ts). With no chapter group (switched off) there is no check to read: as before.
 */
export function standingKind(account: { live: boolean; affiliate: boolean }, check: MembershipCheck, chapterGroup: string | null): StandingKind {
  if (!account.live) return 'none';
  if (chapterGroup === null) return account.affiliate ? 'affiliate' : 'unconfirmed';
  const group = groupStanding(check, chapterGroup);
  // Fix round 5 (S6): the chapter's own are never granted, so a check naming the chapter's group outranks a grant.
  if (group === 'chapter') return fullyChecked(check) ? 'chapter' : 'chapter_partial';
  if (account.affiliate) return fullyChecked(check) ? 'affiliate' : 'affiliate_partial';
  return group === 'guest' ? 'guest' : 'unconfirmed';
}

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
  return kind === 'chapter' || kind === 'chapter_partial';
}

/** Whether this standing may hold an officer power (with OFFICER_VERIFY on). */
export function holdsOfficerPower(kind: StandingKind, guests: GuestPolicy = guestPolicy()): boolean {
  if (kind === 'guest') return guests.officerPower;
  return kind === 'chapter' || kind === 'affiliate';
}
