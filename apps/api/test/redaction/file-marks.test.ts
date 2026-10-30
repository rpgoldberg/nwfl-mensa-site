// MLOGIN S3, option (a): FILE marks (0020). A passage mark with field `file`
// is anchored in its item's stored PDFs, not in the item's own text: the API
// finds the quote in the text layer of the item's PDFs when the mark is added
// and records the files it is in (redaction_mark_anchor). The lens never hides
// an item for an anchored file mark, and withholds its quote from the item's
// own text like any redact mark's; a file mark with no anchor in the version
// shown hides the item, as any unanchored mark does (fail closed). Every
// person here is made up.
import { Code, ConnectError } from '@connectrpc/connect';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentService } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { MarkField, MarkSubjectKind, RedactionCategory, RedactionPolicyService } from '../../src/gen/nwfl/mensa/v1/redaction_pb.js';
import { readPdf, storeOriginal } from '../../src/pdf/store.js';
import { redactPdf } from '../../src/pdf/redact.js';
import { drain } from '../../src/pdf/regenerate.js';
import { FileMarkError, addFileMarks } from '../../src/redaction/file-marks.js';
import { type Api, OFFICER, insertId, startApi } from '../helpers/api.js';
import { publishItem } from '../helpers/content.js';
import { WITHHELD } from '../../src/redaction/render.js';
import { live, url } from '../helpers/pg.js';
import { extractAll } from '../pdf/extract.js';
import { linesPdf } from '../pdf/fixtures.js';

const NAME = 'Quillon Brask';
const PHONE = '850-555-0142';
const HOST = 'Ottoline Varga';
const ABSENT = 'Ysolde Pemberton';
const STORER = { sub: 'sub-officer', groups: ['nwfl-members', 'nwfl-officers'] };
const AUTHOR = { sub: 'sub-author', groups: ['nwfl-members'] };
const STRANGER = { sub: 'sub-stranger', groups: ['nwfl-members'] };

