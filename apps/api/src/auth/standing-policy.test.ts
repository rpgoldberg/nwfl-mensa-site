// OFFICER-VERIFY: what each kind of standing allows. Guests (members of another local group, or of none)
// follow ONE policy, guestPolicy(). Ross decided it 11-23 (desk GUEST): "public pages and events only,
// ability to create/submit an article, and officer tools if admin grants": guests read as the public
// except events, which they read as members do (one flag, being confirmed with Ross); they hold no
// officer power (an Admin's affiliate grant gives it); they may submit an article (MEMBER-SUBMIT, unused yet).
import { describe, expect, it } from 'vitest';
import {
  type MembershipCheck,
  type StandingKind,
  canSubmitArticle,
  confirmsMember,
  fullyChecked,
  groupStanding,
  guestPolicy,
  holdsOfficerPower,
  readsAsMember,
  readsEventsAsMember,
  standingKind,
} from './standing-policy.js';

const CHAPTER = 'Northwest Florida Mensa';
const check = (verification: string | null, firstNameMatched: boolean | null = null, localGroup: string | null = null): MembershipCheck => ({ verification, firstNameMatched, localGroup });

describe('the standing policy', () => {
  it('is Ross\'s GUEST ruling for guests', () => {
    expect(guestPolicy()).toEqual({ readsAsMember: false, eventsAsMember: true, officerPower: false, canSubmitArticle: true });
  });

  it.each<[StandingKind, boolean, boolean, boolean, boolean]>([
    ['chapter', true, true, true, true],
    // Fix round 3 (S1): the same standing with the first name not confirmed reads the same and holds no power.
    ['chapter_partial', true, true, false, true],
    ['affiliate', true, true, true, false],
    ['affiliate_partial', true, true, false, false],
    ['unconfirmed', true, true, false, false],
    ['guest', false, true, false, true],
    ['none', false, false, false, false],
  ])('%s: reads as a member %s, reads events as a member %s, holds officer power %s, may submit an article %s', (kind, reads, events, power, submit) => {
    expect(readsAsMember(kind)).toBe(reads);
    expect(readsEventsAsMember(kind)).toBe(events);
    expect(holdsOfficerPower(kind)).toBe(power);
    expect(canSubmitArticle(kind)).toBe(submit);
  });

  it('applies the guest policy it is given, and only to guests', () => {
    const closed = { readsAsMember: false, eventsAsMember: false, officerPower: false, canSubmitArticle: false };
    const open = { readsAsMember: true, eventsAsMember: true, officerPower: true, canSubmitArticle: true };
    expect(readsEventsAsMember('guest', closed)).toBe(false);
    expect(canSubmitArticle('guest', closed)).toBe(false);
    expect(readsAsMember('guest', open)).toBe(true);
    expect(readsEventsAsMember('guest', open)).toBe(true);
    expect(holdsOfficerPower('guest', open)).toBe(true);
    expect(readsAsMember('chapter', closed)).toBe(true);
    expect(holdsOfficerPower('unconfirmed', open)).toBe(false);
    expect(canSubmitArticle('unconfirmed', open)).toBe(false);
  });

  it('holds no power for a partial standing, whatever the guest policy', () => {
    const open = { readsAsMember: true, eventsAsMember: true, officerPower: true, canSubmitArticle: true };
    expect(holdsOfficerPower('chapter_partial', open)).toBe(false);
    expect(holdsOfficerPower('affiliate_partial', open)).toBe(false);
  });
});

