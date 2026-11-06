// W-SIGNUP: the words and checks of the first-sign-in page (/account) and the approvers' queue
// (/officer-area/sign-ups), checked here on the server (both pages work with no script).
import { describe, expect, it } from 'vitest';
import { newSession } from '../../server/session.mjs';
import { TokenStore } from '../../server/token-store.mjs';
import { ApiUnavailable } from './api/client';
import { type MembershipApi, type MyAccount, MembershipSignInAgain } from './api/membership';
import type { Tokens } from './auth/oidc';
import {
  ACCOUNT_PATH,
  CHECK_TEXT,
  DECISION_REFUSED,
  REOPEN_REFUSED,
  ROUTE_TEXT,
  REJECTED_CONTACT,
  SIGNUP_REFUSED,
  STANDING_TEXT,
  WAITING,
  accountView,
  errorSummary,
  checkText,
  doneFromQuery,
  doneText,
  firstStop,
  formatDay,
  formatMoment,
  isMembershipApprover,
  isSignupReopener,
  parseDecisionForm,
  parseSignupForm,
} from './signup';

const form = (values: Record<string, string>) => (name: string) => values[name];
// Obviously fake: never a real membership number.
const FAKE_NUMBER = '000012345';
const ID = '6a1f0c8e-1b2c-4d3e-8f40-5a6b7c8d9e0f';
const NOW = 1_800_000_000;
const session = (groups: string[]) => newSession({ sub: '0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b', groups }, NOW - 60);

describe('parseSignupForm (D1: both fields, for everyone)', () => {
  it('takes a last name and a number of digits, trimmed', () => {
    expect(parseSignupForm(form({ lastName: '  Fakename ', membershipNumber: ` ${FAKE_NUMBER} ` }))).toEqual({ ok: true, value: { lastName: 'Fakename', membershipNumber: FAKE_NUMBER } });
    expect(parseSignupForm(form({ lastName: 'Ó Fakeáin-Smythe', membershipNumber: '7' }))).toMatchObject({ ok: true });
    expect(parseSignupForm(form({ lastName: 'L'.repeat(80), membershipNumber: '1'.repeat(12) }))).toMatchObject({ ok: true });
  });

  it('says what is missing, by field, and gives back the last name but never the number', () => {
    expect(parseSignupForm(form({}))).toEqual({ ok: false, errors: { lastName: 'Enter your last name.', membershipNumber: 'Enter your membership number.' }, values: { lastName: '' } });
    expect(parseSignupForm(form({ lastName: '   ', membershipNumber: '  ' }))).toMatchObject({ ok: false, errors: { lastName: 'Enter your last name.', membershipNumber: 'Enter your membership number.' } });
    const refused = parseSignupForm(form({ lastName: 'Fakename', membershipNumber: `${FAKE_NUMBER}x` }));
    expect(refused).toEqual({ ok: false, errors: { membershipNumber: 'Enter your membership number using digits only, up to 12 of them.' }, values: { lastName: 'Fakename' } });
    expect(JSON.stringify(refused)).not.toContain(FAKE_NUMBER);
  });

  it.each([
    ['13 digits', '1234567890123'],
    ['a dash', '0000-12345'],
    ['a space inside', '0000 12345'],
    ['a full-width digit', '０００１'],
    ['a sign', '+12345'],
  ])('refuses a number with %s', (_label, number) => {
    expect(parseSignupForm(form({ lastName: 'Fakename', membershipNumber: number }))).toMatchObject({ ok: false, errors: { membershipNumber: 'Enter your membership number using digits only, up to 12 of them.' } });
  });

  it('refuses a last name over 80 characters, counted as letters, or with a hidden character', () => {
    expect(parseSignupForm(form({ lastName: 'L'.repeat(81), membershipNumber: '7' }))).toMatchObject({ ok: false, errors: { lastName: 'Keep your last name to 80 characters or fewer.' } });
    expect(parseSignupForm(form({ lastName: '\u{1F600}'.repeat(80), membershipNumber: '7' }))).toMatchObject({ ok: true });
    expect(parseSignupForm(form({ lastName: 'Fake\u0000name', membershipNumber: '7' }))).toMatchObject({
      ok: false,
      errors: { lastName: 'Type your last name again: it has a hidden character that cannot be kept.' },
    });
  });
});

