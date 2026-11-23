// OFFICER-VERIFY (0032): the database's side, exercised as the APPLICATION role.
//   - signup_request.first_name_matched: whether the membership check confirmed the typed first name;
//     NULL until a report, and NULL when the report did not say (a check that does not compare it yet).
//   - signup_request.local_group: the local group the check reported, the one value the site keeps from
//     the membership records (Ross 11-23); 1 to 120 characters, no control character.
//   - Both are written with the report only: never on an unchecked sign-up, and never changed after.
//   - Fix round 3 (B1): both only beside an outcome that confirmed the number and the last name; with not
//     found, an error or a duplicate claim the database refuses them.
//   - Fix round 3: the outcome is as final as the two answers, with one way round: a fresh check the
//     approved member asked for (recheck_requested_at) may answer again; a failed one is noted
//     (recheck_outcome) beside the earlier answers. Both only on an approved sign-up.
//   - Nothing derived is stored (fix round 1): member_account has no chapter or guest column; the
//     standing is decided when read, from the reported group (auth/standing.ts).
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

  // Fix round 3, B1: a check that did not confirm the person says nothing about their first name or their group.
  it.each(['not_found', 'error', 'duplicate_claim'])('refuses either beside a %s outcome, and takes that outcome with neither', async (outcome) => {
    const set = async (sub: string, extra: string) =>
      sqlstate(app, `UPDATE signup_request SET verification = '${outcome}', verified_on = current_date${extra} WHERE id = $1`, [await signup(sub)]);
    expect(await set(`ov-${outcome}-group`, `, local_group = 'Northwest Florida Mensa'`)).toBe(CHECK_VIOLATION);
    expect(await set(`ov-${outcome}-name`, `, first_name_matched = true`)).toBe(CHECK_VIOLATION);
    expect(await set(`ov-${outcome}-name-false`, `, first_name_matched = false`)).toBe(CHECK_VIOLATION);
    expect(await set(`ov-${outcome}-bare`, '')).toBe('ok');
  });

  it.each(['verified_local', 'verified_other_group', 'email_mismatch'])('takes both beside a %s outcome', async (outcome) => {
    const id = await signup(`ov-${outcome}-both`);
    expect(await sqlstate(app, `UPDATE signup_request SET verification = '${outcome}', verified_on = current_date, first_name_matched = true, local_group = 'Boston Mensa' WHERE id = $1`, [id])).toBe('ok');
  });

  describe('a fresh check (fix round 3)', () => {
    const approved = async (sub: string): Promise<string> => {
      const id = await signup(sub);
      expect(await report(id, false, 'Northwest Florida Mensa')).toBe('ok');
      expect(await sqlstate(app, `UPDATE signup_request SET decision = 'approved', decided_at = now(), decided_by_sub = 'sub-x' WHERE id = $1`, [id])).toBe('ok');
      return id;
    };
    const ask = (id: string) => sqlstate(app, `UPDATE signup_request SET recheck_requested_at = now(), recheck_outcome = NULL WHERE id = $1`, [id]);

    it('keeps the outcome as final as the answers, until a fresh check is asked for', async () => {
      const id = await approved('ov-recheck-final');
      expect(await sqlstate(app, `UPDATE signup_request SET verification = 'verified_other_group' WHERE id = $1`, [id])).toBe(NOT_IN_PREREQUISITE_STATE);
      expect(await sqlstate(app, `UPDATE signup_request SET verification = 'not_found', first_name_matched = NULL, local_group = NULL WHERE id = $1`, [id])).toBe(NOT_IN_PREREQUISITE_STATE);
      expect(await ask(id)).toBe('ok');
      expect(
        await sqlstate(app, `UPDATE signup_request SET verification = 'verified_local', first_name_matched = true, local_group = 'Northwest Florida Mensa', recheck_requested_at = NULL WHERE id = $1`, [id]),
      ).toBe('ok');
      // Answered: final again.
      expect(await sqlstate(app, `UPDATE signup_request SET first_name_matched = false WHERE id = $1`, [id])).toBe(NOT_IN_PREREQUISITE_STATE);
      expect(await sqlstate(app, `UPDATE signup_request SET verification = 'email_mismatch' WHERE id = $1`, [id])).toBe(NOT_IN_PREREQUISITE_STATE);
    });

    it('notes a fresh check that did not confirm beside the earlier answers, and only such an outcome', async () => {
      const id = await approved('ov-recheck-noted');
      expect(await ask(id)).toBe('ok');
      // Asked, or answered: never both at once.
      expect(await sqlstate(app, `UPDATE signup_request SET recheck_outcome = 'not_found' WHERE id = $1`, [id])).toBe(CHECK_VIOLATION);
      for (const outcome of ['verified_local', 'unchecked', 'gone']) {
        expect(await sqlstate(app, `UPDATE signup_request SET recheck_outcome = '${outcome}', recheck_requested_at = NULL WHERE id = $1`, [id]), outcome).toBe(CHECK_VIOLATION);
      }
      for (const outcome of ['not_found', 'error', 'duplicate_claim']) {
        expect(await ask(id)).toBe('ok');
        expect(await sqlstate(app, `UPDATE signup_request SET recheck_outcome = '${outcome}', recheck_requested_at = NULL WHERE id = $1`, [id]), outcome).toBe('ok');
      }
      const { rows } = await app.query(`SELECT verification, first_name_matched, local_group, recheck_outcome FROM signup_request WHERE id = $1`, [id]);
      expect(rows).toEqual([{ verification: 'verified_local', first_name_matched: false, local_group: 'Northwest Florida Mensa', recheck_outcome: 'duplicate_claim' }]);
    });

    it('is for an approved sign-up only: never a pending or a rejected one', async () => {
      const pending = await signup('ov-recheck-pending');
      expect(await ask(pending)).toBe(CHECK_VIOLATION);
      expect(await report(pending, null, null)).toBe('ok');
      expect(await ask(pending)).toBe(CHECK_VIOLATION);
      expect(await sqlstate(app, `UPDATE signup_request SET recheck_outcome = 'error' WHERE id = $1`, [pending])).toBe(CHECK_VIOLATION);
      expect(await sqlstate(app, `UPDATE signup_request SET decision = 'rejected', decided_at = now(), decided_by_sub = 'sub-x' WHERE id = $1`, [pending])).toBe('ok');
      expect(await ask(pending)).toBe(CHECK_VIOLATION);
    });
  });

  it('stores no derived chapter or guest flag on the account: only the reported group, on the sign-up', async () => {
    const { rows } = await app.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'member_account' AND column_name ~ 'chapter|guest|local'`,
    );
    expect(rows).toEqual([]);
  });
});
