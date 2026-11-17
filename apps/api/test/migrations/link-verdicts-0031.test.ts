// L-ITEM (0031): the link checker's verdicts. The audit log learns the link checker as an actor
// (linkcheck) and a list of addresses as a subject (link_list: each list handed out is audited as
// links_read); the gate reads an item's machine verdicts by URL through their own index. Exercised as
// the APPLICATION role. Every name is made up.
import pgLib from 'pg';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP, APP_PW, dropDatabase, freshDatabase, live, migrate, sqlstate, urlFor } from '../helpers/pg.js';

const CHECK = '23514';

describe.skipIf(!live)('0031: the link checker in the audit log', () => {
  let db: string;
  let app: pg.Client;

  beforeAll(async () => {
    db = await freshDatabase('nwfl_lc31');
    const run = await migrate(db);
    if (run.code !== 0) throw new Error(`migrate failed: ${run.stderr}`);
    app = new pgLib.Client({ connectionString: urlFor(APP, APP_PW, db) });
    await app.connect();
  }, 60_000);

  afterAll(async () => {
    await app?.end();
    if (db) await dropDatabase(db);
  });

  const AUDIT = `INSERT INTO audit_event (actor_kind, actor_sub, action, subject_kind, subject_id, payload) VALUES ($1, 'svc-nwfl-linkcheck', 'links_read', $2, $3, '{"audience": "officers", "urls": 2}')`;

  it('takes the link checker as an actor and a list of addresses as a subject', async () => {
    expect(await sqlstate(app, AUDIT, ['linkcheck', 'link_list', 'a'.repeat(64)])).toBe('ok');
  });

  it('still refuses an actor or a subject it does not know', async () => {
    expect(await sqlstate(app, AUDIT, ['crawler', 'link_list', 'x'])).toBe(CHECK);
    expect(await sqlstate(app, AUDIT, ['linkcheck', 'link', 'x'])).toBe(CHECK);
  });

  it('keeps every earlier actor and subject', async () => {
    for (const kind of ['user', 'agent', 'verifier', 'system']) expect(await sqlstate(app, AUDIT, [kind, 'content_item', 'x'])).toBe('ok');
    for (const subject of ['content_version', 'edition', 'member_account', 'redaction_mark_removal', 'approval_rule']) {
      expect(await sqlstate(app, `INSERT INTO audit_event (actor_kind, action, subject_kind, subject_id) VALUES ('system', 'seed', $1, 'x')`, [subject])).toBe('ok');
    }
  });

  it("indexes an item's machine verdicts by URL, latest last", async () => {
    const { rows } = await app.query<{ def: string }>(`SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'content_link_check_machine'`);
    expect(rows.map((r) => r.def)).toEqual([expect.stringMatching(/\(item_id, url, id\) WHERE \(source = 'machine'::text\)$/)]);
  });
});
