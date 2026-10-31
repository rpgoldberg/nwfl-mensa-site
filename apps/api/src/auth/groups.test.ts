// CF-ISO-0: a chapter's Authentik groups (<prefix>officers, e.g. mensa-nwfl-officers) map to the
// internal role groups the code and SQL use (nwfl-officers). The prefix comes from config
// (SITE_GROUP_PREFIX), nwfl- by default, so today's tokens keep today's roles.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SITE_GROUP_PREFIX, INTERNAL_GROUP_PREFIX, internalGroups, parseGroupPrefix } from './groups.js';

describe('parseGroupPrefix', () => {
  it('defaults to nwfl-, today\'s group names, and keeps the internal names nwfl-', () => {
    expect(DEFAULT_SITE_GROUP_PREFIX).toBe('nwfl-');
    expect(INTERNAL_GROUP_PREFIX).toBe('nwfl-');
    expect(parseGroupPrefix(undefined)).toBe('nwfl-');
  });

  it.each(['nwfl-', 'mensa-nwfl-', 'mensa-nwflorida-', 'm2-x-', 'mensa-x9-'])('accepts %s', (prefix) => {
    expect(parseGroupPrefix(prefix)).toBe(prefix);
  });

  it.each([
    ['', 'empty: every group would count'],
    ['nwfl', 'no closing hyphen: nwflofficers'],
    ['NWFL-', 'upper case'],
    ['-nwfl-', 'a leading hyphen'],
    ['mensa--nwfl-', 'an empty segment'],
    ['mensa nwfl-', 'a space'],
    ['mensa_nwfl-', 'an underscore'],
    ['mensa.nwfl-', 'a dot'],
    ['9nwfl-', 'a leading digit'],
    [`${'a'.repeat(32)}-`, 'longer than 32'],
  ])('refuses %j (%s)', (prefix) => {
    expect(() => parseGroupPrefix(prefix)).toThrow(/SITE_GROUP_PREFIX/);
  });

  it.each(['nwfl-office-', 'mensa-nwfl-role-', 'nwfl-officers-', 'mensa-admin-', 'members-', 'nwfl-membership-', 'x-approvers-', 'webmaster-x-', 'affiliates-'])(
    'refuses %s: a role word in the prefix would let another prefix\'s group read as <prefix>officers',
    (prefix) => {
      expect(() => parseGroupPrefix(prefix)).toThrow(/SITE_GROUP_PREFIX .* role word/);
    },
  );
});

describe('parseGroupPrefix: a family and a chapter (CF-ISO-0 N5)', () => {
  it.each(['mensa-', 'fc-', 'm2-', 'chapter-'])('refuses the one-word prefix %s, which would read a whole family\'s groups', (prefix) => {
    expect(() => parseGroupPrefix(prefix)).toThrow('SITE_GROUP_PREFIX must name a family and a chapter (e.g. mensa-nwfl-); only the default nwfl- is one word');
  });
});

describe('internalGroups', () => {
  const ALL = ['admin', 'webmaster', 'officers', 'membership-approvers', 'affiliates', 'members', 'office-treasurer', 'role-rvc'];

  it('with the default prefix, keeps today\'s nwfl- groups as they are and drops every other', () => {
    expect(internalGroups(['nwfl-members', 'nwfl-officers', 'fc-admins', 'officers', 'NWFL-OFFICERS', 'mensa-nwfl-officers'], 'nwfl-')).toEqual(['nwfl-members', 'nwfl-officers']);
  });

  it('with mensa-nwfl-, maps every role group to its internal name', () => {
    expect(internalGroups(ALL.map((g) => `mensa-nwfl-${g}`), 'mensa-nwfl-')).toEqual(ALL.map((g) => `nwfl-${g}`));
  });

  it('with mensa-nwfl-, a bare nwfl- group and another chapter\'s groups grant nothing', () => {
    expect(internalGroups(['nwfl-officers', 'nwfl-admin', 'mensa-other-officers', 'mensa-other-admin', 'mensa-officers', 'xmensa-nwfl-officers'], 'mensa-nwfl-')).toEqual([]);
  });
});
