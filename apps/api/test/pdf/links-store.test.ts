// LINKS L3 against the database: the links a copy may carry (store.ts inputsFor, read as of a time,
// each target checked per audience with targetHolds), the kept ids recorded with the copy (0025's
// pdf_copy_put, seventh argument), the worker's boot sweep (pdf_regen_request_files) and the worker's
// new grants (nwfl_worker_grants). The "PDFs" are a few bytes no engine reads: the engine here is a
// stand-in. Every URL is under a reserved example name and every person is made up.
import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RedactRequest } from '../../src/pdf/redact.js';
import { type Redact, drain, regenerateOne, startRegenerator, sweepCopies } from '../../src/pdf/regenerate.js';
import { ENGINE_VERSION, inputHash, inputsFor } from '../../src/pdf/store.js';
import { APP, APP_PW, MIGRATOR, MIGRATOR_PW, WORKER, WORKER_PW, dropDatabase, freshDatabase, live, migrate, sqlstate, url, urlFor, testPool } from '../helpers/pg.js';

const LOADER = 'system:issue-loader';
const OFFICER = { sub: 'sub-officer', groups: ['nwfl-members', 'nwfl-officers'] };
const ORIGIN = 'https://nwflorida.us';
const sha = (bytes: Uint8Array | string): Buffer => createHash('sha256').update(bytes).digest();
const id = (c: string): string => c.repeat(26);

interface Row {
  id: string;
  page: number;
  rect: number[];
  url: string;
  host: string;
  kind: 'web' | 'mail';
  confirm: boolean;
}
const web = (c: string, path: string, extra: Partial<Row> = {}): Row => ({ id: id(c), page: 1, rect: [72.004, 700, 300.126, 714.5], url: `https://site.example/${path}`, host: 'site.example', kind: 'web', confirm: false, ...extra });

/** A stand-in engine: every link it is given is kept, and the copy names its quotes and links. */
const seen: RedactRequest[] = [];
const keepAll: Redact = (_original, request) => {
  seen.push(request);
  const links = (request.links ?? []).map((link) => link.id);
  return Promise.resolve({ kind: 'redacted', pdf: new Uint8Array(Buffer.from(`copy:${request.quotes.join('|')}:${links.join(',')}`)), boxes: [], kept: links });
};

