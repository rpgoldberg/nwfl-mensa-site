// Member standing from member_account (AC6 b): the database decides who reads
// at member level, not the groups in a token that can be a month old.
// A member or an affiliate reads at member level while verified within the
// last 13 months; unverified for longer, either falls back to public (R24;
// STACK-FIX ruling: affiliates lapse like members).
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
    const insert = (sub: string, status: string, verifiedOn: string | null): Promise<unknown> =>
      pool.query(
        `INSERT INTO member_account (sub, status, route, approved_by_sub, approved_at, verified_on, affiliate_granted_by_sub, affiliate_granted_at, removed_at)
         VALUES ($1, $2, 'signup', $3, $4, $5::date, $6, $7, $8)`,
        [
          sub,
          status,
          status === 'member' ? 'sub-approver' : null,
          status === 'member' ? today : null,
          verifiedOn,
          status === 'affiliate' ? 'sub-admin' : null,
          status === 'affiliate' ? today : null,
          status === 'removed' ? today : null,
        ],
      );
    await insert('current', 'member', '2026-10-01');
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
    expect(await dbStanding(pool).isMember('verified-today')).toBe(true);
  });

  it.each([
    ['current', true],
    ['thirteen-months', true],
    ['just-over', false],
    ['affiliate', true],
    ['affiliate-never-verified', false],
    ['affiliate-2020', false],
    ['affiliate-just-over', false],
    ['pending', false],
    ['lapsed', false],
    ['removed', false],
    ['no-account', false],
  ])('%s reads at member level: %s', async (subject, expected) => {
    expect(await dbStanding(pool, () => today).isMember(subject)).toBe(expected);
  });
});
