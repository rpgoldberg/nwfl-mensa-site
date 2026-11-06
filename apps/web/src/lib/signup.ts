// W-SIGNUP: the words and checks of the first-sign-in page (/account) and the approvers' queue
// (/officer-area/sign-ups), checked here on the server: both pages work with no script.
//
// D1: every sign-up gives a last name and a Mensa membership number, invited or not; the API checks
// them again and refuses anything else. The number is digits only, as the API and the schema take
// it, and it is never given back in a page or a log line (D6). D3: an enrolee with no account gets
// the form; a pending account the waiting line; a rejected sign-up says it was not approved; anyone
// else their standing. Officers and the Admin need no account (fix 1): no form and no stop after
// signing in. D4: the queue is for the membership approvers and the Admin only, in plain words,
// never by colour alone. REOPEN: the Admin and the Membership Officer also see the rejections that
// can be reopened, and reopen one after a confirmation step; the person's /account then offers the
// form again (the API removes the account the rejection closed).
import type { Session } from '../../server/session.mjs';
import { isAdmin } from './approval-rules';
import type { Check, MembershipApi, MyAccount, Route } from './api/membership';
import { type SessionReaderDeps, sessionReader } from './api/membership';
import { ZONE } from './calendar';

export const ACCOUNT_PATH = '/account';
/** The API's own limits (apps/api/src/membership/service.ts). */
export const MAX_LAST_NAME = 80;
export const MAX_NUMBER_DIGITS = 12;

export const WAITING = 'Your sign-up is waiting for an officer to approve it.';

export interface SignupForm {
  lastName: string;
  membershipNumber: string;
}

export type SignupErrors = Partial<Record<keyof SignupForm, string>>;

/** On a problem, the last name comes back to the form; the number never does (D6). */
export type ParsedSignup = { ok: true; value: SignupForm } | { ok: false; errors: SignupErrors; values: { lastName: string } };

const DIGITS = new RegExp(`^[0-9]{1,${MAX_NUMBER_DIGITS}}$`);
/** Any control character (a NUL, a tab, an escape code): no last name holds one. */
const CONTROL = /\p{Cc}/u;

/** The sign-up form's two fields, checked; each problem is said in words, by field. */
export function parseSignupForm(field: (name: string) => string | undefined): ParsedSignup {
  const lastName = (field('lastName') ?? '').trim();
  const membershipNumber = (field('membershipNumber') ?? '').trim();
  const errors: SignupErrors = {};
  if (lastName === '') errors.lastName = 'Enter your last name.';
  else if ([...lastName].length > MAX_LAST_NAME) errors.lastName = `Keep your last name to ${MAX_LAST_NAME} characters or fewer.`;
  else if (CONTROL.test(lastName)) errors.lastName = 'Type your last name again: it has a hidden character that cannot be kept.';
  if (membershipNumber === '') errors.membershipNumber = 'Enter your membership number.';
  else if (!DIGITS.test(membershipNumber)) errors.membershipNumber = `Enter your membership number using digits only, up to ${MAX_NUMBER_DIGITS} of them.`;
  if (Object.keys(errors).length > 0) return { ok: false, errors, values: { lastName } };
  return { ok: true, value: { lastName, membershipNumber } };
}

/** The order of the form's fields, which its error summary follows. */
const FIELDS: readonly (keyof SignupForm)[] = ['lastName', 'membershipNumber'];

/** Fix 1 (NOTE-6): the summary at the top of the form, one entry per problem, each linking to its field. */
export function errorSummary(errors: SignupErrors): Array<{ field: keyof SignupForm; text: string }> {
  return FIELDS.flatMap((field) => (errors[field] === undefined ? [] : [{ field, text: errors[field] }]));
}

/** What /account shows. */
export type AccountView = 'form' | 'waiting' | 'member' | 'affiliate' | 'lapsed' | 'removed' | 'rejected' | 'officer' | 'not-club';

/** Fix 1 (SHOULD-2): officers and the Admin use the officer area with no member account. */
export function needsNoAccount(session: Session): boolean {
  return session.officer || isAdmin(session);
}

/**
 * D3: the form only for one of the group's enrolees with no account yet who is neither an officer nor
 * the Admin (they get a plain line instead); a standing for any account. A removed account that was
 * never checked is a sign-up an approver rejected (the API removes it with the rejection, fix 1); a
 * member removed later was checked when approved, so the two read differently.
 */
export function accountView(session: Session, account: MyAccount | undefined): AccountView {
  if (account === undefined) return needsNoAccount(session) ? 'officer' : session.enrolee ? 'form' : 'not-club';
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
  officer: 'You need no member account to use the officer area.',
  'not-club': 'This sign-in is not one of the group’s accounts, so there is nothing to sign up for here.',
};

/** Fix 1 (SHOULD-1): after "Your sign-up was not approved." The page links the officer's title to /officers. */
export const REJECTED_CONTACT = "If you think this is a mistake, please contact the club's Membership Officer.";

export const SIGNUP_REFUSED: Record<'invalid' | 'on_file' | 'profile', string> = {
  invalid: 'Your sign-up was not accepted. Check your last name and membership number, and send it again.',
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
  verified_local: 'Found on our group’s membership list',
  verified_other_group: 'Found as a member of another local group',
  not_found: 'Not found on the membership list (members who opted out or lapsed may not appear)',
  error: 'The check could not be done',
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

export interface DecisionForm {
  decision: 'approve' | 'reject' | 'reopen';
  requestId: string;
  /** A rejection or a reopening is applied only once confirmed; an approval at once. */
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
export function doneFromQuery(params: URLSearchParams): Done | undefined {
  const done = params.get('done');
  return done === 'approved' || done === 'rejected' || done === 'reopened' ? done : undefined;
}

export function doneText(done: Done): string {
  return DONE_TEXT[done];
}

export const DECISION_REFUSED: Record<'own' | 'closed', string> = {
  own: 'Nothing was changed: no one approves or rejects their own sign-up.',
  closed: 'Nothing was changed: this sign-up was already decided, or it cannot be approved as a member. The list below is as it is now.',
};

/** REOPEN: a reopening the API refused. */
export const REOPEN_REFUSED: Record<'own' | 'closed', string> = {
  own: 'Nothing was changed: only the Admin or the Membership Officer reopens a sign-up, and never their own.',
  closed: 'Nothing was changed: this sign-up can no longer be reopened. The list below is as it is now.',
};

/**
 * D3: where a sign-in goes first. One of the group's enrolees with no account yet goes to /account,
 * after each sign-in until they have signed up (then they have an account, pending or decided);
 * anyone else goes back where they were. Officers and the Admin are never stopped: they need no
 * member account (fix 1, SHOULD-2), so the API is not asked. When the API cannot say, the return is
 * honoured: signing in never fails for this.
 */
export async function firstStop(session: Session, back: string, api: MembershipApi | undefined, deps: SessionReaderDeps): Promise<string> {
  if (!session.enrolee || needsNoAccount(session) || api === undefined) return back;
  const { reader } = sessionReader(session, deps);
  if (reader === undefined) return back;
  try {
    return (await api.getMyAccount(reader)) === undefined ? ACCOUNT_PATH : back;
  } catch {
    return back;
  }
}
