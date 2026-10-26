// REDACT R3c: ContentService.ReadFile serves a PDF's bytes as the caller's
// audience may have them: the current redacted copy, or the original only
// when the audience's policy shows everything. A file the audience may not
// have is answered exactly as one that does not exist. Every name is made up.
import { Code, ConnectError } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentService, type ReadFileResponse } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { MarkField, MarkSubjectKind, RedactionCategory, RedactionPolicyService } from '../../src/gen/nwfl/mensa/v1/redaction_pb.js';
import { drain } from '../../src/pdf/regenerate.js';
import { storeOriginal } from '../../src/pdf/store.js';
import { type Api, MEMBER, OFFICER, insertId, startApi } from '../helpers/api.js';
import { paragraph, publishItem, text } from '../helpers/content.js';
import { live } from '../helpers/pg.js';
import { extractAll } from '../pdf/extract.js';
import { linesPdf } from '../pdf/fixtures.js';

const PHONE = '850-555-0147';
const NAME = 'Quillon Brask';
const STORER = { sub: 'sub-officer', groups: ['nwfl-members', 'nwfl-officers'] };

type Options = { headers?: Record<string, string> };
type Read = { messages: ReadFileResponse[]; bytes: Buffer } | { error: { code: Code; message: string; details: unknown; metadata: [string, string][] } };

