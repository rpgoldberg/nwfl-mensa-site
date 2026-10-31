// @ts-check
// CF-ISO-0: a chapter's group names, from config, to the internal role names.
// The same rule as the API's (apps/api/src/auth/groups.ts), and the two must
// be given the same SITE_GROUP_PREFIX: Authentik names a chapter's groups by
// family and chapter (mensa-nwfl-officers); the session keeps only the groups
// under the prefix, renamed to nwfl-<role>, so the officer and member checks
// stay on the internal names. Every other group is dropped: a bare
// nwfl-officers when the prefix is mensa-nwfl-, and every other chapter's.
// The default, nwfl-, is today's names. A prefix is lowercase words of letters
// and digits joined by single hyphens and closed by one, at most 32 characters,
// at least two words (only the default nwfl- is one), with no role word in it (nwfl-office- would read the default prefix's seat
// group nwfl-office-officers as <prefix>officers).

/** The role groups' names inside the code and the API's SQL. */
export const INTERNAL_GROUP_PREFIX = 'nwfl-';
/** Today's Authentik names, so no env change keeps today's behaviour. */
export const DEFAULT_SITE_GROUP_PREFIX = 'nwfl-';

const PREFIX = /^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*-$/;
const MAX_LENGTH = 32;
const ROLE_WORDS = new Set(['admin', 'webmaster', 'officers', 'members', 'membership', 'approvers', 'affiliates', 'office', 'role']);

/**
 * SITE_GROUP_PREFIX, validated; unset is the default. Throws on a bad value.
 *
 * @param {string | undefined} value
 * @returns {string}
 */
export function parseGroupPrefix(value) {
  if (value === undefined) return DEFAULT_SITE_GROUP_PREFIX;
  if (value.length > MAX_LENGTH || !PREFIX.test(value)) {
    throw new Error(`SITE_GROUP_PREFIX must be lowercase words joined by single hyphens and ending in one, at most ${MAX_LENGTH} characters (e.g. mensa-nwfl-)`);
  }
  const word = value.slice(0, -1).split('-').find((segment) => ROLE_WORDS.has(segment));
  if (word !== undefined) throw new Error(`SITE_GROUP_PREFIX must not contain the role word ${word}: <prefix>officers could then be another prefix's group`);
  // One word (mensa-) would read a whole family's groups (mensa-officers); only today's default is one word.
  if (value !== DEFAULT_SITE_GROUP_PREFIX && value.split('-').length < 3) {
    throw new Error('SITE_GROUP_PREFIX must name a family and a chapter (e.g. mensa-nwfl-); only the default nwfl- is one word');
  }
  return value;
}

/**
 * A token's groups under `prefix`, renamed to the internal names; every other group is dropped.
 *
 * @param {readonly string[]} groups
 * @param {string} prefix
 * @returns {string[]}
 */
export function internalGroups(groups, prefix) {
  return groups.filter((g) => g.startsWith(prefix)).map((g) => INTERNAL_GROUP_PREFIX + g.slice(prefix.length));
}

/**
 * The ID token's groups claim, refused as the API refuses the token (auth/jwt.ts) when it is present
 * and not a list of strings (CF-ISO-0 N3). Absent is no groups.
 *
 * @param {unknown} claim
 * @returns {string[]}
 */
export function groupsClaim(claim) {
  if (claim === undefined) return [];
  if (!Array.isArray(claim) || !claim.every((g) => typeof g === 'string')) throw new Error('malformed groups claim');
  return claim;
}