describe('accountView (D3)', () => {
  const account = (status: MyAccount['status']): MyAccount => ({ status, route: 'signup', verifiedOn: '2026-10-20' });

  it('gives an enrolee with no account the form, and one with a pending account the waiting line', () => {
    expect(accountView(session(['nwfl-users']), undefined)).toBe('form');
    expect(accountView(session(['nwfl-users', 'nwfl-members', 'nwfl-invited']), undefined)).toBe('form');
    expect(accountView(session(['nwfl-users']), account('pending'))).toBe('waiting');
    expect(WAITING).toBe('Your sign-up is waiting for an officer to approve it.');
  });

  it('gives a member, an affiliate, a lapsed and a removed account their standing, officers too', () => {
    for (const status of ['member', 'affiliate', 'lapsed', 'removed'] as const) {
      expect(accountView(session(['nwfl-users']), account(status))).toBe(status);
      expect(accountView(session(['nwfl-members', 'nwfl-officers']), account(status))).toBe(status);
    }
  });

  it('fix 1 (SHOULD-1): tells a rejected sign-up (removed, never checked) it was not approved, never that it waits', () => {
    const rejected: MyAccount = { status: 'removed', route: 'signup' };
    expect(accountView(session(['nwfl-users']), rejected)).toBe('rejected');
    expect(accountView(session(['nwfl-users', 'nwfl-members', 'nwfl-invited']), { status: 'removed', route: 'invite' })).toBe('rejected');
    expect(STANDING_TEXT.rejected).toBe('Your sign-up was not approved.');
    expect(REJECTED_CONTACT).toBe("If you think this is a mistake, please contact the club's Membership Officer.");
    expect(STANDING_TEXT.rejected).not.toContain('waiting');
    // A member removed later was checked once, so their words stay "no longer has member access".
    expect(accountView(session(['nwfl-users']), account('removed'))).toBe('removed');
  });

  it('fix 1 (NOTE-8): tells an officer or the Admin with no account that the officer area needs none, with no form', () => {
    for (const groups of [['nwfl-officers'], ['nwfl-members', 'nwfl-officers'], ['nwfl-admin'], ['nwfl-users', 'nwfl-admin']]) {
      expect(accountView(session(groups), undefined), groups.join()).toBe('officer');
    }
    expect(STANDING_TEXT.officer).toBe('You need no member account to use the officer area.');
    expect(accountView(session(['nwfl-members', 'nwfl-officers']), account('member'))).toBe('member');
    expect(accountView(session(['nwfl-members', 'nwfl-officers']), account('pending'))).toBe('waiting');
  });

  it('gives no form to an account that is not the group\'s (no enrolee group, not an officer, not the Admin), only a plain line', () => {
    expect(accountView(session([]), undefined)).toBe('not-club');
    expect(accountView(session(['nwfl-webmaster']), undefined)).toBe('not-club');
    expect(accountView(session(['mensa-nwfl-admin']), undefined)).toBe('not-club');
  });
});

describe('errorSummary (fix 1, NOTE-6: the summary at the top of a form with problems)', () => {
  it('lists each problem in the form\'s order, each pointing at its field', () => {
    expect(errorSummary({ membershipNumber: 'Enter your membership number.', lastName: 'Enter your last name.' })).toEqual([
      { field: 'lastName', text: 'Enter your last name.' },
      { field: 'membershipNumber', text: 'Enter your membership number.' },
    ]);
    expect(errorSummary({ membershipNumber: 'Enter your membership number.' })).toEqual([{ field: 'membershipNumber', text: 'Enter your membership number.' }]);
    expect(errorSummary({})).toEqual([]);
  });
});

