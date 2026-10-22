// API-FIX3: the round-2 challenger's schema findings, each pinned by a test.
// Exercised as the APPLICATION role.
//   - A file of an approved version is frozen whole: no key swap, no delete,
//     no new file, and no file moved onto it (0010 froze its audience only).
//   - An edition's status only moves forward, and a frozen edition's pins are
//     immutable but for the takedown mark.
import type pg from 'pg';
import pgLib from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP, APP_PW, dropDatabase, failure, freshDatabase, live, migrate, urlFor } from '../helpers/pg.js';

const HASH = Buffer.alloc(32, 7);

describe.skipIf(!live)('schema after API-FIX3', () => {
  let db: string;
  let app: pg.Client;
  let officeId: string;
  let n = 0;

  const one = async <T>(text: string, values: unknown[] = []): Promise<T> => (await app.query(text, values)).rows[0] as T;
  const newItem = async (): Promise<string> =>
    (await one<{ id: string }>(`INSERT INTO content_item (slug, kind, office_id) VALUES ($1, 'article', $2) RETURNING id`, [`f3-${(n += 1)}`, officeId])).id;
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
      `UPDATE content_version SET status = 'approved', approved_at = now(), approved_by_sub = 'w', approval_kind = 'normal', public_ast = '{"blocks": []}' WHERE id = $1`,
      [id],
    );
  };
  const file = async (versionId: string, key: string, audience: string): Promise<string> =>
    (
      await one<{ id: string }>(
        `INSERT INTO stored_file (version_id, object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ($1, $2, $2, 'application/pdf', 10, $3, $4) RETURNING id`,
        [versionId, key, HASH, audience],
      )
    ).id;

  beforeAll(async () => {
    db = await freshDatabase('nwfl_fix3');
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

  describe('the files of an approved version', () => {
    it('can be added, changed, moved and removed while the version is a draft', async () => {
      const draft = await newVersion(await newItem());
      const other = await newVersion(await newItem());
      const f = await file(draft, 'k-draft', 'members');
      expect(await failure(app, `UPDATE stored_file SET object_key = 'k-draft-2', audience = 'public' WHERE id = $1`, [f])).toBe('ok');
      expect(await failure(app, `UPDATE stored_file SET version_id = $2 WHERE id = $1`, [f, other])).toBe('ok');
      expect(await failure(app, `DELETE FROM stored_file WHERE id = $1`, [f])).toBe('ok');
    });

    it('are frozen whole once it is approved: no key swap, no delete and re-insert, no new file, nothing moved onto it', async () => {
      const version = await newVersion(await newItem());
      const roster = await file(version, 'obj/members-roster.pdf', 'members');
      const flyer = await file(version, 'obj/flyer.pdf', 'public');
      await approve(version);
      expect(await failure(app, `UPDATE stored_file SET object_key = 'tmp' WHERE id = $1`, [roster])).toMatch(/its files are frozen/);
      expect(await failure(app, `UPDATE stored_file SET object_key = 'obj/members-roster.pdf' WHERE id = $1`, [flyer])).toMatch(/its files are frozen/);
      expect(await failure(app, `DELETE FROM stored_file WHERE id = $1`, [roster])).toMatch(/its files are frozen/);
      expect(await failure(app, `INSERT INTO stored_file (version_id, object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ($1, 'obj/new.pdf', 'roster.pdf', 'application/pdf', 10, $2, 'public')`, [version, HASH])).toMatch(
        /its files are frozen/,
      );
      const loose = await file(await newVersion(await newItem()), 'obj/loose.pdf', 'public');
      expect(await failure(app, `UPDATE stored_file SET version_id = $2 WHERE id = $1`, [loose, version])).toMatch(/its files are frozen/);
      const { rows } = await app.query(`SELECT object_key, audience FROM stored_file WHERE version_id = $1 ORDER BY object_key`, [version]);
      expect(rows).toEqual([
        { object_key: 'obj/flyer.pdf', audience: 'public' },
        { object_key: 'obj/members-roster.pdf', audience: 'members' },
      ]);
    });
  });

  describe('editions and their pins', () => {
    const edition = async (slug: string): Promise<string> =>
      (await one<{ id: string }>(`INSERT INTO edition (slug, title, kind, period_start, period_end) VALUES ($1, 'T', 'regular', '2027-01-01', '2027-01-31') RETURNING id`, [slug])).id;

    it('moves an edition forward only', async () => {
      const id = await edition('2027-01');
      expect(await failure(app, `UPDATE edition SET status = 'collecting' WHERE id = $1`, [id])).toBe('ok');
      expect(await failure(app, `UPDATE edition SET status = 'planning' WHERE id = $1`, [id])).toMatch(/only moves forward/);
      expect(await failure(app, `UPDATE edition SET status = 'proof', frozen_at = now() WHERE id = $1`, [id])).toBe('ok');
      expect(await failure(app, `UPDATE edition SET status = 'planning', frozen_at = NULL WHERE id = $1`, [id])).toMatch(/only moves forward/);
      expect(await failure(app, `UPDATE edition SET status = 'drafting' WHERE id = $1`, [id])).toMatch(/only moves forward/);
    });

    it('keeps a frozen edition’s pins as they were: no new pin, no delete, no repoint; only the takedown mark, once', async () => {
      const itemId = await newItem();
      const v1 = await newVersion(itemId);
      await approve(v1);
      const id = await edition('2027-02');
      expect(await failure(app, `INSERT INTO edition_item (edition_id, item_id, version_id) VALUES ($1, $2, $3)`, [id, itemId, v1])).toBe('ok');
      await app.query(`UPDATE edition SET status = 'proof', frozen_at = now() WHERE id = $1`, [id]);
      const other = await newItem();
      const ov = await newVersion(other);
      await approve(ov);
      expect(await failure(app, `INSERT INTO edition_item (edition_id, item_id, version_id) VALUES ($1, $2, $3)`, [id, other, ov])).toMatch(/pins are frozen/);
      expect(await failure(app, `DELETE FROM edition_item WHERE edition_id = $1`, [id])).toMatch(/pins are frozen/);
      expect(await failure(app, `UPDATE edition_item SET pinned_at = now() - interval '1 day' WHERE edition_id = $1`, [id])).toMatch(/pins are frozen/);
      expect(await failure(app, `UPDATE edition_item SET taken_down_at = now() WHERE edition_id = $1`, [id])).toBe('ok');
      // Once: a later transaction cannot set the mark again, even to its own now().
      expect(await failure(app, `UPDATE edition_item SET taken_down_at = now() WHERE edition_id = $1`, [id])).toMatch(/pins are frozen/);
      expect(await failure(app, `UPDATE edition_item SET taken_down_at = NULL WHERE edition_id = $1`, [id])).toMatch(/pins are frozen/);
      expect(await failure(app, `UPDATE edition_item SET taken_down_at = now() - interval '1 day' WHERE edition_id = $1`, [id])).toMatch(/pins are frozen/);
    });
  });

  it('documents why a sign-up keeps the name and email after its decision', async () => {
    const { rows } = await app.query<{ comment: string }>(`SELECT col_description('signup_request'::regclass, attnum) AS comment FROM pg_attribute WHERE attrelid = 'signup_request'::regclass AND attname = 'display_name'`);
    expect(rows[0]?.comment).toMatch(/kept after the decision/);
  });
});
