// MLOGIN S3, the issue loader against a migrated database and the real API:
// one public-visibility DOCUMENT item, written and approved by
// system:issue-loader, with a public file and a members file. The public gets
// NOT_FOUND for the members file and, through ReadFile, a redacted copy of the
// public one; a member a copy without home addresses; an officer the
// originals. Its marks are file marks (0020), anchored in both PDFs, so the
// issue is listed for everyone.
// A repeated run changes nothing, and each database-side refusal leaves
// nothing behind. Every person here is made up.
import { Code, ConnectError } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentService, type ReadFileResponse } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { LOADER, LoadError, type LoadResult, applyBundle, marksSha256, parseBundle, runLoad } from '../../src/load/load.js';
import { redactPdf } from '../../src/pdf/redact.js';
import { readPdf } from '../../src/pdf/store.js';
import { loadLens } from '../../src/redaction/lens.js';
import { subjectKey } from '../../src/redaction/render.js';
import { drain } from '../../src/pdf/regenerate.js';
import { type Api, MEMBER, OFFICER, insertId, startApi } from '../helpers/api.js';
import { APP, APP_PW, live, urlFor } from '../helpers/pg.js';
import { extractAll } from '../pdf/extract.js';
import { ADDRESS, EMAIL, KEPT, MARKS, MEMBERS_ONLY, NAME, PHONE, bundleJson, membersPdf, publicInputHash, publicPdf, sha256, stdinOf } from './bundle.js';

type Read = { bytes: Buffer } | { error: { code: Code; message: string } };