describe('the queue\'s words (D4)', () => {
  it('names how each person came, never by colour alone', () => {
    expect(ROUTE_TEXT).toEqual({ invite: 'Invited by an officer', signup: 'Signed up on the site', admin_grant: 'Granted by the Admin or the Webmaster' });
  });

  it('says the check\'s outcome in words, with its day when there is one', () => {
    expect(Object.keys(CHECK_TEXT).sort()).toEqual(['error', 'not_found', 'unchecked', 'verified_local', 'verified_other_group']);
    expect(checkText('verified_local', '2026-11-02')).toBe(`${CHECK_TEXT.verified_local}, on November 2, 2026`);
    expect(checkText('unchecked', undefined)).toBe(CHECK_TEXT.unchecked);
    expect(formatDay('2026-01-31')).toBe('January 31, 2026');
    // A sign-up's moment by the Central calendar: 03:00 UTC on November 2 is still November 1 there.
    expect(formatMoment(new Date('2026-11-02T03:00:00Z'))).toBe('November 1, 2026');
  });

  it('is for the membership approvers and the Admin only', () => {
    expect(isMembershipApprover(session(['nwfl-members', 'nwfl-officers', 'nwfl-membership-approvers']))).toBe(true);
    expect(isMembershipApprover(session(['nwfl-admin']))).toBe(true);
    expect(isMembershipApprover(session(['nwfl-members', 'nwfl-officers', 'nwfl-webmaster']))).toBe(false);
    expect(isMembershipApprover(session(['mensa-nwfl-membership-approvers']))).toBe(false);
    expect(isMembershipApprover(undefined)).toBe(false);
  });

  it('reads a decision: approve at once, reject only once confirmed, by a request id', () => {
    expect(parseDecisionForm(form({ decision: 'approve', request: ID }))).toEqual({ ok: true, value: { decision: 'approve', requestId: ID, confirmed: false } });
    expect(parseDecisionForm(form({ decision: 'reject', request: ID }))).toEqual({ ok: true, value: { decision: 'reject', requestId: ID, confirmed: false } });
    expect(parseDecisionForm(form({ decision: 'reject', request: ID, confirmed: 'yes' }))).toEqual({ ok: true, value: { decision: 'reject', requestId: ID, confirmed: true } });
    for (const values of [{}, { decision: 'approve' }, { decision: 'grant', request: ID }, { decision: 'approve', request: 'nope' }, { decision: 'approve', request: ID.toUpperCase() }]) {
      expect(parseDecisionForm(form(values)), JSON.stringify(values)).toEqual({ ok: false });
    }
  });

  it('fix 1 (NOTE-2): confirms a rejection only by the exact word, and takes no id with anything around it', () => {
    for (const confirmed of ['no', '1', 'true', 'Yes', 'yes ', '']) {
      expect(parseDecisionForm(form({ decision: 'reject', request: ID, confirmed })), confirmed).toEqual({ ok: true, value: { decision: 'reject', requestId: ID, confirmed: false } });
    }
    for (const request of [`${ID}x`, `${ID}\n`, ` ${ID}`, `x${ID}`, `${ID}/../${ID}`]) {
      expect(parseDecisionForm(form({ decision: 'approve', request })), JSON.stringify(request)).toEqual({ ok: false });
    }
  });

  it('names the outcome the page lands on after a decision', () => {
    expect(doneFromQuery(new URLSearchParams('done=approved'))).toBe('approved');
    expect(doneFromQuery(new URLSearchParams('done=rejected'))).toBe('rejected');
    expect(doneFromQuery(new URLSearchParams('done=granted'))).toBeUndefined();
    expect(doneFromQuery(new URLSearchParams(''))).toBeUndefined();
    expect(doneText('approved')).toBe('Approved. The account now has member access.');
    expect(doneText('rejected')).toBe('Rejected. The sign-up has been removed from the queue.');
  });

  it('REOPEN: lets only the Admin and the Membership Officer\'s seat reopen, as the API does', () => {
    expect(isSignupReopener(session(['nwfl-admin']))).toBe(true);
    expect(isSignupReopener(session(['nwfl-members', 'nwfl-officers', 'nwfl-office-membership', 'nwfl-membership-approvers']))).toBe(true);
    expect(isSignupReopener(session(['nwfl-officers', 'nwfl-office-membership']))).toBe(true);
    for (const groups of [['nwfl-users', 'nwfl-membership-approvers'], ['nwfl-members', 'nwfl-officers', 'nwfl-webmaster'], ['nwfl-office-treasurer'], ['mensa-nwfl-office-membership'], ['nwfl-office-membershipx']]) {
      expect(isSignupReopener(session(groups)), groups.join(' ')).toBe(false);
    }
    expect(isSignupReopener(undefined)).toBe(false);
  });

  it('REOPEN: reads a reopening, applied only once confirmed by the exact word', () => {
    expect(parseDecisionForm(form({ decision: 'reopen', request: ID }))).toEqual({ ok: true, value: { decision: 'reopen', requestId: ID, confirmed: false } });
    expect(parseDecisionForm(form({ decision: 'reopen', request: ID, confirmed: 'yes' }))).toEqual({ ok: true, value: { decision: 'reopen', requestId: ID, confirmed: true } });
    expect(parseDecisionForm(form({ decision: 'reopen', request: ID, confirmed: 'Yes' }))).toEqual({ ok: true, value: { decision: 'reopen', requestId: ID, confirmed: false } });
    expect(parseDecisionForm(form({ decision: 'reopen', request: 'nope' }))).toEqual({ ok: false });
    expect(parseDecisionForm(form({ decision: 'Reopen', request: ID }))).toEqual({ ok: false });
  });

  it('REOPEN: names the outcome, and says each refusal in plain words', () => {
    expect(doneFromQuery(new URLSearchParams('done=reopened'))).toBe('reopened');
    expect(doneText('reopened')).toBe('Reopened. The person can now send the sign-up form again from their account page.');
    expect(Object.keys(REOPEN_REFUSED).sort()).toEqual(['closed', 'own']);
    expect(REOPEN_REFUSED.own).toBe('Nothing was changed: only the Admin or the Membership Officer reopens a sign-up, and never their own.');
    expect(REOPEN_REFUSED.closed).toBe('Nothing was changed: this sign-up can no longer be reopened. The list below is as it is now.');
  });

  it('says each refusal in plain words', () => {
    expect(Object.keys(SIGNUP_REFUSED).sort()).toEqual(['invalid', 'on_file', 'profile']);
    expect(Object.keys(DECISION_REFUSED).sort()).toEqual(['closed', 'own']);
    expect(DECISION_REFUSED.own).toBe('Nothing was changed: no one approves or rejects their own sign-up.');
  });
});