describe.skipIf(!live)('LINKS L3: links in the inputs, the kept ids and the boot sweep (0025)', () => {
  let database: string;
  let app: pg.Pool;
  let worker: pg.Pool;
  let owner: pg.Client;
  let root: pg.Client;
  let office: string;
  let serial = 0;

  /** A document item the loader wrote, with one stored PDF of `audience`. */
  async function file(audience = 'public'): Promise<{ file: string; item: string; bytes: Buffer }> {
    serial++;
    const item = (await app.query<{ id: string }>(`INSERT INTO content_item (slug, kind, office_id) VALUES ($1, 'document', $2) RETURNING id`, [`issue-${serial}`, office])).rows[0]!.id;
    const version = (await app.query<{ id: string }>(`INSERT INTO content_version (item_id, n, title, created_by_sub, acting_office_id) VALUES ($1, 1, 'Issue', $2, $3) RETURNING id`, [item, LOADER, office])).rows[0]!.id;
    const bytes = Buffer.from(`%PDF-1.7\n% issue ${serial}\n%%EOF\n`, 'latin1');
    const fileId = (
      await app.query<{ id: string }>(
        `INSERT INTO stored_file (version_id, object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ($1, $2, 'i.pdf', 'application/pdf', $3, $4, $5) RETURNING id`,
        [version, `k-${serial}`, bytes.length, sha(bytes), audience],
      )
    ).rows[0]!.id;
    await app.query(`SELECT pdf_original_put($1, $2, $3, '{}', NULL)`, [fileId, bytes, LOADER]);
    return { file: fileId, item, bytes };
  }
  const attach = (fileId: string, links: Row[]) => app.query(`SELECT pdf_links_attach($1, $2::jsonb, 'LINKS', $3, $4, NULL)`, [fileId, JSON.stringify(links), sha('approved'), LOADER]);
  const mark = (item: string, quote: string, category: string) => app.query(`SELECT redaction_mark_add('content_item', $1, 'body', $2, $3, $4, $5, NULL)`, [item, quote, category, OFFICER.sub, OFFICER.groups]);
  const copyOf = async (fileId: string, audience: string) => {
    const inputs = await inputsFor(app, fileId, audience, undefined, ORIGIN);
    if (inputs?.kind !== 'copy') throw new Error(`expected a copy for ${audience}`);
    return inputs;
  };
  const nowInDb = async (): Promise<Date> => (await root.query<{ t: Date }>(`SELECT clock_timestamp() AS t`)).rows[0]!.t;
  const queued = async (fileId: string): Promise<boolean> => ((await root.query(`SELECT 1 FROM pdf_regen WHERE file_id = $1`, [fileId])).rowCount ?? 0) > 0;
  const linksOf = async (fileId: string): Promise<string[]> => (await root.query<{ link_id: string }>(`SELECT link_id FROM pdf_copy_link WHERE file_id = $1 ORDER BY link_id`, [fileId])).rows.map((row) => row.link_id);

  beforeAll(async () => {
    database = await freshDatabase('nwfl_links3');
    const run = await migrate(database);
    if (run.code !== 0) throw new Error(`migrate failed: ${run.stderr}`);
    app = testPool({ connectionString: urlFor(APP, APP_PW, database), max: 4 });
    worker = testPool({ connectionString: urlFor(WORKER, WORKER_PW, database), max: 3 });
    owner = new pg.Client({ connectionString: urlFor(MIGRATOR, MIGRATOR_PW, database) });
    const target = new URL(url as string);
    target.pathname = `/${database}`;
    root = new pg.Client({ connectionString: target.toString() });
    await Promise.all([owner.connect(), root.connect()]);
    office = (await app.query<{ id: string }>(`INSERT INTO office (slug, title, kind) VALUES ('editor', 'Newsletter Editor', 'appointed') RETURNING id`)).rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await Promise.all([owner?.end(), root?.end()]);
    await Promise.all([app?.end(), worker?.end()]);
    if (database !== undefined) await dropDatabase(database);
  });

  describe('inputsFor: the links that pass, as of a time', () => {
    it('gives a copy\'s request each active link by id, page, rect to hundredths and label, with the origin, and no target', async () => {
      const { file: f } = await file();
      await attach(f, [web('b', 'b'), web('a', 'a', { page: 2, host: 'site.example' }), { ...web('c', 'c'), url: 'mailto:games~@mail.example', host: 'mail.example', kind: 'mail' }]);
      const inputs = await copyOf(f, 'public');
      expect(inputs.request.origin).toBe(ORIGIN);
      expect(inputs.request.links).toEqual([
        { id: id('a'), page: 2, rect: [72, 700, 300.13, 714.5], label: 'Link to site.example' },
        { id: id('b'), page: 1, rect: [72, 700, 300.13, 714.5], label: 'Link to site.example' },
        { id: id('c'), page: 1, rect: [72, 700, 300.13, 714.5], label: 'Link to mail.example' },
      ]);
      expect(JSON.stringify(inputs.request)).not.toContain('site.example/');
      const urls = { [id('a')]: 'https://site.example/a', [id('b')]: 'https://site.example/b', [id('c')]: 'mailto:games~@mail.example' };
      expect(inputs.hash.equals(inputHash(sha(Buffer.from(`%PDF-1.7\n% issue ${serial}\n%%EOF\n`, 'latin1')), inputs.request, ENGINE_VERSION, urls))).toBe(true);
      // The same file under another origin is another copy.
      const other = await inputsFor(app, f, 'public', undefined, 'https://nwflmensa.us');
      expect(other?.kind === 'copy' && !other.hash.equals(inputs.hash)).toBe(true);
    });

    it('leaves out a disabled link from then on, and reads the link set as it stood at an earlier time', async () => {
      const { file: f } = await file();
      const before = await nowInDb();
      await attach(f, [web('d', 'd'), web('e', 'e')]);
      const attached = await nowInDb();
      const hashAttached = (await copyOf(f, 'public')).hash;
      await app.query(`SELECT pdf_link_disable($1, 'nxdomain', 'svc-nwfl-linkcheck', NULL)`, [id('d')]);
      const now = await copyOf(f, 'public');
      expect(now.request.links?.map((link) => link.id)).toEqual([id('e')]);
      const asOfAttached = await inputsFor(app, f, 'public', attached, ORIGIN);
      expect(asOfAttached?.kind === 'copy' && asOfAttached.request.links?.map((link) => link.id)).toEqual([id('d'), id('e')]);
      expect(asOfAttached?.kind === 'copy' && asOfAttached.hash.equals(hashAttached)).toBe(true);
      const asOfBefore = await inputsFor(app, f, 'public', before, ORIGIN);
      expect(asOfBefore?.kind === 'copy' && asOfBefore.request.links).toEqual([]);
    });

    it('checks each target against the passages this audience redacts (targetHolds): dropped for the public, kept for members', async () => {
      const { file: f, item } = await file();
      await attach(f, [
        web('f', 'rides/kestrel-ambry'),
        web('g', 'picnic'),
        { ...web('h', 'h'), url: 'mailto:wrenhallow.lane@mail.example', host: 'mail.example', kind: 'mail' },
        web('i', 'p?to=Kestrel%20Ambry'),
        // In the host, split by dots; in punycode; a mail address withheld itself.
        { ...web('r', 'x'), url: 'https://kestrel.ambry.example/x', host: 'kestrel.ambry.example' },
        { ...web('s', 'x'), url: 'https://xn--qillon-brask-dlb.example/x', host: 'xn--qillon-brask-dlb.example' },
        { ...web('t', 't'), url: 'mailto:q.brask@mail.example', host: 'mail.example', kind: 'mail' },
      ]);
      await mark(item, 'Kestrel Ambry', 'member_phone');
      await mark(item, 'Wrenhallow Lane', 'member_address');
      await mark(item, 'qüillon brask', 'member_phone');
      await mark(item, 'q.brask@mail.example', 'member_email');
      const pub = await copyOf(f, 'public');
      const members = await copyOf(f, 'members');
      // The public redacts phones, emails and addresses; members redact addresses only.
      expect(pub.request.links?.map((link) => link.id)).toEqual([id('g')]);
      expect(members.request.links?.map((link) => link.id)).toEqual([id('f'), id('g'), id('i'), id('r'), id('s'), id('t')]);
    });

    it('gives a file with no links an empty list, so its copy is made exactly as before links', async () => {
      const { file: f } = await file();
      expect((await copyOf(f, 'public')).request.links).toEqual([]);
    });
  });

  describe('0025: pdf_copy_put records the kept ids with the copy', () => {
    it('lets the worker record the links its copy holds, and refuses links on a refused copy, another file\'s, one twice or too many', async () => {
      const { file: f } = await file();
      const { file: g } = await file();
      await attach(f, [web('j', 'j'), web('k', 'k')]);
      await attach(g, [web('l', 'l')]);
      const claim = (await root.query<{ claim: string }>(`UPDATE pdf_regen SET claim = gen_random_uuid(), claimed_generation = generation, claimed_until = clock_timestamp() + interval '1 minute' WHERE file_id = $1 RETURNING claim`, [f])).rows[0]!.claim;
      const w = await worker.connect();
      try {
        const put = (hash: number, bytes: Buffer | null, links: string[] | null) => sqlstate(w, `SELECT pdf_copy_put($1, $2, $3, 'e', $4, $5, $6)`, [f, claim, Buffer.alloc(32, hash), bytes, bytes === null ? 'refused' : null, links]);
        expect(await put(1, Buffer.from('%PDF-copy'), [id('j'), id('k')])).toBe('ok');
        expect(await linksOf(f)).toEqual([id('j'), id('k')]);
        expect(await put(2, Buffer.from('%PDF-copy2'), null)).toBe('ok');
        expect(await put(3, null, [id('j')])).toBe('22023');
        expect(await put(4, Buffer.from('%PDF-copy4'), [id('l')])).toBe('22023');
        expect(await put(5, Buffer.from('%PDF-copy5'), [id('j'), id('j')])).toBe('22023');
        expect(await put(6, Buffer.from('%PDF-copy6'), Array.from({ length: 501 }, () => id('j')))).toBe('22023');
        expect(await put(7, Buffer.from('%PDF-copy7'), ['not-an-id'])).toBe('22023');
        // Once made, a copy is not put again, nor its links changed.
        expect(await put(1, Buffer.from('%PDF-copy'), [id('j')])).toBe('ok');
        expect(await linksOf(f)).toEqual([id('j'), id('k')]);
        // The six-argument put is gone.
        expect(await sqlstate(w as unknown as pg.Client, `SELECT pdf_copy_put($1, $2, $3, 'e', $4, NULL)`, [f, claim, Buffer.alloc(32, 9), Buffer.from('x')])).toBe('42883');
      } finally {
        w.release();
      }
      expect((await root.query(`SELECT 1 FROM pdf_copy WHERE file_id = $1 AND input_hash = ANY($2::bytea[])`, [f, [3, 4, 5, 6, 7].map((n) => Buffer.alloc(32, n))])).rowCount).toBe(0);
      // Let the job have the file again.
      await root.query(`UPDATE pdf_regen SET claimed_until = clock_timestamp() - interval '1 second' WHERE file_id = $1`, [f]);
    });

    it('records the ids the engine kept when the worker makes the copies, per audience', async () => {
      await drain(worker, { redact: keepAll, origin: ORIGIN });
      const { file: f, item } = await file();
      await attach(f, [web('m', 'kestrel-ambry'), web('n', 'picnic')]);
      await mark(item, 'Kestrel Ambry', 'member_phone');
      seen.length = 0;
      await drain(worker, { redact: keepAll, origin: ORIGIN });
      expect(seen.map((request) => request.links?.map((link) => link.id))).toEqual([[id('n')], [id('m'), id('n')]]);
      const rows = await root.query<{ input_hash: Buffer; link_id: string }>(`SELECT input_hash, link_id FROM pdf_copy_link WHERE file_id = $1 ORDER BY link_id`, [f]);
      const pub = await copyOf(f, 'public');
      const members = await copyOf(f, 'members');
      expect(rows.rows.filter((row) => row.input_hash.equals(pub.hash)).map((row) => row.link_id)).toEqual([id('n')]);
      expect(rows.rows.filter((row) => row.input_hash.equals(members.hash)).map((row) => row.link_id)).toEqual([id('m'), id('n')]);
    });

    it('refuses a copy whose engine says it kept a link of another file, and stores nothing for it', async () => {
      await drain(worker, { redact: keepAll, origin: ORIGIN });
      const { file: f } = await file();
      const lying: Redact = () => Promise.resolve({ kind: 'redacted', pdf: new Uint8Array(Buffer.from('copy')), boxes: [], kept: [id('j')] });
      await expect(regenerateOne(worker, { redact: lying, origin: ORIGIN })).rejects.toMatchObject({ code: '22023' });
      expect((await root.query(`SELECT 1 FROM pdf_copy WHERE file_id = $1`, [f])).rowCount).toBe(0);
      expect(await queued(f)).toBe(true);
      await root.query(`UPDATE pdf_regen SET claimed_until = clock_timestamp() - interval '1 second' WHERE file_id = $1`, [f]);
      await drain(worker, { redact: keepAll, origin: ORIGIN });
      expect(await queued(f)).toBe(false);
    });
  });

  describe('the boot sweep: every file that lacks a copy for its current inputs is queued', () => {
    it('queues only the files with no copy for an audience\'s current hash, and every file under a new origin', async () => {
      await drain(worker, { redact: keepAll, origin: ORIGIN });
      const { file: kept } = await file();
      const { file: lost } = await file();
      await drain(worker, { redact: keepAll, origin: ORIGIN });
      expect(await sweepCopies(worker, { origin: ORIGIN })).toEqual([]);
      // A copy that went (an engine bump keys every copy anew; here, one file's copies are removed).
      await root.query(`DELETE FROM pdf_copy WHERE file_id = $1`, [lost]);
      expect(await sweepCopies(worker, { origin: ORIGIN })).toEqual([lost]);
      expect(await queued(lost)).toBe(true);
      expect(await queued(kept)).toBe(false);
      await drain(worker, { redact: keepAll, origin: ORIGIN });
      // A new origin changes every key: every file with a copy is queued.
      const all = (await root.query<{ file_id: string }>(`SELECT file_id FROM pdf_original ORDER BY file_id`)).rows.map((row) => row.file_id);
      expect((await sweepCopies(worker, { origin: 'https://nwflmensa.us' })).sort()).toEqual(all);
      await drain(worker, { redact: keepAll, origin: ORIGIN });
    });

    it('runs the sweep once, before the job\'s first drain; a sweep that fails is heard and the drain still runs', async () => {
      await drain(worker, { redact: keepAll, origin: ORIGIN });
      const { file: f } = await file();
      const errors: unknown[] = [];
      let sweeps = 0;
      const job = startRegenerator({ db: worker, intervalMs: 10, redact: keepAll, origin: ORIGIN, onError: (error) => void errors.push(error), before: () => Promise.reject(Object.assign(new Error('sweep'), { n: ++sweeps })) });
      const deadline = Date.now() + 10_000;
      while ((await queued(f)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      await new Promise((resolve) => setTimeout(resolve, 60));
      await job.stop();
      expect(await queued(f)).toBe(false);
      expect(sweeps).toBe(1);
      expect(errors).toEqual([expect.objectContaining({ message: 'sweep' })]);
    });

    it('counts a refused copy as made: it is not queued again at every boot', async () => {
      const refusing: Redact = () => Promise.resolve({ kind: 'refused', reason: 'page 1 is a scan: pictures cover most of it' });
      await drain(worker, { redact: keepAll, origin: ORIGIN });
      const { file: f } = await file();
      await drain(worker, { redact: refusing, origin: ORIGIN });
      expect((await root.query(`SELECT 1 FROM pdf_copy WHERE file_id = $1 AND status = 'refused'`, [f])).rowCount).toBeGreaterThan(0);
      expect(await sweepCopies(worker, { origin: ORIGIN })).toEqual([]);
    });
  });

  describe('0025: who may do what', () => {
    it('gives the worker the new put and the sweep, and reads of the links; the app role and PUBLIC neither function', async () => {
      const { rows } = await root.query<{ fn: string; app: boolean; worker: boolean; public: boolean; definer: boolean }>(
        `SELECT p.oid::regprocedure::text AS fn, has_function_privilege('nwfl', p.oid, 'EXECUTE') AS app,
                has_function_privilege('nwfl_worker', p.oid, 'EXECUTE') AS worker, has_function_privilege('public', p.oid, 'EXECUTE') AS public, p.prosecdef AS definer
           FROM pg_proc p WHERE p.proname IN ('pdf_copy_put', 'pdf_regen_request_files') ORDER BY 1`,
      );
      expect(rows).toEqual([
        { fn: 'pdf_copy_put(uuid,uuid,bytea,text,bytea,text,text[])', app: false, worker: true, public: false, definer: true },
        { fn: 'pdf_regen_request_files(uuid[])', app: false, worker: true, public: false, definer: true },
      ]);
      const a = await app.connect();
      try {
        expect(await sqlstate(a as unknown as pg.Client, `SELECT pdf_regen_request_files(ARRAY[]::uuid[])`)).toBe('42501');
      } finally {
        a.release();
      }
      const w = await worker.connect();
      try {
        expect(await sqlstate(w as unknown as pg.Client, `SELECT id, file_id, page, rect, url, host, created_at FROM pdf_link`)).toBe('ok');
        expect(await sqlstate(w as unknown as pg.Client, `SELECT id, link_id, status, at FROM pdf_link_status`)).toBe('ok');
        for (const sql of [`SELECT kind FROM pdf_link`, `SELECT approval_reference FROM pdf_link`, `SELECT reason FROM pdf_link_status`, `SELECT * FROM pdf_copy_link`, `INSERT INTO pdf_link_status (link_id, status, reason, by_sub) VALUES ('x', 'active', 'x', 'x')`]) {
          expect(await sqlstate(w as unknown as pg.Client, sql), sql).toBe('42501');
        }
        expect(await sqlstate(w as unknown as pg.Client, `SELECT pdf_regen_request_files($1::uuid[])`, [Array.from({ length: 10_001 }, () => '00000000-0000-0000-0000-000000000000')])).toBe('22023');
        // A file with no original is not queued; nothing fails.
        expect(await sqlstate(w as unknown as pg.Client, `SELECT pdf_regen_request_files(ARRAY['00000000-0000-0000-0000-000000000000']::uuid[])`)).toBe('ok');
      } finally {
        w.release();
      }
      expect((await root.query(`SELECT 1 FROM pdf_regen WHERE file_id = '00000000-0000-0000-0000-000000000000'`)).rowCount).toBe(0);
    });

    it('lets the migrator run nwfl_worker_grants() again, with the same result', async () => {
      expect((await owner.query<{ done: boolean }>(`SELECT nwfl_worker_grants() AS done`)).rows[0]!.done).toBe(true);
      expect((await root.query<{ ok: boolean }>(`SELECT has_function_privilege('nwfl_worker', 'pdf_regen_request_files(uuid[])', 'EXECUTE') AS ok`)).rows[0]!.ok).toBe(true);
    });
  });
});
