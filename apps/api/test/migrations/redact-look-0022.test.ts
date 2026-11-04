// REDACT-LOOK: 0022 moves the public's member_name and image cells to "show"
// on Ross's 11-02 decision, through the same change history the narrow path
// writes (0012, 0013), so the as-of policy (lens.ts policyCells) and the
// publication ledger still read the past right. Each case gets a database
// migrated up to just before 0022, is set up as the case needs, then gets
// 0022. Every person here is made up.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { policyCells } from '../../src/redaction/lens.js';
import { APP, APP_PW, dockerExec, dropDatabase, freshDatabase, live, migrate, sqlstate, url, urlFor, testPool } from '../helpers/pg.js';

const OFFICER = { sub: 'sub-officer-alex-sample', groups: ['nwfl-members', 'nwfl-officers'] };
const SECOND = { sub: 'sub-officer-jo-ostley', groups: ['nwfl-members', 'nwfl-officers'] };
const PROPOSER = 'system:migration-0022';
const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const APPROVER = 'system:decision-ross-2026-11-02';

/** The 24 cells after 0022: the 0012 defaults with the public's names and pictures shown. */
const EXPECTED: Record<string, string> = {
  'public:member_name': 'show',
  'public:member_address': 'redact',
  'public:member_phone': 'redact',
  'public:member_email': 'redact',
  'public:private_venue': 'redact',
  'public:business_venue': 'show',
  'public:officer_contact': 'redact',
  'public:image': 'show',
  'members:member_name': 'show',
  'members:member_address': 'redact',
  'members:member_phone': 'show',
  'members:member_email': 'show',
  'members:private_venue': 'show',
  'members:business_venue': 'show',
  'members:officer_contact': 'show',
  'members:image': 'show',
  'officers:member_name': 'show',
  'officers:member_address': 'show',
  'officers:member_phone': 'show',
  'officers:member_email': 'show',
  'officers:private_venue': 'show',
  'officers:business_venue': 'show',
  'officers:officer_contact': 'show',
  'officers:image': 'show',
};

interface Db {
  name: string;
  app: pg.Pool;
  owner: pg.Client;
}

/** A database migrated up to just before 0022 (0022 left out of a scratch copy of the migrations). */
async function beforeZeroTwentyTwo(prefix: string): Promise<Db> {
  const name = await freshDatabase(prefix);
  const dir = `/tmp/${name}-pre0022`;
  const copy = await dockerExec(['sh', '-c', `rm -rf ${dir} && mkdir -p ${dir} && cp /repo/migrations/*.sql ${dir}/ && for f in ${dir}/*.sql; do n=$(basename "$f"); n=\${n%%_*}; if [ "$n" -ge 22 ]; then rm "$f"; fi; done`]);
  if (copy.code !== 0) throw new Error(`copy failed: ${copy.stderr}`);
  const run = await migrate(name, dir);
  if (run.code !== 0) throw new Error(`migrate failed: ${run.stderr}`);
  await dockerExec(['sh', '-c', `rm -rf ${dir}`]);
  const target = new URL(url as string);
  target.pathname = `/${name}`;
  const owner = new pg.Client({ connectionString: target.toString() });
  await owner.connect();
  return { name, app: testPool({ connectionString: urlFor(APP, APP_PW, name), max: 3 }), owner };
}

async function close(db: Db | undefined): Promise<void> {
  if (db === undefined) return;
  await db.owner.end();
  await db.app.end();
  await dropDatabase(db.name);
}

const cells = async (db: Db): Promise<Record<string, string>> =>
  Object.fromEntries(
    (await db.owner.query<{ audience: string; category: string; action: string }>(`SELECT audience, category, action FROM redaction_policy WHERE tenant_id = 'nwflorida'`)).rows.map((r) => [
      `${r.audience}:${r.category}`,
      r.action,
    ]),
  );

