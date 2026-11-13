// EDITOR A3b (0030): content_link_check, the reviewers' answers on a piece's links (and, from
// L-ITEM, the machine's verdicts). Append-only twice over, as the audit log: the app role may insert
// the columns it names and read, never update, delete or truncate, and a trigger refuses all three
// for every role. A human answer binds to a READY version and to its ready time as it stands, and
// comes from someone who did not edit that version: the database holds that as well as the API.
// Also AUDIT-IDX: the audit log is indexed by item. Exercised as the APPLICATION role unless the
// owner is the point of the test. Every name is made up.
import pgLib from 'pg';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP, APP_PW, dropDatabase, failure, freshDatabase, live, migrate, MIGRATOR, MIGRATOR_PW, sqlstate, urlFor } from '../helpers/pg.js';

const CHECK = '23514';
const DENIED = '42501';
const RAISED = 'P0001';
const HASH = Buffer.alloc(32, 7);
const LINKS = Buffer.alloc(32, 3);

describe.skipIf(!live)('0030: the link checks', () => {
  let db: string;
  let app: pg.Client;
  let owner: pg.Client;
  let officeId: string;
  let n = 0;

  const connect = async (user: string, password: string): Promise<pg.Client> => {
    const client = new pgLib.Client({ connectionString: urlFor(user, password, db) });
    await client.connect();
    return client;
  };
  const one = async <T>(client: pg.Client, text: string, values: unknown[] = []): Promise<T> => (await client.query(text, values)).rows[0] as T;

  /** A new item and its version 1, saved by `editor`, then ready. */
  const readyVersion = async (editor = 'sub-author'): Promise<{ itemId: string; id: string }> => {
    const itemId = (await one<{ id: string }>(app, `INSERT INTO content_item (slug, kind, office_id) VALUES ($1, 'article', $2) RETURNING id`, [`lc-${(n += 1)}`, officeId])).id;
    const id = (
      await one<{ id: string }>(app, `INSERT INTO content_version (item_id, n, title, created_by_sub, acting_office_id) VALUES ($1, 1, 'Title', $2, $3) RETURNING id`, [itemId, editor, officeId])
    ).id;
    await app.query(`INSERT INTO content_version_editor (version_id, subject) VALUES ($1, $2)`, [id, editor]);
    await app.query(`UPDATE content_version SET status = 'ready', content_hash = $2, ready_at = now() WHERE id = $1`, [id, HASH]);
    await app.query(`UPDATE content_item SET state = 'ready', working_version_id = $2 WHERE id = $1`, [itemId, id]);
    return { itemId, id };
  };
  const HUMAN = `INSERT INTO content_link_check (item_id, version_id, url, source, answer, note, ready_at_seen, links_sha256, by_sub, acting_office_id)
                 SELECT $1, $2, $3, 'human', $4, $5, coalesce($6, v.ready_at), $7, $8, $9 FROM content_version v WHERE v.id = $2`;
  /** A reviewer's answer, as the API writes it: the version's own ready time unless `seen` says otherwise. */
  const answer = (
    client: pg.Client,
    v: { itemId: string; id: string },
    options: { url?: string; answer?: string; note?: string | null; seen?: Date | null; by?: string; links?: Buffer | null; office?: string | null } = {},
  ): Promise<string> =>
    sqlstate(client, HUMAN, [
      v.itemId,
      v.id,
      options.url ?? 'https://www.facebook.com/groups/example',
      options.answer ?? 'yes',
      options.note ?? null,
      options.seen ?? null,
      options.links === undefined ? LINKS : options.links,
      options.by ?? 'sub-reviewer',
      options.office === undefined ? officeId : options.office,
    ]);
  const MACHINE = `INSERT INTO content_link_check (item_id, url, source, answer, reasons, by_sub) VALUES ($1, $2, 'machine', $3, $4, 'svc-linkcheck')`;

  beforeAll(async () => {
    db = await freshDatabase('nwfl_lc30');
    const run = await migrate(db);
    if (run.code !== 0) throw new Error(`migrate failed: ${run.stderr}`);
    app = await connect(APP, APP_PW);
    owner = await connect(MIGRATOR, MIGRATOR_PW);
    officeId = (await one<{ id: string }>(app, `INSERT INTO office (slug, title, kind) VALUES ('treasurer', 'Treasurer', 'appointed') RETURNING id`)).id;
  }, 60_000);

  afterAll(async () => {
    await Promise.all([app?.end(), owner?.end()]);
    if (db) await dropDatabase(db);
  });

  describe('a human answer', () => {
    it('is stored for a ready version, numbered and timed by the database, with the version ready time and the acting office', async () => {
      const v = await readyVersion();
      expect(await answer(app, v, { note: 'opens the group page' })).toBe('ok');
      const row = await one<Record<string, unknown>>(
        app,
        `SELECT c.id, c.at, c.source, c.answer, c.note, c.reasons, c.by_sub, c.acting_office_id, c.ready_at_seen = v.ready_at AS bound
         FROM content_link_check c JOIN content_version v ON v.id = c.version_id WHERE c.version_id = $1`,
        [v.id],
      );
      expect(row).toMatchObject({ source: 'human', answer: 'yes', note: 'opens the group page', reasons: [], by_sub: 'sub-reviewer', acting_office_id: officeId, bound: true });
      expect(row['at']).toBeInstanceOf(Date);
    });

    it('takes yes or no only, and needs its version, its ready time and the list hash', async () => {
      const v = await readyVersion();
      expect(await answer(app, v, { answer: 'ok' })).toBe(CHECK);
      expect(await answer(app, v, { answer: 'maybe' })).toBe(CHECK);
      expect(await answer(app, v, { links: null })).toBe(CHECK);
      expect(await answer(app, v, { links: Buffer.alloc(31) })).toBe(CHECK);
      expect(await sqlstate(app, `INSERT INTO content_link_check (item_id, url, source, answer, ready_at_seen, links_sha256, by_sub) VALUES ($1, 'https://x.example.org/', 'human', 'yes', now(), $2, 's')`, [v.itemId, LINKS])).toBe(CHECK);
      expect(await answer(app, v, { answer: 'no' })).toBe('ok');
    });

    it('is refused for a version that is not ready: a draft, or one already approved', async () => {
      const v = await readyVersion();
      await app.query(`UPDATE content_version SET status = 'draft' WHERE id = $1`, [v.id]);
      expect(await failure(app, HUMAN, [v.itemId, v.id, 'https://x.example.org/', 'yes', null, null, LINKS, 'sub-reviewer', null])).toMatch(/only a ready version's links are answered/);
      const cleared = await readyVersion();
      await app.query(`UPDATE content_version SET status = 'cleared', approved_at = now(), approved_by_sub = 'sub-reviewer', approval_kind = 'normal', public_ast = '{"blocks": []}' WHERE id = $1`, [cleared.id]);
      expect(await answer(app, cleared)).toBe(RAISED);
    });

    it('is refused when its ready time is not the version ready time as it stands (an older round)', async () => {
      const v = await readyVersion();
      expect(await answer(app, v, { seen: new Date('2026-01-01T00:00:00Z') })).toBe(RAISED);
      expect(await failure(app, HUMAN, [v.itemId, v.id, 'https://x.example.org/', 'yes', null, new Date('2026-01-01T00:00:00Z'), LINKS, 'sub-reviewer', null])).toMatch(/ready time/);
    });

    it('is refused from someone who edited the version, the owner included', async () => {
      const v = await readyVersion('sub-author');
      expect(await failure(app, HUMAN, [v.itemId, v.id, 'https://x.example.org/', 'yes', null, null, LINKS, 'sub-author', null])).toMatch(/edited this version/);
      expect(await answer(owner, v, { by: 'sub-author' })).toBe(RAISED);
    });

    it("records the answerer's groups as they were, for the history label; none by default", async () => {
      const v = await readyVersion();
      const withGroups = `INSERT INTO content_link_check (item_id, version_id, url, source, answer, ready_at_seen, links_sha256, by_sub, by_groups)
                          SELECT $1, $2, 'https://x.example.org/', 'human', 'yes', ready_at, $3, 'sub-reviewer', $4 FROM content_version WHERE id = $2`;
      expect(await sqlstate(app, withGroups, [v.itemId, v.id, LINKS, ['nwfl-officers', 'nwfl-webmaster']])).toBe('ok');
      expect(await answer(app, v)).toBe('ok');
      const rows = (await app.query<{ by_groups: string[] }>(`SELECT by_groups FROM content_link_check WHERE version_id = $1 ORDER BY id`, [v.id])).rows;
      expect(rows.map((r) => r.by_groups)).toEqual([['nwfl-officers', 'nwfl-webmaster'], []]);
    });

    it('names a version of its own item only', async () => {
      const v = await readyVersion();
      const other = await readyVersion();
      expect(await sqlstate(app, HUMAN, [other.itemId, v.id, 'https://x.example.org/', 'yes', null, null, LINKS, 'sub-reviewer', null])).toBe('23503');
    });

    it('keeps a URL between 1 and 2048 characters and a note to 2000', async () => {
      const v = await readyVersion();
      expect(await answer(app, v, { url: '' })).toBe(CHECK);
      expect(await answer(app, v, { url: `https://x.example.org/${'a'.repeat(2048)}` })).toBe(CHECK);
      expect(await answer(app, v, { note: 'n'.repeat(2001) })).toBe(CHECK);
    });
  });

  describe('a machine verdict (L-ITEM writes these)', () => {
    it('is ok, confirm or drop, for no version, with its reasons as a list', async () => {
      const v = await readyVersion();
      expect(await sqlstate(app, MACHINE, [v.itemId, 'https://x.example.org/', 'ok', '[]'])).toBe('ok');
      expect(await sqlstate(app, MACHINE, [v.itemId, 'https://x.example.org/', 'drop', '["gone"]'])).toBe('ok');
      expect(await sqlstate(app, MACHINE, [v.itemId, 'https://x.example.org/', 'yes', '[]'])).toBe(CHECK);
      expect(await sqlstate(app, MACHINE, [v.itemId, 'https://x.example.org/', 'ok', '{}'])).toBe(CHECK);
      expect(
        await sqlstate(app, `INSERT INTO content_link_check (item_id, version_id, url, source, answer, by_sub) VALUES ($1, $2, 'https://x.example.org/', 'machine', 'ok', 'svc')`, [v.itemId, v.id]),
      ).toBe(CHECK);
    });
  });

  describe('append-only, as the audit log', () => {
    it('refuses UPDATE, DELETE and TRUNCATE to the app role by grant, and to the owner by trigger', async () => {
      const v = await readyVersion();
      await answer(app, v);
      expect(await sqlstate(app, `UPDATE content_link_check SET answer = 'no' WHERE version_id = $1`, [v.id])).toBe(DENIED);
      expect(await sqlstate(app, `DELETE FROM content_link_check WHERE version_id = $1`, [v.id])).toBe(DENIED);
      expect(await sqlstate(app, `TRUNCATE content_link_check`)).toBe(DENIED);
      expect(await failure(owner, `UPDATE content_link_check SET answer = 'no' WHERE version_id = $1`, [v.id])).toMatch(/content_link_check is append-only: UPDATE refused/);
      expect(await sqlstate(owner, `DELETE FROM content_link_check WHERE version_id = $1`, [v.id])).toBe(RAISED);
      expect(await sqlstate(owner, `TRUNCATE content_link_check`)).toBe(RAISED);
      expect((await one<{ n: string }>(app, `SELECT count(*) AS n FROM content_link_check WHERE version_id = $1`, [v.id])).n).toBe('1');
    });

    it('numbers and times each row itself: the app role cannot write id or at', async () => {
      const v = await readyVersion();
      const backdated = `INSERT INTO content_link_check (item_id, version_id, url, source, answer, ready_at_seen, links_sha256, by_sub, at)
                         SELECT $1, $2, 'https://x.example.org/', 'human', 'yes', ready_at, $3, 'sub-reviewer', '2020-01-01' FROM content_version WHERE id = $2`;
      expect(await sqlstate(app, backdated, [v.itemId, v.id, LINKS])).toBe(DENIED);
      const forcedId = `INSERT INTO content_link_check (id, item_id, version_id, url, source, answer, ready_at_seen, links_sha256, by_sub) OVERRIDING SYSTEM VALUE
                        SELECT 1, $1, $2, 'https://x.example.org/', 'human', 'yes', ready_at, $3, 'sub-reviewer' FROM content_version WHERE id = $2`;
      expect(await sqlstate(app, forcedId, [v.itemId, v.id, LINKS])).toBe(DENIED);
    });
  });

  it('AUDIT-IDX: indexes the audit log by item', async () => {
    const row = await one<{ def: string } | undefined>(app, `SELECT indexdef AS def FROM pg_indexes WHERE tablename = 'audit_event' AND indexname = 'audit_event_item'`);
    expect(row?.def).toMatch(/\(item_id\)/);
  });
});
