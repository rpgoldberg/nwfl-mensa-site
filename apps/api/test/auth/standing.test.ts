// Member standing from member_account (AC6 b): the database decides who reads
// at member level, not the groups in a token that can be a month old.
// A member or an affiliate reads at member level while verified within the
// last 13 months; unverified for longer, either falls back to public (R24;
// STACK-FIX ruling: affiliates lapse like members). OFFICER-VERIFY (fix round 1):
// a member is a chapter member or a guest member by the local group its
// approved sign-up's check reported, compared when read with the chapter's own
// (CHAPTER_GROUP_NAME, switched on only); with none (switched off), unconfirmed.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbStanding } from '../../src/auth/standing.js';
import { APP, APP_PW, dropDatabase, freshDatabase, live, migrate, urlFor, testPool } from '../helpers/pg.js';
import { type Seeded, seedAccount } from '../helpers/standing.js';

const CHAPTER = 'Northwest Florida Mensa';

describe.skipIf(!live)('dbStanding', () => {
  let db: string;
  let pool: pg.Pool;
  const today = new Date('2026-10-22T15:00:00Z');

  beforeAll(async () => {
    db = await freshDatabase('nwfl_standing');
    const run = await migrate(db);
    if (run.code !== 0) throw new Error(run.stderr);
    pool = testPool({ connectionString: urlFor(APP, APP_PW, db) });
    const at = (sub: string, status: Seeded['status'], verifiedOn: string | null, check?: Seeded['check']): Promise<void> =>
      seedAccount(pool, { sub, status, verifiedOn, ...(check === undefined ? {} : { check }) });
    await at('current', 'member', '2026-10-01');
    await at('chapter', 'member', '2026-10-01', { localGroup: CHAPTER });
    await at('guest', 'member', '2026-10-01', { localGroup: 'Boston Mensa' });
    await at('guest-unlisted', 'member', '2026-10-01', { localGroup: 'Atlantis Mensa' });
    await at('other-group-unsaid', 'member', '2026-10-01', { verification: 'verified_other_group' });
    await at('checked-unsaid', 'member', '2026-10-01', { verification: 'verified_local' });
    await at('chapter-just-over', 'member', '2025-09-21', { localGroup: CHAPTER });
    await at('guest-just-over', 'member', '2025-09-21', { localGroup: 'Boston Mensa' });
    await at('lapsed-chapter', 'lapsed', '2026-10-01', { localGroup: CHAPTER });
    await at('thirteen-months', 'member', '2025-09-22');
    await at('just-over', 'member', '2025-09-21');
    await at('affiliate', 'affiliate', '2026-10-01');
    await at('affiliate-guest', 'affiliate', '2026-10-01', { localGroup: 'Boston Mensa' });
    await at('affiliate-never-verified', 'affiliate', null);
    await at('affiliate-2020', 'affiliate', '2020-01-01');
    await at('affiliate-just-over', 'affiliate', '2025-09-21');
    await at('pending', 'pending', null);
    await at('lapsed', 'lapsed', '2026-10-01');
    await at('removed', 'removed', '2026-10-01');
    await pool.query(
      `INSERT INTO member_account (sub, status, route, approved_by_sub, approved_at, verified_on) VALUES ('verified-today', 'member', 'invite', 'sub-approver', now(), current_date)`,
    );
  });

  afterAll(async () => {
    await pool?.end();
    if (db !== undefined) await dropDatabase(db);
  });

  it('reads today from the real clock, and no chapter group, by default', async () => {
    expect(await dbStanding(pool).standingOf('verified-today')).toBe('unconfirmed');
    expect(await dbStanding(pool).standingOf('chapter')).toBe('unconfirmed');
  });

  it.each([
    ['current', 'unconfirmed'],
    ['thirteen-months', 'unconfirmed'],
    ['just-over', 'none'],
    ['chapter', 'chapter'],
    ['guest', 'guest'],
    ['guest-unlisted', 'guest'],
    ['other-group-unsaid', 'guest'],
    ['checked-unsaid', 'unconfirmed'],
    ['chapter-just-over', 'none'],
    ['guest-just-over', 'none'],
    ['lapsed-chapter', 'none'],
    ['affiliate', 'affiliate'],
    ['affiliate-guest', 'affiliate'],
    ['affiliate-never-verified', 'none'],
    ['affiliate-2020', 'none'],
    ['affiliate-just-over', 'none'],
    ['pending', 'none'],
    ['lapsed', 'none'],
    ['removed', 'none'],
    ['no-account', 'none'],
  ])('switched on (the chapter\'s group named), %s stands as %s', async (subject, expected) => {
    expect(await dbStanding(pool, () => today, CHAPTER).standingOf(subject)).toBe(expected);
  });

  // Fix round 1: no chapter group in use (switched off) means no chapter and no guest: what was reported is kept
  // as reported, never turned into a standing.
  it.each([
    ['chapter', 'unconfirmed'],
    ['guest', 'unconfirmed'],
    ['other-group-unsaid', 'unconfirmed'],
    ['affiliate-guest', 'affiliate'],
    ['just-over', 'none'],
  ])('with no chapter group, %s stands as %s', async (subject, expected) => {
    expect(await dbStanding(pool, () => today, null).standingOf(subject)).toBe(expected);
  });

  // Fix round 1: decided when read, so a wrong CHAPTER_GROUP_NAME fixes no one as a guest for good: correct it,
  // and the same rows read right.
  it('decides chapter or guest when read: a wrong chapter group and then the right one', async () => {
    const wrong = dbStanding(pool, () => today, 'Boston Mensa');
    expect([await wrong.standingOf('chapter'), await wrong.standingOf('guest')]).toEqual(['guest', 'chapter']);
    const right = dbStanding(pool, () => today, CHAPTER);
    expect([await right.standingOf('chapter'), await right.standingOf('guest')]).toEqual(['chapter', 'guest']);
  });
});
