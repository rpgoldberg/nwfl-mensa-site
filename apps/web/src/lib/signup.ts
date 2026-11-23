// W-SIGNUP: the words and checks of the first-sign-in page (/account) and the approvers' queue
// (/officer-area/sign-ups), checked here on the server: both pages work with no script.
//
// D1: every sign-up gives a last name and a Mensa membership number, invited or not, and (PROFILE-ID)
// a first name, prefilled from the sign-in's given name; the API checks them again and refuses
// anything else. The number is digits only, as the API and the schema take it, and it is never given
// back in a form after a problem, nor in a log line (D6). PROFILE-ID: an approved member's /account
// shows their profile, the two names editable and the number shown only; one line by the sign-up's
// number field says it cannot be changed once sent, except through the site administrator. D3: an enrolee with no account gets
// the form; a pending account the waiting line; a rejected sign-up says it was not approved; anyone
// else their standing. OFFICER-VERIFY: officers, the Admin, the Webmaster and the approvers confirm
// their membership too (Ross 11-23: "the officer needs to also pass the verifier"): with no account
// they get the form and the stop after signing in, and while the check is pending their officer tools
// wait (OFFICER_CHECK_NOTICE). A guest member (another local group, or none) is told their standing in
// their own words (GUEST_TEXT). D4: the queue is for the membership approvers and the Admin only, in plain words,
// never by colour alone. REOPEN: the Admin and the Membership Officer also see the rejections that
// can be reopened, and reopen one after a confirmation step; the person's /account then offers the
// form again (the API removes the account the rejection closed).
import type { Session } from '../../server/session.mjs';
import type { Check, Decision, MembershipApi, MyAccount, PendingSignup, RejectedSignup, Route, Typed } from './api/membership';
import { type SessionReaderDeps, sessionReader } from './api/membership';
import { ZONE } from './calendar';

export const ACCOUNT_PATH = '/account';
/** The API's own limits (apps/api/src/membership/service.ts). */
export const MAX_LAST_NAME = 80;
/** PROFILE-ID: as the API's (0028). */
export const MAX_FIRST_NAME = 80;
export const MAX_NUMBER_DIGITS = 12;

export const WAITING = 'Your sign-up is waiting for an officer to approve it.';

export interface SignupForm {
  firstName: string;
  lastName: string;
  membershipNumber: string;
}

export type SignupErrors = Partial<Record<keyof SignupForm, string>>;

/** On a problem, the names come back to the form; the number never does (D6). */
export type ParsedSignup = { ok: true; value: SignupForm } | { ok: false; errors: SignupErrors; values: { firstName: string; lastName: string } };

/** PROFILE-ID: the member's own two names. */
export interface ProfileForm {
  firstName: string;
  lastName: string;
}

export type ProfileErrors = Partial<Record<keyof ProfileForm, string>>;

export type ParsedProfile = { ok: true; value: ProfileForm } | { ok: false; errors: ProfileErrors; values: ProfileForm };

const DIGITS = new RegExp(`^[0-9]{1,${MAX_NUMBER_DIGITS}}$`);
/**
 * VET fix 1: typing noise in a number, dropped before the digit rule, as the API drops it: any space
 * (a no-break space too) and any dash or minus. Letters and every other mark are still refused.
 */
const NUMBER_NOISE = /[\p{Zs}\p{Pd}\u2212]/gu;
/** The most the number's field takes as typed: the digits with a space or a dash between each. */
export const MAX_NUMBER_TYPED = 2 * MAX_NUMBER_DIGITS;
/** Any control character (a NUL, a tab, an escape code): no last name holds one. */
const CONTROL = /\p{Cc}/u;

/** A name's problem in words, or none: needed, at most 80 characters, no hidden character. */
function nameProblem(name: string, which: 'first' | 'last', max: number): string | undefined {
  if (name === '') return `Enter your ${which} name.`;
  if ([...name].length > max) return `Keep your ${which} name to ${max} characters or fewer.`;
  if (CONTROL.test(name)) return `Type your ${which} name again: it has a hidden character that cannot be kept.`;
  return undefined;
}

