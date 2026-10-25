// REDACT R3b: PDF originals and their redacted copies in Postgres (0015), and
// the background job that regenerates the copies. The grants are tested by
// direct SQL as the app role `nwfl`; the owner (here the superuser, which
// bypasses grants but not triggers) checks what holds for every role.
// Every person and name here is made up.
import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RedactRequest } from '../../src/pdf/redact.js';
import { type Redact, drain, regenerateOne, startRegenerator } from '../../src/pdf/regenerate.js';
import { MAX_ORIGINAL_BYTES, inputsFor, readPdf, storeOriginal } from '../../src/pdf/store.js';
import { checkCopy } from '../../src/pdf/gate.js';
import { APP, APP_PW, dropDatabase, failure, freshDatabase, live, migrate, sqlstate, url, urlFor } from '../helpers/pg.js';
import { leakFixture } from './fixtures.js';

const OFFICER = { sub: 'sub-officer', groups: ['nwfl-members', 'nwfl-officers'] };
const AUTHOR = { sub: 'sub-author', groups: ['nwfl-members'] };
const STRANGER = { sub: 'sub-stranger', groups: ['nwfl-members'] };
const PHONE_NAME = 'Quillon Brask';
const EMAIL_NAME = 'Ottoline Varga';
const sha = (bytes: Uint8Array): Buffer => createHash('sha256').update(bytes).digest();
const pdfBytes = (label: string): Uint8Array => new Uint8Array(Buffer.from(`%PDF-1.7\n% ${label}\n%%EOF\n`, 'latin1'));

/** A fast stand-in for the engine: the copy names its quotes, so a test sees which inputs made it. */
const calls: RedactRequest[] = [];
const stub =
  (delayMs = 0): Redact =>
  async (_original, request) => {
    calls.push(request);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (request.quotes.includes('Refuse Me')) return { kind: 'refused', reason: 'page 1 is a scan: pictures cover most of it' };
    if (request.quotes.includes('Throw Me')) throw new Error('wasm trap');
    if (request.quotes.includes('Give Original')) return { kind: 'original' };
    return { kind: 'redacted', pdf: new Uint8Array(Buffer.from(`copy:${[...request.quotes].sort().join('|')}`)), boxes: [] };
  };
const text = (result: Awaited<ReturnType<typeof readPdf>>): string => {
  if (result.kind !== 'pdf') throw new Error(`expected a pdf, got ${JSON.stringify(result)}`);
  return Buffer.from(result.pdf).toString('latin1');
};

