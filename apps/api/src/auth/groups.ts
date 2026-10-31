// ============================================================================
// CF-ISO-0: a chapter's group names, from config, to the internal role names.
//
// Authentik names a chapter's groups by family and chapter (mensa-nwfl-
// officers); the code (auth/roles.ts, caller.ts) and the SQL (0014-0020 check
// 'nwfl-officers') use the internal names, nwfl-<role>, which never change.
// The one place a token's groups enter, caller.ts establish(), keeps only the
// groups under this deployment's prefix, SITE_GROUP_PREFIX, and renames each
// <prefix><role> to nwfl-<role>. Every other group is dropped: a bare
// nwfl-officers when the prefix is mensa-nwfl-, and every other chapter's.
//
// The default, nwfl-, is today's names, so an unchanged deployment behaves as
// before. The web (apps/web server/groups.mjs) maps the same way and must be
// given the same SITE_GROUP_PREFIX.
//
// A prefix is checked at startup, strictly: lowercase segments of letters and
// digits, each starting with a letter, joined by single hyphens and closed by
// one, at most 32 characters. No segment may be a role word (office, role,
// officers, admin...): with nwfl-office- as the prefix, the default prefix's
// seat group nwfl-office-officers would read as <prefix>officers.
// ============================================================================

/** The role groups' names inside the code and the SQL. */
export const INTERNAL_GROUP_PREFIX = 'nwfl-';
/** Today's Authentik names, so no env change keeps today's behaviour. */
export const DEFAULT_SITE_GROUP_PREFIX = 'nwfl-';

const PREFIX = /^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*-$/;
const MAX_LENGTH = 32;
const ROLE_WORDS = new Set(['admin', 'webmaster', 'officers', 'members', 'membership', 'approvers', 'affiliates', 'office', 'role']);

/** SITE_GROUP_PREFIX, validated; unset is the default. Throws, so a bad value refuses to start. */
export function parseGroupPrefix(value: string | undefined): string {
  if (value === undefined) return DEFAULT_SITE_GROUP_PREFIX;
  if (value.length > MAX_LENGTH || !PREFIX.test(value)) {
    throw new Error(`SITE_GROUP_PREFIX must be lowercase words joined by single hyphens and ending in one, at most ${MAX_LENGTH} characters (e.g. mensa-nwfl-)`);
  }
  const word = value.slice(0, -1).split('-').find((segment) => ROLE_WORDS.has(segment));
  if (word !== undefined) throw new Error(`SITE_GROUP_PREFIX must not contain the role word ${word}: <prefix>officers could then be another prefix's group`);
  return value;
}

/** A token's groups under `prefix`, renamed to the internal names; every other group is dropped. */
export function internalGroups(groups: readonly string[], prefix: string): string[] {
  return groups.filter((group) => group.startsWith(prefix)).map((group) => INTERNAL_GROUP_PREFIX + group.slice(prefix.length));
}