describe.skipIf(!live)('ContentService.ReadFile', () => {
  let api: Api;
  let office: string;
  let original: Uint8Array;
  const files: Record<string, string> = {};

  async function read(fileId: string, options: Options = {}): Promise<Read> {
    const messages: ReadFileResponse[] = [];
    try {
      for await (const message of api.client(ContentService).readFile({ fileId }, options)) messages.push(message);
    } catch (error) {
      const e = ConnectError.from(error);
      return { error: { code: e.code, message: e.message, details: e.details, metadata: [...e.metadata].filter(([k]) => k !== 'date') } };
    }
    const bytes = Buffer.concat(messages.flatMap((m) => (m.part.case === 'chunk' ? [Buffer.from(m.part.value)] : [])));
    return { messages, bytes };
  }
  const pdfOf = async (fileId: string, options: Options = {}) => {
    const result = await read(fileId, options);
    if ('error' in result) throw new Error(`expected a PDF, got ${result.error.message}`);
    return result;
  };

  const publish = async (slug: string, title: string, bytes: Uint8Array, extra: { audience?: 'public' | 'members' | 'officers'; visibility?: 'public' | 'members' | 'officers' } = {}) => {
    const { itemId, versionId } = await publishItem(api.pool, {
      slug,
      officeId: office,
      title,
      visibility: extra.visibility ?? 'public',
      body: { blocks: [paragraph(text(`Rides: call ${PHONE}.`))] },
      files: [{ objectKey: `k-${slug}`, audience: extra.audience ?? 'public', bytes }],
    });
    const file = (await api.pool.query<{ id: string }>(`SELECT id FROM stored_file WHERE version_id = $1`, [versionId])).rows[0]!.id;
    await storeOriginal(api.pool, { fileId: file, bytes, ...STORER });
    return { itemId, file };
  };
  const mark = (itemId: string, field: MarkField, quote: string, category: RedactionCategory) =>
    api.client(RedactionPolicyService).addRedactionMark({ subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: itemId, field, quote, category }, OFFICER);

  beforeAll(async () => {
    api = await startApi('nwfl_readfile');
    office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
    original = await linesPdf([`Picnic with ${NAME}`, `Rides: call ${PHONE} by Friday.`, 'Bring a chair.']);

    const flyer = await publish('picnic', `Picnic with ${NAME}`, original);
    files['flyer'] = flyer.file;
    await mark(flyer.itemId, MarkField.BODY, PHONE, RedactionCategory.MEMBER_PHONE);
    await mark(flyer.itemId, MarkField.TITLE, NAME, RedactionCategory.MEMBER_NAME);

    const whole = await publish('whole', 'Remembering a friend', await linesPdf(['Words by a friend']));
    files['whole'] = whole.file;
    await mark(whole.itemId, MarkField.UNSPECIFIED, '', RedactionCategory.MEMBER_NAME);

    files['members'] = (await publish('members-file', 'Members flyer', await linesPdf(['For members']), { audience: 'members' })).file;
    files['officersItem'] = (await publish('officers-item', 'Board notes', await linesPdf(['Board only']), { visibility: 'officers' })).file;

    // A draft item's file: stored, never published.
    const draftItem = await insertId(api.pool, `INSERT INTO content_item (slug, kind, office_id) VALUES ('draft', 'article', $1) RETURNING id`, [office]);
    const draftVersion = await insertId(
      api.pool,
      `INSERT INTO content_version (item_id, n, title, created_by_sub, acting_office_id) VALUES ($1, 1, 'Draft', 'sub-author', $2) RETURNING id`,
      [draftItem, office],
    );
    const draftBytes = await linesPdf(['Not yet']);
    files['draft'] = await insertId(
      api.pool,
      `INSERT INTO stored_file (version_id, object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ($1, 'k-draft', 'd.pdf', 'application/pdf', $2, sha256($3), 'public') RETURNING id`,
      [draftVersion, draftBytes.length, Buffer.from(draftBytes)],
    );
    await storeOriginal(api.pool, { fileId: files['draft'], bytes: draftBytes, ...STORER });

    // An edition's issue PDF: served once the edition is published, not before.
    const edition = async (slug: string, status: string) => {
      const id = await insertId(api.pool, `INSERT INTO edition (slug, title, kind, period_start, period_end, status) VALUES ($1, 'November 2026', 'regular', '2026-11-01', '2026-11-30', $2) RETURNING id`, [
        slug,
        status,
      ]);
      const bytes = await linesPdf([`The ${slug} issue`]);
      const file = await insertId(
        api.pool,
        `INSERT INTO stored_file (edition_id, object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ($1, $2, 'issue.pdf', 'application/pdf', $3, sha256($4), 'public') RETURNING id`,
        [id, `k-${slug}`, bytes.length, Buffer.from(bytes)],
      );
      await storeOriginal(api.pool, { fileId: file, bytes, ...STORER });
      return file;
    };
    files['published'] = await edition('2026-11', 'published');
    files['proof'] = await edition('2026-12', 'proof');
  }, 60_000);

  afterAll(async () => {
    await api?.close();
  });

  it('says "not ready" to the public while the copy is being made, and nothing else', async () => {
    const result = await read(files['flyer'] as string);
    expect('messages' in result && result.messages.map((m) => m.part.case)).toEqual(['notReady']);
  });

  it('serves the public the redacted copy once made: a PDF, named from the redacted title, without the marked passages', async () => {
    await drain(api.worker);
    const { messages, bytes } = await pdfOf(files['flyer'] as string);
    const head = messages[0]?.part;
    expect(head?.case).toBe('head');
    if (head?.case !== 'head') return;
    expect(head.value.mimeType).toBe('application/pdf');
    expect(head.value.filename).toBe('picnic-with-withheld.pdf');
    expect(Number(head.value.sizeBytes)).toBe(bytes.length);
    expect(messages.slice(1).every((m) => m.part.case === 'chunk')).toBe(true);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(Buffer.compare(bytes, Buffer.from(original))).not.toBe(0);
    const extracted = await extractAll(bytes);
    expect(extracted).toContain('Bring a chair');
    expect(extracted).not.toContain(PHONE);
    expect(extracted).not.toContain('Quillon');
  }, 60_000);

  it('serves an officer, whose policy shows everything, the original itself, named from the title', async () => {
    const { messages, bytes } = await pdfOf(files['flyer'] as string, OFFICER);
    expect(Buffer.compare(bytes, Buffer.from(original))).toBe(0);
    expect(messages[0]?.part.case === 'head' && messages[0].part.value.filename).toBe('picnic-with-quillon-brask.pdf');
  });

  it('serves a member a members file, which the public cannot have', async () => {
    expect((await pdfOf(files['members'] as string, MEMBER)).bytes.length).toBeGreaterThan(0);
  });

  it('serves a published edition\'s issue PDF, named from the edition', async () => {
    const { messages } = await pdfOf(files['published'] as string);
    expect(messages[0]?.part.case === 'head' && messages[0].part.value.filename).toBe('november-2026.pdf');
  });

  it('answers a withheld file exactly as a missing one: hidden, refused, another audience\'s, unpublished, not an id', async () => {
    // A refused copy: the engine would not make one.
    const refused = await publish('refused', 'Scanned flyer', await linesPdf(['A scan of a phone number']));
    await mark(refused.itemId, MarkField.BODY, PHONE, RedactionCategory.MEMBER_PHONE);
    await drain(api.worker, { redact: () => Promise.resolve({ kind: 'refused', reason: 'page 1 is a scan' }) });
    const stored = await api.pool.query<{ status: string }>(`SELECT status FROM pdf_copy WHERE file_id = $1`, [refused.file]);
    expect(stored.rows.map((row) => row.status)).toContain('refused');

    const missing = await read('00000000-0000-4000-8000-000000000000');
    expect(missing).toEqual({ error: { code: Code.NotFound, message: '[not_found] file not found', details: [], metadata: expect.any(Array) as unknown } });
    const shape = (r: Read) => ('error' in r ? { ...r.error, metadata: r.error.metadata.map(([k]) => k).sort() } : r);
    for (const [name, id, options] of [
      ['whole-item mark', files['whole'], {}],
      ['refused copy', refused.file, {}],
      ['members file', files['members'], {}],
      ['officers item', files['officersItem'], MEMBER],
      ['draft item', files['draft'], OFFICER],
      ['edition in proof', files['proof'], {}],
      ['not an id', 'not-an-id', {}],
      ['empty', '', {}],
    ] as const) {
      expect(shape(await read(id as string, options)), name).toEqual(shape(missing));
    }
  }, 60_000);
});