/** The two names of a form, trimmed, with their problems by field. */
function namesOf(field: (name: string) => string | undefined): { names: ProfileForm; errors: ProfileErrors } {
  const names = { firstName: (field('firstName') ?? '').trim(), lastName: (field('lastName') ?? '').trim() };
  const errors: ProfileErrors = {};
  const first = nameProblem(names.firstName, 'first', MAX_FIRST_NAME);
  const last = nameProblem(names.lastName, 'last', MAX_LAST_NAME);
  if (first !== undefined) errors.firstName = first;
  if (last !== undefined) errors.lastName = last;
  return { names, errors };
}

/** The sign-up form's three fields, checked; each problem is said in words, by field. */
export function parseSignupForm(field: (name: string) => string | undefined): ParsedSignup {
  const { names, errors: nameErrors } = namesOf(field);
  const membershipNumber = (field('membershipNumber') ?? '').trim().replace(NUMBER_NOISE, '');
  const errors: SignupErrors = { ...nameErrors };
  if ((field('membershipNumber') ?? '').trim() === '') errors.membershipNumber = 'Enter your membership number.';
  else if (!DIGITS.test(membershipNumber)) errors.membershipNumber = `Enter your membership number using digits only, up to ${MAX_NUMBER_DIGITS} of them.`;
  if (Object.keys(errors).length > 0) return { ok: false, errors, values: names };
  return { ok: true, value: { ...names, membershipNumber } };
}

/** PROFILE-ID: the profile form's two names, checked as the sign-up's. A number posted with them is never read. */
export function parseProfileForm(field: (name: string) => string | undefined): ParsedProfile {
  const { names, errors } = namesOf(field);
  return Object.keys(errors).length > 0 ? { ok: false, errors, values: names } : { ok: true, value: names };
}

/** The order of the form's fields, which its error summary follows. */
const FIELDS: readonly (keyof SignupForm)[] = ['firstName', 'lastName', 'membershipNumber'];

/** Fix 1 (NOTE-6): the summary at the top of the form, one entry per problem, each linking to its field. */
export function errorSummary(errors: SignupErrors): Array<{ field: keyof SignupForm; text: string }> {
  return FIELDS.flatMap((field) => (errors[field] === undefined ? [] : [{ field, text: errors[field] }]));
}

/** PROFILE-ID: the profile form's summary; its fields' ids carry a "profile-" prefix. */
export function profileErrorSummary(errors: ProfileErrors): Array<{ field: string; text: string }> {
  return (['firstName', 'lastName'] as const).flatMap((field) => (errors[field] === undefined ? [] : [{ field: `profile-${field}`, text: errors[field] }]));
}

/** PROFILE-ID: the sign-up's first name, prefilled from the sign-in's given name when there is one. */
export function prefillFirstName(session: Pick<Session, 'givenName'>): string {
  return (session.givenName ?? '').trim();
}

/** PROFILE-ID: one plain address, as an Admin role mailbox is: no spaces, no query, no second @. */
const ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * PROFILE-ID: where to contact the site administrator: a mailto of the Admin role's address from
 * configuration (SITE_ADMIN_CONTACT), else, unset or not one plain address, the officers page, which
 * lists every office's contact. Never an empty or a broken link.
 */
export function adminContactHref(env: Record<string, string | undefined>): string {
  const address = (env['SITE_ADMIN_CONTACT'] ?? '').trim();
  return ADDRESS.test(address) ? `mailto:${address}` : '/officers';
}

/** PROFILE-ID (the editor): the one line by the number field. The page links the middle words. */
export const NUMBER_LOCKED = { before: 'Once you send it, your number can’t be changed. If it needs correcting, contact the ', link: 'site administrator', after: '.' } as const;

/** PROFILE-ID: what a sign-up typed, labelled, in the form's order, leaving out any value not held. */
export function typedFacts(typed: Typed): Array<[string, string]> {
  const facts: Array<[string, string | undefined]> = [
    ['First name', typed.firstName],
    ['Last name', typed.lastName],
    ['Membership number', typed.membershipNumber],
  ];
  return facts.filter((fact): fact is [string, string] => fact[1] !== undefined && fact[1] !== '');
}

/**
 * QUEUE-C: a pending sign-up's label and value pairs for its card's grid, in reading order: what it
 * typed, how the person came, and the day they signed up when the API sent it. The membership check
 * follows as its own pair across the card (checkText), so its sentence is never squeezed into a cell.
 */
