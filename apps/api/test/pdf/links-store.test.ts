// LINKS L3 against the database: the links a copy may carry (store.ts inputsFor, read as of a time,
// each target checked per audience with targetHolds), the kept ids recorded with the copy (0025's
// pdf_copy_put, seventh argument), the worker's boot sweep (pdf_regen_request_files) and the worker's
// new grants (nwfl_worker_grants). The "PDFs" are a few bytes no engine reads: the engine here is a
// stand-in. Every URL is under a reserved example name and every person is made up.
import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RedactRequest } from '../../src/pdf/redact.js';
import { type Redact, drain, regenerateOne, startRegenerator, sweepCopies } from '../../src/pdf/regenerate.js';
import { ENGINE_VERSION, inputHash, inputHashV1, inputsFor } from '../../src/pdf/store.js';
import { ledgerAsOf, renderFile } from '../../src/ledger/ledger.js';
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
        { ...web('h', 'h'), url: 'mailto:wrenhallow.lane@example.org', host: 'example.org', kind: 'mail' },
        web('i', 'p?to=Kestrel%20Ambry'),
        // In the host, split by dots; in punycode; a mail address withheld itself.
        { ...web('r', 'x'), url: 'https://kestrel.ambry.example/x', host: 'kestrel.ambry.example' },
        { ...web('s', 'x'), url: 'https://xn--qillon-brask-dlb.example/x', host: 'xn--qillon-brask-dlb.example' },
        { ...web('t', 't'), url: 'mailto:q.brask@example.org', host: 'example.org', kind: 'mail' },
      ]);
      await mark(item, 'Kestrel Ambry', 'member_phone');
      await mark(item, 'Wrenhallow Lane', 'member_address');
      await mark(item, 'qüillon brask', 'member_phone');
      await mark(item, 'q.brask@example.org', 'member_email');
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

    it('passes over a file no audience is given a copy of, reads LINK_ORIGIN when given no origin, and stores no links for an engine that names none', async () => {
      const silent: Redact = () => Promise.resolve({ kind: 'redacted', pdf: new Uint8Array(Buffer.from('copy')), boxes: [] });
      await drain(worker, { redact: keepAll, origin: ORIGIN });
      // Officers only: officers are given the original, everyone else nothing.
      const { file: officers } = await file('officers');
      await drain(worker, { redact: keepAll, origin: ORIGIN });
      const { file: f } = await file();
      await attach(f, [web('u', 'u')]);
      await drain(worker, { redact: silent });
      expect(await linksOf(f)).toEqual([]);
      expect((await root.query(`SELECT 1 FROM pdf_copy WHERE file_id = $1 AND status = 'ready'`, [f])).rowCount).toBeGreaterThan(0);
      expect(await sweepCopies(worker)).toEqual([]);
      expect(await queued(officers)).toBe(false);
    });
  });

  describe('LINKS L3 fix round 1', () => {
    it('N4: refuses a rect under a hundredth of a point wide or high once rounded (0025), and inputsFor drops one attached before 0025', async () => {
      const { file: f } = await file();
      for (const rect of [[100.001, 700, 100.004, 710], [72, 700.001, 300, 700.004], [100.005, 700, 100.0149, 710]]) {
        await expect(attach(f, [web('v', 'v', { rect })]), rect.join(' ')).rejects.toMatchObject({ code: '23514' });
      }
      await attach(f, [web('v', 'v', { rect: [100.004, 700, 100.014, 700.01] })]);
      expect((await copyOf(f, 'public')).request.links?.map((link) => link.rect)).toEqual([[100, 700, 100.01, 700.01]]);
      // A row attached under 0024 alone, before the CHECK: the constraint is NOT VALID, so it may stand, and is dropped.
      const { file: g } = await file();
      const def = (await root.query<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'pdf_link_rect_hundredth'`)).rows[0]!.def;
      expect(def).toMatch(/NOT VALID/);
      await root.query(`ALTER TABLE pdf_link DROP CONSTRAINT pdf_link_rect_hundredth`);
      try {
        await attach(g, [web('w', 'w', { rect: [100.001, 700, 100.004, 710] }), web('x', 'x')]);
      } finally {
        await root.query(`ALTER TABLE pdf_link ADD CONSTRAINT pdf_link_rect_hundredth ${def}`);
      }
      expect((await copyOf(g, 'public')).request.links?.map((link) => link.id)).toEqual([id('x')]);
      expect((await copyOf(g, 'members')).request.links?.map((link) => link.id)).toEqual([id('x')]);
    });

    it('N3: the ledger records the origin with each file row, and as of a date reports an origin or engine change, not a mismatch', async () => {
      await drain(worker, { redact: keepAll, origin: ORIGIN });
      const { file: f } = await file();
      await attach(f, [web('y', 'y')]);
      await drain(worker, { redact: keepAll, origin: ORIGIN });
      const row = (await root.query<{ current_from: Date; inputs: Record<string, unknown> }>(`SELECT current_from, inputs FROM publication_ledger WHERE subject_id = $1 AND audience = 'public' ORDER BY seq DESC LIMIT 1`, [f])).rows[0]!;
      expect(row.inputs['served']).toBe('copy');
      expect(row.inputs['origin']).toBe(ORIGIN);
      const at = new Date(row.current_from.getTime() + 1);
      expect(await ledgerAsOf(app, 'stored_file', f, 'public', at, { origin: ORIGIN })).toMatchObject({ matches: true, detail: '' });
      expect(await ledgerAsOf(app, 'stored_file', f, 'public', at, { origin: 'https://nwflmensa.us' })).toMatchObject({ matches: false, detail: 'the link origin changed since this row: its inputs cannot be rebuilt to compare' });
      expect(await ledgerAsOf(app, 'stored_file', f, 'public', at, { origin: ORIGIN, engine: 'pdfium-0+other' })).toMatchObject({ matches: false, detail: 'the engine changed since this row: its inputs cannot be rebuilt to compare' });
      // With the same engine and origin, history that no longer gives the row's inputs is a mismatch: here a link's status rows
      // are taken out by hand, past the append-only guard, so the link reads as never active.
      await root.query('BEGIN');
      try {
        await root.query(`SET LOCAL session_replication_role = replica`);
        await root.query(`DELETE FROM pdf_link_status WHERE link_id = $1`, [id('y')]);
        await root.query('COMMIT');
      } catch (error) {
        await root.query('ROLLBACK');
        throw error;
      }
      expect(await ledgerAsOf(app, 'stored_file', f, 'public', at, { origin: ORIGIN })).toMatchObject({ matches: false, detail: 'the inputs rebuilt from the history do not match the row' });
    });

    it('N9: logs, for officers, a copy made without its links and why, by file and never by URL', async () => {
      await drain(worker, { redact: keepAll, origin: ORIGIN });
      const { file: f } = await file();
      await attach(f, [web('z', 'z')]);
      const dropping: Redact = () => Promise.resolve({ kind: 'redacted', pdf: new Uint8Array(Buffer.from('copy without links')), boxes: [], kept: [], linksDropped: 'the links could not be written' });
      const warnings: Array<[Record<string, unknown>, string]> = [];
      await drain(worker, { redact: dropping, origin: ORIGIN, warn: (fields, message) => void warnings.push([fields, message]) });
      expect(warnings.length).toBeGreaterThan(0);
      for (const [fields, message] of warnings) {
        expect(message).toBe('a PDF copy was made without its links');
        expect(fields).toEqual({ file_id: f, input_hash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown, links: 1, reason: 'the links could not be written' });
      }
      expect(JSON.stringify(warnings)).not.toContain('site.example');
      expect((await root.query(`SELECT 1 FROM pdf_copy WHERE file_id = $1 AND status = 'ready'`, [f])).rowCount).toBeGreaterThan(0);
      expect(await linksOf(f)).toEqual([]);
    });
  });

  describe('LINKS L3 fix round 2', () => {
    // 0017 takes publication_ledger_original from the app role once the worker role exists; granting it back stands for a
    // database where fc has not created the role yet, so an officer's remake reads the original (as in ledger.test.ts).
    const LEGACY_GRANT = `GRANT EXECUTE ON FUNCTION publication_ledger_original(bigint, text, text[], text) TO nwfl`;
    const LEGACY_REVOKE = `REVOKE EXECUTE ON FUNCTION publication_ledger_original(bigint, text, text[], text) FROM nwfl`;
    const latest = async (fileId: string, audience = 'public') =>
      (await root.query<{ current_from: Date; inputs: Record<string, unknown>; output_sha256: Buffer | null }>(`SELECT current_from, inputs, output_sha256 FROM publication_ledger WHERE subject_id = $1 AND audience = $2 ORDER BY seq DESC LIMIT 1`, [fileId, audience])).rows[0]!;
    const dropCopy = (fileId: string, hash: unknown) => owner.query(`DELETE FROM pdf_copy WHERE file_id = $1 AND input_hash = decode($2, 'hex')`, [fileId, hash]);
    const hasLinks = (request: RedactRequest): boolean => (request.links ?? []).length > 0;
    const WITHOUT = 'copy without links';
    /** An engine whose copy names whether it was given links, keeping each one. */
    const keeping = () =>
      vi.fn<Redact>((_original, request) =>
        Promise.resolve({ kind: 'redacted', pdf: new Uint8Array(Buffer.from(hasLinks(request) ? 'copy with links' : WITHOUT)), boxes: [], kept: (request.links ?? []).map((link) => link.id) }),
      );

    it('N4: the ledger records a copy made without its links, and the remake makes it again without them', async () => {
      await drain(worker, { redact: keepAll, origin: ORIGIN });
      const { file: f } = await file();
      await attach(f, [web('o', 'o')]);
      const dropping: Redact = (_original, request) =>
        Promise.resolve({ kind: 'redacted', pdf: new Uint8Array(Buffer.from(WITHOUT)), boxes: [], kept: [], ...(hasLinks(request) ? { linksDropped: 'the links could not be written' } : {}) });
      await drain(worker, { redact: dropping, origin: ORIGIN });
      const row = await latest(f);
      expect(row.inputs).toMatchObject({ served: 'copy', links_dropped: 'the links could not be written' });
      expect(row.output_sha256).toEqual(sha(WITHOUT));
      // A copy whose links were kept records nothing of the kind.
      const { file: g } = await file();
      await attach(g, [web('p', 'p')]);
      await drain(worker, { redact: keepAll, origin: ORIGIN });
      expect((await latest(g)).inputs).not.toHaveProperty('links_dropped');
      const at = new Date(row.current_from.getTime() + 1);
      await dropCopy(f, row.inputs['input_hash']);
      await owner.query(LEGACY_GRANT);
      try {
        // An engine that would keep the links today is asked with none, as the row says: the same bytes.
        const redact = keeping();
        expect(await ledgerAsOf(app, 'stored_file', f, 'public', at, { origin: ORIGIN, caller: OFFICER, redact })).toMatchObject({ matches: true, detail: '', rerender: sha(WITHOUT) });
        expect(redact.mock.calls.map(([, request]) => request.links)).toEqual([[]]);
      } finally {
        await owner.query(LEGACY_REVOKE);
      }
    });

    it('N4: a remake with no such record uses the worker\'s fallback: a run with links that is refused or fails is asked again with none', async () => {
      await drain(worker, { redact: keepAll, origin: ORIGIN });
      const { file: f } = await file();
      await attach(f, [web('q', 'q')]);
      // An engine that met every link (all vetoed): the copy holds none, and nothing was dropped by the fallback.
      const vetoing: Redact = () => Promise.resolve({ kind: 'redacted', pdf: new Uint8Array(Buffer.from(WITHOUT)), boxes: [], kept: [] });
      await drain(worker, { redact: vetoing, origin: ORIGIN });
      const row = await latest(f);
      expect(row.inputs).not.toHaveProperty('links_dropped');
      const at = new Date(row.current_from.getTime() + 1);
      await dropCopy(f, row.inputs['input_hash']);
      await owner.query(LEGACY_GRANT);
      try {
        for (const linked of [() => Promise.resolve({ kind: 'refused' as const, reason: 'the links could not be written' }), () => Promise.reject(new Error('the engine took longer than 300000 ms'))]) {
          const redact = vi.fn<Redact>((original, request) => (hasLinks(request) ? linked() : keeping()(original, request)));
          expect(await ledgerAsOf(app, 'stored_file', f, 'public', at, { origin: ORIGIN, caller: OFFICER, redact })).toMatchObject({ matches: true, detail: '', rerender: sha(WITHOUT) });
          expect(redact.mock.calls.map(([, request]) => request.links?.length)).toEqual([1, 0]);
        }
      } finally {
        await owner.query(LEGACY_REVOKE);
      }
    });

    it('N5: a row made before links-1 (no origin, the box-exact engine, input hash v1) rebuilds under its own engine with no links, and verifies', async () => {
      const BOX_EXACT = 'pdfium-2.15.1+pdf-lib-2.11.1+pdfjs-6.4.299+gate-r3b+box-exact';
      await drain(worker, { redact: keepAll, origin: ORIGIN });
      const { file: f, bytes } = await file();
      // As the worker did before links-1: claim the file, put its copy under the v1 key and the old engine, and record the
      // row main's renderFile wrote (today's, less the origin, with the old engine and key), then finish.
      const now = await copyOf(f, 'public');
      // main's inputHash, written out (store-unit.test.ts pins inputHashV1 to the same text).
      const v1 = sha(JSON.stringify({ v: 1, engine: BOX_EXACT, original: sha(bytes).toString('hex'), redactsAny: true, quotes: now.request.quotes, image: now.request.image }));
      const old = Buffer.from('copy made under box-exact');
      const client = await worker.connect();
      try {
        const claim = (await client.query<{ file_id: string; claim: string }>(`SELECT file_id, claim FROM pdf_regen_claim(600)`)).rows[0]!;
        expect(claim.file_id).toBe(f);
        await client.query(`SELECT pdf_copy_put($1, $2, $3, $4, $5, NULL, '{}')`, [f, claim.claim, v1, BOX_EXACT, old]);
        const inputs: Record<string, unknown> = { ...(await renderFile(app, f, 'public')).inputs, engine: BOX_EXACT, input_hash: v1.toString('hex'), served: 'copy' };
        delete inputs['origin'];
        await client.query('BEGIN');
        await client.query('SELECT publication_ledger_lock()');
        await client.query(`SELECT publication_ledger_record_file($1, $2, 'public', $3, $4, $5)`, [f, claim.claim, sha(old), inputs, now.request.quotes.length]);
        await client.query(`SELECT pdf_regen_finish($1, $2, $3::bytea[])`, [f, claim.claim, [v1]]);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      const row = await latest(f);
      expect(row.inputs).not.toHaveProperty('origin');
      expect(row.inputs['engine']).toBe(BOX_EXACT);
      const at = new Date(row.current_from.getTime() + 1);
      // The copy is kept (0021), and the row's inputs rebuild to its own key: it verifies, under any origin now.
      expect(await ledgerAsOf(app, 'stored_file', f, 'public', at, { origin: ORIGIN })).toMatchObject({ matches: true, detail: '', rerender: sha(old) });
      expect(await ledgerAsOf(app, 'stored_file', f, 'public', at, { origin: 'https://nwflmensa.us' })).toMatchObject({ matches: true, detail: '' });
      // A copy no longer kept is made again only by the engine that made it, with no links.
      await dropCopy(f, v1.toString('hex'));
      await owner.query(LEGACY_GRANT);
      try {
        const redact = vi.fn<Redact>(() => Promise.resolve({ kind: 'redacted', pdf: new Uint8Array(old), boxes: [] }));
        expect(await ledgerAsOf(app, 'stored_file', f, 'public', at, { origin: ORIGIN, caller: OFFICER, redact })).toMatchObject({
          matches: false,
          rerender: null,
          detail: 'the copy is no longer kept and another engine made it: inputs verified only',
        });
        expect(redact).not.toHaveBeenCalled();
        expect(await ledgerAsOf(app, 'stored_file', f, 'public', at, { origin: ORIGIN, caller: OFFICER, redact, engine: BOX_EXACT })).toMatchObject({ matches: true, detail: '', rerender: sha(old) });
        expect(redact.mock.calls.map(([, request]) => request)).toEqual([{ quotes: now.request.quotes, redactsAny: true, image: now.request.image, links: [] }]);
        expect(v1).toEqual(inputHashV1(sha(bytes), now.request, BOX_EXACT));
      } finally {
        await owner.query(LEGACY_REVOKE);
      }
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