const propose = (db: Db, audience: string, category: string, to: string, who = OFFICER) =>
  db.app.query<{ id: string; status: string }>(`SELECT (c).id, (c).status FROM (SELECT redaction_propose('nwflorida', $1, $2, $3, $4, $5, NULL) AS c) s`, [audience, category, to, who.sub, who.groups]);

async function item(db: Db, slug: string): Promise<string> {
  const office = (await db.app.query<{ id: string }>(`INSERT INTO office (slug, title, kind) VALUES ($1, 'Publications Officer', 'appointed') RETURNING id`, [`pub-${slug}`])).rows[0]!.id;
  return (await db.app.query<{ id: string }>(`INSERT INTO content_item (slug, kind, office_id) VALUES ($1, 'article', $2) RETURNING id`, [slug, office])).rows[0]!.id;
}

const wholeItemMark = (db: Db, subject: string, category: string) =>
  db.app.query(`SELECT redaction_mark_add('content_item', $1, NULL, NULL, $2, $3, $4, NULL)`, [subject, category, OFFICER.sub, OFFICER.groups]);

describe.skipIf(!live)('0022: the public copy shows member names and pictures (Ross, 11-02)', () => {
  describe('on a database with the 0012 defaults', () => {
    let db: Db;
    let before: Date;
    let pendingImage: string;
    let queuedBefore: { file_id: string; generation: string };
    let migrated: { code: number; stdout: string; stderr: string };

    beforeAll(async () => {
      db = await beforeZeroTwentyTwo('nwfl_0022');
      // A public loosening an officer proposed is waiting: 0022 supersedes it.
      pendingImage = (await propose(db, 'public', 'image', 'show')).rows[0]!.id;
      // Marks that must not stop 0022: a passage mark of a name, a whole-item mark of a phone.
      const subject = await item(db, 'picnic');
      await db.app.query(`INSERT INTO content_version (item_id, n, title, body_src, created_by_sub, acting_office_id) SELECT $1, 1, 'Picnic', 'Ask Alex Sample.', $2, office_id FROM content_item WHERE id = $1`, [subject, OFFICER.sub]);
      await db.app.query(`SELECT redaction_mark_add('content_item', $1, 'body', 'Alex Sample', 'member_name', $2, $3, NULL)`, [subject, OFFICER.sub, OFFICER.groups]);
      await wholeItemMark(db, subject, 'member_phone');
      // A stored original, already queued once: 0022 queues it again.
      const version = (await db.app.query<{ id: string }>(`SELECT id FROM content_version WHERE item_id = $1`, [subject])).rows[0]!.id;
      const bytes = Buffer.from('%PDF-1.7\n% the flyer\n%%EOF\n', 'latin1');
      const file = (
        await db.app.query<{ id: string }>(
          `INSERT INTO stored_file (version_id, object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ($1, 'k-flyer', 'f.pdf', 'application/pdf', $2, sha256($3), 'public') RETURNING id`,
          [version, bytes.length, bytes],
        )
      ).rows[0]!.id;
      await db.app.query(`SELECT pdf_original_put($1, $2, $3, $4, NULL)`, [file, bytes, OFFICER.sub, OFFICER.groups]);
      queuedBefore = (await db.owner.query<{ file_id: string; generation: string }>(`SELECT file_id, generation FROM pdf_regen WHERE file_id = $1`, [file])).rows[0]!;
      before = (await db.owner.query<{ now: Date }>(`SELECT clock_timestamp() AS now`)).rows[0]!.now;
      migrated = await migrate(db.name);
    });

    afterAll(() => close(db));

    it('applies, and a second run is a no-op', async () => {
      expect(migrated.code, migrated.stderr).toBe(0);
      // 0022 and every later migration (0023 SOLO-APPROVE) apply on top of the copy.
      expect(migrated.stdout).toMatch(new RegExp(`applied=${readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) >= 22).length} `));
      const again = await migrate(db.name);
      expect(again.code, again.stderr).toBe(0);
      expect(again.stdout).toMatch(/applied=0 /);
    });

    it('leaves every cell as 0012 set it but the public\'s names and pictures, which now show', async () => {
      expect(await cells(db)).toEqual(EXPECTED);
      const by = (await db.owner.query<{ key: string; updated_by_sub: string | null }>(`SELECT audience || ':' || category AS key, updated_by_sub FROM redaction_policy WHERE updated_by_sub IS NOT NULL ORDER BY 1`)).rows;
      expect(by).toEqual([
        { key: 'public:image', updated_by_sub: PROPOSER },
        { key: 'public:member_name', updated_by_sub: PROPOSER },
      ]);
    });

    it('records exactly two applied changes, proposed by the migration and approved on Ross\'s decision, decided and approved at one stamp', async () => {
      const { rows } = await db.owner.query<{ category: string; from_action: string; to_action: string; proposed_by_sub: string; approved_by_sub: string; same: boolean }>(
        `SELECT category, from_action, to_action, proposed_by_sub, approved_by_sub, decided_at = approved_at AS same
           FROM redaction_change WHERE status = 'applied' ORDER BY category`,
      );
      expect(rows).toEqual([
        { category: 'image', from_action: 'blur', to_action: 'show', proposed_by_sub: PROPOSER, approved_by_sub: APPROVER, same: true },
        { category: 'member_name', from_action: 'redact', to_action: 'show', proposed_by_sub: PROPOSER, approved_by_sub: APPROVER, same: true },
      ]);
    });

    it('supersedes the waiting loosening, and leaves nothing waiting', async () => {
      const { rows } = await db.owner.query<{ id: string; status: string }>(`SELECT id, status FROM redaction_change WHERE id = $1 OR status = 'pending'`, [pendingImage]);
      expect(rows).toEqual([{ id: pendingImage, status: 'superseded' }]);
      const audit = await db.owner.query<{ actor_kind: string; actor_sub: string; action: string }>(
        `SELECT actor_kind, actor_sub, action FROM audit_event WHERE subject_kind = 'redaction_change' AND subject_id = $1 AND action = 'redaction_supersede'`,
        [pendingImage],
      );
      expect(audit.rows).toEqual([{ actor_kind: 'system', actor_sub: PROPOSER, action: 'redaction_supersede' }]);
    });

    it('audits each change as the narrow path does, as the system, with the reason', async () => {
      const { rows } = await db.owner.query<{ category: string; action: string; actor_kind: string; actor_sub: string; from_state: string | null; to_state: string; note: string; payload: Record<string, string> }>(
        `SELECT c.category, a.action, a.actor_kind, a.actor_sub, a.from_state, a.to_state, a.note, a.payload
           FROM redaction_change c
           JOIN audit_event a ON (a.subject_kind = 'redaction_change' AND a.subject_id = c.id::text)
                              OR (a.subject_kind = 'redaction_policy' AND a.subject_id = c.tenant_id || ':' || c.audience || ':' || c.category AND a.payload ->> 'change_id' = c.id::text)
          WHERE c.status = 'applied' ORDER BY c.category, a.id`,
      );
      // The change is written applied, on the recorded decision: it was never pending, so its approval has no from_state.
      const shape = rows.map((r) => [r.category, r.action, r.actor_kind, r.actor_sub, r.from_state, r.to_state]);
      expect(shape).toEqual([
        ['image', 'redaction_propose', 'system', PROPOSER, 'blur', 'show'],
        ['image', 'redaction_approve', 'system', APPROVER, null, 'applied'],
        ['image', 'redaction_set', 'system', PROPOSER, 'blur', 'show'],
        ['member_name', 'redaction_propose', 'system', PROPOSER, 'redact', 'show'],
        ['member_name', 'redaction_approve', 'system', APPROVER, null, 'applied'],
        ['member_name', 'redaction_set', 'system', PROPOSER, 'redact', 'show'],
      ]);
      for (const row of rows) {
        expect(row.note).toMatch(/^Ross's 11-02 decision \(REDACT-LOOK\): the public copy shows member names and pictures; contacts stay redacted\.$/);
        expect(row.payload).toMatchObject({ tenant: 'nwflorida', audience: 'public', category: row.category, decision: 'ross-2026-11-02' });
        expect(typeof row.payload['change_id']).toBe('string');
      }
    });

    it('queues every stored original again, so each copy is made anew', async () => {
      const after = (await db.owner.query<{ generation: string }>(`SELECT generation FROM pdf_regen WHERE file_id = $1`, [queuedBefore.file_id])).rows[0]!;
      expect(BigInt(after.generation)).toBeGreaterThan(BigInt(queuedBefore.generation));
    });

    it('keeps the past readable: the public policy as of before 0022 is the 0012 defaults, after it shows', async () => {
      const asOf = async (at: Date) => Object.fromEntries((await policyCells(db.app, 'public', at)).map((c) => [c.category, c.action]));
      expect(await asOf(before)).toMatchObject({ member_name: 'redact', image: 'blur', member_phone: 'redact' });
      const now = (await db.owner.query<{ now: Date }>(`SELECT clock_timestamp() AS now`)).rows[0]!.now;
      expect(await asOf(now)).toMatchObject({ member_name: 'show', image: 'show', member_phone: 'redact' });
    });

    it('keeps the app role out of the cells and the history (A1/A2)', async () => {
      const client = await db.app.connect();
      try {
        expect(await sqlstate(client as unknown as pg.Client, `UPDATE redaction_policy SET action = 'show' WHERE audience = 'public' AND category = 'member_phone'`)).toBe('42501');
        expect(await sqlstate(client as unknown as pg.Client, `INSERT INTO redaction_change (audience, category, from_action, to_action, status, proposed_by_sub) VALUES ('public', 'member_phone', 'redact', 'show', 'applied', 'x')`)).toBe('42501');
      } finally {
        client.release();
      }
      // A public loosening through the narrow path still waits for a second officer.
      expect((await propose(db, 'public', 'member_phone', 'show')).rows[0]!.status).toBe('pending');
    });
  });

  describe('on a database where a cell has moved since 0012', () => {
    let db: Db | undefined;
    afterAll(() => close(db));

    it('leaves a cell an officer already set to show as it is, and applies the other', async () => {
      db = await beforeZeroTwentyTwo('nwfl_0022_shown');
      const waiting = (await propose(db, 'public', 'member_name', 'show')).rows[0]!.id;
      await db.app.query(`SELECT redaction_approve($1, $2, $3, NULL)`, [waiting, SECOND.sub, SECOND.groups]);
      const run = await migrate(db.name);
      expect(run.code, run.stderr).toBe(0);
      expect(await cells(db)).toEqual(EXPECTED);
      const changes = (await db.owner.query<{ category: string; proposed_by_sub: string }>(`SELECT category, proposed_by_sub FROM redaction_change WHERE status = 'applied' ORDER BY category`)).rows;
      expect(changes).toEqual([
        { category: 'image', proposed_by_sub: PROPOSER },
        { category: 'member_name', proposed_by_sub: OFFICER.sub },
      ]);
    });
  });

  describe('lock order (challenger r3, N3)', () => {
    let db: Db | undefined;
    afterAll(() => close(db));

    it('takes both cells, then the ledger, as the narrow path does: an officer holding the image cell, then taking the ledger, never deadlocks with it', async () => {
      db = await beforeZeroTwentyTwo('nwfl_0022_order');
      const d = db;
      const target = new URL(url as string);
      target.pathname = `/${d.name}`;
      const officer = new pg.Client({ connectionString: target.toString() });
      await officer.connect();
      try {
        // A change to the public image cell as redaction_propose makes it: the cell first ...
        await officer.query('BEGIN');
        await officer.query(`SELECT redaction_lock_cell('nwflorida', 'public', 'image')`);
        const running = migrate(d.name);
        const waiting = async (): Promise<number> =>
          (await d.owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name = 'nwfl-migrate' AND wait_event_type = 'Lock'`, [d.name])).rows[0]!.n;
        for (let tries = 0; (await waiting()) === 0; tries++) {
          if (tries > 200) throw new Error('0022 never waited for the image cell');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        // ... then the ledger, which setting the cell takes (0016's trigger). 0022 holds no ledger lock yet.
        await officer.query('SELECT publication_ledger_lock()');
        await officer.query('COMMIT');
        const run = await running;
        expect(run.stderr).not.toMatch(/deadlock/);
        expect(run.code, run.stderr).toBe(0);
        expect(await cells(d)).toEqual(EXPECTED);
      } finally {
        await officer.end();
      }
    });
  });

  describe('refuses, applying nothing, so Ross decides', () => {
    let db: Db | undefined;
    afterAll(() => close(db));

    const refusesWith = async (prefix: string, setUp: (db: Db) => Promise<void>, message: RegExp): Promise<void> => {
      await close(db);
      db = await beforeZeroTwentyTwo(prefix);
      await setUp(db);
      const cellsBefore = await cells(db);
      const changesBefore = (await db.owner.query(`SELECT 1 FROM redaction_change`)).rowCount;
      const run = await migrate(db.name);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toMatch(message);
      expect(await cells(db)).toEqual(cellsBefore);
      expect((await db.owner.query(`SELECT 1 FROM redaction_change`)).rowCount).toBe(changesBefore);
      expect((await db.owner.query(`SELECT 1 FROM schema_migrations WHERE filename LIKE '0022_%'`)).rowCount).toBe(0);
    };

    it('when an officer has hidden the public\'s pictures since', async () => {
      await refusesWith('nwfl_0022_hide', async (d) => void (await propose(d, 'public', 'image', 'hide')), /0022: the public image cell is hide, not the 0012 default blur/);
    });

    it('when an officer has hidden the public\'s names since', async () => {
      await refusesWith('nwfl_0022_hidename', async (d) => void (await propose(d, 'public', 'member_name', 'hide')), /0022: the public member_name cell is hide, not the 0012 default redact/);
    });

    it('when a whole item is marked as a member\'s name: it would silently become public', async () => {
      await refusesWith('nwfl_0022_whole', async (d) => void (await wholeItemMark(d, await item(d, 'roster-note'), 'member_name')), /0022: 1 active whole-item member_name mark/);
    });

    it('when such a mark is being written as it runs: it waits for the mark, then counts it (challenger r2, N7)', async () => {
      await close(db);
      db = await beforeZeroTwentyTwo('nwfl_0022_race');
      const d = db;
      const subject = await item(d, 'late-note');
      const writer = await d.app.connect();
      try {
        // An officer's whole-item name mark, written and not yet committed: it holds the ledger lock (0016).
        await writer.query('BEGIN');
        await writer.query(`SELECT redaction_mark_add('content_item', $1, NULL, NULL, 'member_name', $2, $3, NULL)`, [subject, OFFICER.sub, OFFICER.groups]);
        const running = migrate(d.name);
        const waiting = async (): Promise<number> =>
          (await d.owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name = 'nwfl-migrate' AND wait_event_type = 'Lock'`, [d.name])).rows[0]!.n;
        for (let tries = 0; (await waiting()) === 0; tries++) {
          if (tries > 200) throw new Error('0022 never waited for the mark');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await writer.query('COMMIT');
        const run = await running;
        expect(run.code).not.toBe(0);
        expect(run.stderr).toMatch(/0022: 1 active whole-item member_name mark/);
        expect(await cells(d)).toMatchObject({ 'public:member_name': 'redact', 'public:image': 'blur' });
        expect((await d.owner.query(`SELECT 1 FROM schema_migrations WHERE filename LIKE '0022_%'`)).rowCount).toBe(0);
      } finally {
        writer.release();
      }
    });
  });
});