describe.skipIf(!live)('the issue loader, on the database', () => {
  let api: Api;
  let office: string;
  let database: string;
  let pub: Uint8Array;
  let members: Uint8Array;
  // Each test awaits the one load itself, so a failed load fails every test that depends on it.
  let loading: Promise<LoadResult>;

  async function read(fileId: string, options: { headers?: Record<string, string> } = {}): Promise<Read> {
    const messages: ReadFileResponse[] = [];
    try {
      for await (const message of api.client(ContentService).readFile({ fileId }, options)) messages.push(message);
    } catch (error) {
      const e = ConnectError.from(error);
      return { error: { code: e.code, message: e.message } };
    }
    return { bytes: Buffer.concat(messages.flatMap((m) => (m.part.case === 'chunk' ? [Buffer.from(m.part.value)] : []))) };
  }
  const pdfOf = async (fileId: string, options: { headers?: Record<string, string> } = {}): Promise<Buffer> => {
    const result = await read(fileId, options);
    if ('error' in result) throw new Error(`expected a PDF, got ${result.error.message}`);
    return result.bytes;
  };
  /** Row counts of every table a load writes. */
  const counts = async (): Promise<Record<string, number>> => {
    const tables = ['content_item', 'content_version', 'content_version_editor', 'stored_file', 'pdf_original', 'redaction_mark', 'redaction_mark_anchor', 'audit_event', 'publication_ledger', 'pdf_regen'];
    const out: Record<string, number> = {};
    for (const table of tables) out[table] = Number((await api.pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n);
    return out;
  };
  const load = async (options: Parameters<typeof bundleJson>[0] = {}) => applyBundle(api.pool, parseBundle(await bundleJson(options)));

  beforeAll(async () => {
    api = await startApi('nwfl_loader');
    database = (await api.pool.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db;
    office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('editor', 'Newsletter Editor', 'appointed') RETURNING id`);
    pub = await publicPdf('2026-10');
    members = await membersPdf('2026-10');
    loading = bundleJson({ publicPdf: pub, membersPdf: members }).then((json) => applyBundle(api.pool, parseBundle(json)));
    await loading.catch(() => undefined);
  }, 60_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('what one load writes', () => {
    it('reports a load, with the item and both files', async () => {
      const loaded = await loading;
      expect(loaded.status).toBe('loaded');
      expect(loaded.marks).toBe(MARKS.length);
      for (const id of [loaded.itemId, loaded.publicFileId, loaded.membersFileId]) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('is one public-visibility DOCUMENT item and version, written by the loader, on the S4 contract', async () => {
      const loaded = await loading;
      const item = (
        await api.pool.query(
          `SELECT i.slug, i.kind, i.state, i.office_id, i.working_version_id, v.n, v.title, v.summary, v.visibility, v.created_by_sub, v.acting_office_id,
             v.target_website, v.target_newsletter, v.target_email, v.edition_id, v.status, v.body_src
           FROM content_item i JOIN content_version v ON v.id = i.live_version_id WHERE i.id = $1`,
          [loaded.itemId],
        )
      ).rows;
      expect(item).toEqual([
        {
          slug: 'pensa-mensa-2026-10',
          kind: 'document',
          state: 'published',
          office_id: office,
          working_version_id: null,
          n: 1,
          title: 'Pensa Mensa, October-November 2026',
          summary: 'Volume 30, Number 5',
          visibility: 'public',
          created_by_sub: LOADER,
          acting_office_id: office,
          target_website: true,
          // The newsletter agent's ExportEdition never picks the issue up.
          target_newsletter: false,
          target_email: false,
          edition_id: null,
          status: 'approved',
          body_src: '',
        },
      ]);
      expect((await api.pool.query(`SELECT count(*)::int AS n FROM content_version WHERE item_id = $1`, [loaded.itemId])).rows[0]).toEqual({ n: 1 });
      expect((await api.pool.query(`SELECT subject FROM content_version_editor WHERE version_id = (SELECT live_version_id FROM content_item WHERE id = $1)`, [loaded.itemId])).rows).toEqual([
        { subject: LOADER },
      ]);
    });

    it('is approved by the loader as self_breakglass, the reason naming the approval, the marks hash, the public input hash and the members sha256', async () => {
      const loaded = await loading;
      const row = (
        await api.pool.query<{ approved_by_sub: string; approval_kind: string; approval_reason: string; public_ast: unknown; content_hash: Buffer | null }>(
          `SELECT approved_by_sub, approval_kind, approval_reason, public_ast, content_hash FROM content_version WHERE id = (SELECT live_version_id FROM content_item WHERE id = $1)`,
          [loaded.itemId],
        )
      ).rows[0]!;
      expect(row.approved_by_sub).toBe(LOADER);
      expect(row.approval_kind).toBe('self_breakglass');
      expect(row.approval_reason).toContain('PUBCOPY');
      expect(row.approval_reason).toContain(marksSha256(MARKS));
      expect(row.approval_reason).toBe(
        `Issue loader, approved as PUBCOPY: marks sha256 ${marksSha256(MARKS)}, public inputHash ${publicInputHash(pub, MARKS)}, members sha256 ${sha256(members).toString('hex')}`,
      );
      expect(row.public_ast).toEqual({ blocks: [] });
      expect(row.content_hash?.length).toBe(32);
    });

    it('holds two PDFs on that one version, public and members, stored by the loader, with random ids', async () => {
      const loaded = await loading;
      const files = (
        await api.pool.query<{ id: string; audience: string; role: string; sha256: Buffer; size_bytes: string; object_key: string; filename: string; stored_by_sub: string }>(
          `SELECT f.id, f.audience, f.role, f.sha256, f.size_bytes::text, f.object_key, f.filename, o.stored_by_sub
           FROM stored_file f JOIN pdf_original o ON o.file_id = f.id
           WHERE f.version_id = (SELECT live_version_id FROM content_item WHERE id = $1) ORDER BY f.audience DESC`,
          [loaded.itemId],
        )
      ).rows;
      expect(files.map((f) => [f.id, f.audience, f.role, f.stored_by_sub])).toEqual([
        [loaded.publicFileId, 'public', 'primary', LOADER],
        [loaded.membersFileId, 'members', 'primary', LOADER],
      ]);
      expect(files[0]!.sha256.equals(sha256(pub))).toBe(true);
      expect(files[1]!.sha256.equals(sha256(members))).toBe(true);
      expect(files.map((f) => Number(f.size_bytes))).toEqual([pub.length, members.length]);
      expect(files.map((f) => f.filename)).toEqual(['pensa-mensa-2026-10.pdf', 'pensa-mensa-2026-10-members.pdf']);
      // Nothing derived from the content: not the sha256, not the slug.
      for (const file of files) {
        expect(file.object_key).toBe(`pdf_original/${file.id}`);
        expect(file.object_key).not.toContain(file.sha256.toString('hex').slice(0, 8));
      }
    });

    it('adds one mark per bundle mark, on the item, as the loader, each with its own category', async () => {
      const loaded = await loading;
      const marks = (
        await api.pool.query(`SELECT field, quote, category, status, created_by_sub FROM redaction_mark WHERE content_item_id = $1 ORDER BY quote`, [loaded.itemId])
      ).rows;
      expect(marks).toEqual(
        [...MARKS].sort((a, b) => (a.quote < b.quote ? -1 : 1)).map((mark) => ({ field: 'file', quote: mark.quote, category: mark.category, status: 'active', created_by_sub: LOADER })),
      );
    });

    it('anchors each mark in the PDFs whose text layer holds its quote: both files for every synthetic mark', async () => {
      const loaded = await loading;
      const { rows } = await api.pool.query<{ quote: string; files: string[] }>(
        `SELECT m.quote, array_agg(a.file_id::text ORDER BY a.file_id) AS files FROM redaction_mark m
           LEFT JOIN redaction_mark_anchor a ON a.mark_id = m.id WHERE m.content_item_id = $1 GROUP BY m.quote ORDER BY m.quote`,
        [loaded.itemId],
      );
      const both = [loaded.publicFileId, loaded.membersFileId].sort();
      expect(rows).toEqual([...MARKS].map((mark) => mark.quote).sort().map((quote) => ({ quote, files: both })));
    });

    it('audits every step as the system, with no groups, and never writes a marked quote to the audit log', async () => {
      const rows = (
        await api.pool.query<{ actor_kind: string; actor_sub: string; actor_groups: string[]; action: string }>(
          `SELECT actor_kind, actor_sub, actor_groups, action FROM audit_event WHERE actor_sub = $1 ORDER BY id`,
          [LOADER],
        )
      ).rows;
      expect(rows.map((row) => row.action)).toEqual([
        'create',
        'file_added',
        'file_added',
        'pdf_original_store',
        'pdf_original_store',
        ...MARKS.map(() => 'redaction_mark_add'),
        'ready',
        'approve_self',
      ]);
      expect(rows.every((row) => row.actor_groups.length === 0)).toBe(true);
      expect(new Set(rows.filter((row) => !row.action.startsWith('pdf_') && !row.action.startsWith('redaction_')).map((row) => row.actor_kind))).toEqual(new Set(['system']));
      const all = (await api.pool.query<{ t: string }>(`SELECT string_agg(a::text, '\n') AS t FROM audit_event a`)).rows[0]!.t;
      for (const mark of MARKS) expect(all).not.toContain(mark.quote);
    });

    it('records the published version in the publication ledger', async () => {
      const loaded = await loading;
      const ledger = await api.pool.query(`SELECT audience FROM publication_ledger WHERE subject_kind = 'content_version' AND subject_id = (SELECT live_version_id FROM content_item WHERE id = $1)`, [
        loaded.itemId,
      ]);
      expect(ledger.rowCount).toBeGreaterThan(0);
    });
  });

  describe('what each audience is given', () => {
    /** What the PDF store serves this audience for the file (store.ts readPdf, the bytes ReadFile streams once it serves the file). */
    const stored = async (fileId: string, audience: 'public' | 'members' | 'officers') => readPdf(api.pool, fileId, audience);
    const storedPdf = async (fileId: string, audience: 'public' | 'members' | 'officers'): Promise<Buffer> => {
      const result = await stored(fileId, audience);
      if (result.kind !== 'pdf') throw new Error(`expected a PDF, got ${result.kind}`);
      return Buffer.from(result.pdf);
    };

    beforeAll(async () => {
      // The PDF worker, with the real engine (in process): it makes the public and members copies.
      await drain(api.worker, { redact: redactPdf });
    }, 120_000);

    it('answers the public NOT_FOUND for the members file through ReadFile, exactly as for a missing file, and the store has nothing for it', async () => {
      const loaded = await loading;
      const missing = await read('00000000-0000-4000-8000-000000000000');
      expect(missing).toEqual({ error: { code: Code.NotFound, message: '[not_found] file not found' } });
      expect(await read(loaded.membersFileId)).toEqual(missing);
      // The structural reason, which holds whatever the lens decides: the file's audience outranks the public.
      expect(await stored(loaded.membersFileId, 'public')).toEqual({ kind: 'not_found' });
    });

    it('holds, for the public, a redacted copy of the public file: no marked quote, the rest readable', async () => {
      const loaded = await loading;
      const result = await stored(loaded.publicFileId, 'public');
      expect(result).toMatchObject({ kind: 'pdf', original: false });
      const bytes = await storedPdf(loaded.publicFileId, 'public');
      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(sha256(bytes).equals(sha256(pub))).toBe(false);
      expect(sha256(bytes).equals(sha256(members))).toBe(false);
      const text = await extractAll(bytes);
      expect(text).toContain(KEPT);
      for (const quote of [NAME, PHONE, ADDRESS, EMAIL, 'Quillon', 'Brask']) expect(text).not.toContain(quote);
      expect(text).not.toContain(MEMBERS_ONLY);
    }, 60_000);

    it('gives an officer the originals of both files, through ReadFile', async () => {
      const loaded = await loading;
      expect((await pdfOf(loaded.membersFileId, OFFICER)).equals(Buffer.from(members))).toBe(true);
      expect((await pdfOf(loaded.publicFileId, OFFICER)).equals(Buffer.from(pub))).toBe(true);
    });

    it('holds, for a member, a copy of the members file with the home address redacted and the rest shown', async () => {
      const loaded = await loading;
      expect(await stored(loaded.membersFileId, 'members')).toMatchObject({ kind: 'pdf', original: false });
      const bytes = await storedPdf(loaded.membersFileId, 'members');
      expect(sha256(bytes).equals(sha256(members))).toBe(false);
      const text = await extractAll(bytes);
      expect(text).not.toContain(ADDRESS);
      for (const shown of [NAME, PHONE, EMAIL, MEMBERS_ONLY, KEPT]) expect(text).toContain(shown);
    }, 60_000);

    it('lists the issue for the public and members, and shows its item: its file marks are anchored in its PDFs (0020)', async () => {
      const loaded = await loading;
      const version = (await api.pool.query<{ v: string }>(`SELECT live_version_id AS v FROM content_item WHERE id = $1`, [loaded.itemId])).rows[0]!.v;
      for (const audience of ['public', 'members', 'officers']) {
        const lens = await loadLens(api.pool, audience, { items: [loaded.itemId], versions: [version] }, { uniform: true });
        expect(lens.hidden([subjectKey('content_item', loaded.itemId)], version), audience).toBe(false);
      }
      for (const who of [{}, MEMBER]) {
        const listed = await api.client(ContentService).listPublishedItems({}, who);
        expect(listed.items.map((item) => item.id)).toContain(loaded.itemId);
      }
    });

    it('gives the public, through ReadFile, the redacted copy of the public file', async () => {
      const loaded = await loading;
      expect((await pdfOf(loaded.publicFileId)).equals(await storedPdf(loaded.publicFileId, 'public'))).toBe(true);
    }, 60_000);

    it('gives a member, through ReadFile, the copy of the members file without home addresses, and the public copy of the public file', async () => {
      const loaded = await loading;
      expect((await pdfOf(loaded.membersFileId, MEMBER)).equals(await storedPdf(loaded.membersFileId, 'members'))).toBe(true);
      const text = await extractAll(await pdfOf(loaded.membersFileId, MEMBER));
      expect(text).not.toContain(ADDRESS);
      expect(text).toContain(MEMBERS_ONLY);
      expect((await pdfOf(loaded.publicFileId, MEMBER)).equals(await storedPdf(loaded.publicFileId, 'members'))).toBe(true);
    }, 60_000);
  });

  describe('a repeated run', () => {
    it('changes nothing: the same item and files are found by slug and sha256', async () => {
      const loaded = await loading;
      const before = await counts();
      const again = await applyBundle(api.pool, parseBundle(await bundleJson({ publicPdf: pub, membersPdf: members })));
      expect(again).toEqual({ ...loaded, status: 'unchanged' });
      expect(await counts()).toEqual(before);
    });

    it('changes nothing when the marks arrive in another order', async () => {
      const before = await counts();
      const again = await applyBundle(api.pool, parseBundle(await bundleJson({ publicPdf: pub, membersPdf: members, marks: [...MARKS].reverse() })));
      expect(again.status).toBe('unchanged');
      expect(await counts()).toEqual(before);
    });
  });

  describe('the database-side refusals, each leaving nothing behind', () => {
    const refused = async (options: Parameters<typeof bundleJson>[0], message: RegExp): Promise<void> => {
      const before = await counts();
      await expect(load(options)).rejects.toThrow(LoadError);
      await expect(load(options)).rejects.toThrow(message);
      expect(await counts()).toEqual(before);
    };

    it('refuses a public input hash other than the approved one, naming the one it computed', async () => {
      const period = '2026-06';
      const expected = publicInputHash(await publicPdf(period), MARKS);
      await refused({ period, publicInputHash: 'b'.repeat(64) }, new RegExp(`public copy.*not the approved.*${expected}`));
      expect((await api.pool.query(`SELECT 1 FROM content_item WHERE slug = 'pensa-mensa-2026-06'`)).rowCount).toBe(0);
    });

    it('refuses an office the database does not have', async () => {
      await refused({ period: '2026-02', office: 'treasurer' }, /unknown office/);
    });

    it('refuses an issue already loaded with other files, and never revises it', async () => {
      await loading;
      await refused({ publicPdf: await publicPdf('another render') }, /pensa-mensa-2026-10 is already loaded.*differ/);
      await refused({ publicPdf: pub, membersPdf: await membersPdf('another render') }, /already loaded.*differ/);
    });

    it('refuses an issue already loaded with other marks', async () => {
      await loading;
      await refused({ publicPdf: pub, membersPdf: members, marks: MARKS.slice(1) }, /already loaded.*differ/);
    });

    it('refuses a mark whose quote is in the text layer of neither PDF (fail closed), without repeating the quote', async () => {
      const marks = [...MARKS, { quote: 'Ysolde Pemberton', category: 'member_name' as const }];
      await refused({ period: '2026-04', marks }, /marks\[4\]: the quote is not in the text layer of any of the item's PDFs/);
      const error = await applyBundle(api.pool, parseBundle(await bundleJson({ period: '2026-04', marks }))).catch((caught: Error) => caught);
      expect(error).toBeInstanceOf(LoadError);
      expect((error as Error).message).not.toContain('Ysolde');
      expect((await api.pool.query(`SELECT 1 FROM content_item WHERE slug = 'pensa-mensa-2026-04'`)).rowCount).toBe(0);
    });

    it("refuses a slug that holds someone else's item", async () => {
      await api.pool.query(`INSERT INTO content_item (slug, kind, office_id) VALUES ('pensa-mensa-2025-08', 'document', $1)`, [office]);
      await refused({ period: '2025-08' }, /pensa-mensa-2025-08 already exists and was not written by the loader/);
    });
  });

  describe('the command', () => {
    it('loads from a pipe in production mode, prints ids and counts only, then finds the issue unchanged', async () => {
      const env = { NODE_ENV: 'production', DATABASE_URL: urlFor(APP, APP_PW, database) };
      const json = JSON.stringify(await bundleJson({ period: '2025-10', volume: 29, number: 5 }));
      const lines: string[] = [];
      expect(await runLoad(['-'], env, stdinOf(json, 'pipe'), (line) => lines.push(line))).toBe(0);
      expect(await runLoad(['-'], env, stdinOf(json, 'socket'), (line) => lines.push(line))).toBe(0);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^loaded: item [0-9a-f-]{36}, public file [0-9a-f-]{36}, members file [0-9a-f-]{36}, 4 marks$/);
      expect(lines[1]).toBe(lines[0]!.replace(/^loaded/, 'unchanged'));
      for (const quote of [NAME, PHONE, ADDRESS, EMAIL]) expect(lines.join('\n')).not.toContain(quote);
    });

    it('exits 1, nothing applied, on a database-side refusal', async () => {
      const env = { DATABASE_URL: urlFor(APP, APP_PW, database) };
      const lines: string[] = [];
      const json = JSON.stringify(await bundleJson({ period: '2025-06', publicInputHash: 'c'.repeat(64) }));
      expect(await runLoad(['-'], env, stdinOf(json), (line) => lines.push(line))).toBe(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^load refused, nothing applied: the public copy's inputs are not the approved ones/);
    });
  });

  // Last: it tightens the public policy for the rest of this database.
  describe('after a policy change that hides a category from the public', () => {
    it('refuses, because the public would be given no copy at all, so none matches the approval', async () => {
      await api.pool.query(`SELECT redaction_propose('nwflorida', 'public', 'member_email', 'hide', 'sub-officer', ARRAY['nwfl-officers'], NULL)`);
      const before = await counts();
      await expect(load({ period: '2026-04' })).rejects.toThrow(/public copy's inputs are not the approved ones: computed none/);
      expect(await counts()).toEqual(before);
    });

    it('fails, nothing applied, when the officers policy no longer shows everything: the originals cannot be read to anchor the marks', async () => {
      await api.pool.query(`SELECT redaction_propose('nwflorida', 'officers', 'member_phone', 'redact', 'sub-officer', ARRAY['nwfl-officers'], NULL)`);
      const before = await counts();
      const lines: string[] = [];
      const json = JSON.stringify(await bundleJson({ period: '2026-03' }));
      expect(await runLoad(['-'], { DATABASE_URL: urlFor(APP, APP_PW, database) }, stdinOf(json), (line) => lines.push(line))).toBe(1);
      expect(lines).toEqual(['load failed, nothing applied: 42501']);
      expect(await counts()).toEqual(before);
    });
  });
});