export function pendingFacts(signup: Pick<PendingSignup, 'firstName' | 'lastName' | 'membershipNumber' | 'route' | 'createdAt'>): Array<[string, string]> {
  const facts: Array<[string, string]> = [...typedFacts(signup), ['How they came', ROUTE_TEXT[signup.route]]];
  if (signup.createdAt) facts.push(['Signed up', formatMoment(signup.createdAt)]);
  return facts;
}

/** QUEUE-C: a rejected sign-up's pairs, in reading order: what it typed, then the day it was rejected when the API sent it. */
export function rejectedFacts(signup: Pick<RejectedSignup, 'firstName' | 'lastName' | 'membershipNumber' | 'rejectedAt'>): Array<[string, string]> {
  const facts = typedFacts(signup);
  if (signup.rejectedAt) facts.push(['Rejected on', formatMoment(signup.rejectedAt)]);
  return facts;
}

export const PROFILE_SAVED = 'Your profile has been saved.';

export const PROFILE_REFUSED: Record<'invalid' | 'not_member', string> = {
  invalid: 'Your profile was not saved. Check your first and last name, and save it again.',
  not_member: 'Your profile can only be changed once your account has member access.',
};

/** What /account shows. */
export type AccountView = 'form' | 'waiting' | 'member' | 'affiliate' | 'lapsed' | 'removed' | 'rejected' | 'not-club';

/** OFFICER-VERIFY: the groups that carry an officer power (the API's groups.ts isPowerGroup), by internal name. */
const POWER_GROUPS = new Set(['nwfl-officers', 'nwfl-admin', 'nwfl-webmaster', 'nwfl-membership-approvers']);
const OFFICE_GROUP = 'nwfl-office-';

/**
 * Who may confirm their membership here: one of the group's enrolees, or (OFFICER-VERIFY) anyone holding
 * an officer power, whose tools need the check too.
 */
export function mayConfirmMembership(session: Pick<Session, 'enrolee' | 'groups'>): boolean {
  return session.enrolee || session.groups.some((g) => POWER_GROUPS.has(g) || (g.startsWith(OFFICE_GROUP) && g.length > OFFICE_GROUP.length));
}

/** OFFICER-VERIFY: on /account while the person's officer tools wait for the membership check. */
export const OFFICER_CHECK_NOTICE = 'Your officer tools open once your membership is confirmed. Until then you see what the public sees.';

/** OFFICER-VERIFY: a guest member's standing (Ross's GUEST ruling, 11-23). */
export const GUEST_TEXT = 'Your account has guest member access: the public pages, and the events as members see them.';

/**
 * D3: the form for one who may confirm their membership (an enrolee, or an officer power holder) with no
 * account yet; a plain line for anyone else; a standing for any account. A removed account that was
 * never checked is a sign-up an approver rejected (the API removes it with the rejection, fix 1); a
 * member removed later was checked when approved, so the two read differently.
 */
export function accountView(session: Session, account: MyAccount | undefined): AccountView {
  if (account === undefined) return mayConfirmMembership(session) ? 'form' : 'not-club';
  if (account.status === 'pending') return 'waiting';
  return account.status === 'removed' && account.verifiedOn === undefined ? 'rejected' : account.status;
}

export const STANDING_TEXT: Record<Exclude<AccountView, 'form'>, string> = {
  waiting: WAITING,
  member: 'Your account has member access.',
  affiliate: 'Your account has member access as an affiliated officer.',
  lapsed: 'Your member access is paused until an officer completes the yearly membership check.',
  removed: 'Your account no longer has member access.',
  rejected: 'Your sign-up was not approved.',
  'not-club': 'This sign-in is not one of the group’s accounts, so there is nothing to sign up for here.',
};

/** The standing line for a view, a guest member's in their own words (OFFICER-VERIFY). */
export function standingText(view: Exclude<AccountView, 'form'>, account: MyAccount | undefined): string {
  if (view === 'member' && (account?.localGroup === 'guest' || account?.localGroup === 'guest_unlisted')) return GUEST_TEXT;
  return STANDING_TEXT[view];
}

/** Fix 1 (SHOULD-1): after "Your sign-up was not approved." The page links the officer's title to /officers. */
export const REJECTED_CONTACT = "If you think this is a mistake, please contact the club's Membership Officer.";

export const SIGNUP_REFUSED: Record<'invalid' | 'on_file' | 'profile', string> = {
  invalid: 'Your sign-up was not accepted. Check your names and membership number, and send it again.',
  on_file: 'A sign-up is already on file for this account. An officer will look at it.',
  profile: 'Your sign-in account has no name or email address yet, so the sign-up could not be sent. Please contact an officer for help.',
};

