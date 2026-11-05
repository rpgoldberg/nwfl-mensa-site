// W-SIGNUP: the words and checks of the first-sign-in page (/account) and the approvers' queue
// (/officer-area/sign-ups), checked here on the server: both pages work with no script.
//
// D1: every sign-up gives a last name and a Mensa membership number, invited or not; the API checks
// them again and refuses anything else. The number is digits only, as the API and the schema take
// it, and it is never given back in a page or a log line (D6). D3: an enrolee with no account gets
// the form; a pending account the waiting line; anyone else their standing. D4: the queue is for the
// membership approvers and the Admin only, in plain words, never by colour alone.
import type { Session } from '../../server/session.mjs';
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

/** What /account shows. */
export type AccountView = 'form' | 'waiting' | 'member' | 'affiliate' | 'lapsed' | 'removed' | 'not-club';

/** D3: the form only for one of the group's enrolees with no account yet; a standing for any account. */
export function accountView(session: Session, account: MyAccount | undefined): AccountView {
  if (account === undefined) return session.enrolee ? 'form' : 'not-club';
  return account.status === 'pending' ? 'waiting' : account.status;
}

export const STANDING_TEXT: Record<Exclude<AccountView, 'form'>, string> = {
  waiting: WAITING,
  member: 'Your account has member access.',
  affiliate: 'Your account has member access as an affiliated officer.',
  lapsed: 'Your member access is paused until an officer completes the yearly membership check.',
  removed: 'Your account no longer has member access.',
  'not-club': 'This sign-in is not one of the group’s accounts, so there is nothing to sign up for here.',
};

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

export interface DecisionForm {
  decision: 'approve' | 'reject';
  requestId: string;
  /** A rejection is applied only once confirmed; an approval at once. */
  confirmed: boolean;
}

/** The API's request ids, lower-case. */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseDecisionForm(field: (name: string) => string | undefined): { ok: true; value: DecisionForm } | { ok: false } {
  const decision = field('decision');
  const requestId = field('request') ?? '';
  if ((decision !== 'approve' && decision !== 'reject') || !REQUEST_ID.test(requestId)) return { ok: false };
  return { ok: true, value: { decision, requestId, confirmed: field('confirmed') === 'yes' } };
}

export type Done = 'approved' | 'rejected';

/** The outcome named by the address the queue lands on after a decision (?done=approved|rejected). */
export function doneFromQuery(params: URLSearchParams): Done | undefined {
  const done = params.get('done');
  return done === 'approved' || done === 'rejected' ? done : undefined;
}

export function doneText(done: Done): string {
  return done === 'approved' ? 'Approved. The account now has member access.' : 'Rejected. The sign-up has been removed from the queue.';
}

export const DECISION_REFUSED: Record<'own' | 'closed', string> = {
  own: 'Nothing was changed: no one approves or rejects their own sign-up.',
  closed: 'Nothing was changed: this sign-up was already decided, or it cannot be approved as a member. The list below is as it is now.',
};

/**
 * D3: where a sign-in goes first. One of the group's enrolees with no account yet goes to /account
 * (once: after the sign-up they have a pending account); anyone else goes back where they were. When
 * the API cannot say, the return is honoured: signing in never fails for this.
 */
export async function firstStop(session: Session, back: string, api: MembershipApi | undefined, deps: SessionReaderDeps): Promise<string> {
  if (!session.enrolee || api === undefined) return back;
  const { reader } = sessionReader(session, deps);
  if (reader === undefined) return back;
  try {
    return (await api.getMyAccount(reader)) === undefined ? ACCOUNT_PATH : back;
  } catch {
    return back;
  }
}