describe.skipIf(!live)('file marks (0020)', () => {
  let api: Api;
  let office: string;
  /** Item ids and their PDF file ids, by name. */
  const items: Record<string, { item: string; version: string; files: Record<string, string> }> = {};

  const asOwner = async <T>(fn: (client: pg.Client) => Promise<T>): Promise<T> => {
    const target = new URL(url as string);
    target.pathname = `/${(await api.pool.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db}`;
    const client = new pg.Client({ connectionString: target.toString() });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  };
  /** `code: message` of a statement as the app role, or 'ok'. */
  const outcome = (text: string, values: unknown[] = [], client: Pick<pg.Pool, 'query'> = api.pool): Promise<string> =>
    client.query(text, values).then(
      () => 'ok',
      (error: { code?: string; message: string }) => `${error.code}: ${error.message}`,
    );
  const addFile = (item: string, quote: string, category: string, files: string[], who = STORER) =>
    outcome(`SELECT id FROM redaction_mark_add_file($1, $2, $3, $4, $5, $6, NULL)`, [item, quote, category, files, who.sub, who.groups]);
  const anchors = async (mark: string): Promise<string[]> =>
    (await api.pool.query<{ file_id: string }>(`SELECT file_id FROM redaction_mark_anchor WHERE mark_id = $1 ORDER BY file_id`, [mark])).rows.map((row) => row.file_id);
  const marksOn = async (item: string): Promise<number> => Number((await api.pool.query<{ n: string }>(`SELECT count(*) AS n FROM redaction_mark WHERE content_item_id = $1`, [item])).rows[0]!.n);
  const published = async (slug: string, options: { headers?: Record<string, string> } = {}) =>
    api
      .client(ContentService)
      .getPublishedItem({ slug }, options)
      .then(
        (response) => response.item,
        (error: unknown) => ConnectError.from(error).code,
      );
  const listed = async (): Promise<string[]> => (await api.client(ContentService).listPublishedItems({})).items.map((item) => item.id);

  /** A published DOCUMENT item with these PDFs (audience -> lines), each with its stored original. */
  async function documentItem(slug: string, title: string, pdfs: Record<string, readonly string[] | Uint8Array>, unstored = false): Promise<void> {
    const bytes = Object.fromEntries(await Promise.all(Object.entries(pdfs).map(async ([audience, lines]) => [audience, lines instanceof Uint8Array ? lines : await linesPdf(lines)] as const)));
    const { itemId, versionId } = await publishItem(api.pool, {
      slug,
      officeId: office,
      kind: 'document',
      title,
      body: { blocks: [] },
      files: [
        ...Object.entries(bytes).map(([audience, b]) => ({ objectKey: `k-${slug}-${audience}`, audience: audience as 'public' | 'members', bytes: b })),
        // A PDF file row whose original was never stored.
        ...(unstored ? [{ objectKey: `k-${slug}-unstored`, audience: 'public' as const }] : []),
      ],
    });
    const files: Record<string, string> = {};
    for (const [audience, b] of Object.entries(bytes)) {
      const id = (await api.pool.query<{ id: string }>(`SELECT id FROM stored_file WHERE version_id = $1 AND audience = $2`, [versionId, audience])).rows[0]!.id;
      await storeOriginal(api.pool, { fileId: id, bytes: b, ...STORER });
      files[audience] = id;
    }
    items[slug] = { item: itemId, version: versionId, files };
  }

  beforeAll(async () => {
    api = await startApi('nwfl_filemarks');
    office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('editor', 'Newsletter Editor', 'appointed') RETURNING id`);
    const both = [`Call ${NAME} at ${PHONE}.`];
    // The title names the person too: a file mark is for the PDFs, and leaves the item's own text alone.
    await documentItem('flyer', `Picnic with ${NAME}`, { public: [...both, 'Bring a chair.'], members: [...both, `Members: ${HOST} hosts.`] });
    await documentItem('other', 'Another flyer', { public: [`Call ${NAME} at ${PHONE}.`] });
    await documentItem('bare', 'No files', {});
    await documentItem('unreadable', 'Broken scan', { public: new Uint8Array(Buffer.from('%PDF-1.7 not really a PDF', 'latin1')) });
    await documentItem('lost', 'Lost anchor', { public: [`Call ${NAME}.`] });
    await documentItem('old', 'Body-marked flyer', { public: [`Call ${NAME}.`] });
    await documentItem('unstored', 'Not stored', {}, true);
  }, 60_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('the database: only redaction_mark_add_file adds one, with its files', () => {
    it('refuses field file through redaction_mark_add: a file mark comes only with the files it is found in', async () => {
      const flyer = items['flyer']!;
      expect(await outcome(`SELECT redaction_mark_add('content_item', $1, 'file', $2, 'member_name', $3, $4, NULL)`, [flyer.item, NAME, STORER.sub, STORER.groups])).toMatch(
        /^22023: .*redaction_mark_add_file/,
      );
    });

    it('refuses a file mark on an item with no stored PDF: none at all, or a file row with no original', async () => {
      expect(await addFile(items['bare']!.item, NAME, 'member_name', [])).toMatch(/^22023: .*stored PDF/);
      expect(await addFile(items['unstored']!.item, NAME, 'member_name', [])).toMatch(/^22023: .*stored PDF/);
    });

    it("refuses a file mark with no files, or anchored in another item's PDF", async () => {
      const flyer = items['flyer']!;
      expect(await addFile(flyer.item, NAME, 'member_name', [])).toMatch(/^22023: .*the files its quote is found in/);
      expect(await addFile(flyer.item, NAME, 'member_name', [items['other']!.files['public']!])).toMatch(/^22023: .*own item/);
    });

    it("refuses anyone but an officer or the item's writer", async () => {
      const lost = items['lost']!;
      expect(await addFile(lost.item, NAME, 'member_name', [lost.files['public']!], STRANGER)).toMatch(/^42501: /);
      expect(await addFile(lost.item, NAME, 'member_name', [lost.files['public']!], { sub: '', groups: STORER.groups })).toMatch(/^42501: /);
    });

    it('keeps the anchors: the app role cannot write them, and no role rewrites or deletes them', async () => {
      const other = items['other']!;
      const added = await api.pool.query<{ id: string }>(`SELECT id FROM redaction_mark_add_file($1, $2, 'member_phone', $3, $4, $5, NULL)`, [
        other.item,
        PHONE,
        [other.files['public']],
        AUTHOR.sub,
        AUTHOR.groups,
      ]);
      const mark = added.rows[0]!.id;
      expect(await anchors(mark)).toEqual([other.files['public']]);
      expect(await outcome(`INSERT INTO redaction_mark_anchor (mark_id, file_id) VALUES ($1, $2)`, [mark, items['flyer']!.files['public']])).toMatch(/^42501: /);
      expect(await outcome(`UPDATE redaction_mark_anchor SET file_id = $2 WHERE mark_id = $1`, [mark, items['flyer']!.files['public']])).toMatch(/^42501: /);
      expect(await outcome(`DELETE FROM redaction_mark_anchor WHERE mark_id = $1`, [mark])).toMatch(/^42501: /);
      await asOwner(async (owner) => {
        expect(await outcome(`UPDATE redaction_mark_anchor SET file_id = $2 WHERE mark_id = $1`, [mark, items['flyer']!.files['public']], owner)).toMatch(/^55000: .*append-only/);
        expect(await outcome(`DELETE FROM redaction_mark_anchor WHERE mark_id = $1`, [mark], owner)).toMatch(/^55000: .*append-only/);
        expect(await outcome(`TRUNCATE redaction_mark_anchor CASCADE`, [], owner)).toMatch(/^55000: .*append-only/);
      });
      const audit = await api.pool.query<{ actor_sub: string; payload: Record<string, unknown> }>(
        `SELECT actor_sub, payload FROM audit_event WHERE action = 'redaction_mark_add' AND subject_id = $1`,
        [mark],
      );
      expect(audit.rows).toEqual([{ actor_sub: AUTHOR.sub, payload: { subject_kind: 'content_item', subject_id: other.item, field: 'file', category: 'member_phone', files: 1 } }]);
    });
  });

  describe('addFileMarks: the quote found in the text layer of the item’s PDFs', () => {
    it('anchors each quote in exactly the files whose text holds it', async () => {
      const flyer = items['flyer']!;
      const ids = await addFileMarks(api.pool, {
        itemId: flyer.item,
        marks: [
          { quote: NAME, category: 'member_name' },
          { quote: PHONE, category: 'member_phone' },
          { quote: HOST, category: 'member_name' },
        ],
        ...STORER,
      });
      expect(ids).toHaveLength(3);
      const both = [flyer.files['public'], flyer.files['members']].sort();
      expect(await anchors(ids[0]!)).toEqual(both);
      expect(await anchors(ids[1]!)).toEqual(both);
      expect(await anchors(ids[2]!)).toEqual([flyer.files['members']]);
      const fields = await api.pool.query(`SELECT DISTINCT field FROM redaction_mark WHERE content_item_id = $1`, [flyer.item]);
      expect(fields.rows).toEqual([{ field: 'file' }]);
    }, 60_000);

    it('refuses a quote found in none of the PDFs, fail closed: no mark is added, of any in the call, and the quote is not repeated', async () => {
      const lost = items['lost']!;
      const before = await marksOn(lost.item);
      const call = addFileMarks(api.pool, {
        itemId: lost.item,
        marks: [
          { quote: NAME, category: 'member_name' },
          { quote: ABSENT, category: 'member_name' },
        ],
        ...STORER,
      });
      await expect(call).rejects.toThrow(FileMarkError);
      await expect(call).rejects.toThrow(/marks\[1\]: .*not in the text layer/);
      await call.catch((error: Error) => expect(error.message).not.toContain('Ysolde'));
      await expect(addFileMarks(api.pool, { itemId: lost.item, marks: [{ quote: ABSENT, category: 'member_name' }], ...STORER })).rejects.toThrow(
        /^marks\[0\]: the quote is not in the text layer of any of the item's PDFs$/,
      );
      expect(await marksOn(lost.item)).toBe(before);
    }, 60_000);

    it('refuses an item with no stored PDF, and a PDF it cannot read anchors nothing', async () => {
      await expect(addFileMarks(api.pool, { itemId: items['bare']!.item, marks: [{ quote: NAME, category: 'member_name' }], ...STORER })).rejects.toThrow(/no stored PDF/);
      await expect(addFileMarks(api.pool, { itemId: items['unreadable']!.item, marks: [{ quote: NAME, category: 'member_name' }], ...STORER })).rejects.toThrow(
        /marks\[0\]: .*not in the text layer/,
      );
    }, 60_000);
  });

  describe('what each audience is given', () => {
    beforeAll(async () => {
      // An anchored file mark, and beside it one with NO anchor record, as if the record were lost:
      // only the owner can write one so. The first one's anchor must not stand for the second.
      await addFileMarks(api.pool, { itemId: items['lost']!.item, marks: [{ quote: 'Quillon', category: 'member_name' }], ...STORER });
      await asOwner((owner) =>
        owner.query(`INSERT INTO redaction_mark (content_item_id, field, quote, category, created_by_sub) VALUES ($1, 'file', $2, 'member_name', 'sub-officer')`, [items['lost']!.item, NAME]),
      );
      // The old way: a BODY mark on a name that is in the PDF but not in the item's text.
      await api.pool.query(`SELECT redaction_mark_add('content_item', $1, 'body', $2, 'member_name', $3, $4, NULL)`, [items['old']!.item, NAME, STORER.sub, STORER.groups]);
      await drain(api.worker, { redact: redactPdf });
    }, 120_000);

    it('shows the public an item whose file marks are anchored: listed, found by its slug, a file-marked quote withheld from its own text', async () => {
      const flyer = items['flyer']!;
      const item = await published('flyer');
      expect(typeof item === 'object' && item?.id).toBe(flyer.item);
      expect(typeof item === 'object' && item?.slug).toBe('flyer');
      expect(typeof item === 'object' && item?.live?.title).toBe(`Picnic with ${WITHHELD}`);
      const officer = await published(flyer.item, OFFICER);
      expect(typeof officer === 'object' && officer?.live?.title).toBe(`Picnic with ${NAME}`);
      expect(await listed()).toContain(flyer.item);
    });

    it('gives the public, through ReadFile, a copy of the public PDF without the file-marked passages', async () => {
      const flyer = items['flyer']!;
      const parts: Buffer[] = [];
      for await (const message of api.client(ContentService).readFile({ fileId: flyer.files['public']! })) if (message.part.case === 'chunk') parts.push(Buffer.from(message.part.value));
      const text = await extractAll(Buffer.concat(parts));
      expect(text).toContain('Bring a chair.');
      for (const quote of [NAME, PHONE]) expect(text).not.toContain(quote);
      const stored = await readPdf(api.pool, flyer.files['public']!, 'public');
      expect(stored.kind === 'pdf' && Buffer.from(stored.pdf).equals(Buffer.concat(parts))).toBe(true);
    }, 60_000);

    it('hides an item, fail closed, for a file mark with no anchor record: from the public and members, not from officers', async () => {
      const lost = items['lost']!;
      expect(await published('lost')).toBe(Code.NotFound);
      expect(await listed()).not.toContain(lost.item);
      const officer = await published(lost.item, OFFICER);
      expect(typeof officer === 'object' && officer?.id).toBe(lost.item);
    });

    it('still hides an item for a body mark that is not in its text, though the quote is in its PDF (no regression)', async () => {
      const old = items['old']!;
      expect(await published('old')).toBe(Code.NotFound);
      expect(await listed()).not.toContain(old.item);
      const stream = api.client(ContentService).readFile({ fileId: old.files['public']! });
      const read = await stream[Symbol.asyncIterator]()
        .next()
        .then(
          () => 'served',
          (error: unknown) => ConnectError.from(error).code,
        );
      expect(read).toBe(Code.NotFound);
    });
  });

  describe('the marks RPCs', () => {
    it('list a file mark with its field', async () => {
      const { marks } = await api.client(RedactionPolicyService).listRedactionMarks({ subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: items['flyer']!.item }, OFFICER);
      expect(marks.map((mark) => mark.field)).toEqual([MarkField.FILE, MarkField.FILE, MarkField.FILE]);
      expect(MarkField.FILE).toBe(10);
    });

    it('refuse to add one: a file mark comes with its files, from the issue loader', async () => {
      const call = api
        .client(RedactionPolicyService)
        .addRedactionMark({ subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: items['flyer']!.item, field: MarkField.FILE, quote: NAME, category: RedactionCategory.MEMBER_NAME }, OFFICER);
      await expect(call).rejects.toMatchObject({ code: Code.InvalidArgument });
      await expect(call).rejects.toThrow(/file mark/);
    });
  });
});
