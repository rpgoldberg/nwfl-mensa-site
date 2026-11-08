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
  NOT_AN_APPROVER,
  REJECTED_LISTED_MAX,
  REOPEN_REFUSED,
  ROUTE_TEXT,
  REJECTED_CONTACT,
  SIGNUP_REFUSED,
  STANDING_TEXT,
  WAITING,
  accountView,
  errorSummary,
  checkText,
  checkWarning,
  confirmText,
  decisionRefusal,
  doneFromQuery,
  doneText,
  firstStop,
  formatDay,
  formatMoment,
  isMembershipApprover,
  isSignupReopener,
  refusedText,
  rejectedShownNote,
  parseDecisionForm,
  signUpsLink,
  signUpsTitle,
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

  it('VET fix 1: takes a number typed with spaces and dashes inside it, keeping only the digits', () => {
    for (const typed of ['000-012-345', '000 012 345', ' 000 012-345 ', '000\u00a0012\u2013345', '0-0-0-0-1-2-3-4-5']) {
      expect(parseSignupForm(form({ lastName: 'Fakename', membershipNumber: typed })), typed).toEqual({ ok: true, value: { lastName: 'Fakename', membershipNumber: FAKE_NUMBER } });
    }
    expect(parseSignupForm(form({ lastName: 'Fakename', membershipNumber: '1234-5678-9012' }))).toMatchObject({ ok: true, value: { membershipNumber: '123456789012' } });
  });

  it('VET fix 1: still refuses a letter, any other mark, more than 12 digits or no digit, never giving the number back', () => {
    for (const typed of ['000-012-34x', '0OO 012 345', '000.012.345', '000/012/345', '1234-5678-90123', '- -', '+000012345']) {
      const refused = parseSignupForm(form({ lastName: 'Fakename', membershipNumber: typed }));
      expect(refused, typed).toEqual({ ok: false, errors: { membershipNumber: 'Enter your membership number using digits only, up to 12 of them.' }, values: { lastName: 'Fakename' } });
      expect(JSON.stringify(refused)).not.toContain('012');
    }
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
    // VET fix 1: a dash or a space inside is now typing noise, dropped (above); 13 digits with them still is not.
    ['13 digits with dashes', '1234-5678-9012-3'],
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

describe('VET: the queue\'s warnings before approving', () => {
  it('asks the approver to confirm with the member, from their own mailbox, when the service did not confirm the email', () => {
    expect(checkWarning({ verification: 'email_mismatch' })).toBe(
      'The membership verification service did not confirm this email. Confirm with the member that this sign-up is theirs, from your own mailbox, before approving.',
    );
  });

  it('names the earlier claim of a duplicate by its display name and day, and says not to approve until an officer resolves it', () => {
    // 03:00 UTC on September 16 is still September 15 by the Central calendar.
    expect(checkWarning({ verification: 'duplicate_claim', earlierClaim: { displayName: 'Lee Firstclaim', signedUpAt: new Date('2026-09-16T03:00:00Z') } })).toBe(
      'Another account already claimed this number (Lee Firstclaim, September 15, 2026). Don’t approve until an officer resolves it.',
    );
    expect(checkWarning({ verification: 'duplicate_claim', earlierClaim: { displayName: 'Lee Firstclaim' } })).toBe(
      'Another account already claimed this number (Lee Firstclaim). Don’t approve until an officer resolves it.',
    );
    expect(checkWarning({ verification: 'duplicate_claim' })).toBe('Another account already claimed this number. Don’t approve until an officer resolves it.');
  });

  it('fix 1 (N2): names an earlier claim since closed only as closed, with its day, never by a name', () => {
    expect(checkWarning({ verification: 'duplicate_claim', earlierClaim: { displayName: '', closed: true, signedUpAt: new Date('2026-09-16T03:00:00Z') } })).toBe(
      'Another account already claimed this number: an earlier claim (since closed), September 15, 2026. Don’t approve until an officer resolves it.',
    );
    expect(checkWarning({ verification: 'duplicate_claim', earlierClaim: { displayName: 'Stale Name', closed: true } })).toBe(
      'Another account already claimed this number: an earlier claim (since closed). Don’t approve until an officer resolves it.',
    );
  });

  it('fix 1: words the confirmation an approval of either warning needs, for each outcome, and none for the others', () => {
    expect(confirmText('email_mismatch')).toBe('I confirmed with the member that this sign-up is theirs.');
    expect(confirmText('duplicate_claim')).toBe('I resolved the earlier claim on this number.');
    for (const verification of ['unchecked', 'verified_local', 'verified_other_group', 'not_found', 'error'] as const) expect(confirmText(verification)).toBeUndefined();
  });

  it('fix 1: says an approval refused for want of the confirmation as that, and every other refusal as before', () => {
    const queue = [
      { requestId: 'a1000000-0000-4000-8000-000000000001', verification: 'email_mismatch' as const },
      { requestId: 'a1000000-0000-4000-8000-000000000002', verification: 'not_found' as const },
    ];
    const approve = (requestId: string, confirmed = false) => ({ decision: 'approve' as const, requestId, confirmed });
    expect(decisionRefusal('closed', approve('a1000000-0000-4000-8000-000000000001'), queue)).toBe('unconfirmed');
    // Confirmed, gone from the queue, no warning, a rejection, the approver's own, or no queue to read: as the API said.
    expect(decisionRefusal('closed', approve('a1000000-0000-4000-8000-000000000001', true), queue)).toBe('closed');
    expect(decisionRefusal('closed', approve('a1000000-0000-4000-8000-000000000003'), queue)).toBe('closed');
    expect(decisionRefusal('closed', approve('a1000000-0000-4000-8000-000000000002'), queue)).toBe('closed');
    expect(decisionRefusal('closed', { decision: 'reject', requestId: 'a1000000-0000-4000-8000-000000000001', confirmed: true }, queue)).toBe('closed');
    expect(decisionRefusal('own', approve('a1000000-0000-4000-8000-000000000001'), queue)).toBe('own');
    expect(decisionRefusal('closed', approve('a1000000-0000-4000-8000-000000000001'), undefined)).toBe('closed');
    expect(refusedText({ reason: 'unconfirmed', reopen: false }, true)).toBe(
      'Nothing was changed: tick the box by the warning to say you confirmed it, then approve. The list below is as it is now.',
    );
  });

  it('warns about nothing else', () => {
    for (const verification of ['unchecked', 'verified_local', 'verified_other_group', 'not_found', 'error'] as const) expect(checkWarning({ verification })).toBeUndefined();
  });
});

describe('the queue\'s words (D4)', () => {
  it('names how each person came, never by colour alone', () => {
    expect(ROUTE_TEXT).toEqual({ invite: 'Invited by an officer', signup: 'Signed up on the site', admin_grant: 'Granted by the Admin or the Webmaster' });
  });

  it('says the check\'s outcome in words, with its day when there is one', () => {
    expect(Object.keys(CHECK_TEXT).sort()).toEqual(['duplicate_claim', 'email_mismatch', 'error', 'not_found', 'unchecked', 'verified_local', 'verified_other_group']);
    expect(CHECK_TEXT).toEqual({
      unchecked: 'Not checked yet',
      verified_local: 'Confirmed by the membership verification service',
      verified_other_group: 'Confirmed by the membership verification service as a member of another local group',
      not_found: 'Not confirmed by the membership verification service',
      error: 'The membership verification service could not complete the check',
      email_mismatch: 'Number and last name confirmed by the membership verification service, but the email differs',
      duplicate_claim: 'This membership number was already claimed by another account',
    });
    expect(checkText('verified_local', '2026-11-02')).toBe(`${CHECK_TEXT.verified_local}, on November 2, 2026`);
    expect(checkText('unchecked', undefined)).toBe(CHECK_TEXT.unchecked);
    expect(formatDay('2026-01-31')).toBe('January 31, 2026');
    // A sign-up's moment by the Central calendar: 03:00 UTC on November 2 is still November 1 there.
    expect(formatMoment(new Date('2026-11-02T03:00:00Z'))).toBe('November 1, 2026');
  });

  // SIGNOUT (B): the site names the verifier only as an external membership verification service,
  // never who runs it, where, or how it checks: no list, roster or directory in what anyone reads.
  it('never says how the check is made, in any outcome or warning', () => {
    const words = [...Object.values(CHECK_TEXT), ...(['email_mismatch', 'duplicate_claim'] as const).map((verification) => checkWarning({ verification }) ?? '')];
    for (const text of words) expect(text).not.toMatch(/\blist\b|roster|directory|home|offline/i);
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

  it('REOPEN: names the officer area\'s link to the sign-ups page by what the person may do there', () => {
    expect(signUpsLink(session(['nwfl-users', 'nwfl-membership-approvers']))).toBe('Sign-ups to approve');
    expect(signUpsLink(session(['nwfl-admin']))).toBe('Sign-ups to approve');
    expect(signUpsLink(session(['nwfl-officers', 'nwfl-office-membership', 'nwfl-membership-approvers']))).toBe('Sign-ups to approve');
    expect(signUpsLink(session(['nwfl-officers', 'nwfl-office-membership']))).toBe('Rejected sign-ups to reopen');
    expect(signUpsLink(session(['nwfl-officers', 'nwfl-office-treasurer']))).toBeUndefined();
    expect(signUpsLink(undefined)).toBeUndefined();
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

  it('NOTE-1: tells someone who is not an approver that approving is the approvers\' job, not that the sign-up is their own', () => {
    expect(NOT_AN_APPROVER).toBe('Nothing was changed: only the sign-up approvers can approve or reject a sign-up.');
    expect(refusedText({ reason: 'own', reopen: false }, false)).toBe(NOT_AN_APPROVER);
    expect(refusedText({ reason: 'own', reopen: false }, true)).toBe(DECISION_REFUSED.own);
    expect(refusedText({ reason: 'closed', reopen: false }, false)).toBe(DECISION_REFUSED.closed);
    expect(refusedText({ reason: 'closed', reopen: false }, true)).toBe(DECISION_REFUSED.closed);
    expect(refusedText({ reason: 'own', reopen: true }, false)).toBe(REOPEN_REFUSED.own);
    expect(refusedText({ reason: 'own', reopen: true }, true)).toBe(REOPEN_REFUSED.own);
    expect(refusedText({ reason: 'closed', reopen: true }, true)).toBe(REOPEN_REFUSED.closed);
  });

  it('NOTE-1: names the page by what the person may do there, as the officer area\'s link does', () => {
    expect(signUpsTitle(session(['nwfl-users', 'nwfl-membership-approvers']))).toBe('Sign-ups to approve');
    expect(signUpsTitle(session(['nwfl-admin']))).toBe('Sign-ups to approve');
    expect(signUpsTitle(session(['nwfl-officers', 'nwfl-office-membership']))).toBe('Rejected sign-ups to reopen');
    expect(signUpsTitle(session(['nwfl-officers', 'nwfl-office-treasurer']))).toBe('Sign-ups to approve');
  });

  it('NOTE-4: says when the list of rejections is at its cap of 50, so none is hidden without a word', () => {
    expect(REJECTED_LISTED_MAX).toBe(50);
    expect(rejectedShownNote(0)).toBeUndefined();
    expect(rejectedShownNote(49)).toBeUndefined();
    expect(rejectedShownNote(50)).toBe('Showing the latest 50 rejected sign-ups. Any older ones are not shown here.');
  });

  it('says each refusal in plain words', () => {
    expect(Object.keys(SIGNUP_REFUSED).sort()).toEqual(['invalid', 'on_file', 'profile']);
    expect(Object.keys(DECISION_REFUSED).sort()).toEqual(['closed', 'own', 'unconfirmed']);
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