export const ROUTE_TEXT: Record<Route, string> = {
  invite: 'Invited by an officer',
  signup: 'Signed up on the site',
  admin_grant: 'Granted by the Admin or the Webmaster',
};

export const CHECK_TEXT: Record<Check, string> = {
  unchecked: 'Not checked yet',
  verified_local: 'Confirmed by the membership verification service',
  verified_other_group: 'Confirmed by the membership verification service as a member of another local group',
  not_found: 'Not confirmed by the membership verification service',
  error: 'The membership verification service could not complete the check',
  email_mismatch: 'Number and last name confirmed by the membership verification service, but the email differs',
  duplicate_claim: 'This membership number was already claimed by another account',
};

const DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
const MOMENT = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, year: 'numeric', month: 'long', day: 'numeric' });

/** A calendar day (YYYY-MM-DD) as people read it: "October 20, 2026". */
export function formatDay(iso: string): string {
  return DAY.format(new Date(`${iso}T00:00:00Z`));
}

/** A moment as people read it, by the Central calendar. */
export function formatMoment(at: Date): string {
  return MOMENT.format(at);
}

/** The check's outcome, with its day when there is one. */
export function checkText(verification: Check, verifiedOn: string | undefined): string {
  return verifiedOn === undefined ? CHECK_TEXT[verification] : `${CHECK_TEXT[verification]}, on ${formatDay(verifiedOn)}`;
}

/**
 * VET: what the approver must do before approving, in words, for the two outcomes that never approve
 * by themselves; none for the others. An email the membership verification service did not confirm
 * is confirmed with the member, from the approver's own mailbox (the site never mails anyone about
 * it); a duplicate claim waits for an officer, naming the earlier claim by its display name and day
 * when the verifier named it.
 */
export function checkWarning(signup: Pick<PendingSignup, 'verification' | 'earlierClaim'>): string | undefined {
  if (signup.verification === 'email_mismatch') {
    return 'The membership verification service did not confirm this email. Confirm with the member that this sign-up is theirs, from your own mailbox, before approving.';
  }
  if (signup.verification !== 'duplicate_claim') return undefined;
  const earlier = signup.earlierClaim;
  const when = earlier?.signedUpAt === undefined ? '' : `, ${formatMoment(earlier.signedUpAt)}`;
  // Fix 1 (N2): a claim since closed is never named.
  const which = earlier === undefined ? '' : earlier.closed ? `: an earlier claim (since closed)${when}` : ` (${earlier.displayName}${when})`;
  return `Another account already claimed this number${which}. Don’t approve until an officer resolves it.`;
}

/**
 * VET fix 1: the label of the box an approver ticks to approve either warning outcome, in words for
 * each; none for the others. The API refuses the approval without it (confirmed_warning).
 */
export function confirmText(verification: Check): string | undefined {
  if (verification === 'email_mismatch') return 'I confirmed with the member that this sign-up is theirs.';
  if (verification === 'duplicate_claim') return 'I resolved the earlier claim on this number.';
  return undefined;
}

/**
 * VET fix 1: the API refuses an unconfirmed approval of a warning outcome as it refuses a closed one
 * (FAILED_PRECONDITION). Told apart by the queue as it is now: still waiting, with its warning, and
 * the box not ticked, it was the confirmation that was missing.
 */
export function decisionRefusal(
  reason: 'own' | 'closed',
  form: DecisionForm,
  queue: ReadonlyArray<Pick<PendingSignup, 'requestId' | 'verification'>> | undefined,
): 'own' | 'closed' | 'unconfirmed' {
  if (reason !== 'closed' || form.decision !== 'approve' || form.confirmed) return reason;
  const waiting = queue?.find((r) => r.requestId === form.requestId);
  return waiting !== undefined && confirmText(waiting.verification) !== undefined ? 'unconfirmed' : reason;
}

/** D4: the membership approvers and the Admin, by the internal groups the session carries (server/groups.mjs). */
export function isMembershipApprover(session: { groups: readonly string[] } | undefined): boolean {
  return session !== undefined && (session.groups.includes('nwfl-membership-approvers') || session.groups.includes('nwfl-admin'));
}

