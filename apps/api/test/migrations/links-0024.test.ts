// LINKS L2 (0024): the approved links of a stored PDF. pdf_link is kept as written, pdf_link_status
// only grows, and pdf_copy_link changes only with its copy. A status is written at its transaction's
// ledger stamp, under the ledger lock, so "as of T" reads the link set as the ledger does; every
// link or status write queues its file. pdf_links_attach is the one writer of links, for the issue
// loader's files only; pdf_link_disable only ever turns a link off. Every URL here is under a
// reserved example name and every person is made up; the "PDFs" are a few bytes the database never
// parses.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostOf } from '../../src/load/links.js';
import { APP, APP_PW, MIGRATOR, MIGRATOR_PW, WORKER, WORKER_PW, dropDatabase, failure, freshDatabase, live, migrate, sqlstate, url, urlFor } from '../helpers/pg.js';

const LOADER = 'system:issue-loader';
const OFFICER = 'sub-officer-alex-sample';
const CHECKER = 'svc-nwfl-linkcheck';
const ATTACH = `SELECT pdf_links_attach($1, $2::jsonb, $3, $4, $5, $6) AS n`;
const DISABLE = `SELECT pdf_link_disable($1, $2, $3, $4) AS done`;
const sha = (value: string | Buffer): Buffer => createHash('sha256').update(value).digest();
const SHA = sha('the approved links');

const id = (n: number): string => `${'a'.repeat(24)}${'abcdefghijklmnopqrstuvwxyz234567'[Math.floor(n / 32)]}${'abcdefghijklmnopqrstuvwxyz234567'[n % 32]}`;
interface Row {
  id: string;
  page: number;
  rect: number[];
  url: string;
  host: string;
  kind: string;
  confirm: boolean;
}
const web = (n: number, extra: Partial<Row> = {}): Row => ({ id: id(n), page: 1, rect: [72, 700, 300, 714.5], url: `https://example.org/p/${n}`, host: 'example.org', kind: 'web', confirm: false, ...extra });
const mail = (n: number, extra: Partial<Row> = {}): Row => ({ id: id(n), page: 2, rect: [72, 600, 200, 612], url: 'mailto:Games@example.org', host: 'example.org', kind: 'mail', confirm: false, ...extra });