describe('firstStop (D3: the callback sends a person with no account to /account)', () => {
  const signedIn = (groups: string[], tokens: Tokens | undefined = { access_token: 'tok.en', expires_at: NOW + 3600 }) => {
    const store = new TokenStore<Tokens>();
    const s = session(groups);
    if (tokens) store.put(s.sid, tokens, s.exp);
    return { session: s, deps: { tokens: store, now: () => NOW } };
  };
  const api = (answer: () => Promise<MyAccount | undefined>, seen: string[] = []): MembershipApi =>
    ({
      getMyAccount: (as) => {
        seen.push(as.bearer);
        return answer();
      },
    }) as MembershipApi;

  it('sends an enrolee with no account to /account, whatever the return', async () => {
    const { session: s, deps } = signedIn(['nwfl-users']);
    const seen: string[] = [];
    expect(await firstStop(s, '/news', api(() => Promise.resolve(undefined), seen), deps)).toBe(ACCOUNT_PATH);
    expect(ACCOUNT_PATH).toBe('/account');
    expect(seen).toEqual(['tok.en']);
  });

  it('honours the return for anyone with an account, pending included', async () => {
    const { session: s, deps } = signedIn(['nwfl-users']);
    expect(await firstStop(s, '/news', api(() => Promise.resolve({ status: 'pending', route: 'signup' })), deps)).toBe('/news');
    expect(await firstStop(s, '/about', api(() => Promise.resolve({ status: 'member', route: 'invite' })), deps)).toBe('/about');
  });

  it('honours the return without asking for an account that is not the group\'s, with no API, or with no live token', async () => {
    const seen: string[] = [];
    const ask = api(() => Promise.resolve(undefined), seen);
    const outsider = signedIn(['nwfl-officers']);
    expect(await firstStop(outsider.session, '/news', ask, outsider.deps)).toBe('/news');
    const lapsed = signedIn(['nwfl-users'], { access_token: 'tok.en', expires_at: NOW + 10 });
    expect(await firstStop(lapsed.session, '/news', ask, lapsed.deps)).toBe('/news');
    const enrolee = signedIn(['nwfl-users']);
    expect(await firstStop(enrolee.session, '/news', undefined, enrolee.deps)).toBe('/news');
    expect(seen).toEqual([]);
  });

  it('fix 1 (SHOULD-2): honours the return for officers and the Admin without asking: they need no account', async () => {
    const seen: string[] = [];
    const ask = api(() => Promise.resolve(undefined), seen);
    for (const groups of [['nwfl-members', 'nwfl-officers'], ['nwfl-users', 'nwfl-officers'], ['nwfl-users', 'nwfl-admin'], ['nwfl-members', 'nwfl-officers', 'nwfl-membership-approvers']]) {
      const { session: s, deps } = signedIn(groups);
      expect(await firstStop(s, '/news', ask, deps), groups.join()).toBe('/news');
    }
    expect(seen).toEqual([]);
    // A membership approver who is neither still signs up like anyone else.
    const lone = signedIn(['nwfl-users', 'nwfl-membership-approvers']);
    expect(await firstStop(lone.session, '/news', ask, lone.deps)).toBe(ACCOUNT_PATH);
  });

  it('honours the return when the API cannot say: signing in never fails for this', async () => {
    const { session: s, deps } = signedIn(['nwfl-users']);
    for (const error of [new ApiUnavailable('GetMyAccount'), new MembershipSignInAgain('GetMyAccount'), new Error('a bug')]) {
      expect(await firstStop(s, '/news', api(() => Promise.reject(error)), deps)).toBe('/news');
    }
  });
});
