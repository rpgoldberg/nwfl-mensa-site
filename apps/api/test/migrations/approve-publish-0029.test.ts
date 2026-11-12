// EDITOR A1 (0029): approving and publishing are two steps, and the database holds the line between
// them. A version goes ready -> cleared (approved, not live) -> approved (published, live); ready ->
// approved is gone. A cleared version is frozen but for going back to draft, which drops its
// approval. Publishing records who published and when. A version approved by its approver's own
// exception (break-glass or one approver) is published by someone else, except the issue loader,
// which does both steps in one transaction. Exercised as the APPLICATION role unless the owner is the
// point of the test. Every name is made up.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pgLib from 'pg';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP, APP_PW, dockerExec, dropDatabase, failure, freshDatabase, live, migrate, MIGRATOR, MIGRATOR_PW, sqlstate, urlFor } from '../helpers/pg.js';

const STATE = '55000';
const CHECK = '23514';
const HASH = Buffer.alloc(32, 7);
const OTHER_HASH = Buffer.alloc(32, 9);
const ADMIN = { sub: 'sub-admin', groups: ['nwfl-members', 'nwfl-officers', 'nwfl-admin'] };
const LOADER = 'system:issue-loader';
const SET = `SELECT rule FROM approval_rule_set($1, $2, $3, $4, $5, $6)`;
const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

