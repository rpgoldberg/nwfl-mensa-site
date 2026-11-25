// OFFICER-VERIFY: what a reported local group makes a person, decided when read against the chapter's
// own name (switched on only), and what an approver may then do by hand (fix round 1: switched off,
// neither applies).
import { describe, expect, it } from 'vitest';
import { HandApproval, LocalGroupStanding } from '../gen/nwfl/mensa/v1/membership_pb.js';
import { handApproval, localStanding } from './local-group.js';
import { LOCAL_GROUPS, NO_GROUP } from './local-groups.js';

const CHAPTER = 'Northwest Florida Mensa';

describe('the local group list', () => {
  it('holds the 119 names, the chapter\'s own and "No group assigned" among them, each trimmed', () => {
    expect(LOCAL_GROUPS.size).toBe(119);
    expect(LOCAL_GROUPS.has(CHAPTER)).toBe(true);
    expect(LOCAL_GROUPS.has(NO_GROUP)).toBe(true);
    for (const name of LOCAL_GROUPS) expect(name).toBe(name.trim());
  });
});

describe('localStanding (decided when read)', () => {
  it.each<[string | null, string, string | null, LocalGroupStanding]>([
    [null, 'verified_local', CHAPTER, LocalGroupStanding.UNSPECIFIED],
    [null, 'not_found', CHAPTER, LocalGroupStanding.UNSPECIFIED],
    [null, 'verified_other_group', CHAPTER, LocalGroupStanding.GUEST],
    [CHAPTER, 'verified_local', CHAPTER, LocalGroupStanding.CHAPTER],
    // An other-group match is a guest, whatever group it names.
    [CHAPTER, 'verified_other_group', CHAPTER, LocalGroupStanding.GUEST],
    [CHAPTER, 'email_mismatch', CHAPTER, LocalGroupStanding.CHAPTER],
    ['  Northwest Florida Mensa ', 'verified_local', CHAPTER, LocalGroupStanding.CHAPTER],
    [' Boston Mensa ', 'verified_local', CHAPTER, LocalGroupStanding.GUEST],
    // Fix round 3 (B1): beside an outcome that did not confirm the person, a group says nothing.
    [CHAPTER, 'not_found', CHAPTER, LocalGroupStanding.UNSPECIFIED],
    [CHAPTER, 'error', CHAPTER, LocalGroupStanding.UNSPECIFIED],
    [CHAPTER, 'duplicate_claim', CHAPTER, LocalGroupStanding.UNSPECIFIED],
    [CHAPTER, 'unchecked', CHAPTER, LocalGroupStanding.UNSPECIFIED],
    ['Boston Mensa', 'not_found', CHAPTER, LocalGroupStanding.UNSPECIFIED],
    ['Atlantis Mensa', 'duplicate_claim', CHAPTER, LocalGroupStanding.UNSPECIFIED],
    ['Boston Mensa', 'verified_local', CHAPTER, LocalGroupStanding.GUEST],
    [NO_GROUP, 'verified_local', CHAPTER, LocalGroupStanding.GUEST],
    ['northwest florida mensa', 'verified_local', CHAPTER, LocalGroupStanding.GUEST_UNLISTED],
    ['Atlantis Mensa', 'verified_local', CHAPTER, LocalGroupStanding.GUEST_UNLISTED],
    // A different chapter group setting reads the same rows differently: nothing is fixed.
    [CHAPTER, 'verified_local', 'Boston Mensa', LocalGroupStanding.GUEST],
    ['Boston Mensa', 'verified_local', 'Boston Mensa', LocalGroupStanding.CHAPTER],
    // Switched off: no chapter group, no standing at all.
    [CHAPTER, 'verified_local', null, LocalGroupStanding.UNSPECIFIED],
    ['Boston Mensa', 'verified_other_group', null, LocalGroupStanding.UNSPECIFIED],
  ])('%j (%s) against %j is %s', (group, verification, chapter, standing) => {
    expect(localStanding(group, verification, chapter)).toBe(standing);
  });
});

describe('handApproval', () => {
  const ON = { chapterGroup: CHAPTER };
  const signup = (extra: Partial<Parameters<typeof handApproval>[0]>) => ({ route: 'signup', verification: 'unchecked', firstNameMatched: null, localGroup: null, ...extra });

  it('switched off, says nothing: the rule is as before (an other-group match is not approved as a member)', () => {
    for (const verification of ['unchecked', 'verified_local', 'verified_other_group', 'not_found']) {
      for (const route of ['signup', 'invite']) expect(handApproval(signup({ route, verification, firstNameMatched: false, localGroup: 'Boston Mensa' }), null)).toBe(HandApproval.UNSPECIFIED);
    }
  });

  it.each<[string, Partial<Parameters<typeof handApproval>[0]>, HandApproval]>([
    ['a plain sign-up, unchecked', {}, HandApproval.OPEN],
    ['a plain sign-up, not found', { verification: 'not_found' }, HandApproval.OPEN],
    ['a plain sign-up, a first-name mismatch', { verification: 'verified_local', firstNameMatched: false, localGroup: CHAPTER }, HandApproval.OPEN],
    ['a plain sign-up in another group', { verification: 'verified_local', localGroup: 'Boston Mensa' }, HandApproval.AS_GUEST],
    ['a plain other-group match, no group said', { verification: 'verified_other_group' }, HandApproval.AS_GUEST],
    ['an invited local match', { route: 'invite', verification: 'verified_local', localGroup: CHAPTER }, HandApproval.OPEN],
    ['an invited local match, no group said', { route: 'invite', verification: 'verified_local' }, HandApproval.OPEN],
    ['an invited email mismatch', { route: 'invite', verification: 'email_mismatch', localGroup: CHAPTER }, HandApproval.OPEN],
    ['an invited other-group match', { route: 'invite', verification: 'verified_other_group', localGroup: 'Boston Mensa' }, HandApproval.AS_GUEST],
    ['an invited unchecked sign-up', { route: 'invite' }, HandApproval.NEEDS_CHECK],
    ['an invited not found', { route: 'invite', verification: 'not_found' }, HandApproval.NEEDS_CHECK],
    ['an invited check error', { route: 'invite', verification: 'error' }, HandApproval.NEEDS_CHECK],
    ['an invited duplicate claim', { route: 'invite', verification: 'duplicate_claim' }, HandApproval.NEEDS_CHECK],
    ['an invited first-name mismatch', { route: 'invite', verification: 'verified_local', firstNameMatched: false, localGroup: CHAPTER }, HandApproval.NEEDS_CHECK],
  ])('switched on, %s is %s', (_why, extra, answer) => {
    expect(handApproval(signup(extra), ON)).toBe(answer);
  });
});
