// CF-ISO-0: the web reads a chapter's groups (<prefix>officers) as the internal names (nwfl-officers),
// exactly as the API does (apps/api/src/auth/groups.ts), from the same SITE_GROUP_PREFIX.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SITE_GROUP_PREFIX, INTERNAL_GROUP_PREFIX, internalGroups, parseGroupPrefix } from '../groups.mjs';

describe('parseGroupPrefix', () => {
  it('defaults to nwfl-, today\'s names, and keeps the internal names nwfl-', () => {
    expect(DEFAULT_SITE_GROUP_PREFIX).toBe('nwfl-');
    expect(INTERNAL_GROUP_PREFIX).toBe('nwfl-');
    expect(parseGroupPrefix(undefined)).toBe('nwfl-');
  });

  it.each(['nwfl-', 'mensa-nwfl-', 'mensa-nwflorida-', 'm2-', 'mensa-x9-'])('accepts %s', (prefix) => {
    expect(parseGroupPrefix(prefix)).toBe(prefix);
  });

  it.each(['', 'nwfl', 'NWFL-', '-nwfl-', 'mensa--nwfl-', 'mensa nwfl-', 'mensa_nwfl-', 'mensa.nwfl-', '9nwfl-', `${'a'.repeat(32)}-`])('refuses %j', (prefix) => {
    expect(() => parseGroupPrefix(prefix)).toThrow(/SITE_GROUP_PREFIX/);
  });

  it.each(['nwfl-office-', 'mensa-nwfl-role-', 'nwfl-officers-', 'mensa-admin-', 'members-', 'nwfl-membership-', 'x-approvers-', 'webmaster-x-', 'affiliates-'])(
    'refuses %s, which holds a role word',
    (prefix) => {
      expect(() => parseGroupPrefix(prefix)).toThrow(/SITE_GROUP_PREFIX .* role word/);
    },
  );
});

describe('internalGroups', () => {
  it('with the default prefix, keeps today\'s nwfl- groups and drops every other', () => {
    expect(internalGroups(['nwfl-members', 'nwfl-officers', 'fc-admins', 'NWFL-OFFICERS', 'mensa-nwfl-officers', 42], 'nwfl-')).toEqual(['nwfl-members', 'nwfl-officers']);
  });

  it('with mensa-nwfl-, renames its groups and drops a bare nwfl- group and another chapter\'s', () => {
    expect(internalGroups(['mensa-nwfl-members', 'mensa-nwfl-officers', 'nwfl-officers', 'mensa-other-officers', 'mensa-officers'], 'mensa-nwfl-')).toEqual(['nwfl-members', 'nwfl-officers']);
  });
});
