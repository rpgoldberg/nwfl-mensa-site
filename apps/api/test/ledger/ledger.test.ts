// REDACT R-LEDGER: the publication ledger (0016). Proof of what each audience
// was given: one hash-chained row each time an audience's output for a content
// version or a PDF file changes, written in the same transaction as the change
// (or by the regeneration job, for copies). The grants are tested by direct
// SQL as the app role `nwfl`; the superuser (bypasses grants, not triggers)
// checks what holds for every role, and tampers to prove the verifier.
// Every person and name here is made up.
import { createHash } from 'node:crypto';
import { toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { type Client, Code } from '@connectrpc/connect';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentItemSchema, ContentKind, ContentService } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import {
  LedgerSubjectKind,
  MarkField,
  MarkSubjectKind,
  RedactionAction,
  RedactionAudience,
  RedactionCategory,
  RedactionPolicyService,
} from '../../src/gen/nwfl/mensa/v1/redaction_pb.js';
import { canonicalText, ledgerAsOf, recordAll, recordItems, renderVersion, verifyLedger } from '../../src/ledger/ledger.js';
import { type Redact, drain } from '../../src/pdf/regenerate.js';
import { storeOriginal } from '../../src/pdf/store.js';
import { type Api, MEMBER, OFFICER, as, insertId, startApi } from '../helpers/api.js';
import { paragraph, publishItem, text } from '../helpers/content.js';
import { APP, APP_PW, live, sqlstate, url, urlFor } from '../helpers/pg.js';

const PUB = as('pub-token');
const WEBMASTER = as('webmaster-token');
const ADMIN = as('admin-token');
const PHONE = '850-555-0199';
const NAME = 'Quillon Brask';
const sha = (bytes: Uint8Array): Buffer => createHash('sha256').update(bytes).digest();
const zero = Buffer.alloc(32);

interface Row {
  seq: string;
  subject_kind: string;
  subject_id: string;
  audience: string;
  output_sha256: Buffer | null;
  inputs: Record<string, unknown>;
  passages_withheld: number;
  current_from: Date;
  current_to: Date | null;
  prev_hash: Buffer;
  row_hash: Buffer;
}

