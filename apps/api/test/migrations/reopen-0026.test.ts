// REOPEN (0026): the database's side of reopening a rejected sign-up, exercised as the
// APPLICATION role.
//   - Only a rejected sign-up is reopened, with who and when recorded together; its decision,
//     decider, time and erased inputs stay as they were (0009).
//   - A reopened sign-up never changes again: not reopened twice, not un-reopened, not edited.
//   - A person has at most one sign-up that is not reopened; a reopened one leaves room for one more.
//   - An account row is deleted only when it is a rejection's closed account (removed, never
//     approved, granted or checked) whose sign-up was reopened and nothing newer is open.
// Every subject here is made up.
import type pg from 'pg';
import pgLib from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP, APP_PW, dropDatabase, failure, freshDatabase, live, migrate, sqlstate, urlFor } from '../helpers/pg.js';

const UNIQUE_VIOLATION = '23505';

describe.skipIf(!live)('schema after REOPEN (0026)', () => {
  let db: string;
  let app: pg.Client;

  const one = async <T>(text: string, values: unknown[] = []): Promise<T> => (await app.query(text, values)).rows[0] as T;
  const signup = (sub: string): Promise<{ id: string }> =>
    one(`INSERT INTO signup_request (sub, display_name, email, last_name, membership_number) VALUES ($1, 'Pat Example', 'pat@example.org', 'Example', '1234567') RETURNING id`, [sub]);
  const decide = (id: string, decision: 'approved' | 'rejected'): Promise<string> =>
    failure(app, `UPDATE signup_request SET decision = $2, decided_at = now(), decided_by_sub = 'officer-1', membership_number = NULL, last_name = NULL WHERE id = $1`, [id, decision]);
  const reopen = (id: string, by = 'officer-mo'): Promise<string> => failure(app, `UPDATE signup_request SET reopened_at = now(), reopened_by_sub = $2 WHERE id = $1`, [id, by]);
  /** A sign-up rejected with its waiting account removed, as RejectSignup leaves it. */
  const rejected = async (sub: string): Promise<string> => {
    const { id } = await signup(sub);
    await app.query(`INSERT INTO member_account (sub, status, route) VALUES ($1, 'pending', 'signup')`, [sub]);
    expect(await decide(id, 'rejected')).toBe('ok');
    await app.query(`UPDATE member_account SET status = 'removed', removed_at = now() WHERE sub = $1`, [sub]);
    return id;
  };

  beforeAll(async () => {
    db = await freshDatabase('nwfl_reopen0026');
    const run = await migrate(db);
    if (run.code !== 0) throw new Error(`migrate failed: ${run.stderr}`);
    app = new pgLib.Client({ connectionString: urlFor(APP, APP_PW, db) });
    await app.connect();
  });

  afterAll(async () => {
    await app?.end();
    if (db !== undefined) await dropDatabase(db);
  });

  it('reopens a rejected sign-up, keeping its decision, decider, time and erased inputs', async () => {
    const id = await rejected('r-ok');
    const before = await one<{ decided_at: Date }>(`SELECT decided_at FROM signup_request WHERE id = $1`, [id]);
    expect(await reopen(id)).toBe('ok');
    expect(await one(`SELECT decision, decided_by_sub, decided_at, membership_number, last_name, reopened_by_sub, reopened_at IS NOT NULL AS reopened FROM signup_request WHERE id = $1`, [id])).toEqual({
      decision: 'rejected',
      decided_by_sub: 'officer-1',
      decided_at: before.decided_at,
      membership_number: null,
      last_name: null,
      reopened_by_sub: 'officer-mo',
      reopened: true,
    });
  });

  it('reopens only a rejected sign-up: not a pending one, not an approved one', async () => {
    const pending = await signup('r-pending');
    expect(await reopen(pending.id)).toMatch(/signup_request_reopen_only_rejected/);
    const approved = await signup('r-approved');
    expect(await decide(approved.id, 'approved')).toBe('ok');
    expect(await reopen(approved.id)).toMatch(/signup_request_reopen_only_rejected/);
  });

  it('records who and when together, never one without the other', async () => {
    const id = await rejected('r-half');
    expect(await failure(app, `UPDATE signup_request SET reopened_at = now() WHERE id = $1`, [id])).toMatch(/signup_request_reopen_recorded/);
    expect(await failure(app, `UPDATE signup_request SET reopened_by_sub = 'officer-mo' WHERE id = $1`, [id])).toMatch(/signup_request_reopen_recorded/);
    expect(await reopen(id, '')).toMatch(/reopened_by_sub_check/);
  });

  it('never changes a reopened sign-up again: not reopened twice, not un-reopened, not edited, its decision kept', async () => {
    const id = await rejected('r-frozen');
    expect(await reopen(id)).toBe('ok');
    expect(await reopen(id, 'officer-admin')).toMatch(/is reopened/);
    expect(await failure(app, `UPDATE signup_request SET reopened_at = NULL, reopened_by_sub = NULL WHERE id = $1`, [id])).toMatch(/is reopened/);
    expect(await failure(app, `UPDATE signup_request SET display_name = 'Someone Else' WHERE id = $1`, [id])).toMatch(/is reopened/);
    expect(await failure(app, `UPDATE signup_request SET decision = 'pending', decided_at = NULL, decided_by_sub = NULL WHERE id = $1`, [id])).toMatch(/is decided|is reopened/);
    expect(await failure(app, `UPDATE signup_request SET reopened_by_sub = reopened_by_sub WHERE id = $1`, [id])).toBe('ok');
  });

  it('keeps one open sign-up per person; a reopened one leaves room for exactly one more', async () => {
    const id = await rejected('r-again');
    expect(await sqlstate(app, `INSERT INTO signup_request (sub, display_name, email) VALUES ('r-again', 'Pat Example', 'pat@example.org')`)).toBe(UNIQUE_VIOLATION);
    expect(await reopen(id)).toBe('ok');
    expect(await sqlstate(app, `INSERT INTO signup_request (sub, display_name, email) VALUES ('r-again', 'Pat Example', 'pat@example.org')`)).toBe('ok');
    expect(await sqlstate(app, `INSERT INTO signup_request (sub, display_name, email) VALUES ('r-again', 'Pat Example', 'pat@example.org')`)).toBe(UNIQUE_VIOLATION);
    expect((await app.query(`SELECT 1 FROM signup_request WHERE sub = 'r-again'`)).rows).toHaveLength(2);
  });

  describe('deleting an account row', () => {
    const remove = (sub: string): Promise<string> => failure(app, `DELETE FROM member_account WHERE sub = $1`, [sub]);

    it('deletes a rejection\'s closed account once its sign-up is reopened', async () => {
      const id = await rejected('d-ok');
      expect(await reopen(id)).toBe('ok');
      expect(await remove('d-ok')).toBe('ok');
      expect((await app.query(`SELECT 1 FROM member_account WHERE sub = 'd-ok'`)).rows).toEqual([]);
    });

    it('refuses while the sign-up is only rejected, not reopened', async () => {
      await rejected('d-rejected');
      expect(await remove('d-rejected')).toMatch(/only a rejection's closed account/);
    });

    it('refuses an account that is not removed, or that once had standing, whatever its sign-up', async () => {
      const id = await rejected('d-member');
      expect(await reopen(id)).toBe('ok');
      await app.query(`UPDATE member_account SET status = 'affiliate', removed_at = NULL, affiliate_granted_by_sub = 'officer-admin', affiliate_granted_at = now() WHERE sub = 'd-member'`);
      expect(await remove('d-member')).toMatch(/only a rejection's closed account/);
      await app.query(`UPDATE member_account SET status = 'removed', removed_at = now() WHERE sub = 'd-member'`);
      expect(await remove('d-member')).toMatch(/only a rejection's closed account/);
      await app.query(`INSERT INTO member_account (sub, status, route) VALUES ('d-pending', 'pending', 'signup')`);
      expect(await remove('d-pending')).toMatch(/only a rejection's closed account/);
    });

    it('refuses once a newer sign-up is open for the person', async () => {
      const id = await rejected('d-newer');
      expect(await reopen(id)).toBe('ok');
      await signup('d-newer');
      expect(await remove('d-newer')).toMatch(/only a rejection's closed account/);
    });
  });
});
