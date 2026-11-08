// VET (0027): the database's side of sign-up vetting, exercised as the APPLICATION role.
//   - The stored check takes the two new outcomes, email_mismatch and duplicate_claim, and nothing else new.
//   - A duplicate claim may name the earlier sign-up: an existing one, never itself, and only on a
//     duplicate claim.
//   - signup_claim_release: one row per released claim, written in the same transaction as the
//     rejection, the reopening, or the removal or deletion of the member account. Append-only for every
//     role, the owner included. A row the app writes by hand must be a real release, and takes its
//     cursor and time from the database, never from the writer. Writers take the cursor in commit
//     order (one at a time), so a reader that has seen a cursor never later finds a smaller one.
// Every subject here is made up.
import type pg from 'pg';
import pgLib from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP, APP_PW, MIGRATOR, MIGRATOR_PW, dropDatabase, failure, freshDatabase, live, migrate, sqlstate, urlFor } from '../helpers/pg.js';

const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const INSUFFICIENT_PRIVILEGE = '42501';
const NOT_IN_PREREQUISITE_STATE = '55000';
const LOCK_NOT_AVAILABLE = '55P03';

describe.skipIf(!live)('schema after VET (0027)', () => {
  let db: string;
  let app: pg.Client;
  let app2: pg.Client;
  let owner: pg.Client;

  const one = async <T>(text: string, values: unknown[] = []): Promise<T> => (await app.query(text, values)).rows[0] as T;
  const signup = async (sub: string): Promise<string> => {
    const { id } = await one<{ id: string }>(
      `INSERT INTO signup_request (sub, display_name, email, last_name, membership_number) VALUES ($1, 'Pat Example', 'pat@example.org', 'Example', '1234567') RETURNING id`,
      [sub],
    );
    await app.query(`INSERT INTO member_account (sub, status, route) VALUES ($1, 'pending', 'signup')`, [sub]);
    return id;
  };
  const report = (id: string, verification: string, conflicting: string | null = null, client: pg.Client = app): Promise<string> =>
    sqlstate(
      client,
      `UPDATE signup_request SET verification = $2, verified_on = current_date, membership_number = NULL, last_name = NULL, conflicting_request_id = $3 WHERE id = $1`,
      [id, verification, conflicting],
    );
  const decide = (id: string, decision: 'approved' | 'rejected', client: pg.Client = app): Promise<string> =>
    sqlstate(client, `UPDATE signup_request SET decision = $2, decided_at = now(), decided_by_sub = 'officer-1', membership_number = NULL, last_name = NULL WHERE id = $1`, [id, decision]);
  const releases = async (id: string): Promise<string[]> =>
    (await app.query<{ kind: string }>(`SELECT kind FROM signup_claim_release WHERE request_id = $1 ORDER BY seq`, [id])).rows.map((r) => r.kind);

  beforeAll(async () => {
    db = await freshDatabase('nwfl_vet0027');
    const run = await migrate(db);
    if (run.code !== 0) throw new Error(`migrate failed: ${run.stderr}`);
    app = new pgLib.Client({ connectionString: urlFor(APP, APP_PW, db) });
    await app.connect();
    app2 = new pgLib.Client({ connectionString: urlFor(APP, APP_PW, db) });
    await app2.connect();
    owner = new pgLib.Client({ connectionString: urlFor(MIGRATOR, MIGRATOR_PW, db) });
    await owner.connect();
  });

  afterAll(async () => {
    await app?.end();
    await app2?.end();
    await owner?.end();
    if (db !== undefined) await dropDatabase(db);
  });

  describe('the stored check', () => {
    it('takes email_mismatch and duplicate_claim, still erasing the inputs, and still refuses an unknown outcome', async () => {
      expect(await report(await signup('c-mismatch'), 'email_mismatch')).toBe('ok');
      expect(await report(await signup('c-duplicate'), 'duplicate_claim')).toBe('ok');
      expect(await report(await signup('c-unknown'), 'verified_maybe')).toBe(CHECK_VIOLATION);
      const keep = await signup('c-keep');
      expect(await sqlstate(app, `UPDATE signup_request SET verification = 'email_mismatch', verified_on = current_date WHERE id = $1`, [keep])).toBe(CHECK_VIOLATION);
    });

    it('names an earlier sign-up only on a duplicate claim, never itself, and only one that exists', async () => {
      const earlier = await signup('c-earlier');
      expect(await report(await signup('c-named'), 'duplicate_claim', earlier)).toBe('ok');
      expect(await report(await signup('c-wrong-outcome'), 'email_mismatch', earlier)).toBe(CHECK_VIOLATION);
      const self = await signup('c-self');
      expect(await report(self, 'duplicate_claim', self)).toBe(CHECK_VIOLATION);
      expect(await report(await signup('c-missing'), 'duplicate_claim', '6a1f0c8e-0000-4000-8000-000000000000')).toBe(FOREIGN_KEY_VIOLATION);
    });
  });

  describe('released claims', () => {
    it('records a rejection, a reopening and its account’s deletion, each in the transaction that made it', async () => {
      const id = await signup('r-reject');
      expect(await decide(id, 'rejected')).toBe('ok');
      await app.query(`UPDATE member_account SET status = 'removed', removed_at = now() WHERE sub = 'r-reject'`);
      expect(await releases(id)).toEqual(['rejected']);
      expect(await sqlstate(app, `UPDATE signup_request SET reopened_at = now(), reopened_by_sub = 'officer-mo' WHERE id = $1`, [id])).toBe('ok');
      expect(await sqlstate(app, `DELETE FROM member_account WHERE sub = 'r-reject'`)).toBe('ok');
      expect(await releases(id)).toEqual(['rejected', 'reopened']);
      const row = await one<{ released_at: Date; seq: string }>(`SELECT released_at, seq::text FROM signup_claim_release WHERE request_id = $1 ORDER BY seq LIMIT 1`, [id]);
      expect(row.released_at).toBeInstanceOf(Date);
    });

    it('records nothing for a rejection rolled back', async () => {
      const id = await signup('r-rollback');
      await app.query('BEGIN');
      expect(await decide(id, 'rejected')).toBe('ok');
      await app.query('ROLLBACK');
      expect(await releases(id)).toEqual([]);
    });

    it('records an approved member’s removal or deletion as account_deleted, and a lapse or an approval not at all', async () => {
      const id = await signup('r-member');
      expect(await report(id, 'verified_local')).toBe('ok');
      expect(await decide(id, 'approved')).toBe('ok');
      await app.query(`UPDATE member_account SET status = 'member', approved_by_sub = 'officer-1', approved_at = now(), verified_on = current_date WHERE sub = 'r-member'`);
      await app.query(`UPDATE member_account SET status = 'lapsed' WHERE sub = 'r-member'`);
      expect(await releases(id)).toEqual([]);
      await app.query(`UPDATE member_account SET status = 'removed', removed_at = now() WHERE sub = 'r-member'`);
      expect(await releases(id)).toEqual(['account_deleted']);
      // Removed once: a later update of the removed row releases nothing more.
      await app.query(`UPDATE member_account SET updated_at = now() WHERE sub = 'r-member'`);
      expect(await releases(id)).toEqual(['account_deleted']);
      // A deletion, by the owner (the app may delete only a rejection's closed account).
      const gone = await signup('r-deleted');
      expect(await decide(gone, 'approved')).toBe('ok');
      await owner.query(`ALTER TABLE member_account DISABLE TRIGGER member_account_delete_only_reopened`);
      await owner.query(`DELETE FROM member_account WHERE sub = 'r-deleted'`);
      await owner.query(`ALTER TABLE member_account ENABLE TRIGGER member_account_delete_only_reopened`);
      expect(await releases(gone)).toEqual(['account_deleted']);
    });

    it('is append-only for every role, the owner included', async () => {
      for (const statement of [`UPDATE signup_claim_release SET kind = 'rejected'`, `DELETE FROM signup_claim_release`, `TRUNCATE signup_claim_release`]) {
        expect(await sqlstate(app, statement), statement).toBe(INSUFFICIENT_PRIVILEGE);
        expect(await sqlstate(owner, statement), statement).toBe(NOT_IN_PREREQUISITE_STATE);
      }
    });

    it('takes a hand-written row only for a real release, with the cursor and the time from the database', async () => {
      const pending = await signup('h-pending');
      expect(await failure(app, `INSERT INTO signup_claim_release (request_id, kind) VALUES ($1, 'rejected')`, [pending])).toMatch(/not released/);
      expect(await failure(app, `INSERT INTO signup_claim_release (request_id, kind) VALUES ($1, 'reopened')`, [pending])).toMatch(/not released/);
      expect(await failure(app, `INSERT INTO signup_claim_release (request_id, kind) VALUES ($1, 'account_deleted')`, [pending])).toMatch(/not released/);
      expect(await sqlstate(app, `INSERT INTO signup_claim_release (request_id, kind) VALUES ($1, 'forgotten')`, [pending])).toBe(NOT_IN_PREREQUISITE_STATE);
      expect(await decide(pending, 'rejected')).toBe('ok');
      const { max } = await one<{ max: string }>(`SELECT max(seq)::text AS max FROM signup_claim_release`);
      const forged = await one<{ seq: string; recent: boolean }>(
        `INSERT INTO signup_claim_release (seq, request_id, kind, released_at) VALUES (1, $1, 'rejected', '2000-01-01') RETURNING seq::text, released_at > now() - interval '1 minute' AS recent`,
        [pending],
      );
      expect(BigInt(forged.seq)).toBeGreaterThan(BigInt(max));
      expect(forged.recent).toBe(true);
    });

    it('lets one writer at a time take a cursor, until it commits, so the cursor never goes back', async () => {
      const a = await signup('o-first');
      const b = await signup('o-second');
      await app.query('BEGIN');
      expect(await decide(a, 'rejected')).toBe('ok');
      await app2.query(`SET lock_timeout = '300ms'`);
      expect(await decide(b, 'rejected', app2)).toBe(LOCK_NOT_AVAILABLE);
      await app.query('COMMIT');
      expect(await decide(b, 'rejected', app2)).toBe('ok');
      const order = (await app.query<{ request_id: string }>(`SELECT request_id FROM signup_claim_release WHERE request_id IN ($1, $2) ORDER BY seq`, [a, b])).rows.map((r) => r.request_id);
      expect(order).toEqual([a, b]);
    });

    it('lets the app read it, and no one write it but through the release rules', async () => {
      const { rows } = await owner.query<{ privilege: string }>(
        `SELECT privilege_type AS privilege FROM information_schema.role_table_grants WHERE table_name = 'signup_claim_release' AND grantee = 'nwfl' ORDER BY 1`,
      );
      expect(rows.map((r) => r.privilege)).toEqual(['INSERT', 'SELECT']);
    });
  });
});
