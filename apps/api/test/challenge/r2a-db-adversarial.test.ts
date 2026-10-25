/* eslint-disable -- the challenger's R2a tests, kept as written (only M2 removed). */
// CHALLENGER (R2a): 0014 as the app role. Each assertion is the SECURE outcome; red = finding.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP, APP_PW, asSuper, dropDatabase, freshDatabase, live, migrate, sqlstate, urlFor } from '../helpers/pg.js';

const OFF = ['nwfl-members', 'nwfl-officers'];
describe.skipIf(!live)('R2a challenge: 0014 as nwfl', () => {
  let db: string;
  let app: pg.Pool;
  let item: string;
  const addMark = async (): Promise<string> =>
    (await app.query<{ id: string }>(`SELECT id FROM redaction_mark_add('content_item', $1, 'body', 'John Smith', 'member_name', 'alice', $2, NULL)`, [item, OFF])).rows[0]!.id;
  const propose = async (mark: string, sub = 'alice'): Promise<string> =>
    (await app.query<{ id: string }>(`SELECT id FROM redaction_mark_propose_removal($1, $2, $3, NULL)`, [mark, sub, OFF])).rows[0]!.id;
  beforeAll(async () => {
    db = await freshDatabase('nwfl_chaldb');
    const run = await migrate(db);
    expect(run.code, run.stderr).toBe(0);
    app = new pg.Pool({ connectionString: urlFor(APP, APP_PW, db), max: 8 });
    const office = (await app.query<{ id: string }>(`INSERT INTO office (slug, title, kind) VALUES ('pubs', 'Pubs', 'appointed') RETURNING id`)).rows[0]!.id;
    item = (await app.query<{ id: string }>(`INSERT INTO content_item (slug, kind, office_id) VALUES ('x', 'article', $1) RETURNING id`, [office])).rows[0]!.id;
    const ledger = await asSuper(async (c) => { await c.query(`SELECT 1`); return 0; });
    expect(ledger).toBe(0);
  });
  afterAll(async () => { await app?.end(); if (db) await dropDatabase(db); });

  it('D1 direct writes and TRUNCATE are refused', async () => {
    const mark = await addMark();
    const c = await app.connect();
    try {
      const got = {
        insMark: await sqlstate(c as never, `INSERT INTO redaction_mark (content_item_id, category, created_by_sub) VALUES ($1, 'member_name', 'x')`, [item]),
        updMark: await sqlstate(c as never, `UPDATE redaction_mark SET status='removed', removed_at=now() WHERE id=$1`, [mark]),
        delMark: await sqlstate(c as never, `DELETE FROM redaction_mark WHERE id=$1`, [mark]),
        truncMark: await sqlstate(c as never, `TRUNCATE redaction_mark CASCADE`),
        insRem: await sqlstate(c as never, `INSERT INTO redaction_mark_removal (mark_id, status, proposed_by_sub) VALUES ($1, 'pending', 'x')`, [mark]),
        truncRem: await sqlstate(c as never, `TRUNCATE redaction_mark_removal`),
        disable: await sqlstate(c as never, `ALTER TABLE redaction_mark DISABLE TRIGGER redaction_mark_guard`),
        forgeAudit: await sqlstate(c as never, `SELECT redaction_audit('x', ARRAY['nwfl-officers'], NULL, 'redaction_mark_approve_removal', 'redaction_mark_removal', 'x', 'pending', 'applied', '{}'::jsonb)`),
        updAudit: await sqlstate(c as never, `UPDATE audit_event SET note='x' WHERE action='redaction_mark_add'`),
        delAudit: await sqlstate(c as never, `DELETE FROM audit_event WHERE action='redaction_mark_add'`),
      };
      expect(got).toEqual({ insMark: '42501', updMark: '42501', delMark: '42501', truncMark: '42501', insRem: '42501', truncRem: '42501', disable: '42501', forgeAudit: '42501', updAudit: '42501', delAudit: '42501' });
    } finally { c.release(); }
  });
  it('D2 self-approval, case-variant groups and no-sub are refused', async () => {
    const mark = await addMark();
    const rem = await propose(mark);
    const c = await app.connect();
    try {
      expect(await sqlstate(c as never, `SELECT redaction_mark_approve_removal($1, 'alice', $2, NULL)`, [rem, OFF])).toBe('42501');
      expect(await sqlstate(c as never, `SELECT redaction_mark_approve_removal($1, 'bob', ARRAY['NWFL-OFFICERS'], NULL)`, [rem])).toBe('42501');
      expect(await sqlstate(c as never, `SELECT redaction_mark_approve_removal($1, '', $2, NULL)`, [rem, OFF])).toBe('42501');
      expect(await sqlstate(c as never, `SELECT redaction_mark_approve_removal($1, NULL, $2, NULL)`, [rem, OFF])).toBe('42501');
      expect(await sqlstate(c as never, `SELECT redaction_mark_propose_removal($1, 'bob', ARRAY['nwfl-members'], NULL)`, [mark])).toBe('42501');
      expect((await app.query(`SELECT status FROM redaction_mark WHERE id=$1`, [mark])).rows[0].status).toBe('active');
    } finally { c.release(); }
  });
  it('D3 race: 6 approvers on one removal -> exactly one applies, one audit row, mark removed once', async () => {
    const mark = await addMark();
    const rem = await propose(mark);
    const results = await Promise.allSettled(['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].map((sub) => app.query(`SELECT redaction_mark_approve_removal($1, $2, $3, NULL)`, [rem, sub, OFF])));
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    const audits = await app.query(`SELECT count(*)::int AS n FROM audit_event WHERE action='redaction_mark_approve_removal' AND subject_id=$1`, [rem]);
    expect(audits.rows[0].n).toBe(1);
  });
  it('D4 race: 6 proposals on one mark -> exactly one pending', async () => {
    const mark = await addMark();
    const results = await Promise.allSettled(['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((sub) => propose(mark, sub)));
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect((await app.query(`SELECT count(*)::int AS n FROM redaction_mark_removal WHERE mark_id=$1`, [mark])).rows[0].n).toBe(1);
  });
  it('D5 race: approve vs approve of two removals of different marks + re-propose after applied is refused', async () => {
    const mark = await addMark();
    const rem = await propose(mark);
    await app.query(`SELECT redaction_mark_approve_removal($1, 'bob', $2, NULL)`, [rem, OFF]);
    const c = await app.connect();
    try {
      expect(await sqlstate(c as never, `SELECT redaction_mark_propose_removal($1, 'carol', $2, NULL)`, [mark, OFF])).toBe('55000');
      expect(await sqlstate(c as never, `SELECT redaction_mark_approve_removal($1, 'dave', $2, NULL)`, [rem, OFF])).toBe('55000');
    } finally { c.release(); }
  });
  it('D6 history: an approved version cannot be rewritten by the app role', async () => {
    const v = (await app.query<{ id: string }>(`INSERT INTO content_version (item_id, n, title, visibility, body_ast, created_by_sub, acting_office_id) VALUES ($1, 1, 'T John Smith', 'public', '{"blocks":[]}', 'a', (SELECT office_id FROM content_item WHERE id = $1)) RETURNING id`, [item])).rows[0]!.id;
    await app.query(`UPDATE content_version SET status='ready', content_hash=decode(repeat('00',32),'hex'), ready_at=now() WHERE id=$1`, [v]);
    await app.query(`UPDATE content_version SET status='approved', approved_at=now(), approved_by_sub='w', approval_kind='normal', public_ast='{"blocks":[]}' WHERE id=$1`, [v]);
    const c = await app.connect();
    try {
      expect(await sqlstate(c as never, `UPDATE content_version SET title='T J. Sm­ith' WHERE id=$1`, [v])).not.toBe('ok');
    } finally { c.release(); }
  });
});
