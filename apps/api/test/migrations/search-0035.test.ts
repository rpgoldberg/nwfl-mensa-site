// ARCHIVE-SEARCH S3: 0035_search_read.sql. The ledger stamp of an app re-record (version_rerecorded.at), which the search
// read sets against a mark's created_at (the same stamp, 0016). Set by a trigger on every insert and update, whatever the statement gives; the app
// role reads it and writes nothing. Run against a real Postgres. Everything here is synthetic; every name is made up.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordItems } from '../../src/ledger/ledger.js';
import { type Api, insertId, startApi } from '../helpers/api.js';
import { paragraph, publishItem, text } from '../helpers/content.js';
import { APP, APP_PW, live, sqlstate, url, urlFor } from '../helpers/pg.js';

describe.skipIf(!live)('0035: when the app last re-recorded a version for an audience', () => {
  let api: Api;
  let owner: pg.Client;
  let app: pg.Client;
  let versionId: string;

  const stamp = async (): Promise<Date> =>
    (await owner.query<{ at: Date }>(`SELECT at FROM version_rerecorded WHERE version_id = $1 AND audience = 'public'`, [versionId])).rows[0]!.at;

  beforeAll(async () => {
    api = await startApi('nwfl_search0035');
    const office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
    versionId = (await publishItem(api.pool, { slug: 'stamp-item', officeId: office, title: 'Stamp item', body: { blocks: [paragraph(text('A synthetic item.'))] } })).versionId;
    const database = (await api.pool.query<{ db: string }>(`SELECT current_database() AS db`)).rows[0]!.db;
    owner = new pg.Client({ connectionString: urlFor('postgres', new URL(url as string).password, database) });
    await owner.connect();
    app = new pg.Client({ connectionString: urlFor(APP, APP_PW, database) });
    await app.connect();
  });

  afterAll(async () => {
    for (const client of [owner, app]) await client?.end();
    await api?.close();
  });

  it('is the ledger stamp of the transaction that wrote the row, on insert and on update, whatever the statement gives', async () => {
    await owner.query(`DELETE FROM version_rerecorded WHERE version_id = $1 AND audience = 'public'`, [versionId]);
    await owner.query('BEGIN');
    const now = (await owner.query<{ now: Date }>(`SELECT publication_ledger_stamp() AS now`)).rows[0]!.now;
    await owner.query(`INSERT INTO version_rerecorded (version_id, audience, seq, at) VALUES ($1, 'public', 1, '2001-01-01')`, [versionId]);
    await owner.query('COMMIT');
    expect((await stamp()).getTime()).toBe(now.getTime());
    await owner.query('BEGIN');
    const later = (await owner.query<{ now: Date }>(`SELECT publication_ledger_stamp() AS now`)).rows[0]!.now;
    await owner.query(`UPDATE version_rerecorded SET seq = 2, at = '2001-01-01' WHERE version_id = $1 AND audience = 'public'`, [versionId]);
    await owner.query('COMMIT');
    expect((await stamp()).getTime()).toBe(later.getTime());
    expect(later.getTime()).toBeGreaterThan(now.getTime());
  });

  it('is stamped by the app\'s re-record (search_item_put) with its transaction\'s stamp, the stamp a mark made in it gets', async () => {
    const before = await stamp();
    const item = (await api.pool.query<{ item_id: string }>(`SELECT item_id FROM content_version WHERE id = $1`, [versionId])).rows[0]!.item_id;
    const client = await api.pool.connect();
    try {
      await client.query('BEGIN');
      const made = await client.query<{ created: Date }>(
        `SELECT (redaction_mark_add('content_item', $1, 'body', 'synthetic', 'member_address', 'sub-officer', ARRAY['nwfl-officers'], NULL)).created_at AS created`,
        [item],
      );
      await recordItems(client, [item]);
      await client.query('COMMIT');
      const created = made.rows[0]!.created;
      expect((await stamp()).getTime()).toBe(created.getTime());
      expect(created.getTime()).toBeGreaterThan(before.getTime());
    } finally {
      client.release();
    }
  });

  it('the app\'s role reads it and may not write it', async () => {
    expect((await app.query(`SELECT at FROM version_rerecorded WHERE version_id = $1`, [versionId])).rowCount).toBeGreaterThanOrEqual(1);
    expect(await sqlstate(app, `UPDATE version_rerecorded SET at = now() WHERE version_id = $1`, [versionId])).toBe('42501');
    expect(await sqlstate(app, `SELECT version_rerecorded_at()`)).toBe('42501');
  });
});
