// OFFICER-VERIFY (0032): the database's side, exercised as the APPLICATION role.
//   - signup_request.first_name_matched: whether the membership check confirmed the typed first name;
//     NULL until a report, and NULL when the report did not say (a check that does not compare it yet).
//   - signup_request.local_group: the local group the check reported, the one value the site keeps from
//     the membership records (Ross 11-23); 1 to 120 characters, no control character.
//   - Both are written with the report only: never on an unchecked sign-up, and never changed after.
//   - member_account.chapter_member: whether the approved account's local group is this chapter's;
//     NULL when no group was reported.
// Every subject here is made up.
import type pg from 'pg';
import pgLib from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP, APP_PW, dropDatabase, freshDatabase, live, migrate, sqlstate, urlFor } from '../helpers/pg.js';

const CHECK_VIOLATION = '23514';
const NOT_IN_PREREQUISITE_STATE = '55000';

describe.skipIf(!live)('schema after OFFICER-VERIFY (0032)', () => {
  let db: string;
  let app: pg.Client;

  const signup = async (sub: string): Promise<string> => {
    const { rows } = await app.query<{ id: string }>(
      `INSERT INTO signup_request (sub, display_name, email, first_name, last_name, membership_number) VALUES ($1, 'Pat Example', 'pat@example.org', 'Pat', 'Example', '1234567') RETURNING id`,
      [sub],
    );
    return (rows[0] as { id: string }).id;
  };
  const report = (id: string, matched: boolean | null, group: string | null): Promise<string> =>
    sqlstate(app, `UPDATE signup_request SET verification = 'verified_local', verified_on = current_date, first_name_matched = $2, local_group = $3 WHERE id = $1`, [
      id,
      matched,
      group,
    ]);

  beforeAll(async () => {
    db = await freshDatabase('nwfl_ov0032');
    const run = await migrate(db);
    if (run.code !== 0) throw new Error(`migrate failed: ${run.stderr}`);
    app = new pgLib.Client({ connectionString: urlFor(APP, APP_PW, db) });
    await app.connect();
  });

  afterAll(async () => {
    await app?.end();
    if (db !== undefined) await dropDatabase(db);
  });

  it('takes the first-name answer and the local group with the report, and NULL for a report that does not say', async () => {
    expect(await report(await signup('ov-a'), true, 'Northwest Florida Mensa')).toBe('ok');
    expect(await report(await signup('ov-b'), false, 'No group assigned')).toBe('ok');
    expect(await report(await signup('ov-c'), null, null)).toBe('ok');
  });

  it('refuses either on a sign-up the check has not reported on', async () => {
    const id = await signup('ov-unchecked');
    expect(await sqlstate(app, `UPDATE signup_request SET first_name_matched = true WHERE id = $1`, [id])).toBe(CHECK_VIOLATION);
    expect(await sqlstate(app, `UPDATE signup_request SET local_group = 'Boston Mensa' WHERE id = $1`, [id])).toBe(CHECK_VIOLATION);
  });

  it.each([
    ['empty', ''],
    ['too long', 'M'.repeat(121)],
    ['a control character', 'Boston\nMensa'],
  ])('refuses a local group that is %s', async (_why, group) => {
    expect(await report(await signup(`ov-bad-${_why.replace(/ /g, '-')}`), true, group)).toBe(CHECK_VIOLATION);
  });

  it('never changes either once reported, pending or decided', async () => {
    const id = await signup('ov-frozen');
    expect(await report(id, true, 'Northwest Florida Mensa')).toBe('ok');
    expect(await sqlstate(app, `UPDATE signup_request SET first_name_matched = false WHERE id = $1`, [id])).toBe(NOT_IN_PREREQUISITE_STATE);
    expect(await sqlstate(app, `UPDATE signup_request SET local_group = 'Boston Mensa' WHERE id = $1`, [id])).toBe(NOT_IN_PREREQUISITE_STATE);
    expect(await sqlstate(app, `UPDATE signup_request SET decision = 'approved', decided_at = now(), decided_by_sub = 'sub-x' WHERE id = $1`, [id])).toBe('ok');
    expect(await sqlstate(app, `UPDATE signup_request SET local_group = NULL WHERE id = $1`, [id])).toBe(NOT_IN_PREREQUISITE_STATE);
  });

  it('keeps chapter_member on the account: true, false, or NULL when no group was reported', async () => {
    for (const [sub, chapter] of [
      ['ov-chapter', true],
      ['ov-guest', false],
      ['ov-unconfirmed', null],
    ] as const) {
      expect(
        await sqlstate(
          app,
          `INSERT INTO member_account (sub, status, route, approved_by_sub, approved_at, verified_on, chapter_member) VALUES ($1, 'member', 'invite', 'sub-x', now(), current_date, $2)`,
          [sub, chapter],
        ),
      ).toBe('ok');
    }
    const { rows } = await app.query<{ sub: string; chapter_member: boolean | null }>(`SELECT sub, chapter_member FROM member_account WHERE sub LIKE 'ov-%' ORDER BY sub`);
    expect(rows).toEqual([
      { sub: 'ov-chapter', chapter_member: true },
      { sub: 'ov-guest', chapter_member: false },
      { sub: 'ov-unconfirmed', chapter_member: null },
    ]);
  });
});
