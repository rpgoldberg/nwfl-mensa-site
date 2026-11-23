// Member standing from member_account (AC6 b): the database decides who reads
// at member level, not the groups in a token that can be a month old.
// A member or an affiliate reads at member level while verified within the
// last 13 months; unverified for longer, either falls back to public (R24;
// STACK-FIX ruling: affiliates lapse like members). OFFICER-VERIFY: a member is
// a chapter member, a guest member or unconfirmed by member_account.chapter_member.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbStanding } from '../../src/auth/standing.js';
import { APP, APP_PW, dropDatabase, freshDatabase, live, migrate, urlFor, testPool } from '../helpers/pg.js';

describe.skipIf(!live)('dbStanding', () => {
  let db: string;
  let pool: pg.Pool;
  const today = new Date('2026-10-22T15:00:00Z');

  beforeAll(async () => {
    db = await freshDatabase('nwfl_standing');
    const run = await migrate(db);
    if (run.code !== 0) throw new Error(run.stderr);
    pool = testPool({ connectionString: urlFor(APP, APP_PW, db) });
    const insert = (sub: string, status: string, verifiedOn: string | null, chapter: boolean | null = null): Promise<unknown> =>
      pool.query(
        `INSERT INTO member_account (sub, status, route, approved_by_sub, approved_at, verified_on, affiliate_granted_by_sub, affiliate_granted_at, removed_at, chapter_member)
         VALUES ($1, $2, 'signup', $3, $4, $5::date, $6, $7, $8, $9)`,
        [
          sub,
          status,
          status === 'member' ? 'sub-approver' : null,
          status === 'member' ? today : null,
          verifiedOn,
          status === 'affiliate' ? 'sub-admin' : null,
          status === 'affiliate' ? today : null,
          status === 'removed' ? today : null,
          chapter,
        ],
      );
    await insert('current', 'member', '2026-10-01');
    await insert('chapter', 'member', '2026-10-01', true);
    await insert('guest', 'member', '2026-10-01', false);
    await insert('chapter-just-over', 'member', '2025-09-21', true);
    await insert('guest-just-over', 'member', '2025-09-21', false);
    await insert('lapsed-chapter', 'lapsed', '2026-10-01', true);
    await insert('thirteen-months', 'member', '2025-09-22');
    await insert('just-over', 'member', '2025-09-21');
    await insert('affiliate', 'affiliate', '2026-10-01');
    await insert('affiliate-never-verified', 'affiliate', null);
    await insert('affiliate-2020', 'affiliate', '2020-01-01');
    await insert('affiliate-just-over', 'affiliate', '2025-09-21');
    await insert('pending', 'pending', null);
    await insert('lapsed', 'lapsed', '2026-10-01');
    await insert('removed', 'removed', '2026-10-01');
    await pool.query(
      `INSERT INTO member_account (sub, status, route, approved_by_sub, approved_at, verified_on) VALUES ('verified-today', 'member', 'invite', 'sub-approver', now(), current_date)`,
    );
  });

  afterAll(async () => {
    await pool?.end();
    if (db !== undefined) await dropDatabase(db);
  });

  it('reads today from the real clock by default', async () => {
    expect(await dbStanding(pool).standingOf('verified-today')).toBe('unconfirmed');
  });

  it.each([
    ['current', 'unconfirmed'],
    ['thirteen-months', 'unconfirmed'],
    ['just-over', 'none'],
    ['chapter', 'chapter'],
    ['guest', 'guest'],
    ['chapter-just-over', 'none'],
    ['guest-just-over', 'none'],
    ['lapsed-chapter', 'none'],
    ['affiliate', 'affiliate'],
    ['affiliate-never-verified', 'none'],
    ['affiliate-2020', 'none'],
    ['affiliate-just-over', 'none'],
    ['pending', 'none'],
    ['lapsed', 'none'],
    ['removed', 'none'],
    ['no-account', 'none'],
  ])('%s stands as %s', async (subject, expected) => {
    expect(await dbStanding(pool, () => today).standingOf(subject)).toBe(expected);
  });
});