describe.skipIf(!live)('PDF store and regeneration (0015)', () => {
  let database: string;
  let pool: pg.Pool;
  let owner: pg.Client;
  let office: string;
  let item: string;
  let version: string;
  let file: string;
  let original: Uint8Array;

  const q = <R extends pg.QueryResultRow>(sql: string, values: unknown[] = []) => pool.query<R>(sql, values);
  const newItem = async (slug: string): Promise<{ item: string; version: string }> => {
    const i = (await q<{ id: string }>(`INSERT INTO content_item (slug, kind, office_id) VALUES ($1, 'document', $2) RETURNING id`, [slug, office])).rows[0]!.id;
    const v = (await q<{ id: string }>(`INSERT INTO content_version (item_id, n, title, created_by_sub, acting_office_id) VALUES ($1, 1, 'T', $2, $3) RETURNING id`, [i, AUTHOR.sub, office])).rows[0]!.id;
    return { item: i, version: v };
  };
  const newFile = async (owner: { version?: string; edition?: string }, bytes: Uint8Array, audience = 'public', mime = 'application/pdf'): Promise<string> =>
    (
      await q<{ id: string }>(
        `INSERT INTO stored_file (version_id, edition_id, object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ($1, $2, $3, 'f.pdf', $4, $5, $6, $7) RETURNING id`,
        [owner.version ?? null, owner.edition ?? null, `k-${Math.random()}`, mime, bytes.length, sha(bytes), audience],
      )
    ).rows[0]!.id;
  const mark = (subject: string, quote: string | null, category: string, who = OFFICER) =>
    q(`SELECT redaction_mark_add('content_item', $1, $2, $3, $4, $5, $6, NULL)`, [subject, quote === null ? null : 'body', quote, category, who.sub, who.groups]);
  const propose = (audience: string, category: string, to: string, who = OFFICER) =>
    q(`SELECT redaction_propose('nwflorida', $1, $2, $3, $4, $5, NULL)`, [audience, category, to, who.sub, who.groups]);
  const copies = async (id: string) =>
    (await q<{ input_hash: Buffer; status: string; stale: boolean; reason: string | null; id: string }>(`SELECT id, input_hash, status, stale, reason FROM pdf_copy WHERE file_id = $1 ORDER BY created_at, id`, [id])).rows;
  const queued = async (id: string) => (await q(`SELECT 1 FROM pdf_regen WHERE file_id = $1`, [id])).rowCount;

  beforeAll(async () => {
    database = await freshDatabase('nwfl_pdfstore');
    const run = await migrate(database);
    if (run.code !== 0) throw new Error(`migrate failed: ${run.stderr}`);
    pool = new pg.Pool({ connectionString: urlFor(APP, APP_PW, database), max: 6 });
    const target = new URL(url as string);
    target.pathname = `/${database}`;
    owner = new pg.Client({ connectionString: target.toString() });
    await owner.connect();
    office = (await q<{ id: string }>(`INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`)).rows[0]!.id;
    ({ item, version } = await newItem('flyer'));
    original = pdfBytes('the flyer');
    file = await newFile({ version }, original);
  });

  afterAll(async () => {
    await owner?.end();
    await pool?.end();
    if (database !== undefined) await dropDatabase(database);
  });

  describe('storing an original', () => {
    it('refuses one over 10 MiB before it reaches the database', async () => {
      const nodb = { query: () => Promise.reject(new Error('the database was asked')) };
      await expect(storeOriginal(nodb, { fileId: file, bytes: new Uint8Array(MAX_ORIGINAL_BYTES + 1), ...OFFICER })).rejects.toThrow('larger than 10 MiB');
      expect(MAX_ORIGINAL_BYTES).toBe(10 * 1024 * 1024);
    });

    it('is refused by the database when too large, mismatched, not a PDF, or from a stranger', async () => {
      const asApp = (id: string, bytes: Uint8Array | Buffer, who = OFFICER) =>
        pool.query(`SELECT pdf_original_put($1, $2, $3, $4, NULL)`, [id, bytes, who.sub, who.groups]).then(
          () => 'ok',
          (error: { code?: string; message: string }) => `${error.code}: ${error.message}`,
        );
      const big = Buffer.alloc(MAX_ORIGINAL_BYTES + 1, 0x20);
      const bigFile = await newFile({ version }, pdfBytes('x'));
      expect(await asApp(bigFile, big)).toMatch(/^22023: .*10 MiB/);
      expect(await asApp(file, pdfBytes('not the flyer'))).toMatch(/^22023: .*do not match/);
      const word = await newFile({ version }, pdfBytes('w'), 'officers', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      expect(await asApp(word, pdfBytes('w'))).toMatch(/^22023: .*not a PDF/);
      expect(await asApp(file, original, STRANGER)).toMatch(/^42501: /);
      expect(await asApp(file, original, { sub: '', groups: OFFICER.groups })).toMatch(/^42501: /);
      expect(await asApp('00000000-0000-0000-0000-000000000000', original)).toMatch(/^22023: no such file/);
    });

    it('is stored by the item writer, once, audited, and queues the file', async () => {
      await storeOriginal(pool, { fileId: file, bytes: original, ...AUTHOR, trace: 'a'.repeat(32) });
      await expect(storeOriginal(pool, { fileId: file, bytes: original, ...OFFICER })).rejects.toMatchObject({ code: '23505' });
      const audit = await q<{ actor_sub: string }>(`SELECT actor_sub FROM audit_event WHERE action = 'pdf_original_store' AND subject_id = $1`, [file]);
      expect(audit.rows.map((row) => row.actor_sub)).toEqual([AUTHOR.sub]);
      expect(await queued(file)).toBe(1);
    });
  });

  describe('the app role, by direct SQL', () => {
    it('cannot read an original\'s bytes, only that it exists', async () => {
      expect(await sqlstate(pool as unknown as pg.Client, `SELECT bytes FROM pdf_original`)).toBe('42501');
      expect(await sqlstate(pool as unknown as pg.Client, `SELECT * FROM pdf_original`)).toBe('42501');
      expect((await q(`SELECT file_id, stored_by_sub, created_at FROM pdf_original`)).rowCount).toBe(1);
    });

    it('cannot write originals, copies, the queue or its sequence', async () => {
      const c = pool as unknown as pg.Client;
      expect(await sqlstate(c, `INSERT INTO pdf_original (file_id, bytes, stored_by_sub) VALUES ($1, '\\x25', 'x')`, [file])).toBe('42501');
      expect(await sqlstate(c, `UPDATE pdf_original SET stored_by_sub = 'x'`)).toBe('42501');
      expect(await sqlstate(c, `DELETE FROM pdf_original`)).toBe('42501');
      expect(await sqlstate(c, `INSERT INTO pdf_copy (file_id, input_hash, engine, status, reason) VALUES ($1, $2, 'e', 'refused', 'r')`, [file, Buffer.alloc(32)])).toBe('42501');
      expect(await sqlstate(c, `UPDATE pdf_copy SET stale = false`)).toBe('42501');
      expect(await sqlstate(c, `DELETE FROM pdf_copy`)).toBe('42501');
      expect(await sqlstate(c, `INSERT INTO pdf_regen (file_id, generation) VALUES ($1, 1)`, [file])).toBe('42501');
      expect(await sqlstate(c, `UPDATE pdf_regen SET claim = NULL`)).toBe('42501');
      expect(await sqlstate(c, `DELETE FROM pdf_regen`)).toBe('42501');
      expect(await sqlstate(c, `SELECT nextval('pdf_regen_generation')`)).toBe('42501');
      expect(await sqlstate(c, `SELECT pdf_regen_request(ARRAY[$1::uuid])`, [file])).toBe('42501');
    });

    it('reads an original only for an audience whose policy shows everything', async () => {
      const read = (audience: string) => sqlstate(pool as unknown as pg.Client, `SELECT pdf_original_read($1, $2)`, [file, audience]);
      expect(await read('public')).toBe('42501');
      expect(await read('members')).toBe('42501'); // members redact member_address by default
      expect(await read('nobody')).toBe('42501');
      const bytes = (await q<{ b: Buffer }>(`SELECT pdf_original_read($1, 'officers') AS b`, [file])).rows[0]!.b;
      expect(Buffer.compare(bytes, Buffer.from(original))).toBe(0);
    });

    it('needs a live claim to read an original for regeneration or to write a copy', async () => {
      const c = pool as unknown as pg.Client;
      const fake = '00000000-0000-0000-0000-000000000001';
      expect(await sqlstate(c, `SELECT pdf_regen_original($1, $2)`, [file, fake])).toBe('42501');
      expect(await sqlstate(c, `SELECT pdf_copy_put($1, $2, $3, 'e', NULL, 'r')`, [file, fake, Buffer.alloc(32)])).toBe('42501');
      expect(await sqlstate(c, `SELECT pdf_regen_finish($1, $2, ARRAY[]::bytea[])`, [file, fake])).toBe('ok');
      expect(await queued(file)).toBe(1);
    });
  });

  describe('the owner too', () => {
    it('cannot rewrite an original, nor a copy but for its stale flag', async () => {
      expect(await failure(owner, `UPDATE pdf_original SET bytes = '\\x25' WHERE file_id = $1`, [file])).toMatch(/an original is kept as stored/);
      expect(await sqlstate(owner, `UPDATE pdf_original SET bytes = '\\x25' WHERE file_id = $1`, [file])).toBe('55000');
    });
  });

  describe('reading and regenerating', () => {
    it('answers not ready before the job runs, and gives officers the original', async () => {
      expect(await readPdf(pool, file, 'public')).toEqual({ kind: 'not_ready' });
      expect(await readPdf(pool, file, 'members')).toEqual({ kind: 'not_ready' });
      const officers = await readPdf(pool, file, 'officers');
      expect(officers).toMatchObject({ kind: 'pdf', original: true });
      expect(await readPdf(pool, '00000000-0000-0000-0000-000000000000', 'public')).toEqual({ kind: 'not_found' });
      expect(await readPdf(pool, file, 'nobody')).toEqual({ kind: 'not_found' });
    });

    it('keys a copy by the image action too: public photos blur, members\' show', async () => {
      calls.length = 0;
      expect(await drain(pool, { redact: stub() })).toBe(1);
      expect(calls).toEqual(expect.arrayContaining([{ quotes: [], redactsAny: true, image: 'blur' }, { quotes: [], redactsAny: true, image: 'show' }]));
      expect(calls).toHaveLength(2);
      expect((await copies(file)).length).toBe(2);
    });

    it('shares one copy between audiences whose settings for the file are the same', async () => {
      await propose('members', 'image', 'blur');
      calls.length = 0;
      expect(await drain(pool, { redact: stub() })).toBe(1);
      expect(calls).toEqual([]);
      expect(text(await readPdf(pool, file, 'public'))).toBe('copy:');
      expect(text(await readPdf(pool, file, 'members'))).toBe('copy:');
      expect((await copies(file)).map((c) => [c.status, c.stale])).toEqual([['ready', false]]);
      expect(await queued(file)).toBe(0);
      expect(await drain(pool, { redact: stub() })).toBe(0);
    });

    it('marks copies stale when a mark changes, serves no stale copy, and regenerates only what changed', async () => {
      const before = await copies(file);
      await mark(item, PHONE_NAME, 'member_phone');
      expect((await copies(file)).map((c) => c.stale)).toEqual([true]);
      expect(await queued(file)).toBe(1);
      // The public redacts phones: its inputs changed, so its old copy is never served.
      expect(await readPdf(pool, file, 'public')).toEqual({ kind: 'not_ready' });
      // Members show phones: their inputs did not change, so their copy (same hash) still serves.
      expect(text(await readPdf(pool, file, 'members'))).toBe('copy:');
      calls.length = 0;
      expect(await drain(pool, { redact: stub() })).toBe(1);
      expect(calls).toEqual([{ quotes: [PHONE_NAME], redactsAny: true, image: 'blur' }]);
      expect(text(await readPdf(pool, file, 'public'))).toBe(`copy:${PHONE_NAME}`);
      const after = await copies(file);
      expect(after.map((c) => [c.stale, c.status])).toEqual([[false, 'ready'], [false, 'ready']]);
      expect(after[0]!.id).toBe(before[0]!.id);
    });

    it('marks copies stale when a policy cell changes', async () => {
      await propose('members', 'member_email', 'redact');
      expect((await copies(file)).every((c) => c.stale)).toBe(true);
      expect(await queued(file)).toBe(1);
      // No mark of that category yet: the inputs are the same, so nothing is regenerated.
      calls.length = 0;
      expect(await drain(pool, { redact: stub() })).toBe(1);
      expect(calls).toEqual([]);
      expect((await copies(file)).every((c) => !c.stale)).toBe(true);
    });

    it('lets one of two racing runs claim a file', async () => {
      await mark(item, EMAIL_NAME, 'member_email');
      calls.length = 0;
      const runs = await Promise.all([regenerateOne(pool, { redact: stub(200) }), regenerateOne(pool, { redact: stub(200) })]);
      expect(runs.filter((run) => run !== null)).toEqual([{ fileId: file, done: true }]);
      expect(calls.map((c) => c.quotes)).toEqual(expect.arrayContaining([[EMAIL_NAME], [EMAIL_NAME, PHONE_NAME]]));
      expect(calls).toHaveLength(2);
      expect(text(await readPdf(pool, file, 'members'))).toBe(`copy:${EMAIL_NAME}`);
      expect(text(await readPdf(pool, file, 'public'))).toBe(`copy:${EMAIL_NAME}|${PHONE_NAME}`);
      // The copies no audience uses any more are gone.
      expect((await copies(file)).length).toBe(2);
    });

    it('stays correct when a run outlives its lease and a second run takes over', async () => {
      await propose('members', 'member_phone', 'redact');
      await mark(item, 'Lease Name', 'member_phone');
      const slow = regenerateOne(pool, { redact: stub(1500), leaseSeconds: 1 });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const fast = await regenerateOne(pool, { redact: stub() });
      expect(fast).toEqual({ fileId: file, done: true });
      expect(await slow).toEqual({ fileId: file, done: false });
      expect(text(await readPdf(pool, file, 'members'))).toBe(`copy:Lease Name|${EMAIL_NAME}|${PHONE_NAME}`);
      expect(text(await readPdf(pool, file, 'public'))).toBe(`copy:Lease Name|${EMAIL_NAME}|${PHONE_NAME}`);
      expect((await copies(file)).length).toBe(1);
      expect(await queued(file)).toBe(0);
    });

    it('requeues a file whose inputs changed during a run', async () => {
      const { item: other, version: v } = await newItem('during');
      const bytes = pdfBytes('during');
      const id = await newFile({ version: v }, bytes);
      await storeOriginal(pool, { fileId: id, bytes, ...OFFICER });
      const changing: Redact = async (o, request) => {
        if (calls.length === 0) await mark(other, 'Mid Run Name', 'member_phone');
        return stub()(o, request);
      };
      calls.length = 0;
      expect(await regenerateOne(pool, { redact: changing })).toEqual({ fileId: id, done: false });
      expect(await queued(id)).toBe(1);
      expect(await readPdf(pool, id, 'public')).toEqual({ kind: 'not_ready' });
      expect(await drain(pool, { redact: stub() })).toBe(1);
      expect(text(await readPdf(pool, id, 'public'))).toBe('copy:Mid Run Name');
    });

    it('writes a copy once per inputs, however often it is put', async () => {
      await owner.query(`INSERT INTO pdf_regen (file_id, generation, claim, claimed_generation, claimed_until) VALUES ($1, 0, '00000000-0000-0000-0000-0000000000aa', 0, now() + interval '1 minute')`, [file]);
      const put = (bytes: string) => q(`SELECT pdf_copy_put($1, '00000000-0000-0000-0000-0000000000aa', $2, 'e', $3, NULL)`, [file, Buffer.alloc(32, 7), Buffer.from(bytes)]);
      await put('first');
      await put('second');
      const rows = await owner.query<{ bytes: Buffer }>(`SELECT bytes FROM pdf_copy WHERE input_hash = $1`, [Buffer.alloc(32, 7)]);
      expect(rows.rows.map((r) => r.bytes.toString())).toEqual(['first']);
      expect(await failure(owner, `UPDATE pdf_copy SET bytes = '\\x00' WHERE input_hash = $1`, [Buffer.alloc(32, 7)])).toMatch(/a copy is kept as made/);
      expect(await sqlstate(owner, `UPDATE pdf_copy SET stale = true WHERE input_hash = $1`, [Buffer.alloc(32, 7)])).toBe('ok');
      expect(await sqlstate(owner, `INSERT INTO pdf_copy (file_id, input_hash, engine, status) VALUES ($1, $2, 'e', 'ready')`, [file, Buffer.alloc(32, 8)])).toBe('23514');
      await q(`SELECT pdf_regen_finish($1, '00000000-0000-0000-0000-0000000000aa', ARRAY[]::bytea[])`, [file]);
      expect(await queued(file)).toBe(0);
      expect((await copies(file)).length).toBe(0);
      await propose('members', 'member_phone', 'show');
      await drain(pool, { redact: stub() });
    });

    it('stores a refusal\'s reason for officers and serves it as refused', async () => {
      await mark(item, 'Refuse Me', 'member_phone');
      await drain(pool, { redact: stub() });
      expect(await readPdf(pool, file, 'public')).toEqual({ kind: 'refused', reason: 'page 1 is a scan: pictures cover most of it' });
      expect(text(await readPdf(pool, file, 'members'))).toBe(`copy:${EMAIL_NAME}`);
    });

    it('fails closed when the engine throws or hands back the original', async () => {
      const { item: i1, version: v1 } = await newItem('throws');
      const b1 = pdfBytes('throws');
      const f1 = await newFile({ version: v1 }, b1);
      await storeOriginal(pool, { fileId: f1, bytes: b1, ...OFFICER });
      await mark(i1, 'Throw Me', 'member_phone');
      const { item: i2, version: v2 } = await newItem('gives-original');
      const b2 = pdfBytes('gives');
      const f2 = await newFile({ version: v2 }, b2);
      await storeOriginal(pool, { fileId: f2, bytes: b2, ...OFFICER });
      await mark(i2, 'Give Original', 'member_phone');
      await drain(pool, { redact: stub() });
      expect(await readPdf(pool, f1, 'public')).toEqual({ kind: 'refused', reason: 'the engine failed: wasm trap' });
      expect(await readPdf(pool, f2, 'public')).toEqual({ kind: 'refused', reason: 'the engine returned the original for an audience that redacts' });
    });

    it('hides the file from an audience a whole-item mark hides it from', async () => {
      const { item: i, version: v } = await newItem('hidden');
      const bytes = pdfBytes('hidden');
      const id = await newFile({ version: v }, bytes);
      await storeOriginal(pool, { fileId: id, bytes, ...OFFICER });
      await mark(i, null, 'member_name');
      await drain(pool, { redact: stub() });
      expect(await readPdf(pool, id, 'public')).toEqual({ kind: 'hidden' });
      expect(await inputsFor(pool, id, 'public')).toEqual({ kind: 'hidden' });
      expect(text(await readPdf(pool, id, 'members'))).toBe('copy:');
      expect(await readPdf(pool, id, 'officers')).toMatchObject({ kind: 'pdf', original: true });
    });

    it('serves an officers-only file to officers alone, and a file with no original to no one', async () => {
      const { version: v } = await newItem('officers-only');
      const bytes = pdfBytes('officers');
      const id = await newFile({ version: v }, bytes, 'officers');
      expect(await readPdf(pool, id, 'officers')).toEqual({ kind: 'not_found' });
      await storeOriginal(pool, { fileId: id, bytes, ...OFFICER });
      expect(await readPdf(pool, id, 'public')).toEqual({ kind: 'not_found' });
      expect(await readPdf(pool, id, 'members')).toEqual({ kind: 'not_found' });
      expect(await readPdf(pool, id, 'officers')).toMatchObject({ kind: 'pdf', original: true });
      await drain(pool, { redact: stub() });
      expect(await copies(id)).toEqual([]);
    });

    it('keeps an edition PDF in step with the marks on the items it prints', async () => {
      const edition = (await q<{ id: string }>(`INSERT INTO edition (slug, title, kind, period_start, period_end) VALUES ('2026-10', 'Fall', 'regular', '2026-10-01', '2026-11-30') RETURNING id`)).rows[0]!.id;
      const bytes = pdfBytes('issue');
      const id = await newFile({ edition }, bytes);
      await storeOriginal(pool, { fileId: id, bytes, ...OFFICER });
      await drain(pool, { redact: stub() });
      expect(text(await readPdf(pool, id, 'public'))).toBe('copy:');
      await q(`INSERT INTO edition_item (edition_id, item_id, version_id) VALUES ($1, $2, $3)`, [edition, item, version]);
      expect(await queued(id)).toBe(1);
      expect(await readPdf(pool, id, 'public')).toEqual({ kind: 'not_ready' });
      await drain(pool, { redact: stub() });
      expect(await readPdf(pool, id, 'public')).toEqual({ kind: 'refused', reason: 'page 1 is a scan: pictures cover most of it' });
      expect(text(await readPdf(pool, id, 'members'))).toBe(`copy:${EMAIL_NAME}`);
    });

    it('gives an audience the original once its policy shows everything, and never a file above its audience', async () => {
      await propose('members', 'member_address', 'show');
      await propose('members', 'member_email', 'show');
      await propose('members', 'image', 'show');
      const { version: v } = await newItem('members-all');
      const bytes = pdfBytes('members-all');
      const id = await newFile({ version: v }, bytes, 'members');
      const off = await newFile({ version: v }, pdfBytes('off'), 'officers');
      await storeOriginal(pool, { fileId: id, bytes, ...OFFICER });
      await storeOriginal(pool, { fileId: off, bytes: pdfBytes('off'), ...OFFICER });
      expect(await readPdf(pool, id, 'members')).toMatchObject({ kind: 'pdf', original: true });
      expect(await sqlstate(pool as unknown as pg.Client, `SELECT pdf_original_read($1, 'members')`, [off])).toBe('42501');
      expect(await readPdf(pool, id, 'public')).toEqual({ kind: 'not_found' });
      await propose('members', 'member_address', 'redact');
      await propose('members', 'image', 'blur');
    });
  });

  describe('the background job', () => {
    it('regenerates without a read asking, and reports a failed run', async () => {
      const { version: v } = await newItem('background');
      const bytes = pdfBytes('background');
      const id = await newFile({ version: v }, bytes);
      await storeOriginal(pool, { fileId: id, bytes, ...OFFICER });
      const job = startRegenerator({ db: pool, intervalMs: 20, redact: stub() });
      for (let i = 0; i < 100 && (await readPdf(pool, id, 'public')).kind !== 'pdf'; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      await job.stop();
      expect(text(await readPdf(pool, id, 'public'))).toBe('copy:');
      const errors: unknown[] = [];
      const broken = startRegenerator({ db: { query: () => Promise.reject(new Error('db down')) }, intervalMs: 10, onError: (error) => errors.push(error) });
      for (let i = 0; i < 100 && errors.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      await broken.stop();
      await broken.stop();
      expect(String(errors[0])).toMatch(/db down/);
    });

    it('lets any other database failure through, and the file is taken again once the lease ends', async () => {
      const { version: v } = await newItem('db-fails');
      const bytes = pdfBytes('db-fails');
      const id = await newFile({ version: v }, bytes);
      await storeOriginal(pool, { fileId: id, bytes, ...OFFICER });
      const failing = {
        query: (sql: string, values?: unknown[]) =>
          sql.includes('pdf_copy_put') ? Promise.reject(Object.assign(new Error('disk full'), { code: '53100' })) : pool.query(sql, values),
      } as unknown as pg.Pool;
      await expect(regenerateOne(failing, { redact: stub(), leaseSeconds: 1 })).rejects.toThrow('disk full');
      expect(await readPdf(pool, id, 'public')).toEqual({ kind: 'not_ready' });
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(await drain(pool, { redact: stub() })).toBe(1);
      expect(text(await readPdf(pool, id, 'public'))).toBe('copy:');
    });

    it('makes a real copy with the engine that passes the gate', async () => {
      const { item: i, version: v } = await newItem('real');
      const bytes = await leakFixture();
      const id = await newFile({ version: v }, bytes);
      await storeOriginal(pool, { fileId: id, bytes, ...OFFICER });
      await mark(i, PHONE_NAME, 'member_phone');
      while ((await regenerateOne(pool)) !== null);
      const result = await readPdf(pool, id, 'public');
      expect(result.kind).toBe('pdf');
      const copy = (result as { pdf: Uint8Array }).pdf;
      expect(Buffer.compare(Buffer.from(copy), Buffer.from(bytes))).not.toBe(0);
      expect(await checkCopy(copy, [PHONE_NAME])).toBeNull();
      expect(await readPdf(pool, id, 'officers')).toMatchObject({ kind: 'pdf', original: true });
    }, 120_000);
  });

  // Documented, not closed (fix 2): the database takes the groups the app passes on trust, as it
  // does for R1's approver. So the app role, or anyone who has taken it over, can say it is an
  // officer, add a mark (which queues the file), claim the file and read its original. Closing this
  // needs a separate worker role, which needs CREATEROLE (filed with fc).
  describe('the trust the worker path rests on', () => {
    it('lets the app role read an original by claiming officer groups, adding a mark and claiming the file', async () => {
      const self = { sub: 'sub-anyone', groups: ['nwfl-officers'] };
      for (const audience of ['public', 'members', 'officers']) {
        if (audience !== 'officers') expect(await sqlstate(pool as unknown as pg.Client, `SELECT pdf_original_read($1, $2)`, [file, audience])).toBe('42501');
      }
      await mark(item, 'zzz nowhere', 'member_phone', self);
      let claim: { file_id: string; claim: string } | undefined;
      for (let i = 0; i < 50; i++) {
        claim = (await q<{ file_id: string; claim: string }>(`SELECT * FROM pdf_regen_claim(60)`)).rows[0];
        if (claim === undefined || claim.file_id === file) break;
      }
      expect(claim?.file_id).toBe(file);
      const got = (await q<{ b: Buffer }>(`SELECT pdf_regen_original($1, $2) AS b`, [file, claim!.claim])).rows[0]!.b;
      expect(got.equals(Buffer.from(original))).toBe(true);
    });
  });
});