describe.skipIf(!live)('0029: approve, then publish', () => {
  let db: string;
  let app: pg.Client;
  let owner: pg.Client;
  let officeId: string;
  let n = 0;

  const connect = async (user: string, password: string, database = db): Promise<pg.Client> => {
    const client = new pgLib.Client({ connectionString: urlFor(user, password, database) });
    await client.connect();
    return client;
  };
  const one = async <T>(client: pg.Client, text: string, values: unknown[] = []): Promise<T> => (await client.query(text, values)).rows[0] as T;
  const flip = async (rule: string): Promise<void> => {
    await app.query(SET, ['content', rule, 'The Webmaster is away', ADMIN.sub, ADMIN.groups, null]);
  };

  /** A new item and its version 1, saved by `editor`, then ready. */
  const readyVersion = async (editor = 'sub-author'): Promise<{ itemId: string; id: string }> => {
    const itemId = (await one<{ id: string }>(app, `INSERT INTO content_item (slug, kind, office_id) VALUES ($1, 'article', $2) RETURNING id`, [`ap-${(n += 1)}`, officeId])).id;
    const id = (
      await one<{ id: string }>(app, `INSERT INTO content_version (item_id, n, title, created_by_sub, acting_office_id) VALUES ($1, 1, 'Title', $2, $3) RETURNING id`, [itemId, editor, officeId])
    ).id;
    await app.query(`INSERT INTO content_version_editor (version_id, subject) VALUES ($1, $2)`, [id, editor]);
    await app.query(`UPDATE content_version SET status = 'ready', content_hash = $2, ready_at = now() WHERE id = $1`, [id, HASH]);
    await app.query(`UPDATE content_item SET state = 'ready', working_version_id = $2 WHERE id = $1`, [itemId, id]);
    return { itemId, id };
  };
  const CLEAR = `UPDATE content_version SET status = 'cleared', approved_at = now(), approved_by_sub = $2, approval_kind = $3, approval_reason = $4,
                   public_ast = '{"blocks": []}' WHERE id = $1`;
  const clear = (id: string, by = 'sub-reviewer', kind = 'normal', reason: string | null = null, client = app): Promise<string> => sqlstate(client, CLEAR, [id, by, kind, reason]);
  const PUBLISH = `UPDATE content_version SET status = 'approved', published_at = now(), published_by_sub = $2 WHERE id = $1`;
  /** Publish as the API does: the version, then the item's live pointer, in one transaction. */
  const publish = async (itemId: string, id: string, by = 'sub-webmaster', client = app): Promise<string> => {
    await client.query('BEGIN');
    try {
      await client.query(PUBLISH, [id, by]);
      await client.query(`UPDATE content_item SET state = 'published', live_version_id = $2, working_version_id = NULL WHERE id = $1`, [itemId, id]);
      await client.query('COMMIT');
      return 'ok';
    } catch (error) {
      await client.query('ROLLBACK');
      return (error as { code?: string }).code ?? 'no-code';
    }
  };
  const statusOf = async (id: string): Promise<string> => (await one<{ status: string }>(app, `SELECT status FROM content_version WHERE id = $1`, [id])).status;

  beforeAll(async () => {
    db = await freshDatabase('nwfl_ap29');
    const run = await migrate(db);
    if (run.code !== 0) throw new Error(`migrate failed: ${run.stderr}`);
    app = await connect(APP, APP_PW);
    owner = await connect(MIGRATOR, MIGRATOR_PW);
    officeId = (await one<{ id: string }>(app, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`)).id;
  }, 60_000);

  afterAll(async () => {
    await Promise.all([app?.end(), owner?.end()]);
    if (db) await dropDatabase(db);
  });

  describe('the transitions', () => {
    it('refuses ready -> approved, even with every approval and publication column filled, for the owner too', async () => {
      const { id } = await readyVersion();
      const direct = `UPDATE content_version SET status = 'approved', approved_at = now(), approved_by_sub = 'sub-reviewer', approval_kind = 'normal',
                        public_ast = '{"blocks": []}', published_at = now(), published_by_sub = 'sub-webmaster' WHERE id = $1`;
      expect(await failure(app, direct, [id])).toMatch(/cannot go from ready to approved/);
      expect(await sqlstate(owner, direct, [id])).toBe(STATE);
      expect(await statusOf(id)).toBe('ready');
    });

    it('goes ready -> cleared -> approved, recording the rule at approval and the publisher at publication', async () => {
      const { itemId, id } = await readyVersion();
      expect(await clear(id)).toBe('ok');
      expect(await one(app, `SELECT status, approval_rule, published_at, published_by_sub FROM content_version WHERE id = $1`, [id])).toEqual({
        status: 'cleared',
        approval_rule: 'two_person',
        published_at: null,
        published_by_sub: null,
      });
      expect(await publish(itemId, id)).toBe('ok');
      const row = await one<{ status: string; published_by_sub: string; published_at: Date | null }>(app, `SELECT status, published_by_sub, published_at FROM content_version WHERE id = $1`, [id]);
      expect(row).toMatchObject({ status: 'approved', published_by_sub: 'sub-webmaster' });
      expect(row.published_at).toBeInstanceOf(Date);
    });

    it('refuses every other move into or out of cleared', async () => {
      const base = await readyVersion();
      const draftId = (await one<{ id: string }>(app, `INSERT INTO content_version (item_id, n, title, created_by_sub, acting_office_id) VALUES ($1, 2, 'T', 'sub-author', $2) RETURNING id`, [base.itemId, officeId])).id;
      expect(await failure(app, `UPDATE content_version SET status = 'cleared', content_hash = $2, approved_at = now(), approved_by_sub = 'w', approval_kind = 'normal', public_ast = '{"blocks": []}' WHERE id = $1`, [draftId, HASH])).toMatch(/cannot go from draft to cleared/);
      const { id } = await readyVersion();
      await clear(id);
      expect(await failure(app, `UPDATE content_version SET status = 'ready' WHERE id = $1`, [id])).toMatch(/cannot go from cleared to ready/);
      expect(await failure(app, `UPDATE content_version SET status = 'superseded' WHERE id = $1`, [id])).toMatch(/cannot go from cleared to superseded/);
      const published = await readyVersion();
      await clear(published.id);
      await publish(published.itemId, published.id);
      expect(await failure(app, `UPDATE content_version SET status = 'cleared' WHERE id = $1`, [published.id])).toMatch(/cannot go from approved to cleared/);
    });

    it('lets a cleared version be discarded, its approval dropped with it', async () => {
      const { itemId, id } = await readyVersion();
      await clear(id);
      await app.query(`UPDATE content_item SET working_version_id = NULL WHERE id = $1`, [itemId]);
      expect(await sqlstate(app, `UPDATE content_version SET status = 'discarded' WHERE id = $1`, [id])).toBe(CHECK);
      expect(
        await sqlstate(
          app,
          `UPDATE content_version SET status = 'discarded', approved_at = NULL, approved_by_sub = NULL, approval_kind = NULL, approval_reason = NULL, public_ast = NULL, approval_rule = NULL WHERE id = $1`,
          [id],
        ),
      ).toBe('ok');
    });
  });

  describe('what each status carries', () => {
    it('needs the approval recorded to clear: approver, time, kind and the public tree', async () => {
      const { id } = await readyVersion();
      expect(await sqlstate(app, `UPDATE content_version SET status = 'cleared' WHERE id = $1`, [id])).toBe(CHECK);
      expect(await sqlstate(app, `UPDATE content_version SET status = 'cleared', approved_at = now(), approved_by_sub = 'w', approval_kind = 'normal' WHERE id = $1`, [id])).toBe(CHECK);
      expect(await statusOf(id)).toBe('ready');
    });

    it('needs the publisher and the time to publish', async () => {
      const { itemId, id } = await readyVersion();
      await clear(id);
      expect(await sqlstate(app, `UPDATE content_version SET status = 'approved' WHERE id = $1`, [id])).toBe(CHECK);
      expect(await sqlstate(app, `UPDATE content_version SET status = 'approved', published_at = now() WHERE id = $1`, [id])).toBe(CHECK);
      expect(await sqlstate(app, `UPDATE content_version SET status = 'approved', published_by_sub = 'w' WHERE id = $1`, [id])).toBe(CHECK);
      expect(await statusOf(id)).toBe('cleared');
      expect(await publish(itemId, id)).toBe('ok');
    });

    it('refuses publication columns on a version that is not published, and approval columns on a draft or ready one', async () => {
      const { id } = await readyVersion();
      expect(await sqlstate(app, `UPDATE content_version SET published_at = now(), published_by_sub = 'w' WHERE id = $1`, [id])).toBe(CHECK);
      expect(await sqlstate(app, `UPDATE content_version SET approved_at = now() WHERE id = $1`, [id])).toBe(CHECK);
      expect(await sqlstate(app, `UPDATE content_version SET public_ast = '{"blocks": []}' WHERE id = $1`, [id])).toBe(CHECK);
      await clear(id);
      expect(await sqlstate(app, `UPDATE content_version SET published_at = now(), published_by_sub = 'w' WHERE id = $1`, [id])).toBe(CHECK);
    });
  });

  describe('the freeze at cleared', () => {
    it('freezes the authored content, the hash, targets, edition, ready time, approval, public tree and rule', async () => {
      const { id } = await readyVersion();
      await clear(id);
      for (const [column, value] of [
        ['title', `'Changed'`],
        ['body_src', `'changed'`],
        ['content_hash', `'\\x${OTHER_HASH.toString('hex')}'::bytea`],
        ['target_website', 'false'],
        ['target_email', 'true'],
        ['ready_at', `now() - interval '1 day'`],
        ['approved_at', `now() - interval '1 day'`],
        ['approved_by_sub', `'sub-someone-else'`],
        ['approval_reason', `'a reason'`],
        ['public_ast', `'{"blocks": [{"type": "paragraph", "children": []}]}'`],
        ['approval_rule', `'one_approver'`],
      ] as const) {
        expect(await failure(app, `UPDATE content_version SET ${column} = ${value} WHERE id = $1`, [id]), column).toMatch(/is cleared/);
        expect(await sqlstate(owner, `UPDATE content_version SET ${column} = ${value} WHERE id = $1`, [id]), column).not.toBe('ok');
      }
    });

    it('lets cleared go back to draft only with its approval dropped, keeping its hash and targets', async () => {
      const { id } = await readyVersion();
      await clear(id);
      // Keeping the approval on a draft: refused.
      expect(await sqlstate(app, `UPDATE content_version SET status = 'draft' WHERE id = $1`, [id])).not.toBe('ok');
      expect(await statusOf(id)).toBe('cleared');
      // Changing the hash on the way: refused.
      expect(
        await failure(
          app,
          `UPDATE content_version SET status = 'draft', approved_at = NULL, approved_by_sub = NULL, approval_kind = NULL, approval_reason = NULL, public_ast = NULL,
             approval_rule = NULL, content_hash = $2 WHERE id = $1`,
          [id, OTHER_HASH],
        ),
      ).toMatch(/is cleared/);
      expect(
        await sqlstate(
          app,
          `UPDATE content_version SET status = 'draft', approved_at = NULL, approved_by_sub = NULL, approval_kind = NULL, approval_reason = NULL, public_ast = NULL,
             approval_rule = NULL, search_public = NULL, search_members = NULL WHERE id = $1`,
          [id],
        ),
      ).toBe('ok');
      expect(await one(app, `SELECT status, content_hash, approved_by_sub, approval_rule FROM content_version WHERE id = $1`, [id])).toEqual({
        status: 'draft',
        content_hash: HASH,
        approved_by_sub: null,
        approval_rule: null,
      });
      // A draft again: its content may change, and it may be marked ready and approved again.
      expect(await sqlstate(app, `UPDATE content_version SET title = 'Edited' WHERE id = $1`, [id])).toBe('ok');
      expect(await sqlstate(app, `UPDATE content_version SET status = 'ready', ready_at = now() WHERE id = $1`, [id])).toBe('ok');
      expect(await clear(id, 'sub-second')).toBe('ok');
    });

    it('freezes the publication columns once published', async () => {
      const { itemId, id } = await readyVersion();
      await clear(id);
      await publish(itemId, id);
      expect(await failure(app, `UPDATE content_version SET published_by_sub = 'someone' WHERE id = $1`, [id])).toMatch(/is approved/);
      expect(await failure(app, `UPDATE content_version SET published_at = now() - interval '1 day' WHERE id = $1`, [id])).toMatch(/is approved/);
      expect(await sqlstate(owner, `UPDATE content_version SET published_by_sub = 'someone' WHERE id = $1`, [id])).toBe(STATE);
    });

    it("freezes a cleared version's files: no audience change, no new, moved or deleted file", async () => {
      const { id } = await readyVersion();
      const fileId = (
        await one<{ id: string }>(
          app,
          `INSERT INTO stored_file (version_id, object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ($1, 'k1', 'f.pdf', 'application/pdf', 3, $2, 'public') RETURNING id`,
          [id, HASH],
        )
      ).id;
      await clear(id);
      expect(await failure(app, `UPDATE stored_file SET audience = 'members' WHERE id = $1`, [fileId])).toMatch(/frozen/);
      expect(await failure(app, `UPDATE stored_file SET object_key = 'k9' WHERE id = $1`, [fileId])).toMatch(/frozen/);
      expect(await failure(app, `DELETE FROM stored_file WHERE id = $1`, [fileId])).toMatch(/frozen/);
      expect(
        await failure(app, `INSERT INTO stored_file (version_id, object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ($1, 'k2', 'g.pdf', 'application/pdf', 3, $2, 'public')`, [id, HASH]),
      ).toMatch(/frozen/);
    });
  });

  describe('the two-person rule at each step', () => {
    it('refuses an editor clearing their own version as a normal approval, for the owner too', async () => {
      const { id } = await readyVersion('sub-author');
      expect(await failure(app, CLEAR, [id, 'sub-author', 'normal', null])).toMatch(/an editor of this version approves it only by break-glass/);
      expect(await sqlstate(owner, CLEAR, [id, 'sub-author', 'normal', null])).toBe(STATE);
      expect(await statusOf(id)).toBe('ready');
    });

    it('refuses a single-approver approval under two-person', async () => {
      const { id } = await readyVersion('sub-author');
      expect(await failure(app, CLEAR, [id, 'sub-author', 'self_single', null])).toMatch(/single-approver approval/);
    });

    it("refuses the publisher of a break-glass approval who is its approver; someone else publishes it", async () => {
      const { itemId, id } = await readyVersion('sub-admin');
      expect(await clear(id, 'sub-admin', 'self_breakglass', 'The officers are away')).toBe('ok');
      expect(await publish(itemId, id, 'sub-admin')).toBe(STATE);
      expect(await publish(itemId, id, 'sub-admin', owner)).toBe(STATE);
      expect(await statusOf(id)).toBe('cleared');
      expect(await publish(itemId, id, 'sub-webmaster')).toBe('ok');
    });

    it('refuses the approver publishing their own single-approver approval, and any such publication once the rule is back to two-person', async () => {
      await flip('one_approver');
      try {
        const first = await readyVersion('sub-webmaster');
        expect(await clear(first.id, 'sub-webmaster', 'self_single')).toBe('ok');
        expect(await publish(first.itemId, first.id, 'sub-webmaster')).toBe(STATE);
        expect(await publish(first.itemId, first.id, 'sub-admin')).toBe('ok');
        const second = await readyVersion('sub-webmaster');
        expect(await clear(second.id, 'sub-webmaster', 'self_single')).toBe('ok');
        await flip('two_person');
        await app.query('BEGIN');
        const refused = await failure(app, PUBLISH, [second.id, 'sub-admin']);
        await app.query('ROLLBACK');
        expect(refused).toMatch(/approval rule is now two_person/);
        expect(await statusOf(second.id)).toBe('cleared');
      } finally {
        await flip('two_person');
      }
    });

    it('lets a normal approval be published by its approver, and by an editor of the version', async () => {
      const mine = await readyVersion('sub-author');
      await clear(mine.id, 'sub-webmaster');
      expect(await publish(mine.itemId, mine.id, 'sub-webmaster')).toBe('ok');
      const written = await readyVersion('sub-webmaster');
      await clear(written.id, 'sub-treasurer');
      expect(await publish(written.itemId, written.id, 'sub-webmaster')).toBe('ok');
    });
  });

  describe("the issue loader's exemption", () => {
    it('lets the loader approve and publish its own break-glass approval in one transaction', async () => {
      const { itemId, id } = await readyVersion(LOADER);
      await app.query('BEGIN');
      await app.query(CLEAR, [id, LOADER, 'self_breakglass', 'ISSUE-2026-11']);
      await app.query(PUBLISH, [id, LOADER]);
      await app.query(`UPDATE content_item SET state = 'published', live_version_id = $2, working_version_id = NULL WHERE id = $1`, [itemId, id]);
      await app.query('COMMIT');
      const row = await one<{ status: string; approved_at: Date; published_at: Date }>(app, `SELECT status, approved_at, published_at FROM content_version WHERE id = $1`, [id]);
      expect(row.status).toBe('approved');
      expect(row.published_at).toEqual(row.approved_at);
    });

    it('refuses the loader publishing in a later transaction what it approved in an earlier one', async () => {
      const { itemId, id } = await readyVersion(LOADER);
      expect(await clear(id, LOADER, 'self_breakglass', 'ISSUE-2026-12')).toBe('ok');
      expect(await publish(itemId, id, LOADER)).toBe(STATE);
      expect(await statusOf(id)).toBe('cleared');
    });

    it('refuses any other subject the exemption, even in one transaction, and a written publication time', async () => {
      for (const sub of ['system:other', 'sub-admin', 'system:issue-loader ']) {
        const { itemId, id } = await readyVersion(sub);
        await app.query('BEGIN');
        await app.query(CLEAR, [id, sub, 'self_breakglass', 'A reason']);
        const refused = await sqlstate(app, PUBLISH, [id, sub]);
        await app.query('ROLLBACK');
        expect(refused, sub).toBe(STATE);
        void itemId;
      }
      // The loader's subject, the approval in an earlier transaction, and the publication time written to match it.
      const { id } = await readyVersion(LOADER);
      await clear(id, LOADER, 'self_breakglass', 'ISSUE-2027-01');
      expect(await sqlstate(app, `UPDATE content_version SET status = 'approved', published_at = approved_at, published_by_sub = $2 WHERE id = $1`, [id, LOADER])).toBe(STATE);
    });
  });

  describe('the functions as 0029 wrote them', () => {
    it('runs 0029\'s bodies of the freeze, the guard and both file freezes, each with the pinned search_path', async () => {
      const file = readFileSync(path.join(MIGRATIONS, '0029_approve_publish.sql'), 'utf8');
      const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();
      for (const name of ['content_version_freeze', 'content_version_approval_guard', 'stored_file_frozen_once_approved', 'stored_file_frozen_whole']) {
        const body = new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\(\\)[^$]*\\$fn\\$([\\s\\S]*?)\\$fn\\$`).exec(file)?.[1];
        expect(body, name).toBeDefined();
        const { src, config } = await one<{ src: string; config: string[] }>(owner, `SELECT prosrc AS src, proconfig AS config FROM pg_proc WHERE proname = $1`, [name]);
        expect(squash(src), name).toBe(squash(body as string));
        expect(config, name).toEqual(['search_path=pg_catalog, public, pg_temp']);
      }
      // The replaced guard keeps 0023's grant: the app role cannot execute it.
      expect(await one(owner, `SELECT has_function_privilege('nwfl', 'content_version_approval_guard()', 'EXECUTE') AS can`)).toEqual({ can: false });
    });
  });

  describe('the backfill', () => {
    let old: string;
    afterAll(async () => {
      if (old) {
        await dockerExec(['sh', '-c', `rm -rf /tmp/${old}-pre`]);
        await dropDatabase(old);
      }
    });

    it('gives every version published before 0029 its approver and approval time as its publisher, and nothing else', async () => {
      old = await freshDatabase('nwfl_ap29_pre');
      const dir = `/tmp/${old}-pre`;
      // 0029 and every later migration left out, so the copy is the schema just before 0029.
      await dockerExec(['sh', '-c', `rm -rf ${dir} && mkdir -p ${dir} && cp /repo/migrations/*.sql ${dir}/ && for f in ${dir}/*.sql; do n=$(basename "$f"); n=\${n%%_*}; if [ "$n" -ge 29 ]; then rm "$f"; fi; done`]);
      const first = await migrate(old, dir);
      expect(first.code, first.stderr).toBe(0);
      const pre = await connect(APP, APP_PW, old);
      try {
        const office = (await one<{ id: string }>(pre, `INSERT INTO office (slug, title, kind) VALUES ('editor', 'Editor', 'appointed') RETURNING id`)).id;
        const item = (await one<{ id: string }>(pre, `INSERT INTO content_item (slug, kind, office_id) VALUES ('old', 'article', $1) RETURNING id`, [office])).id;
        const ids: string[] = [];
        for (const k of [1, 2, 3]) {
          ids.push((await one<{ id: string }>(pre, `INSERT INTO content_version (item_id, n, title, created_by_sub, acting_office_id) VALUES ($1, $2, 'T', 'sub-author', $3) RETURNING id`, [item, k, office])).id);
        }
        const [superseded, approved, ready] = ids as [string, string, string];
        for (const id of ids) await pre.query(`UPDATE content_version SET status = 'ready', content_hash = $2, ready_at = now() WHERE id = $1`, [id, HASH]);
        const approveOld = (id: string, by: string): Promise<unknown> =>
          pre.query(`UPDATE content_version SET status = 'approved', approved_at = now(), approved_by_sub = $2, approval_kind = 'normal', public_ast = '{"blocks": []}' WHERE id = $1`, [id, by]);
        await approveOld(superseded, 'sub-first');
        await pre.query(`UPDATE content_item SET state = 'ready' WHERE id = $1`, [item]);
        await pre.query(`UPDATE content_item SET state = 'published', live_version_id = $2 WHERE id = $1`, [item, superseded]);
        await pre.query('BEGIN');
        await approveOld(approved, 'sub-second');
        await pre.query(`UPDATE content_item SET live_version_id = $2 WHERE id = $1`, [item, approved]);
        await pre.query(`UPDATE content_version SET status = 'superseded' WHERE id = $1`, [superseded]);
        await pre.query('COMMIT');
        await pre.end();
        const second = await migrate(old);
        expect(second.code, second.stderr).toBe(0);
        const after = await connect(APP, APP_PW, old);
        try {
          const { rows } = await after.query<{ id: string; status: string; published_by_sub: string | null; same: boolean | null }>(
            `SELECT id, status, published_by_sub, published_at = approved_at AS same FROM content_version ORDER BY n`,
          );
          expect(rows).toEqual([
            { id: superseded, status: 'superseded', published_by_sub: 'sub-first', same: true },
            { id: approved, status: 'approved', published_by_sub: 'sub-second', same: true },
            { id: ready, status: 'ready', published_by_sub: null, same: null },
          ]);
          // The schema now refuses what the old code did: ready -> approved.
          expect(await failure(after, `UPDATE content_version SET status = 'approved', approved_at = now(), approved_by_sub = 'w', approval_kind = 'normal', public_ast = '{"blocks": []}', published_at = now(), published_by_sub = 'w' WHERE id = $1`, [ready])).toMatch(/cannot go from ready to approved/);
        } finally {
          await after.end();
        }
      } finally {
        await pre.end().catch(() => undefined);
      }
    });
  });
});
