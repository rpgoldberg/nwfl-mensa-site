// PROFILE-ID (0028): what a person typed at sign-up is kept, exercised as the APPLICATION role.
//   - The membership number, last name and first name stay on the sign-up in every state: through the
//     verifier's report (every outcome), an approval, a rejection and a reopening.
//   - The number never changes once stored, in any state, to another number or to nothing, for every
//     role, the owner included: it has no edit path.
//   - The two names change only on an approved sign-up (the member's profile); a pending, rejected or
//     reopened one keeps them as typed, for the approvers to read.
//   - A first name holds 1 to 80 characters and no control character.
//   - An account becomes a member while its sign-up still holds the number (0009's erasure rule is gone).
//   - A pending sign-up the owner deletes takes its typed values with it.
// Every subject and value here is made up.
import type pg from 'pg';
import pgLib from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP, APP_PW, MIGRATOR, MIGRATOR_PW, dropDatabase, freshDatabase, live, migrate, sqlstate, urlFor } from '../helpers/pg.js';

const CHECK_VIOLATION = '23514';
const NOT_IN_PREREQUISITE_STATE = '55000';

describe.skipIf(!live)('schema after PROFILE-ID (0028)', () => {
  let db: string;
  let app: pg.Client;
  let owner: pg.Client;

  const one = async <T>(text: string, values: unknown[] = []): Promise<T> => (await app.query(text, values)).rows[0] as T;
  const signup = async (sub: string, number = '1234567'): Promise<string> => {
    const { id } = await one<{ id: string }>(
      `INSERT INTO signup_request (sub, display_name, email, first_name, last_name, membership_number) VALUES ($1, 'Pat Example', 'pat@example.org', 'Pat', 'Example', $2) RETURNING id`,
      [sub, number],
    );
    await app.query(`INSERT INTO member_account (sub, status, route) VALUES ($1, 'pending', 'signup')`, [sub]);
    return id;
  };
  const typed = (id: string): Promise<{ first_name: string | null; last_name: string | null; membership_number: string | null }> =>
    one(`SELECT first_name, last_name, membership_number FROM signup_request WHERE id = $1`, [id]);
  const report = (id: string, verification: string): Promise<string> =>
    sqlstate(app, `UPDATE signup_request SET verification = $2, verified_on = current_date WHERE id = $1`, [id, verification]);
  const decide = (id: string, decision: 'approved' | 'rejected'): Promise<string> =>
    sqlstate(app, `UPDATE signup_request SET decision = $2, decided_at = now(), decided_by_sub = 'officer-1' WHERE id = $1`, [id, decision]);
  const AS_TYPED = { first_name: 'Pat', last_name: 'Example', membership_number: '1234567' };

  beforeAll(async () => {
    db = await freshDatabase('nwfl_profile0028');
    const run = await migrate(db);
    if (run.code !== 0) throw new Error(`migrate failed: ${run.stderr}`);
    app = new pgLib.Client({ connectionString: urlFor(APP, APP_PW, db) });
    await app.connect();
    owner = new pgLib.Client({ connectionString: urlFor(MIGRATOR, MIGRATOR_PW, db) });
    await owner.connect();
  });

  afterAll(async () => {
    await app?.end();
    await owner?.end();
    if (db !== undefined) await dropDatabase(db);
  });

  describe('kept in every state', () => {
    it.each(['verified_local', 'verified_other_group', 'not_found', 'error', 'email_mismatch', 'duplicate_claim'])('through the verifier reporting %s', async (outcome) => {
      const id = await signup(`k-report-${outcome}`);
      expect(await report(id, outcome)).toBe('ok');
      expect(await typed(id)).toEqual(AS_TYPED);
    });

    it('through an approval, and the account becomes a member with the number still on its sign-up', async () => {
      const id = await signup('k-approved');
      expect(await report(id, 'verified_local')).toBe('ok');
      expect(await decide(id, 'approved')).toBe('ok');
      expect(
        await sqlstate(app, `UPDATE member_account SET status = 'member', approved_by_sub = 'officer-1', approved_at = now(), verified_on = current_date WHERE sub = 'k-approved'`),
      ).toBe('ok');
      expect(await typed(id)).toEqual(AS_TYPED);
    });

    it('through a rejection and a reopening', async () => {
      const id = await signup('k-rejected');
      expect(await decide(id, 'rejected')).toBe('ok');
      expect(await typed(id)).toEqual(AS_TYPED);
      expect(await sqlstate(app, `UPDATE signup_request SET reopened_at = now(), reopened_by_sub = 'officer-2' WHERE id = $1`, [id])).toBe('ok');
      expect(await typed(id)).toEqual(AS_TYPED);
    });

    it('drops the three erasure rules and the trigger that waited on them', async () => {
      const { rows } = await owner.query<{ name: string }>(
        `SELECT conname AS name FROM pg_constraint WHERE conname IN ('signup_request_number_erased_once_checked', 'signup_request_last_name_erased_once_checked', 'signup_request_inputs_erased_on_decision')
         UNION ALL SELECT tgname FROM pg_trigger WHERE tgname = 'member_account_signup_erased'`,
      );
      expect(rows).toEqual([]);
    });
  });

  describe('the number has no edit path', () => {
    const change = (client: pg.Client, id: string, to: string | null): Promise<string> =>
      sqlstate(client, `UPDATE signup_request SET membership_number = $2 WHERE id = $1`, [id, to]);

    it('refuses another number, or none, on a pending sign-up, checked or not, for the app and the owner', async () => {
      const id = await signup('n-pending');
      for (const client of [app, owner]) {
        expect(await change(client, id, '7654321')).toBe(NOT_IN_PREREQUISITE_STATE);
        expect(await change(client, id, null)).toBe(NOT_IN_PREREQUISITE_STATE);
      }
      expect(await report(id, 'not_found')).toBe('ok');
      expect(await change(app, id, '7654321')).toBe(NOT_IN_PREREQUISITE_STATE);
      expect(await typed(id)).toEqual(AS_TYPED);
    });

    it('refuses it on an approved, a rejected and a reopened sign-up', async () => {
      const approved = await signup('n-approved');
      await decide(approved, 'approved');
      const rejected = await signup('n-rejected');
      await decide(rejected, 'rejected');
      const reopened = await signup('n-reopened');
      await decide(reopened, 'rejected');
      await app.query(`UPDATE signup_request SET reopened_at = now(), reopened_by_sub = 'officer-2' WHERE id = $1`, [reopened]);
      for (const id of [approved, rejected, reopened]) {
        expect(await change(app, id, '7654321'), id).toBe(NOT_IN_PREREQUISITE_STATE);
        expect(await change(owner, id, null), id).toBe(NOT_IN_PREREQUISITE_STATE);
      }
    });

    it('lets the same number be written again (a no-op), so an update of other columns is never refused for it', async () => {
      const id = await signup('n-same');
      expect(await change(app, id, '1234567')).toBe('ok');
    });

    it('still takes digits only', async () => {
      expect(await sqlstate(app, `INSERT INTO signup_request (sub, display_name, email, first_name, last_name, membership_number) VALUES ('n-letters', 'Pat', 'pat@example.org', 'Pat', 'Example', '12a4')`)).toBe(
        CHECK_VIOLATION,
      );
    });
  });

  describe('the names', () => {
    const rename = (id: string, first: string, last: string): Promise<string> =>
      sqlstate(app, `UPDATE signup_request SET first_name = $2, last_name = $3 WHERE id = $1`, [id, first, last]);

    it('change on an approved sign-up, the member\'s profile', async () => {
      const id = await signup('p-approved');
      await decide(id, 'approved');
      expect(await rename(id, 'Patricia', 'Example-Smith')).toBe('ok');
      expect(await typed(id)).toEqual({ first_name: 'Patricia', last_name: 'Example-Smith', membership_number: '1234567' });
    });

    it('stay as typed on a pending, a rejected and a reopened sign-up', async () => {
      const pending = await signup('p-pending');
      const rejected = await signup('p-rejected');
      await decide(rejected, 'rejected');
      const reopened = await signup('p-reopened');
      await decide(reopened, 'rejected');
      await app.query(`UPDATE signup_request SET reopened_at = now(), reopened_by_sub = 'officer-2' WHERE id = $1`, [reopened]);
      for (const id of [pending, rejected, reopened]) {
        expect(await rename(id, 'Other', 'Person'), id).toBe(NOT_IN_PREREQUISITE_STATE);
        expect(await typed(id)).toEqual(AS_TYPED);
      }
    });

    it('take a first name of 1 to 80 characters with no control character, or none on an older sign-up', async () => {
      const insert = (sub: string, first: string | null): Promise<string> =>
        sqlstate(app, `INSERT INTO signup_request (sub, display_name, email, first_name, last_name, membership_number) VALUES ($1, 'Pat', 'pat@example.org', $2, 'Example', '1')`, [sub, first]);
      expect(await insert('f-none', null)).toBe('ok');
      expect(await insert('f-80', 'F'.repeat(80))).toBe('ok');
      expect(await insert('f-empty', '')).toBe(CHECK_VIOLATION);
      expect(await insert('f-81', 'F'.repeat(81))).toBe(CHECK_VIOLATION);
      expect(await insert('f-tab', 'Pa\tt')).toBe(CHECK_VIOLATION);
      expect(await insert('f-esc', '\u001b[31mPat')).toBe(CHECK_VIOLATION);
    });
  });

  it('deletes the typed values with a pending sign-up the owner deletes', async () => {
    const id = await signup('d-pending', '99887766');
    expect(await sqlstate(owner, `DELETE FROM signup_request WHERE id = $1`, [id])).toBe('ok');
    expect((await owner.query(`SELECT 1 FROM signup_request WHERE membership_number = '99887766'`)).rows).toEqual([]);
  });
});