// Fix round 3: the one rule the caller gate, the queue, the account page and the grant all read.
describe('what a membership check makes a person', () => {
  it.each<[string | null, boolean]>([
    ['verified_local', true],
    ['verified_other_group', true],
    ['email_mismatch', true],
    ['not_found', false],
    ['error', false],
    ['duplicate_claim', false],
    ['unchecked', false],
    ['VERIFIED_LOCAL', false],
    ['', false],
    [null, false],
  ])('an outcome of %j confirms the person: %s', (verification, confirms) => {
    expect(confirmsMember(verification)).toBe(confirms);
  });

  it.each<[string, MembershipCheck, boolean]>([
    ['a local match, first name confirmed', check('verified_local', true), true],
    ['an other-group match, first name confirmed', check('verified_other_group', true), true],
    ['an email mismatch, first name confirmed', check('email_mismatch', true), true],
    ['a local match, first name not matched', check('verified_local', false), false],
    ['a local match, no first-name answer', check('verified_local', null), false],
    ['not found, with a first-name answer', check('not_found', true), false],
    ['a duplicate claim, with a first-name answer', check('duplicate_claim', true), false],
    ['no sign-up', check(null, null), false],
  ])('%s is a full check: %s', (_what, facts, full) => {
    expect(fullyChecked(facts)).toBe(full);
  });

  it.each<[string, MembershipCheck, 'chapter' | 'guest' | 'unreported']>([
    ['a local match in the chapter\'s group', check('verified_local', null, CHAPTER), 'chapter'],
    ['an email mismatch in the chapter\'s group', check('email_mismatch', null, CHAPTER), 'chapter'],
    ['the chapter\'s group with spaces around it', check('verified_local', null, `  ${CHAPTER}\t`), 'chapter'],
    // S3: exact, after trimming.
    ['the chapter\'s name in lower case', check('verified_local', null, CHAPTER.toLowerCase()), 'guest'],
    ['the chapter\'s name in upper case', check('verified_local', null, CHAPTER.toUpperCase()), 'guest'],
    ['the chapter\'s name with a space doubled inside', check('verified_local', null, 'Northwest  Florida Mensa'), 'guest'],
    ['the chapter\'s name and more', check('verified_local', null, `${CHAPTER} East`), 'guest'],
    ['another group', check('verified_local', null, 'Boston Mensa'), 'guest'],
    ['an other-group match that named none', check('verified_other_group'), 'guest'],
    ['an other-group match that named the chapter', check('verified_other_group', null, CHAPTER), 'guest'],
    ['a local match that named none', check('verified_local'), 'unreported'],
    ['a local match that named only spaces', check('verified_local', null, '   '), 'unreported'],
    // B1: a check that did not confirm the person says nothing, whatever group rode with it.
    ['not found, with the chapter\'s group', check('not_found', null, CHAPTER), 'unreported'],
    ['an error, with the chapter\'s group', check('error', true, CHAPTER), 'unreported'],
    ['a duplicate claim, with the chapter\'s group', check('duplicate_claim', true, CHAPTER), 'unreported'],
    ['unchecked, with the chapter\'s group', check('unchecked', null, CHAPTER), 'unreported'],
    ['not found, with another group', check('not_found', null, 'Boston Mensa'), 'unreported'],
    ['no sign-up', check(null), 'unreported'],
  ])('%s is %s', (_what, facts, standing) => {
    expect(groupStanding(facts, CHAPTER)).toBe(standing);
  });

  const member = { live: true, affiliate: false };
  const affiliate = { live: true, affiliate: true };
  it.each<[string, { live: boolean; affiliate: boolean }, MembershipCheck, StandingKind]>([
    ['a full check in the chapter\'s group', member, check('verified_local', true, CHAPTER), 'chapter'],
    ['an email mismatch, first name confirmed, in the chapter\'s group', member, check('email_mismatch', true, CHAPTER), 'chapter'],
    ['the chapter\'s group, first name not matched', member, check('verified_local', false, CHAPTER), 'chapter_partial'],
    ['the chapter\'s group, no first-name answer', member, check('verified_local', null, CHAPTER), 'chapter_partial'],
    ['another group', member, check('verified_local', true, 'Boston Mensa'), 'guest'],
    ['an other-group match', member, check('verified_other_group', true), 'guest'],
    ['a local match that named no group', member, check('verified_local', true), 'unconfirmed'],
    ['not found with the chapter\'s group and a first-name answer (B1)', member, check('not_found', true, CHAPTER), 'unconfirmed'],
    ['a duplicate claim with the chapter\'s group (B1)', member, check('duplicate_claim', true, CHAPTER), 'unconfirmed'],
    ['no sign-up', member, check(null), 'unconfirmed'],
    ['an affiliate with a full check', affiliate, check('verified_other_group', true, 'Boston Mensa'), 'affiliate'],
    // Fix round 5 (S6, G2b/G2c): an affiliate whose check names the chapter's own group stands as the chapter's own.
    ['an affiliate with a full check in the chapter\'s group', affiliate, check('verified_local', true, CHAPTER), 'chapter'],
    ['an affiliate in the chapter\'s group, first name not matched', affiliate, check('verified_local', false, CHAPTER), 'chapter_partial'],
    ['an affiliate whose email mismatch an approver confirmed in the chapter\'s group', affiliate, check('email_mismatch', true, ` ${CHAPTER} `), 'chapter'],
    ['an affiliate with the chapter\'s name in lower case (exact compare)', affiliate, check('verified_local', true, CHAPTER.toLowerCase()), 'affiliate'],
    ['an affiliate whose first name was not confirmed', affiliate, check('verified_other_group', null, 'Boston Mensa'), 'affiliate_partial'],
    ['an affiliate the check did not confirm', affiliate, check('not_found', true, CHAPTER), 'affiliate_partial'],
    ['an affiliate with no sign-up', affiliate, check(null), 'affiliate_partial'],
    ['a full check on an account with no live standing', { live: false, affiliate: false }, check('verified_local', true, CHAPTER), 'none'],
    ['an affiliate with no live standing', { live: false, affiliate: true }, check('verified_other_group', true), 'none'],
  ])('switched on, %s stands as %s', (_what, account, facts, kind) => {
    expect(standingKind(account, facts, CHAPTER)).toBe(kind);
  });

  it('switched off (no chapter group), reads no check at all: a member is unconfirmed and an affiliate an affiliate, as before', () => {
    for (const facts of [check('verified_local', true, CHAPTER), check('verified_other_group', true, 'Boston Mensa'), check('not_found'), check(null)]) {
      expect(standingKind(member, facts, null)).toBe('unconfirmed');
      expect(standingKind(affiliate, facts, null)).toBe('affiliate');
      expect(standingKind({ live: false, affiliate: true }, facts, null)).toBe('none');
    }
  });
});
