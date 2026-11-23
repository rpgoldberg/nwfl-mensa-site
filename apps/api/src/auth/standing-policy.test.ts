// OFFICER-VERIFY: what each kind of standing allows. Guests (members of another local group, or of none)
// follow ONE policy, guestPolicy(). Ross decided it 11-23 (desk GUEST): "public pages and events only,
// ability to create/submit an article, and officer tools if admin grants": guests read as the public
// except events, which they read as members do (one flag, being confirmed with Ross); they hold no
// officer power (an Admin's affiliate grant gives it); they may submit an article (MEMBER-SUBMIT, unused yet).
import { describe, expect, it } from 'vitest';
import { type StandingKind, canSubmitArticle, guestPolicy, holdsOfficerPower, readsAsMember, readsEventsAsMember } from './standing-policy.js';

describe('the standing policy', () => {
  it('is Ross\'s GUEST ruling for guests', () => {
    expect(guestPolicy()).toEqual({ readsAsMember: false, eventsAsMember: true, officerPower: false, canSubmitArticle: true });
  });

  it.each<[StandingKind, boolean, boolean, boolean, boolean]>([
    ['chapter', true, true, true, true],
    ['affiliate', true, true, true, false],
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
});