/**
 * REOPEN: the Admin and the Membership Officer's seat (nwfl-office-membership), as the API's
 * requireSignupReopener: not every membership approver.
 */
export function isSignupReopener(session: { groups: readonly string[] } | undefined): boolean {
  return session !== undefined && (session.groups.includes('nwfl-admin') || session.groups.includes('nwfl-office-membership'));
}

/**
 * The officer area's link to the sign-ups page, named by what the person may do there: the queue for
 * the membership approvers and the Admin; for the Membership Officer's seat without the approvers
 * group (REOPEN), the rejections alone. None for anyone else.
 */
export function signUpsLink(session: { groups: readonly string[] } | undefined): string | undefined {
  if (isMembershipApprover(session)) return 'Sign-ups to approve';
  return isSignupReopener(session) ? 'Rejected sign-ups to reopen' : undefined;
}

/**
 * NOTE-1: the sign-ups page's title and heading, by what the person may do there, the same words as
 * the officer area's link: the Membership Officer's seat without the approvers group sees the
 * rejections alone.
 */
export function signUpsTitle(session: { groups: readonly string[] } | undefined): string {
  return signUpsLink(session) ?? 'Sign-ups to approve';
}

export interface DecisionForm {
  decision: 'approve' | 'reject' | 'reopen';
  requestId: string;
  /**
   * A rejection or a reopening is applied only once confirmed; an approval at once. VET fix 1: an
   * approval of a warning outcome sends it as confirmed_warning (its box), which the API needs.
   */
  confirmed: boolean;
}

/** The API's request ids, lower-case. */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseDecisionForm(field: (name: string) => string | undefined): { ok: true; value: DecisionForm } | { ok: false } {
  const decision = field('decision');
  const requestId = field('request') ?? '';
  if ((decision !== 'approve' && decision !== 'reject' && decision !== 'reopen') || !REQUEST_ID.test(requestId)) return { ok: false };
  return { ok: true, value: { decision, requestId, confirmed: field('confirmed') === 'yes' } };
}

export type Done = 'approved' | 'rejected' | 'reopened';

const DONE_TEXT: Record<Done, string> = {
  approved: 'Approved. The account now has member access.',
  rejected: 'Rejected. The sign-up has been removed from the queue.',
  reopened: 'Reopened. The person can now send the sign-up form again from their account page.',
};

/** The outcome named by the address the queue lands on after a decision (?done=approved|rejected|reopened). */
/**
 * WEB-SMALL-1: the outcome a decision's redirect names, with the sign-up it names (one id, well formed);
 * the page shows its banner only once the API says that sign-up really is so (bannerShown).
 */
export function doneFromQuery(params: URLSearchParams): { done: Done; requestId: string } | undefined {
  const done = params.get('done');
  const ids = params.getAll('request');
  const requestId = ids.length === 1 ? (ids[0] as string) : '';
  if (!REQUEST_ID.test(requestId)) return undefined;
  return done === 'approved' || done === 'rejected' || done === 'reopened' ? { done, requestId } : undefined;
}

/** Where a decision lands: the queue, naming the outcome and the sign-up. */
export function donePath(here: string, done: Done, requestId: string): string {
  return `${here}?done=${done}&request=${encodeURIComponent(requestId)}`;
}

/** WEB-SMALL-1: the banner only when the named sign-up's real state is the one named; no answer, no banner. */
export function bannerShown(done: Done, decision: Decision | undefined): boolean {
  return decision === done;
}

/**
 * OFFICER-VERIFY: the outcomes that confirm an invited sign-up's number and last name (as the API's
 * CONFIRMED_BY_CHECK); with no first-name mismatch reported, an approver may approve it by hand.
 */
const CONFIRMED_BY_CHECK = new Set<Check>(['verified_local', 'verified_other_group', 'email_mismatch']);

/**
 * The orchestrator's ruling on Ross's "the officer needs to also pass the verifier": an invited sign-up
 * is approved by hand only once the check confirmed it; anything else is rejected (and may be reopened).
 * A plain sign-up is approved on the approver's word, as before.
 */
export function approvableByHand(signup: Pick<PendingSignup, 'route' | 'verification' | 'firstNameMatched'>): boolean {
  if (signup.route !== 'invite') return true;
  return CONFIRMED_BY_CHECK.has(signup.verification) && signup.firstNameMatched !== false;
}

