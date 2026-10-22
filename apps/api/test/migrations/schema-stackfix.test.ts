// STACK-FIX: the challenger's schema findings on the membership and content
// records, each pinned by a test. Exercised as the APPLICATION role.
//   - A membership record's audit row carries no payload at all.
//   - A decided sign-up is final, and an account becomes a member only once
//     its sign-up no longer holds the verifier's inputs.
//   - verified_on is never in the future.
//   - An item's live version is its newest approved version, so nothing can
//     roll it back without an approval.
//   - A file's audience is frozen once its version is approved.
import type pg from 'pg';
import pgLib from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP, APP_PW, dropDatabase, failure, freshDatabase, live, migrate, urlFor } from '../helpers/pg.js';

const HASH = Buffer.alloc(32, 7);

describe.skipIf(!live)('schema after STACK-FIX', () => {
  let db: string;
  let app: pg.Client;
  let officeId: string;
  let n = 0;

  const one = async <T>(text: string, values: unknown[] = []): Promise<T> => (await app.query(text, values)).rows[0] as T;

  beforeAll(async () => {
    db = await freshDatabase('nwfl_stackfix');
    const run = await migrate(db);
    if (run.code !== 0) throw new Error(`migrate failed: ${run.stderr}`);
    app = new pgLib.Client({ connectionString: urlFor(APP, APP_PW, db) });
    await app.connect();
    officeId = (await one<{ id: string }>(`INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`)).id;
  });

  afterAll(async () => {
    await app?.end();
    if (db !== undefined) await dropDatabase(db);
  });

  describe('audit rows on membership records', () => {
    const audit = (subjectKind: string, payload: unknown): Promise<string> =>
      failure(app, `INSERT INTO audit_event (actor_kind, action, subject_kind, subject_id, payload) VALUES ('user', 'probe', $1, 'r', $2)`, [subjectKind, JSON.stringify(payload)]);

    it.each([
      { family_name: 'Example' },
      { surname: 'Example' },
      { mensa_number: '1234567' },
      { member_id: '1234567' },
      { 'membership.number': '1234567' },
      { membership__number: '1234567' },
      { request: '{"membership_number":"1234567"}' },
      { fields: [{ name: 'membership_number', value: '1234567' }] },
      { outcome: 'approved' },
    ])('refuses any payload on a sign-up or an account: %j', async (payload) => {
      expect(await audit('signup_request', payload)).toMatch(/audit_event_no_payload_on_membership/);
      expect(await audit('member_account', payload)).toMatch(/audit_event_no_payload_on_membership/);
    });

    it('records a membership action with an empty payload, and other subjects keep theirs', async () => {
      expect(await audit('signup_request', {})).toBe('ok');
      expect(await audit('edition', { audience: 'members' })).toBe('ok');
    });
  });

  describe('sign-up decisions and the account they lead to', () => {
    const signup = async (sub: string): Promise<void> => {
      await app.query(`INSERT INTO signup_request (sub, display_name, email, last_name, membership_number) VALUES ($1, 'Pat', 'pat@example.org', 'Example', '1234567')`, [sub]);
    };
    const decide = (sub: string, decision: string, by = 'officer-1'): Promise<string> =>
      failure(app, `UPDATE signup_request SET decision = $2, decided_at = now(), decided_by_sub = $3, membership_number = NULL, last_name = NULL WHERE sub = $1`, [sub, decision, by]);
    const account = (sub: string): Promise<string> =>
      failure(app, `INSERT INTO member_account (sub, status, route, approved_by_sub, approved_at, verified_on) VALUES ($1, 'member', 'signup', 'officer-1', now(), current_date)`, [sub]);

    it('makes no account a member while its sign-up still holds the number, and does once the decision erased it', async () => {
      await signup('s-account');
      expect(await account('s-account')).toMatch(/decide the sign-up/);
      await app.query(`INSERT INTO member_account (sub, status, route) VALUES ('s-account', 'pending', 'signup')`);
      expect(await failure(app, `UPDATE member_account SET status = 'member', approved_by_sub = 'officer-1', approved_at = now(), verified_on = current_date WHERE sub = 's-account'`)).toMatch(
        /decide the sign-up/,
      );
      expect(await decide('s-account', 'approved')).toBe('ok');
      expect(await failure(app, `UPDATE member_account SET status = 'member', approved_by_sub = 'officer-1', approved_at = now(), verified_on = current_date WHERE sub = 's-account'`)).toBe('ok');
    });

    it('keeps a decided sign-up decided: no reopening, no flip, no new decider or time, no number stored again', async () => {
      await signup('s-final');
      expect(await decide('s-final', 'rejected', 'officer-2')).toBe('ok');
      expect(
        await failure(app, `UPDATE signup_request SET decision = 'pending', decided_at = NULL, decided_by_sub = NULL, membership_number = '7654321', last_name = 'Example' WHERE sub = 's-final'`),
      ).toMatch(/is decided/);
      expect(await failure(app, `UPDATE signup_request SET decision = 'approved' WHERE sub = 's-final'`)).toMatch(/is decided/);
      expect(await failure(app, `UPDATE signup_request SET decided_by_sub = 'officer-3' WHERE sub = 's-final'`)).toMatch(/is decided/);
      expect(await failure(app, `UPDATE signup_request SET decided_at = now() - interval '1 day' WHERE sub = 's-final'`)).toMatch(/is decided/);
      expect(await one(`SELECT decision, decided_by_sub FROM signup_request WHERE sub = 's-final'`)).toEqual({ decision: 'rejected', decided_by_sub: 'officer-2' });
    });

    it('still lets the verifier report on a pending sign-up, erasing the inputs', async () => {
      await signup('s-pending');
      expect(
        await failure(app, `UPDATE signup_request SET verification = 'verified_local', verified_on = current_date, membership_number = NULL, last_name = NULL WHERE sub = 's-pending'`),
      ).toBe('ok');
      expect(await decide('s-pending', 'approved')).toBe('ok');
    });

    it('refuses a verified_on in the future, on an account and on a sign-up', async () => {
      expect(
        await failure(app, `INSERT INTO member_account (sub, status, route, approved_by_sub, approved_at, verified_on) VALUES ('s-future', 'member', 'invite', 'officer-1', now(), current_date + 1)`),
      ).toMatch(/member_account_verified_on_not_future/);
      await signup('s-future-signup');
      expect(
        await failure(app, `UPDATE signup_request SET verification = 'verified_local', verified_on = current_date + 1, membership_number = NULL, last_name = NULL WHERE sub = 's-future-signup'`),
      ).toMatch(/signup_request_verified_on_not_future/);
    });
  });

  describe('the live version and the files of approved versions', () => {
    const newItem = async (): Promise<string> =>
      (await one<{ id: string }>(`INSERT INTO content_item (slug, kind, office_id) VALUES ($1, 'article', $2) RETURNING id`, [`sf-${(n += 1)}`, officeId])).id;
    const newVersion = async (itemId: string): Promise<string> =>
      (
        await one<{ id: string }>(
          `INSERT INTO content_version (item_id, n, title, created_by_sub, acting_office_id)
           VALUES ($1, (SELECT coalesce(max(n), 0) + 1 FROM content_version WHERE item_id = $1), 'Title', 'sub-author', $2) RETURNING id`,
          [itemId, officeId],
        )
      ).id;
    const approve = async (id: string): Promise<void> => {
      await app.query(`UPDATE content_version SET status = 'ready', content_hash = $2, ready_at = now() WHERE id = $1`, [id, HASH]);
      await app.query(
        `UPDATE content_version SET status = 'approved', approved_at = now(), approved_by_sub = 'sub-webmaster', approval_kind = 'normal', public_ast = '{"blocks": []}' WHERE id = $1`,
        [id],
      );
    };
    const inOne = async (statements: Array<[string, unknown[]]>): Promise<string> => {
      await app.query('BEGIN');
      try {
        for (const [text, values] of statements) await app.query(text, values);
        await app.query('COMMIT');
        return 'ok';
      } catch (error) {
        await app.query('ROLLBACK');
        return (error as Error).message;
      }
    };
    const published = async (): Promise<{ itemId: string; v1: string }> => {
      const itemId = await newItem();
      const v1 = await newVersion(itemId);
      await approve(v1);
      await app.query(`UPDATE content_item SET state = 'ready' WHERE id = $1`, [itemId]);
      await app.query(`UPDATE content_item SET state = 'published', live_version_id = $2 WHERE id = $1`, [itemId, v1]);
      return { itemId, v1 };
    };

    it('lets a revision replace the live version in one transaction, as approval does', async () => {
      const { itemId, v1 } = await published();
      const v2 = await newVersion(itemId);
      await app.query(`UPDATE content_version SET status = 'ready', content_hash = $2, ready_at = now() WHERE id = $1`, [v2, HASH]);
      expect(
        await inOne([
          [`UPDATE content_version SET status = 'approved', approved_at = now(), approved_by_sub = 'w', approval_kind = 'normal', public_ast = '{"blocks": []}' WHERE id = $1`, [v2]],
          [`UPDATE content_item SET live_version_id = $2 WHERE id = $1`, [itemId, v2]],
          [`UPDATE content_version SET status = 'superseded' WHERE id = $1`, [v1]],
        ]),
      ).toBe('ok');
    });

    it('refuses to leave an older approved version live, or to point live back at it, without an approval', async () => {
      const { itemId, v1 } = await published();
      const v2 = await newVersion(itemId);
      // Approved but never made live: the commit is refused.
      expect(await failure(app, `UPDATE content_version SET status = 'ready', content_hash = $2, ready_at = now() WHERE id = $1`, [v2, HASH])).toBe('ok');
      expect(
        await failure(app, `UPDATE content_version SET status = 'approved', approved_at = now(), approved_by_sub = 'w', approval_kind = 'normal', public_ast = '{"blocks": []}' WHERE id = $1`, [
          v2,
        ]),
      ).toMatch(/live version .* is not its newest approved version/);
      // The roll-back the challenger did: both approved, live moved to v2, then back to v1.
      expect(
        await inOne([
          [`UPDATE content_version SET status = 'approved', approved_at = now(), approved_by_sub = 'w', approval_kind = 'normal', public_ast = '{"blocks": []}' WHERE id = $1`, [v2]],
          [`UPDATE content_item SET live_version_id = $2 WHERE id = $1`, [itemId, v2]],
          [`UPDATE content_item SET live_version_id = $2 WHERE id = $1`, [itemId, v1]],
        ]),
      ).toMatch(/is not its newest approved version/);
      expect(await one(`SELECT live_version_id FROM content_item WHERE id = $1`, [itemId])).toEqual({ live_version_id: v1 });
    });

    it('freezes a file’s audience and version once its version is approved', async () => {
      const itemId = await newItem();
      const version = await newVersion(itemId);
      const file = (
        await one<{ id: string }>(
          `INSERT INTO stored_file (version_id, object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ($1, 'k-sf', 'roster.pdf', 'application/pdf', 10, $2, 'members') RETURNING id`,
          [version, HASH],
        )
      ).id;
      expect(await failure(app, `UPDATE stored_file SET audience = 'public' WHERE id = $1`, [file])).toBe('ok');
      expect(await failure(app, `UPDATE stored_file SET audience = 'members' WHERE id = $1`, [file])).toBe('ok');
      await approve(version);
      expect(await failure(app, `UPDATE stored_file SET audience = 'public' WHERE id = $1`, [file])).toMatch(/its version is approved/);
      const draft = await newVersion(itemId);
      expect(await failure(app, `UPDATE stored_file SET version_id = $2 WHERE id = $1`, [file, draft])).toMatch(/its version is approved/);
      // 0011 freezes the rest of the row as well.
      expect(await failure(app, `UPDATE stored_file SET filename = 'roster-2027.pdf' WHERE id = $1`, [file])).toMatch(/its files are frozen/);
    });
  });
});