describe.skipIf(!live)('0024: the approved links of a stored PDF', () => {
  let name: string;
  let app: pg.Pool;
  let appc: pg.Client;
  let worker: pg.Client;
  let owner: pg.Client;
  let root: pg.Client;
  let office: string;
  let serial = 0;

  /** A document item whose version `writer` wrote, with one PDF file, its original stored unless `stored` is false. */
  async function file(writer = LOADER, stored = true): Promise<string> {
    serial++;
    const item = (await app.query<{ id: string }>(`INSERT INTO content_item (slug, kind, office_id) VALUES ($1, 'document', $2) RETURNING id`, [`issue-${serial}`, office])).rows[0]!.id;
    const version = (
      await app.query<{ id: string }>(`INSERT INTO content_version (item_id, n, title, created_by_sub, acting_office_id) VALUES ($1, 1, 'Issue', $2, $3) RETURNING id`, [item, writer, office])
    ).rows[0]!.id;
    const bytes = Buffer.from(`%PDF-1.7\n% issue ${serial}\n%%EOF\n`, 'latin1');
    const fileId = (
      await app.query<{ id: string }>(
        `INSERT INTO stored_file (version_id, object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ($1, $2, 'i.pdf', 'application/pdf', $3, $4, 'public') RETURNING id`,
        [version, `k-${serial}`, bytes.length, sha(bytes)],
      )
    ).rows[0]!.id;
    if (stored) await app.query(`SELECT pdf_original_put($1, $2, $3, '{}', NULL)`, [fileId, bytes, writer]);
    return fileId;
  }

  const attach = (fileId: string, links: unknown, extra: { reference?: string; sha?: Buffer; sub?: string } = {}) =>
    app.query<{ n: number }>(ATTACH, [fileId, JSON.stringify(links), extra.reference ?? 'LINKS', extra.sha ?? SHA, extra.sub ?? LOADER, null]);
  const generation = async (fileId: string): Promise<number | null> => {
    const row = (await root.query<{ generation: string }>(`SELECT generation FROM pdf_regen WHERE file_id = $1`, [fileId])).rows[0];
    return row === undefined ? null : Number(row.generation);
  };
  const count = async (table: string): Promise<number> => Number((await root.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n);
  /** A link's status as of a time: the latest status written at or before it (null: no link yet). */
  // A time as text, so the stamps' microseconds survive (a Date holds milliseconds).
  const statusAsOf = async (link: string, at: Date | string): Promise<string | null> =>
    (await root.query<{ status: string }>(`SELECT status FROM pdf_link_status WHERE link_id = $1 AND at <= $2::timestamptz ORDER BY at DESC, id DESC LIMIT 1`, [link, at])).rows[0]?.status ?? null;

  beforeAll(async () => {
    name = await freshDatabase('nwfl_0024');
    const run = await migrate(name);
    if (run.code !== 0) throw new Error(`migrate failed: ${run.stderr}`);
    app = new pg.Pool({ connectionString: urlFor(APP, APP_PW, name), max: 3 });
    app.on('error', () => undefined);
    appc = new pg.Client({ connectionString: urlFor(APP, APP_PW, name) });
    worker = new pg.Client({ connectionString: urlFor(WORKER, WORKER_PW, name) });
    owner = new pg.Client({ connectionString: urlFor(MIGRATOR, MIGRATOR_PW, name) });
    const target = new URL(url as string);
    target.pathname = `/${name}`;
    root = new pg.Client({ connectionString: target.toString() });
    await Promise.all([appc.connect(), worker.connect(), owner.connect(), root.connect()]);
    office = (await app.query<{ id: string }>(`INSERT INTO office (slug, title, kind) VALUES ('editor', 'Newsletter Editor', 'appointed') RETURNING id`)).rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await Promise.all([appc?.end(), worker?.end(), owner?.end(), root?.end()]);
    await app?.end();
    if (name !== undefined) await dropDatabase(name);
  });

  describe('who may do what', () => {
    it('lets the app role read the three tables and write none of them', async () => {
      for (const table of ['pdf_link', 'pdf_link_status', 'pdf_copy_link']) {
        expect(await sqlstate(appc, `SELECT * FROM ${table}`), table).toBe('ok');
        for (const sql of [`DELETE FROM ${table}`, `UPDATE ${table} SET link_id = link_id`, `TRUNCATE ${table}`]) {
          expect(await sqlstate(appc, sql.replace('pdf_link SET link_id = link_id', 'pdf_link SET url = url')), sql).toBe('42501');
        }
      }
      expect(await sqlstate(appc, `INSERT INTO pdf_link_status (link_id, status, reason, by_sub) VALUES ($1, 'active', 'attached', 'x')`, [id(1)])).toBe('42501');
      expect(await sqlstate(appc, `SELECT nextval('pdf_link_status_id_seq')`)).toBe('42501');
    });

    it('gives the app role the attach and disable functions, and the worker and PUBLIC neither (the worker gets its reads in L3)', async () => {
      const { rows } = await root.query<{ fn: string; app: boolean; worker: boolean; public: boolean; definer: boolean }>(
        `SELECT p.oid::regprocedure::text AS fn, has_function_privilege('nwfl', p.oid, 'EXECUTE') AS app,
                has_function_privilege('nwfl_worker', p.oid, 'EXECUTE') AS worker, has_function_privilege('public', p.oid, 'EXECUTE') AS public,
                p.prosecdef AS definer
           FROM pg_proc p WHERE p.proname IN ('pdf_links_attach', 'pdf_link_disable') ORDER BY 1`,
      );
      expect(rows).toEqual([
        { fn: 'pdf_link_disable(text,text,text,text)', app: true, worker: false, public: false, definer: true },
        { fn: 'pdf_links_attach(uuid,jsonb,text,bytea,text,text)', app: true, worker: false, public: false, definer: true },
      ]);
      for (const table of ['pdf_link', 'pdf_link_status', 'pdf_copy_link']) expect(await sqlstate(worker, `SELECT * FROM ${table}`), table).toBe('42501');
    });

    it('pins every new function\'s search_path', async () => {
      const { rows } = await root.query<{ proname: string; config: string[] | null }>(
        `SELECT proname, proconfig AS config FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'pdf_link%' OR proname LIKE 'pdf_copy_link%') ORDER BY 1`,
      );
      expect(rows.map((row) => row.proname)).toEqual([
        'pdf_copy_link_guard',
        'pdf_link_disable',
        'pdf_link_guard',
        'pdf_link_stale',
        'pdf_link_stamp',
        'pdf_link_status_guard',
        'pdf_link_status_stale',
        'pdf_links_attach',
      ]);
      for (const row of rows) expect(row.config, row.proname).toEqual(['search_path=pg_catalog, public, pg_temp']);
    });
  });

  describe('pdf_links_attach', () => {
    it("attaches a loader file's links: each row as given, its host checked against its url, active from the transaction's stamp, audited by count", async () => {
      const fileId = await file();
      const links = [web(1), mail(2), web(3, { confirm: true, url: 'https://social.example.net/g?x=1#y', host: 'social.example.net', page: 3 })];
      const client = await app.connect();
      try {
        await client.query('BEGIN');
        expect((await client.query<{ n: number }>(ATTACH, [fileId, JSON.stringify(links), 'LINKS-2026-10', SHA, LOADER, '0123456789abcdef0123456789abcdef'])).rows[0]?.n).toBe(3);
        const head = (await client.query<{ stamp: Date; mine: boolean }>(`SELECT stamp, stamp_txid = txid_current() AS mine FROM publication_ledger_head`)).rows[0]!;
        expect(head.mine).toBe(true);
        await client.query('COMMIT');
        const rows = (
          await root.query<Row & { file_id: string; approval_reference: string; links_sha256: Buffer; created_by_sub: string; created_at: Date }>(
            `SELECT id, file_id, page, rect, url, host, kind, confirm, approval_reference, links_sha256, created_by_sub, created_at FROM pdf_link WHERE file_id = $1 ORDER BY id`,
            [fileId],
          )
        ).rows;
        expect(rows.map(({ id: i, page, rect, url: u, host, kind, confirm }) => ({ id: i, page, rect, url: u, host, kind, confirm }))).toEqual(links);
        for (const row of rows) {
          expect(row).toMatchObject({ file_id: fileId, approval_reference: 'LINKS-2026-10', links_sha256: SHA, created_by_sub: LOADER });
          expect(row.created_at).toEqual(head.stamp);
        }
        const statuses = (await root.query(`SELECT link_id, status, reason, by_sub, at FROM pdf_link_status WHERE link_id = ANY($1) ORDER BY link_id`, [links.map((l) => l.id)])).rows;
        expect(statuses).toEqual(links.map((l) => ({ link_id: l.id, status: 'active', reason: 'attached', by_sub: LOADER, at: head.stamp })));
        const audit = (await root.query(`SELECT trace_id, actor_sub, action, subject_kind, subject_id, to_state, payload FROM audit_event WHERE action = 'pdf_links_attach' AND subject_id = $1`, [fileId])).rows;
        expect(audit).toEqual([
          {
            trace_id: '0123456789abcdef0123456789abcdef',
            actor_sub: LOADER,
            action: 'pdf_links_attach',
            subject_kind: 'stored_file',
            subject_id: fileId,
            to_state: 'attached',
            payload: { links: 3, reference: 'LINKS-2026-10', links_sha256: SHA.toString('hex') },
          },
        ]);
      } finally {
        client.release();
      }
    });

    it('queues the file and marks its copies stale', async () => {
      const fileId = await file();
      await root.query(`DELETE FROM pdf_regen WHERE file_id = $1`, [fileId]);
      await root.query(`INSERT INTO pdf_copy (file_id, input_hash, engine, status, bytes) VALUES ($1, $2, 'e', 'ready', '\\x25504446')`, [fileId, sha('old')]);
      expect(await generation(fileId)).toBeNull();
      await attach(fileId, [web(10)]);
      expect(await generation(fileId)).not.toBeNull();
      expect((await root.query(`SELECT stale FROM pdf_copy WHERE file_id = $1`, [fileId])).rows).toEqual([{ stale: true }]);
    });

    it('attaches a file\'s links once: a second attach is refused, whatever it holds', async () => {
      const fileId = await file();
      await attach(fileId, [web(20)]);
      expect(await failure(appc, ATTACH, [fileId, JSON.stringify([web(21)]), 'LINKS', SHA, LOADER, null])).toBe("a file's links are attached once");
      expect(await sqlstate(appc, ATTACH, [fileId, JSON.stringify([web(21)]), 'LINKS', SHA, LOADER, null])).toBe('55000');
      expect((await root.query(`SELECT id FROM pdf_link WHERE file_id = $1`, [fileId])).rows).toEqual([{ id: id(20) }]);
    });

    it("is the issue loader's alone: another sub, an empty one, or a file someone else wrote is refused", async () => {
      const loaders = await file();
      const officers = await file(OFFICER);
      const as = (fileId: string, sub: string | null) => sqlstate(appc, ATTACH, [fileId, JSON.stringify([web(30)]), 'LINKS', SHA, sub, null]);
      expect(await as(loaders, OFFICER)).toBe('42501');
      expect(await as(loaders, '')).toBe('42501');
      expect(await as(loaders, null)).toBe('42501');
      expect(await as(officers, OFFICER)).toBe('42501');
      expect(await as(officers, LOADER)).toBe('42501');
      expect(await failure(appc, ATTACH, [officers, JSON.stringify([web(30)]), 'LINKS', SHA, LOADER, null])).toBe("only the issue loader attaches links, to a file of a version it wrote");
      expect(await count(`pdf_link WHERE file_id IN ('${loaders}', '${officers}')`)).toBe(0);
    });

    it('refuses a file that does not exist or has no stored original', async () => {
      const unstored = await file(LOADER, false);
      expect(await failure(appc, ATTACH, ['00000000-0000-4000-8000-000000000001', JSON.stringify([web(31)]), 'LINKS', SHA, LOADER, null])).toBe('no such file');
      expect(await failure(appc, ATTACH, [unstored, JSON.stringify([web(31)]), 'LINKS', SHA, LOADER, null])).toBe('links are attached only to a stored PDF');
      expect(await sqlstate(appc, ATTACH, [unstored, JSON.stringify([web(31)]), 'LINKS', SHA, LOADER, null])).toBe('22023');
    });

    it.each([
      ['not a list', { links: [] }, 'the links are a list of 1 to 500 objects'],
      ['an empty list', [], 'the links are a list of 1 to 500 objects'],
      ['501 links', Array.from({ length: 501 }, (_v, n) => web(n)), 'the links are a list of 1 to 500 objects'],
      ['a string in the list', ['https://example.org/'], 'each link holds exactly id, page, rect, url, host, kind and confirm'],
      ['an unknown key', [{ ...web(40), text: 'Game night' }], 'each link holds exactly id, page, rect, url, host, kind and confirm'],
      ['a missing key', [{ ...web(40), confirm: undefined }], 'each link holds exactly id, page, rect, url, host, kind and confirm'],
    ])('refuses %s, adding nothing', async (_label, links, message) => {
      const fileId = await file();
      expect(await failure(appc, ATTACH, [fileId, JSON.stringify(links), 'LINKS', SHA, LOADER, null])).toBe(message);
      expect(await sqlstate(appc, ATTACH, [fileId, JSON.stringify(links), 'LINKS', SHA, LOADER, null])).toBe('22023');
      expect(await count(`pdf_link WHERE file_id = '${fileId}'`)).toBe(0);
    });

    it.each([
      ['a reference with free text', { reference: 'ok from Pat' }, 'an approval reference is a reply tag'],
      ['a short links hash', { sha: Buffer.alloc(31) }, 'the links sha256 is 32 bytes'],
    ] as Array<[string, { reference?: string; sha?: Buffer }, string]>)('refuses %s', async (_label, extra, message) => {
      const fileId = await file();
      expect(await failure(appc, ATTACH, [fileId, JSON.stringify([web(41)]), extra.reference ?? 'LINKS', extra.sha ?? SHA, LOADER, null])).toBe(message);
    });

    it.each([
      ['an id that is not base32', { id: `${'a'.repeat(25)}1` }],
      ['an upper-case id', { id: 'A'.repeat(26) }],
      ['page 0', { page: 0 }],
      ['page 10001', { page: 10_001 }],
      ['a rect of three numbers', { rect: [1, 2, 3] }],
      ['a rect with NaN', { rect: ['NaN', 700, 300, 714] }],
      ['a rect with Infinity', { rect: [72, 700, 'Infinity', 714] }],
      ['a rect past 14400', { rect: [72, 700, 14_401, 714] }],
      ['an empty rect', { rect: [72, 700, 72, 714] }],
      ['a rect upside down', { rect: [72, 714, 300, 700] }],
      ['plain http', { url: 'http://example.org/p/1' }],
      ['javascript:', { url: 'javascript:alert(1)', host: 'alert' }],
      ['a space in the url', { url: 'https://example.org/a b' }],
      ['a non-ASCII url', { url: 'https://example.org/é' }],
      ['a url over 2048 bytes', { url: `https://example.org/${'a'.repeat(2030)}` }],
      ['a host that is not the url\'s', { host: 'evil.example' }],
      ['a host that is only the start of the url\'s', { url: 'https://example.org.evil.example/', host: 'example.org' }],
      ['a host with credentials before it', { url: 'https://example.org@example.net/', host: 'example.org' }],
      ['an upper-case host', { url: 'https://Example.org/', host: 'Example.org' }],
      ['an IPv4 host', { url: 'https://127.0.0.1/', host: '127.0.0.1' }],
      ['a private IPv4 host', { url: 'https://10.0.0.1/admin', host: '10.0.0.1' }],
      ['a decimal IPv4 host', { url: 'https://2130706433/', host: '2130706433' }],
      ['a hex IPv4 host', { url: 'https://0x7f.0.0.1/', host: '0x7f.0.0.1' }],
      ['an IPv6 host', { url: 'https://[::1]/', host: '[::1]' }],
      ['a dotless host', { url: 'https://localhost/', host: 'localhost' }],
      ['a trailing dot', { url: 'https://example.org./', host: 'example.org.' }],
      ['an empty label', { url: 'https://example..org/', host: 'example..org' }],
      ['a label that starts with a hyphen', { url: 'https://-x.example.org/', host: '-x.example.org' }],
      ['a numeric last label', { url: 'https://example.123/', host: 'example.123' }],
      ['an explicit port', { url: 'https://example.org:443/', host: 'example.org' }],
      ['a web link to mailto', { url: 'mailto:a@example.org', host: 'example.org' }],
      ['an unknown kind', { kind: 'tel' }],
    ])('refuses a web link with %s, adding nothing', async (_label, change) => {
      const fileId = await file();
      const state = await sqlstate(appc, ATTACH, [fileId, JSON.stringify([web(50), web(51, change as Partial<Row>)]), 'LINKS', SHA, LOADER, null]);
      expect(['23514', '22023', '22P02']).toContain(state);
      expect(await count(`pdf_link WHERE file_id = '${fileId}'`)).toBe(0);
    });

    it.each([
      ['a domain other than the host', { host: 'example.net' }],
      ['an https url', { url: 'https://example.org/' }],
      ['two at signs', { url: 'mailto:a@b@example.org' }],
      ['no address', { url: 'mailto:@example.org' }],
      ['an upper-case domain', { url: 'mailto:games@Example.org' }],
      ['a subject', { url: 'mailto:games@example.org?subject=hi' }],
      ['a subject, its host named with it', { url: 'mailto:games@example.org?subject=hi', host: 'example.org?subject=hi' }],
      ['a cc', { url: 'mailto:games@example.org?cc=a@example.org' }],
      ['an IPv4 domain', { url: 'mailto:games@127.0.0.1', host: '127.0.0.1' }],
      ['a dotless domain', { url: 'mailto:games@localhost', host: 'localhost' }],
      ['an empty label', { url: 'mailto:games@example..org', host: 'example..org' }],
      // The local part: no query, fragment or escape in it either (round 2, S1).
      ['a ? in the local part', { url: 'mailto:a?subject=x@example.org' }],
      ['a # in the local part', { url: 'mailto:a#b@example.org' }],
      ['a % in the local part', { url: 'mailto:a%40b@example.org' }],
      // Nor a local part starting with '/' (round 3, CONTRACT item 10).
      ['a local part starting with /', { url: 'mailto:/x@example.org' }],
      ['an authority', { url: 'mailto://x@example.org' }],
      ['a dot segment', { url: 'mailto:/./x@example.org' }],
      ['a dot-dot segment', { url: 'mailto:/a/../b@example.org' }],
    ])('refuses a mail link with %s', async (_label, change) => {
      const fileId = await file();
      expect(await sqlstate(appc, ATTACH, [fileId, JSON.stringify([mail(60, change as Partial<Row>)]), 'LINKS', SHA, LOADER, null])).toBe('23514');
    });

    it("accepts every kept form of the shared links contract (CONTRACT.md), each with the loader's host", async () => {
      const cases = JSON.parse(readFileSync(new URL('../load/fixtures/links-contract.json', import.meta.url), 'utf8')) as Array<{ in: string; out: string | null }>;
      const kept = [...new Set(cases.flatMap((entry) => (entry.out === null ? [] : [entry.out])))];
      expect(kept.length).toBeGreaterThan(5);
      const rows = kept.map((u, n) => {
        const kind = u.startsWith('mailto:') ? 'mail' : 'web';
        return (kind === 'mail' ? mail : web)(300 + n, { url: u, host: hostOf({ url: u, kind }) });
      });
      expect((await attach(await file(), rows)).rows[0]?.n).toBe(rows.length);
    });

    it('refuses an id already used, on this file or another', async () => {
      const first = await file();
      const second = await file();
      await attach(first, [web(70)]);
      expect(await sqlstate(appc, ATTACH, [second, JSON.stringify([web(71), web(70)]), 'LINKS', SHA, LOADER, null])).toBe('23505');
      expect(await sqlstate(appc, ATTACH, [second, JSON.stringify([web(72), web(72)]), 'LINKS', SHA, LOADER, null])).toBe('23505');
      expect(await count(`pdf_link WHERE file_id = '${second}'`)).toBe(0);
    });
  });

  describe('the guards, for every role\'s writes, the owner\'s too', () => {
    let fileId: string;
    beforeAll(async () => {
      fileId = await file();
      await attach(fileId, [web(80), web(81)]);
    });

    it.each([
      ['pdf_link', `UPDATE pdf_link SET url = 'https://evil.example/' WHERE id = '${id(80)}'`],
      ['pdf_link', `UPDATE pdf_link SET confirm = true WHERE id = '${id(80)}'`],
      ['pdf_link', `DELETE FROM pdf_link WHERE id = '${id(80)}'`],
      ['pdf_link', `TRUNCATE pdf_link CASCADE`],
      ['pdf_link_status', `UPDATE pdf_link_status SET status = 'disabled' WHERE link_id = '${id(80)}'`],
      ['pdf_link_status', `DELETE FROM pdf_link_status WHERE link_id = '${id(80)}'`],
      ['pdf_link_status', `TRUNCATE pdf_link_status`],
    ])('refuses on %s: %s', async (_table, sql) => {
      expect(await sqlstate(owner, sql)).toBe('55000');
      expect(await sqlstate(root, sql)).toBe('55000');
      expect(await count(`pdf_link WHERE file_id = '${fileId}'`)).toBe(2);
      expect(await count(`pdf_link_status s JOIN pdf_link l ON l.id = s.link_id WHERE l.file_id = '${fileId}' AND s.status = 'active'`)).toBe(2);
    });

    it("stamps a status the owner appends with its transaction's stamp, whatever time it gives", async () => {
      await root.query('BEGIN');
      try {
        await root.query(`INSERT INTO pdf_link_status (link_id, status, reason, by_sub, at) VALUES ($1, 'active', 'reapproved', $2, '2001-01-01')`, [id(81), OFFICER]);
        const { rows } = await root.query<{ same: boolean }>(
          `SELECT s.at = h.stamp AND h.stamp_txid = txid_current() AS same FROM pdf_link_status s, publication_ledger_head h WHERE s.link_id = $1 AND s.reason = 'reapproved'`,
          [id(81)],
        );
        expect(rows).toEqual([{ same: true }]);
      } finally {
        await root.query('ROLLBACK');
      }
    });

    it.each([
      ['an unknown status', `INSERT INTO pdf_link_status (link_id, status, reason, by_sub) VALUES ('${id(81)}', 'paused', 'x_y', 'x')`],
      ['a reason with free text', `INSERT INTO pdf_link_status (link_id, status, reason, by_sub) VALUES ('${id(81)}', 'disabled', 'It moved', 'x')`],
      ['no writer', `INSERT INTO pdf_link_status (link_id, status, reason, by_sub) VALUES ('${id(81)}', 'disabled', 'gone', '')`],
      ['an unknown link', `INSERT INTO pdf_link_status (link_id, status, reason, by_sub) VALUES ('${id(999)}', 'disabled', 'gone', 'x')`],
    ])('refuses a status with %s', async (_label, sql) => {
      expect(['23514', '23503']).toContain(await sqlstate(root, sql));
    });
  });

  describe('pdf_link_disable', () => {
    let fileId: string;
    beforeAll(async () => {
      fileId = await file();
      await attach(fileId, [web(90), web(91), web(92)]);
    });

    it('turns an active link off: an appended status at the stamp, an audit row, the file queued; a second call changes nothing', async () => {
      await root.query(`DELETE FROM pdf_regen WHERE file_id = $1`, [fileId]);
      expect((await app.query<{ done: boolean }>(DISABLE, [id(90), 'nxdomain', CHECKER, null])).rows[0]?.done).toBe(true);
      expect(await generation(fileId)).not.toBeNull();
      const statuses = (await root.query(`SELECT status, reason, by_sub FROM pdf_link_status WHERE link_id = $1 ORDER BY id`, [id(90)])).rows;
      expect(statuses).toEqual([
        { status: 'active', reason: 'attached', by_sub: LOADER },
        { status: 'disabled', reason: 'nxdomain', by_sub: CHECKER },
      ]);
      const audit = (await root.query(`SELECT actor_sub, subject_kind, subject_id, from_state, to_state, payload FROM audit_event WHERE action = 'pdf_link_disable'`)).rows;
      expect(audit).toEqual([{ actor_sub: CHECKER, subject_kind: 'stored_file', subject_id: fileId, from_state: 'active', to_state: 'disabled', payload: { link_id: id(90), reason: 'nxdomain' } }]);
      const before = await count('pdf_link_status');
      expect((await app.query<{ done: boolean }>(DISABLE, [id(90), 'parked', CHECKER, null])).rows[0]?.done).toBe(false);
      expect(await count('pdf_link_status')).toBe(before);
      expect(await count(`audit_event WHERE action = 'pdf_link_disable'`)).toBe(1);
    });

    it('refuses an unknown link, a reason that is not a code, and an empty sub', async () => {
      expect(await failure(appc, DISABLE, [id(999), 'gone', CHECKER, null])).toBe('no such link');
      expect(await sqlstate(appc, DISABLE, [id(999), 'gone', CHECKER, null])).toBe('22023');
      expect(await failure(appc, DISABLE, [id(91), 'It moved away', CHECKER, null])).toBe('a reason is a code: lower-case letters, digits and underscores');
      expect(await sqlstate(appc, DISABLE, [id(91), null, CHECKER, null])).toBe('22023');
      expect(await sqlstate(appc, DISABLE, [id(91), 'gone', '', null])).toBe('42501');
      expect(await sqlstate(appc, DISABLE, [id(91), 'gone', null, null])).toBe('42501');
      expect(await statusAsOf(id(91), new Date('2999-01-01'))).toBe('active');
    });

    it('waits for the ledger lock: no disable commits between a render and its append', async () => {
      const holder = await app.connect();
      const waiter = await app.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT publication_ledger_lock()');
        await waiter.query(`SET statement_timeout = 300`);
        expect(await sqlstate(waiter as unknown as pg.Client, DISABLE, [id(91), 'gone', CHECKER, null])).toBe('57014');
        await holder.query('ROLLBACK');
        expect((await waiter.query<{ done: boolean }>(DISABLE, [id(91), 'gone', CHECKER, null])).rows[0]?.done).toBe(true);
        await waiter.query(`RESET statement_timeout`);
      } finally {
        holder.release();
        waiter.release();
      }
    });

    it('reads the link set as of any time: none before the attach, active until the disable, disabled after', async () => {
      const attached = (await root.query<{ at: string; before: string }>(`SELECT at::text AS at, (at - interval '1 microsecond')::text AS before FROM pdf_link_status WHERE link_id = $1 AND status = 'active'`, [id(92)])).rows[0]!;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const between = new Date();
      await new Promise((resolve) => setTimeout(resolve, 5));
      await app.query(DISABLE, [id(92), 'reregistered', CHECKER, null]);
      const disabled = (await root.query<{ at: string; before: string }>(`SELECT at::text AS at, (at - interval '1 microsecond')::text AS before FROM pdf_link_status WHERE link_id = $1 AND status = 'disabled'`, [id(92)])).rows[0]!;
      expect(new Date(disabled.at).getTime()).toBeGreaterThan(between.getTime());
      expect(await statusAsOf(id(92), attached.before)).toBeNull();
      expect(await statusAsOf(id(92), attached.at)).toBe('active');
      expect(await statusAsOf(id(92), between)).toBe('active');
      expect(await statusAsOf(id(92), disabled.before)).toBe('active');
      expect(await statusAsOf(id(92), disabled.at)).toBe('disabled');
    });
  });

  describe('pdf_copy_link (written by the worker with its copy, in L3)', () => {
    let fileId: string;
    let other: string;
    const ready = sha('ready copy');
    const refused = sha('refused copy');

    beforeAll(async () => {
      fileId = await file();
      other = await file();
      await attach(fileId, [web(100), web(101)]);
      await attach(other, [web(102)]);
      await root.query(`INSERT INTO pdf_copy (file_id, input_hash, engine, status, bytes) VALUES ($1, $2, 'e', 'ready', '\\x25504446')`, [fileId, ready]);
      await root.query(`INSERT INTO pdf_copy (file_id, input_hash, engine, status, reason) VALUES ($1, $2, 'e', 'refused', 'gate')`, [fileId, refused]);
    });

    it("lists a ready copy's links, each a link of the copy's own file", async () => {
      await root.query(`INSERT INTO pdf_copy_link (file_id, input_hash, link_id) VALUES ($1, $2, $3), ($1, $2, $4)`, [fileId, ready, id(100), id(101)]);
      expect(await count(`pdf_copy_link WHERE file_id = '${fileId}'`)).toBe(2);
      expect(await failure(root, `INSERT INTO pdf_copy_link (file_id, input_hash, link_id) VALUES ($1, $2, $3)`, [fileId, ready, id(102)])).toBe("a copy holds only a ready copy's own file's links");
      expect(await sqlstate(root, `INSERT INTO pdf_copy_link (file_id, input_hash, link_id) VALUES ($1, $2, $3)`, [fileId, refused, id(100)])).toBe('22023');
      // The guard runs before the foreign key: a copy that does not exist is refused by it too.
      expect(await sqlstate(root, `INSERT INTO pdf_copy_link (file_id, input_hash, link_id) VALUES ($1, $2, $3)`, [fileId, sha('no copy'), id(100)])).toBe('22023');
    });

    it.each([
      `UPDATE pdf_copy_link SET link_id = link_id`,
      `DELETE FROM pdf_copy_link`,
      `TRUNCATE pdf_copy_link`,
    ])('refuses, while the copy stands: %s', async (sql) => {
      expect(await sqlstate(owner, sql)).toBe('55000');
      expect(await sqlstate(root, sql)).toBe('55000');
      expect(await count(`pdf_copy_link WHERE file_id = '${fileId}'`)).toBe(2);
    });

    it('goes with its copy when the copy is dropped (pdf_regen_finish)', async () => {
      await root.query(`DELETE FROM pdf_copy WHERE file_id = $1 AND input_hash = $2`, [fileId, ready]);
      expect(await count(`pdf_copy_link WHERE file_id = '${fileId}'`)).toBe(0);
    });
  });
});