export const INVITE_UNCONFIRMED =
  'An invited sign-up can be approved only once the membership check has confirmed the membership number and names. This one has not been, so it cannot be approved here: reject it, and it can then be reopened for a new check.';

/** OFFICER-VERIFY: an other-group sign-up is approved as a guest member (Ross 11-23). */
export const GUEST_APPROVAL = 'This person is a member of another local group, or of none. Approving gives them guest member access: the public pages, and the events as members see them.';

const LOCAL_GROUP_TEXT = { chapter: 'this chapter', guest: 'guest member', guest_unlisted: 'guest member; not a known local group name: check it' } as const;

/** OFFICER-VERIFY: what the check said of the first name and the local group, as label and value pairs. */
export function checkFacts(signup: Pick<PendingSignup, 'firstNameMatched' | 'localGroup' | 'localGroupStanding'>): Array<[string, string]> {
  const facts: Array<[string, string]> = [];
  if (signup.firstNameMatched !== undefined) facts.push(['First name check', signup.firstNameMatched ? 'Confirmed' : 'Did not match']);
  if (signup.localGroup !== undefined) facts.push(['Local group', signup.localGroupStanding ? `${signup.localGroup} (${LOCAL_GROUP_TEXT[signup.localGroupStanding]})` : signup.localGroup]);
  return facts;
}

export function doneText(done: Done): string {
  return DONE_TEXT[done];
}

export const DECISION_REFUSED: Record<'own' | 'closed' | 'unconfirmed', string> = {
  own: 'Nothing was changed: no one approves or rejects their own sign-up.',
  closed: 'Nothing was changed: this sign-up was already decided, or it cannot be approved as a member. The list below is as it is now.',
  unconfirmed: 'Nothing was changed: tick the box by the warning to say you confirmed it, then approve. The list below is as it is now.',
};

/** REOPEN: a reopening the API refused. */
export const REOPEN_REFUSED: Record<'own' | 'closed', string> = {
  own: 'Nothing was changed: only the Admin or the Membership Officer reopens a sign-up, and never their own.',
  closed: 'Nothing was changed: this sign-up can no longer be reopened. The list below is as it is now.',
};

/** NOTE-1: an approval or rejection the API refused because the person is not an approver at all. */
export const NOT_AN_APPROVER = 'Nothing was changed: only the sign-up approvers can approve or reject a sign-up.';

/**
 * The words for a refused decision. The API answers PERMISSION_DENIED both for an approver's own
 * sign-up and for someone who may not approve at all (the Membership Officer's seat without the
 * approvers group); the page knows which, so it says the one that fits.
 */
export function refusedText(refused: { reason: 'own' | 'closed' | 'unconfirmed'; reopen: boolean }, approver: boolean): string {
  if (refused.reopen) return REOPEN_REFUSED[refused.reason === 'own' ? 'own' : 'closed'];
  return refused.reason === 'own' && !approver ? NOT_AN_APPROVER : DECISION_REFUSED[refused.reason];
}

/**
 * NOTE-4: the most rejections the API lists for reopening, newest first, with no paging (its
 * MAX_REJECTED_LISTED, apps/api/src/membership/service.ts). A full list says so, so an older one is
 * never hidden without a word.
 */
export const REJECTED_LISTED_MAX = 50;

export function rejectedShownNote(count: number): string | undefined {
  return count >= REJECTED_LISTED_MAX ? `Showing the latest ${REJECTED_LISTED_MAX} rejected sign-ups. Any older ones are not shown here.` : undefined;
}

/**
 * D3: where a sign-in goes first. One of the group's enrolees with no account yet goes to /account,
 * after each sign-in until they have signed up (then they have an account, pending or decided);
 * anyone else goes back where they were. OFFICER-VERIFY: officers, the Admin, the Webmaster and the
 * approvers with no account are stopped too: their tools need their membership confirmed. When the API cannot say, the return is
 * honoured: signing in never fails for this.
 */
export async function firstStop(session: Session, back: string, api: MembershipApi | undefined, deps: SessionReaderDeps): Promise<string> {
  if (!mayConfirmMembership(session) || api === undefined) return back;
  const { reader } = sessionReader(session, deps);
  if (reader === undefined) return back;
  try {
    return (await api.getMyAccount(reader)) === undefined ? ACCOUNT_PATH : back;
  } catch {
    return back;
  }
}
