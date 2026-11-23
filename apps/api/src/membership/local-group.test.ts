// OFFICER-VERIFY: what a reported local group makes a person, against the chapter's own name.
import { describe, expect, it } from 'vitest';
import { LocalGroupStanding } from '../gen/nwfl/mensa/v1/membership_pb.js';
import { accountStanding, chapterMemberOf, reportedStanding } from './local-group.js';
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

describe('reportedStanding', () => {
  it.each<[string | null, string | null, LocalGroupStanding]>([
    [null, CHAPTER, LocalGroupStanding.UNSPECIFIED],
    [CHAPTER, CHAPTER, LocalGroupStanding.CHAPTER],
    ['Boston Mensa', CHAPTER, LocalGroupStanding.GUEST],
    [NO_GROUP, CHAPTER, LocalGroupStanding.GUEST],
    ['northwest florida mensa', CHAPTER, LocalGroupStanding.GUEST_UNLISTED],
    ['Atlantis Mensa', CHAPTER, LocalGroupStanding.GUEST_UNLISTED],
    [CHAPTER, null, LocalGroupStanding.GUEST],
  ])('%j against %j is %s', (group, chapter, standing) => {
    expect(reportedStanding(group, chapter)).toBe(standing);
  });
});

describe('accountStanding', () => {
  it.each<[boolean | null, string | null, LocalGroupStanding]>([
    [true, CHAPTER, LocalGroupStanding.CHAPTER],
    [null, null, LocalGroupStanding.UNSPECIFIED],
    [false, 'Boston Mensa', LocalGroupStanding.GUEST],
    [false, null, LocalGroupStanding.GUEST],
    [false, 'Atlantis Mensa', LocalGroupStanding.GUEST_UNLISTED],
  ])('chapter_member %s with %j is %s', (chapter, group, standing) => {
    expect(accountStanding(chapter, group)).toBe(standing);
  });
});

describe('chapterMemberOf', () => {
  it.each<[string, string | null, string | null, boolean | null]>([
    ['verified_local', CHAPTER, CHAPTER, true],
    ['verified_local', 'Boston Mensa', CHAPTER, false],
    ['verified_other_group', CHAPTER, CHAPTER, true],
    ['verified_other_group', null, CHAPTER, false],
    ['verified_local', null, CHAPTER, null],
    ['not_found', null, CHAPTER, null],
    ['verified_local', CHAPTER, null, false],
  ])('%s reporting %j against %j: %s', (verification, group, chapter, member) => {
    expect(chapterMemberOf(verification, group, chapter)).toBe(member);
  });
});