describe.skipIf(!live)('the publication ledger (0016)', () => {
  let api: Api;
  let content: Client<typeof ContentService>;
  let redaction: Client<typeof RedactionPolicyService>;
  let office: string;
  let database: string;
  let owner: pg.Client;

  const q = <R extends pg.QueryResultRow>(sql: string, values: unknown[] = []) => api.pool.query<R>(sql, values);
  const rows = async (subject: string, audience?: string): Promise<Row[]> =>
    (await q<Row>(`SELECT * FROM publication_ledger WHERE subject_id = $1 AND ($2::text IS NULL OR audience = $2) ORDER BY seq`, [subject, audience ?? null])).rows;
  const current = async (subject: string, audience: string): Promise<Row | undefined> =>
    (await rows(subject, audience)).find((row) => row.current_to === null);
  const record = (client: pg.Client | pg.Pool, kind: string, subject: string, audience: string, output: Buffer | null, withheld = 0) =>
    client.query<{ seq: string | null }>(`SELECT publication_ledger_record($1, $2, $3, $4, $5, $6) AS seq`, [kind, subject, audience, output, { v: 1, test: true }, withheld]);
  const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  beforeAll(async () => {
    api = await startApi('nwfl_ledger');
    content = api.client(ContentService);
    redaction = api.client(RedactionPolicyService);
    office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
    database = (await q<{ db: string }>(`SELECT current_database() AS db`)).rows[0]!.db;
    owner = new pg.Client({ connectionString: urlFor('postgres', new URL(url as string).password, database) });
    await owner.connect();
  });

  afterAll(async () => {
    await owner?.end();
    await api?.close();
  });

  describe('the table and its one writer', () => {
    it('gives the app role reads only: no insert, update, delete or head write', async () => {
      expect(await sqlstate(owner, `SELECT 1`)).toBe('ok');
      const app = new pg.Client({ connectionString: urlFor(APP, APP_PW, database) });
      await app.connect();
      try {
        expect(await sqlstate(app, `SELECT count(*) FROM publication_ledger`)).toBe('ok');
        expect(
          await sqlstate(
            app,
            `INSERT INTO publication_ledger (seq, subject_kind, subject_id, audience, inputs, passages_withheld, current_from, prev_hash, row_hash)
             VALUES (999, 'stored_file', $1, 'public', '{}', 0, now(), $2, $2)`,
            [uuid(1), zero],
          ),
        ).toBe('42501');
        expect(await sqlstate(app, `UPDATE publication_ledger SET passages_withheld = 0`)).toBe('42501');
        expect(await sqlstate(app, `DELETE FROM publication_ledger`)).toBe('42501');
        expect(await sqlstate(app, `UPDATE publication_ledger_head SET seq = 0`)).toBe('42501');
        expect(await sqlstate(app, `SELECT publication_ledger_canonical(1, 't', 'k', $1, 'a', NULL, '{}', 0, now(), $2)`, [uuid(1), zero])).toBe('42501');
      } finally {
        await app.end();
      }
    });

    it('appends only on a change, closes the row it replaces, and chains each row to the last', async () => {
      const subject = uuid(10);
      expect((await record(api.pool, 'stored_file', subject, 'public', null)).rows[0]!.seq).toBeNull();
      const first = (await record(api.pool, 'stored_file', subject, 'public', sha(Buffer.from('a')))).rows[0]!.seq;
      expect(first).not.toBeNull();
      expect((await record(api.pool, 'stored_file', subject, 'public', sha(Buffer.from('a')))).rows[0]!.seq).toBeNull();
      const second = (await record(api.pool, 'stored_file', subject, 'public', sha(Buffer.from('a')), 2)).rows[0]!.seq;
      expect(Number(second)).toBe(Number(first) + 1);
      const [a, b] = await rows(subject);
      expect(a!.current_to).toEqual(b!.current_from);
      expect(b!.current_to).toBeNull();
      expect(b!.prev_hash).toEqual(a!.row_hash);
      await expect(record(api.pool, 'stored_file', subject, 'nobody', sha(Buffer.from('n')))).rejects.toMatchObject({ code: '23514' });
      await expect(api.pool.query(`SELECT publication_ledger_record('stored_file', $1, 'public', NULL, NULL, 0)`, [subject])).rejects.toMatchObject({ code: '22023' });
    });

    it('keeps every row as written for every role: current_to is set once, nothing else changes', async () => {
      const subject = uuid(11);
      await record(api.pool, 'stored_file', subject, 'members', sha(Buffer.from('x')));
      const seq = (await current(subject, 'members'))!.seq;
      expect(await sqlstate(owner, `UPDATE publication_ledger SET passages_withheld = 5 WHERE seq = $1`, [seq])).toBe('55000');
      expect(await sqlstate(owner, `UPDATE publication_ledger SET row_hash = $2 WHERE seq = $1`, [seq, zero])).toBe('55000');
      expect(await sqlstate(owner, `DELETE FROM publication_ledger WHERE seq = $1`, [seq])).toBe('55000');
      expect(await sqlstate(owner, `TRUNCATE publication_ledger`)).toBe('55000');
      await record(api.pool, 'stored_file', subject, 'members', sha(Buffer.from('y')));
      expect(await sqlstate(owner, `UPDATE publication_ledger SET current_to = now() + interval '1 day' WHERE seq = $1`, [seq])).toBe('55000');
      expect(await sqlstate(owner, `UPDATE publication_ledger SET current_to = NULL WHERE seq = $1`, [seq])).toBe('55000');
    });

    it('pins search_path on the four 0012-0014 functions that lacked it, and on every ledger function', async () => {
      const { rows: found } = await owner.query<{ proname: string; proconfig: string[] | null }>(
        `SELECT proname, proconfig FROM pg_proc WHERE proname IN ('redaction_action_allowed', 'redaction_rank', 'redaction_change_guard',
           'redaction_mark_removal_guard') OR proname LIKE 'publication_ledger%' ORDER BY proname`,
      );
      expect(found.map((row) => row.proname)).toEqual([
        'publication_ledger_canonical',
        'publication_ledger_guard',
        'publication_ledger_lock',
        'publication_ledger_record',
        'redaction_action_allowed',
        'redaction_change_guard',
        'redaction_mark_removal_guard',
        'redaction_rank',
      ]);
      for (const row of found) expect(row.proconfig, row.proname).toEqual(['search_path=pg_catalog, public, pg_temp']);
      // The CHECKs that call the pinned functions still hold.
      expect(await sqlstate(owner, `UPDATE redaction_policy SET action = 'redact' WHERE audience = 'public' AND category = 'image'`)).toBe('23514');
    });
  });

  describe('concurrent writers', () => {
    it('serializes appends: a second writer waits for the first to commit, and the chain stays linear', async () => {
      const a = new pg.Client({ connectionString: urlFor(APP, APP_PW, database) });
      const b = new pg.Client({ connectionString: urlFor(APP, APP_PW, database) });
      await a.connect();
      await b.connect();
      try {
        await a.query('BEGIN');
        await record(a, 'stored_file', uuid(20), 'public', sha(Buffer.from('a')));
        await b.query('BEGIN');
        let bDone = false;
        const bWrite = record(b, 'stored_file', uuid(21), 'public', sha(Buffer.from('b'))).then(() => {
          bDone = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(bDone).toBe(false);
        await a.query('COMMIT');
        await bWrite;
        await b.query('COMMIT');
        expect(bDone).toBe(true);
      } finally {
        await a.end();
        await b.end();
      }
      // Then 8 writers at once, 5 appends each, each in its own transaction.
      const writers = await Promise.all(
        Array.from({ length: 8 }, async () => {
          const client = new pg.Client({ connectionString: urlFor(APP, APP_PW, database) });
          await client.connect();
          return client;
        }),
      );
      try {
        await Promise.all(
          writers.map(async (client, w) => {
            for (let i = 0; i < 5; i++) {
              await client.query('BEGIN');
              await record(client, 'stored_file', uuid(100 + w * 10 + i), 'officers', sha(Buffer.from(`${w}:${i}`)));
              await client.query('COMMIT');
            }
          }),
        );
      } finally {
        await Promise.all(writers.map((client) => client.end()));
      }
      const { rows: chain } = await q<{ seq: string; prev_hash: Buffer; row_hash: Buffer }>(`SELECT seq, prev_hash, row_hash FROM publication_ledger ORDER BY seq`);
      chain.forEach((row, i) => {
        expect(Number(row.seq)).toBe(i + 1);
        expect(row.prev_hash).toEqual(i === 0 ? zero : chain[i - 1]!.row_hash);
      });
      const head = (await q<{ seq: string; row_hash: Buffer }>(`SELECT seq, row_hash FROM publication_ledger_head`)).rows[0]!;
      expect(Number(head.seq)).toBe(chain.length);
      expect(head.row_hash).toEqual(chain.at(-1)!.row_hash);
      expect(await verifyLedger(api.pool)).toMatchObject({ intact: true, rows: chain.length, firstBreak: null });
    });
  });

  describe('when rows are written, and what they hash', () => {
    let itemId: string;
    let versionId: string;

    /** An item published through the workflow, so the approval writes its rows. */
    const publish = async (slug: string, body: string): Promise<{ itemId: string; versionId: string }> => {
      const item = (await content.createItem({ kind: ContentKind.ARTICLE, officeId: office, slug, title: 'Ledger picnic' }, PUB)).item!;
      await content.saveDraft({ itemId: item.id, title: 'Ledger picnic', bodyMarkup: body }, PUB);
      const hash = (await content.markReady({ itemId: item.id, targets: { website: true, newsletter: false, email: false } }, PUB)).item?.working?.contentHash as Uint8Array;
      const live = (await content.approve({ itemId: item.id, contentHash: hash }, WEBMASTER)).item?.live?.id as string;
      return { itemId: item.id, versionId: live };
    };
    /** sha256 of the exact item the read path gives this caller. */
    const served = async (options?: { headers: Record<string, string> }): Promise<Buffer> =>
      sha(toBinary(ContentItemSchema, (await content.getPublishedItem({ slug: itemId }, options)).item!));

    beforeAll(async () => {
      ({ itemId, versionId } = await publish('ledger-picnic', `Call Quillon Brask at ${PHONE} to bring a dish.`));
    });

    it('writes a row per audience on publish, in the approval transaction, and the read path hashes to it', async () => {
      for (const [audience, options] of [['public', undefined], ['members', MEMBER], ['officers', OFFICER]] as const) {
        const row = await current(versionId, audience);
        expect(row, audience).toBeDefined();
        expect(row!.subject_kind).toBe('content_version');
        expect(row!.passages_withheld).toBe(0);
        expect(row!.output_sha256).toEqual(await served(options));
        expect(row!.inputs).toMatchObject({ v: 1, version_id: versionId, item_id: itemId, marks: [], item_state: 'published' });
        expect(Object.keys(row!.inputs['policy'] as object)).toHaveLength(8);
      }
    });

    it('writes the public a new row when a mark is added, with the passage counted, and the read path still matches', async () => {
      const before = (await current(versionId, 'public'))!;
      const mark = (
        await redaction.addRedactionMark(
          { subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: itemId, field: MarkField.BODY, quote: PHONE, category: RedactionCategory.MEMBER_PHONE },
          OFFICER,
        )
      ).mark!;
      const after = (await current(versionId, 'public'))!;
      expect(after.seq).not.toBe(before.seq);
      expect(after.passages_withheld).toBe(1);
      expect(after.inputs['marks']).toEqual([mark.markId]);
      expect(after.output_sha256).toEqual(await served());
      expect(await rows(versionId, 'public')).toHaveLength(2);
      // Members see phones: their output did not change, so they got no new row.
      expect(await rows(versionId, 'members')).toHaveLength(1);
      expect((await current(versionId, 'members'))!.output_sha256).toEqual(await served(MEMBER));
    });

    it('writes every affected audience a row when a policy change applies, and none while it waits', async () => {
      const before = (await rows(versionId, 'members')).length;
      await redaction.proposeRedactionChange({ audience: RedactionAudience.MEMBERS, category: RedactionCategory.MEMBER_PHONE, action: RedactionAction.REDACT }, OFFICER);
      const members = await rows(versionId, 'members');
      expect(members).toHaveLength(before + 1);
      expect(members.at(-1)!.passages_withheld).toBe(1);
      expect(members.at(-1)!.output_sha256).toEqual(await served(MEMBER));
      const pending = (
        await redaction.proposeRedactionChange({ audience: RedactionAudience.PUBLIC, category: RedactionCategory.MEMBER_PHONE, action: RedactionAction.SHOW }, OFFICER)
      ).change!;
      expect(await rows(versionId, 'public')).toHaveLength(2);
      await redaction.approveRedactionChange({ changeId: pending.changeId }, ADMIN);
      const publicRows = await rows(versionId, 'public');
      expect(publicRows).toHaveLength(3);
      expect(publicRows.at(-1)!.passages_withheld).toBe(0);
      expect(publicRows.at(-1)!.output_sha256).toEqual(await served());
    });

    it('re-renders as of a past time, after later marks and policy changes, and the hash still matches', async () => {
      const [first, second, third] = await rows(versionId, 'public');
      for (const row of [first!, second!, third!]) {
        const at = new Date(row.current_from.getTime() + 1);
        const asOf = await ledgerAsOf(api.pool, 'content_version', versionId, 'public', at);
        expect(asOf.row?.seq).toBe(row.seq);
        expect(asOf.matches, asOf.detail).toBe(true);
        expect(asOf.rerender).toEqual(row.output_sha256);
      }
      // Before the first row: nothing was current.
      expect((await ledgerAsOf(api.pool, 'content_version', versionId, 'public', new Date(first!.current_from.getTime() - 1))).row).toBeNull();
      // The same through the RPC, officers only.
      const response = await redaction.ledgerAsOf(
        { subjectKind: LedgerSubjectKind.CONTENT_VERSION, subjectId: versionId, audience: RedactionAudience.PUBLIC, at: timestampFromDate(new Date(second!.current_from.getTime() + 1)) },
        OFFICER,
      );
      expect(response.matches).toBe(true);
      expect(response.row?.seq).toBe(BigInt(second!.seq));
      expect(Buffer.from(response.row!.outputSha256)).toEqual(second!.output_sha256);
      expect(JSON.parse(response.row!.inputsJson)).toEqual(second!.inputs);
      await expect(
        redaction.ledgerAsOf({ subjectKind: LedgerSubjectKind.CONTENT_VERSION, subjectId: versionId, audience: RedactionAudience.PUBLIC, at: timestampFromDate(new Date()) }, MEMBER),
      ).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(
        redaction.ledgerAsOf({ subjectKind: LedgerSubjectKind.UNSPECIFIED, subjectId: versionId, audience: RedactionAudience.PUBLIC, at: timestampFromDate(new Date()) }, OFFICER),
      ).rejects.toMatchObject({ code: Code.InvalidArgument });
    });

    it('reports a re-render that does not match the row when the history was tampered with', async () => {
      const second = (await rows(versionId, 'public'))[1]!;
      const at = new Date(second.current_from.getTime() + 1);
      // As the superuser, guard off: the mark now claims it was made later, so the re-render shows the phone.
      await owner.query(`SET session_replication_role = replica`);
      const { rows: moved } = await owner.query<{ id: string; created_at: Date }>(
        `UPDATE redaction_mark m SET created_at = now() + interval '1 day' FROM redaction_mark o WHERE m.id = o.id AND m.content_item_id = $1 RETURNING m.id, o.created_at`,
        [itemId],
      );
      try {
        const asOf = await ledgerAsOf(api.pool, 'content_version', versionId, 'public', at);
        expect(asOf.matches).toBe(false);
        expect(asOf.detail).toMatch(/does not match/);
      } finally {
        for (const mark of moved) await owner.query(`UPDATE redaction_mark SET created_at = $2 WHERE id = $1`, [mark.id, mark.created_at]);
        await owner.query(`SET session_replication_role = origin`);
      }
      expect((await ledgerAsOf(api.pool, 'content_version', versionId, 'public', at)).matches).toBe(true);
      // An unknown subject has no row.
      expect(await ledgerAsOf(api.pool, 'content_version', uuid(9), 'public', at)).toMatchObject({ row: null, matches: false });
      expect((await renderVersion(api.pool, uuid(9), 'public')).output).toBeNull();
    });

    it('closes a version when the item is withdrawn: the audience gets the withdrawn stub', async () => {
      const before = (await current(versionId, 'public'))!;
      await content.withdraw({ itemId }, WEBMASTER);
      const after = (await current(versionId, 'public'))!;
      expect(after.seq).not.toBe(before.seq);
      expect(after.inputs['item_state']).toBe('withdrawn');
      expect(after.output_sha256).toEqual(await served());
      const asOf = await ledgerAsOf(api.pool, 'content_version', versionId, 'public', new Date());
      expect(asOf.matches, asOf.detail).toBe(true);
    });

    it('records nothing given to the public for an officers item, and closes an old version when a new one goes live', async () => {
      const secret = await publishItem(api.pool, { slug: 'ledger-officers', officeId: office, title: 'Officers only', visibility: 'officers', body: { blocks: [paragraph(text('x'))] } });
      expect(await recordItems(api.pool, [secret.itemId])).toBe(1);
      expect(await rows(secret.versionId, 'public')).toEqual([]);
      expect(await rows(secret.versionId, 'members')).toEqual([]);
      expect(await current(secret.versionId, 'officers')).toBeDefined();
      // A second version goes live (as approval does it, by SQL here, so nothing records it yet).
      const v2 = await insertId(
        api.pool,
        `INSERT INTO content_version (item_id, n, title, visibility, body_ast, created_by_sub, acting_office_id) VALUES ($1, 2, 'Officers only', 'officers', $2, 'sub-author', $3) RETURNING id`,
        [secret.itemId, JSON.stringify({ blocks: [paragraph(text('y'))] }), office],
      );
      await q(`UPDATE content_version SET status = 'ready', content_hash = $2, ready_at = now() WHERE id = $1`, [v2, sha(Buffer.from('y'))]);
      await q(`UPDATE content_version SET status = 'approved', approved_at = now(), approved_by_sub = 'sub-webmaster', approval_kind = 'normal', public_ast = '{"blocks":[]}' WHERE id = $1`, [v2]);
      await q(`UPDATE content_item SET live_version_id = $2 WHERE id = $1`, [secret.itemId, v2]);
      await q(`UPDATE content_version SET status = 'superseded' WHERE id = $1`, [secret.versionId]);
      expect(await recordAll(api.pool)).toBe(2);
      const closed = (await current(secret.versionId, 'officers'))!;
      expect(closed.output_sha256).toBeNull();
      expect(closed.inputs['item_state']).toBeNull();
      expect((await ledgerAsOf(api.pool, 'content_version', secret.versionId, 'officers', new Date())).matches).toBe(true);
      expect((await current(v2, 'officers'))!.output_sha256).not.toBeNull();
      expect(await recordAll(api.pool)).toBe(0);
    });
  });

  describe('PDF copies', () => {
    const OWNER = { sub: 'sub-officer', groups: ['nwfl-members', 'nwfl-officers'] };
    const stub: Redact = async (_original, request) => ({ kind: 'redacted', pdf: new Uint8Array(Buffer.from(`copy:${[...request.quotes].sort().join('|')}`)), boxes: [] });
    let file: string;
    let item: string;
    let original: Uint8Array;

    beforeAll(async () => {
      original = new Uint8Array(Buffer.from('%PDF-1.7\n% ledger\n%%EOF\n', 'latin1'));
      const published = await publishItem(api.pool, {
        slug: 'ledger-pdf',
        officeId: office,
        title: 'Minutes',
        body: { blocks: [paragraph(text(`Minutes by ${NAME}.`))] },
        files: [{ objectKey: 'minutes.pdf', audience: 'public', bytes: original }],
      });
      item = published.itemId;
      file = (await q<{ id: string }>(`SELECT id FROM stored_file WHERE version_id = $1`, [published.versionId])).rows[0]!.id;
      await storeOriginal(api.pool, { fileId: file, bytes: original, ...OWNER });
    });

    it('writes each audience a row when its copy becomes current, hashing exactly the bytes ReadFile serves', async () => {
      await drain(api.pool, { redact: stub });
      const officers = (await current(file, 'officers'))!;
      expect(officers.output_sha256).toEqual(sha(original));
      expect(officers.inputs).toMatchObject({ served: 'original', file_id: file, original_sha256: sha(original).toString('hex') });
      const pub = (await current(file, 'public'))!;
      expect(pub.inputs['served']).toBe('copy');
      const copy = (await q<{ bytes: Buffer }>(`SELECT bytes FROM pdf_copy WHERE file_id = $1 AND input_hash = decode($2, 'hex')`, [file, pub.inputs['input_hash']])).rows[0]!;
      expect(pub.output_sha256).toEqual(sha(copy.bytes));
      expect(pub.inputs).toMatchObject({ engine: expect.stringContaining('pdfium'), image: 'blur' });
    });

    it('records "not ready" in the mark transaction, then the new copy, and re-renders each as of its time', async () => {
      const before = (await current(file, 'public'))!;
      await redaction.addRedactionMark(
        { subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: item, field: MarkField.BODY, quote: NAME, category: RedactionCategory.MEMBER_NAME },
        OFFICER,
      );
      const waiting = (await current(file, 'public'))!;
      expect(waiting.output_sha256).toBeNull();
      expect(waiting.inputs['served']).toBe('not_ready');
      await drain(api.pool, { redact: stub });
      const ready = (await current(file, 'public'))!;
      expect(ready.passages_withheld).toBe(1);
      const asOfReady = await ledgerAsOf(api.pool, 'stored_file', file, 'public', new Date());
      expect(asOfReady.matches, asOfReady.detail).toBe(true);
      const asOfWaiting = await ledgerAsOf(api.pool, 'stored_file', file, 'public', new Date(waiting.current_from.getTime() + 1));
      expect(asOfWaiting.matches, asOfWaiting.detail).toBe(true);
      // The first copy was dropped by the regeneration's finish: its inputs are checked, its bytes cannot be.
      const asOfBefore = await ledgerAsOf(api.pool, 'stored_file', file, 'public', new Date(before.current_from.getTime() + 1));
      expect(asOfBefore.matches).toBe(false);
      expect(asOfBefore.detail).toMatch(/no longer kept/);
    });
  });

  describe('the chain verifier', () => {
    it('names the first tampered row, then the first broken link', async () => {
      expect(await verifyLedger(api.pool)).toMatchObject({ intact: true, firstBreak: null });
      const response = await redaction.verifyLedger({}, OFFICER);
      expect(response.intact).toBe(true);
      await expect(redaction.verifyLedger({}, MEMBER)).rejects.toMatchObject({ code: Code.PermissionDenied });
      const target = (await q<{ seq: string }>(`SELECT seq FROM publication_ledger ORDER BY seq OFFSET 4 LIMIT 1`)).rows[0]!.seq;
      // As the superuser, with the guard trigger off for this session.
      await owner.query(`SET session_replication_role = replica`);
      await owner.query(`UPDATE publication_ledger SET passages_withheld = passages_withheld + 7 WHERE seq = $1`, [target]);
      const broken = await verifyLedger(api.pool);
      expect(broken).toMatchObject({ intact: false, firstBreak: Number(target) });
      expect(broken.problem).toMatch(/hash/);
      expect((await redaction.verifyLedger({}, OFFICER)).firstBreakSeq).toBe(BigInt(target));
      // Rewrite its hash to match: now the next row's link breaks, and the verifier names that row.
      const row = (await owner.query<Row & { tenant_id: string; inputs_text: string; from_text: string }>(
        `SELECT *, inputs::text AS inputs_text, to_char(current_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS from_text FROM publication_ledger WHERE seq = $1`,
        [target],
      )).rows[0]!;
      const rehash = sha(
        Buffer.from(
          canonicalText({ seq: row.seq, tenant: row.tenant_id, kind: row.subject_kind, subject: row.subject_id, audience: row.audience, output: row.output_sha256, inputs: row.inputs_text, withheld: row.passages_withheld, from: row.from_text, prev: row.prev_hash }),
          'utf8',
        ),
      );
      await owner.query(`UPDATE publication_ledger SET row_hash = $2 WHERE seq = $1`, [target, rehash]);
      const relinked = await verifyLedger(api.pool);
      expect(relinked).toMatchObject({ intact: false, firstBreak: Number(target) + 1 });
      expect(relinked.problem).toMatch(/previous/);
      await owner.query(`SET session_replication_role = origin`);
    });
  });
});
