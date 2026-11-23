// ARCHIVE-SEARCH S1 fix 3: search_page_put stores a file's pages for an audience exactly when servableFile
// (content/files.ts) gives the audience the file. Rounds 1 to 3 each found one more refusal of servableFile's
// that the put did not make; this holds the two to each other over the whole space instead. A seeded
// differential: many states (item state, visibility, live version, edition status, on-behalf-of, each
// audience's cells including missing ones, whole-item, passage and file marks, quotes carried and not,
// removed marks, another tenant's rows), and for each state and audience, the put succeeds IFF servableFile
// answers non-null. The file's own ledger row is set to "copy" by hand, so only servability decides; the
// items' ledger rows are the app's own (recordItems). A5a is the recheck's probe, kept as a test. Synthetic data only.
import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MarkField, MarkSubjectKind, RedactionCategory, RedactionPolicyService } from '../../src/gen/nwfl/mensa/v1/redaction_pb.js';
import { servableFile } from '../../src/content/files.js';
import { deriveForApproval } from '../../src/content/tree.js';
import { recordItems } from '../../src/ledger/ledger.js';
import { ENGINE_VERSION, inputsFor } from '../../src/pdf/store.js';
import { type Api, OFFICER, insertId, startApi } from '../helpers/api.js';
import { paragraph, publishItem, text } from '../helpers/content.js';
import { WORKER, WORKER_PW, live, url, urlFor } from '../helpers/pg.js';

const PUT = `SELECT search_page_put($1, $2, $3, $4, $5::text[], $6::text[]) AS pages`;
const COPY = { v: 1, served: 'copy' };
const SEED = 20261123;
const AUDIENCES = ['public', 'members'] as const;
type Aud = (typeof AUDIENCES)[number];
const CATEGORIES = ['member_name', 'member_address', 'member_phone', 'member_email', 'private_venue', 'business_venue', 'officer_contact'] as const;
type Action = 'show' | 'redact' | 'hide' | 'missing';
/** A policy for one audience: each mark category's cell, or 'missing' for no row. */
type Cells = Record<(typeof CATEGORIES)[number], Action>;
type Config = { name: string } & Record<Aud, Cells>;
type MarkKind = 'whole' | 'present' | 'absent' | 'file-this' | 'file-other' | 'file-other-tenant-anchor' | 'removed' | 'other-tenant';
type Life = 'live' | 'withdrawn' | 'draft' | 'superseded';
interface ItemSpec {
  kind: 'item';
  name: string;
  visibility: 'public' | 'members' | 'officers';
  life: Life;
  pdf: boolean;
  obo: boolean;
  marks: Array<{ kind: MarkKind; category: (typeof CATEGORIES)[number] }>;
}
interface EditionSpec {
  kind: 'edition';
  name: string;
  status: 'planning' | 'collecting' | 'drafting' | 'proof' | 'published';
  pdf: boolean;
}
type Spec = ItemSpec | EditionSpec;
interface Subject {
  spec: Spec;
  fileId: string;
  itemId?: string;
  versionId?: string;
}

const sha = (seed: string): Buffer => createHash('sha256').update(seed).digest();
/** mulberry32: a small seeded generator, so every run builds the same states. */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const uniform = (action: Action): Cells => Object.fromEntries(CATEGORIES.map((category) => [category, action])) as Cells;
const describeSpec = (spec: Spec): string => JSON.stringify(spec);

describe.skipIf(!live)('search_page_put succeeds exactly when servableFile gives the audience the file', () => {
  let api: Api;
  let owner: pg.Client;
  let worker: pg.Client;
  let office: string;
  let n = 0;

  const connect = async (connectionString: string): Promise<pg.Client> => {
    const client = new pg.Client({ connectionString });
    await client.connect();
    return client;
  };
  const outcome = (client: pg.Client, sql: string, values: unknown[]): Promise<string> =>
    client.query(sql, values).then(
      () => 'ok',
      (error: { code?: string }) => error.code ?? 'no-code',
    );
  const body = (title: string) => ({ blocks: [paragraph(text(`${title}, meet at the pier.`))] });
  const original = (fileId: string, bytes: Buffer) => owner.query(`SELECT pdf_original_put($1, $2, 'sub-author', ARRAY['nwfl-officers'], NULL)`, [fileId, bytes]);
  /** A version of the item with one PDF (and its original) that is never published. */
  const draftVersion = async (itemId: string, nth: number, title: string, onBehalfOf: string | null, visibility = 'public'): Promise<{ versionId: string; fileId: string }> => {
    const k = ++n;
    const versionId = await insertId(
      api.pool,
      `INSERT INTO content_version (item_id, n, title, visibility, body_ast, created_by_sub, acting_office_id, on_behalf_of) VALUES ($1, $2, $3, $4, $5, 'sub-author', $6, $7) RETURNING id`,
      [itemId, nth, title, visibility, JSON.stringify(body(title)), office, onBehalfOf],
    );
    const bytes = Buffer.from(`synthetic parity pdf v${nth} ${k}`);
    const fileId = await insertId(
      api.pool,
      `INSERT INTO stored_file (version_id, object_key, filename, mime_type, size_bytes, sha256, audience, role) VALUES ($1, $2, $2, 'application/pdf', $3, sha256($4), 'public', 'primary') RETURNING id`,
      [versionId, `parity-v${nth}-${k}.pdf`, bytes.length, bytes],
    );
    await original(fileId, bytes);
    return { versionId, fileId };
  };
  /** A second version published over the first in SQL, in one transaction as publishVersion runs it (0010's deferred check). */
  const supersede = async (itemId: string, prev: string, title: string): Promise<string> => {
    const next = await draftVersion(itemId, 2, `${title}, again`, null);
    const derived = deriveForApproval({ title: `${title}, again`, summary: null, visibility: 'public', body: body(`${title}, again`) });
    await api.pool.query(`UPDATE content_version SET status = 'ready', content_hash = $2, ready_at = now() WHERE id = $1`, [next.versionId, sha(JSON.stringify(body(`${title}, again`)))]);
    await api.pool.query(
      `UPDATE content_version SET status = 'cleared', approved_at = now(), approved_by_sub = 'sub-webmaster', approval_kind = 'normal',
         public_ast = $2, search_public = to_tsvector('english', $3), search_members = to_tsvector('english', $4) WHERE id = $1`,
      [next.versionId, JSON.stringify(derived.publicAst), derived.publicText, derived.membersText],
    );
    const tx = await api.pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query(`UPDATE content_version SET status = 'approved', published_at = now(), published_by_sub = 'sub-webmaster' WHERE id = $1`, [next.versionId]);
      await tx.query(`UPDATE content_item SET live_version_id = $2, working_version_id = NULL, state = 'published', withdrawn_at = NULL, updated_at = now() WHERE id = $1`, [
        itemId,
        next.versionId,
      ]);
      await tx.query(`UPDATE content_version SET status = 'superseded' WHERE id = $1`, [prev]);
      await tx.query('COMMIT');
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally {
      tx.release();
    }
    return next.fileId;
  };
  const markAdd = async (itemId: string, field: string | null, quote: string | null, category: string): Promise<string> =>
    (
      await owner.query<{ id: string }>(`SELECT (redaction_mark_add('content_item', $1, $2, $3, $4, 'sub-officer', ARRAY['nwfl-officers'], NULL)).id`, [
        itemId,
        field,
        quote,
        category,
      ])
    ).rows[0]!.id;
  const fileMark = async (itemId: string, category: string, files: string[]): Promise<string> =>
    (await owner.query<{ id: string }>(`SELECT (redaction_mark_add_file($1, 'Ferrowick gate code', $2, $3, 'sub-officer', ARRAY['nwfl-officers'], NULL)).id`, [itemId, category, files]))
      .rows[0]!.id;
  /** Owner writes the append-only guards refuse, with the guard set aside for that one write (as 0019 allows the owner). */
  const guardOff = async (table: string, trigger: string, sql: string, values: unknown[]): Promise<void> => {
    await owner.query('BEGIN');
    try {
      await owner.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
      await owner.query(sql, values);
      await owner.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
      await owner.query('COMMIT');
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }
  };

  const build = async (spec: Spec): Promise<Subject> => {
    const k = ++n;
    if (spec.kind === 'edition') {
      const editionId = await insertId(
        api.pool,
        `INSERT INTO edition (slug, title, kind, period_start, period_end, status) VALUES ($1, 'Parity issue', 'regular', '2040-01-01', '2040-01-31', $2) RETURNING id`,
        [`${2040 + k}-01`, spec.status],
      );
      const bytes = Buffer.from(`synthetic parity issue ${k}`);
      const fileId = await insertId(
        api.pool,
        `INSERT INTO stored_file (edition_id, object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ($1, $2, 'issue.pdf', $3, $4, sha256($5), 'public') RETURNING id`,
        [editionId, `parity-issue-${k}`, spec.pdf ? 'application/pdf' : 'image/png', bytes.length, bytes],
      );
      return { spec, fileId };
    }
    const title = `Lantern walk ${k}`;
    const onBehalfOf = spec.obo ? 'Avery Quill' : null;
    let itemId: string;
    let versionId: string;
    let fileId: string;
    if (spec.life === 'draft') {
      itemId = await insertId(api.pool, `INSERT INTO content_item (slug, kind, office_id) VALUES ($1, 'article', $2) RETURNING id`, [`parity-${k}`, office]);
      ({ versionId, fileId } = await draftVersion(itemId, 1, title, onBehalfOf, spec.visibility));
    } else {
      const bytes = Buffer.from(`synthetic parity pdf ${k}`);
      const made = await publishItem(api.pool, {
        slug: `parity-${k}`,
        officeId: office,
        title,
        visibility: spec.visibility,
        body: body(title),
        files: [{ objectKey: `parity-${k}.${spec.pdf ? 'pdf' : 'png'}`, audience: 'public', mimeType: spec.pdf ? 'application/pdf' : 'image/png', bytes }],
        ...(onBehalfOf === null ? {} : { onBehalfOf }),
      });
      ({ itemId, versionId } = made);
      fileId = (await api.pool.query<{ id: string }>(`SELECT id FROM stored_file WHERE version_id = $1`, [versionId])).rows[0]!.id;
      if (spec.pdf) await original(fileId, bytes);
      if (spec.life === 'withdrawn') await owner.query(`UPDATE content_item SET state = 'withdrawn', withdrawn_at = now() WHERE id = $1`, [itemId]);
    }
    let other: string | undefined = spec.life === 'superseded' ? await supersede(itemId, versionId, title) : undefined;
    const otherFile = async (): Promise<string> => (other ??= (await draftVersion(itemId, 2, `${title}, a draft`, null)).fileId);
    for (const mark of spec.marks) {
      if (mark.kind === 'whole' || mark.kind === 'removed') {
        const id = await markAdd(itemId, null, null, mark.category);
        if (mark.kind === 'removed')
          await guardOff('redaction_mark', 'redaction_mark_guard', `UPDATE redaction_mark SET status = 'removed', removed_at = now() WHERE id = $1`, [id]);
      } else if (mark.kind === 'present') await markAdd(itemId, 'body', 'Lantern walk', mark.category);
      else if (mark.kind === 'absent') await markAdd(itemId, 'body', 'Quill gate code 4417', mark.category);
      else if (mark.kind === 'other-tenant')
        await owner.query(`INSERT INTO redaction_mark (tenant_id, content_item_id, category, created_by_sub) VALUES ('other-group', $1, $2, 'sub-other')`, [itemId, mark.category]);
      else if (mark.kind === 'file-this') await fileMark(itemId, mark.category, [fileId]);
      else {
        const id = await fileMark(itemId, mark.category, [await otherFile()]);
        if (mark.kind === 'file-other-tenant-anchor')
          await guardOff('redaction_mark_anchor', 'redaction_mark_anchor_guard', `INSERT INTO redaction_mark_anchor (tenant_id, mark_id, file_id) VALUES ('other-group', $1, $2)`, [
            id,
            fileId,
          ]);
      }
    }
    return { spec, fileId, itemId, versionId };
  };

  /** Sets every nwflorida cell of both audiences (a missing cell: no row), and the image cells untouched. */
  const applyConfig = async (config: Config): Promise<void> => {
    for (const audience of AUDIENCES) {
      for (const category of CATEGORIES) {
        const action = config[audience][category];
        await owner.query(`DELETE FROM redaction_policy WHERE tenant_id = 'nwflorida' AND audience = $1 AND category = $2`, [audience, category]);
        if (action !== 'missing')
          await owner.query(`INSERT INTO redaction_policy (tenant_id, audience, category, action) VALUES ('nwflorida', $1, $2, $3)`, [audience, category, action]);
      }
    }
  };

  beforeAll(async () => {
    api = await startApi('nwfl_searchparity');
    office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
    const database = (await api.pool.query<{ db: string }>(`SELECT current_database() AS db`)).rows[0]!.db;
    owner = await connect(urlFor('postgres', new URL(url as string).password, database));
    worker = await connect(urlFor(WORKER, WORKER_PW, database));
  });

  afterAll(async () => {
    for (const client of [owner, worker]) await client?.end();
    await api?.close();
  });

  it('A5a: a body mark whose quote is not in the item\'s text hides the PDF from both audiences, and the put refuses it; a quote that is there leaves it put', async () => {
    const redaction = api.client(RedactionPolicyService);
    await applyConfig({ name: 'A5a', public: uniform('redact'), members: uniform('redact') });
    const out: Record<string, Record<Aud, { served: string | undefined; servable: boolean; put: string }>> = {};
    for (const [tag, quote] of [
      ['absent', 'Quill gate code 4417'],
      ['present', 'Lantern walk'],
    ] as const) {
      const subject = await build({ kind: 'item', name: `A5a ${tag}`, visibility: 'public', life: 'live', pdf: true, obo: false, marks: [] });
      const itemId = subject.itemId as string;
      await redaction.addRedactionMark(
        { subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: itemId, field: MarkField.BODY, quote, category: RedactionCategory.MEMBER_PHONE },
        OFFICER,
      );
      const shas: Partial<Record<Aud, Buffer>> = {};
      for (const audience of AUDIENCES) {
        const inputs = await inputsFor(api.pool, subject.fileId, audience);
        expect(inputs?.kind, `${tag} ${audience} inputs`).toBe('copy');
        // Both audiences may be given one copy (the same inputs): made once, then read back.
        const hash = (inputs as { hash: Buffer }).hash;
        await owner.query(`INSERT INTO pdf_copy (file_id, input_hash, engine, status, bytes) VALUES ($1, $2, $3, 'ready', $4) ON CONFLICT DO NOTHING`, [
          subject.fileId,
          hash,
          ENGINE_VERSION,
          Buffer.from(`synthetic ${audience} copy of ${subject.fileId}`),
        ]);
        const made = await owner.query<{ bytes: Buffer }>(`SELECT bytes FROM pdf_copy WHERE file_id = $1 AND input_hash = $2 AND engine = $3`, [subject.fileId, hash, ENGINE_VERSION]);
        shas[audience] = sha256Of(made.rows[0]!.bytes);
      }
      await recordItems(api.pool, [itemId]);
      out[tag] = {} as Record<Aud, { served: string | undefined; servable: boolean; put: string }>;
      for (const audience of AUDIENCES) {
        const served = (
          await owner.query<{ served: string }>(
            `SELECT inputs->>'served' AS served FROM publication_ledger WHERE subject_kind = 'stored_file' AND subject_id = $1 AND audience = $2 AND current_to IS NULL`,
            [subject.fileId, audience],
          )
        ).rows[0]?.served;
        out[tag][audience] = {
          served,
          servable: (await servableFile(api.pool, subject.fileId, audience)) !== null,
          put: await outcome(worker, PUT, [subject.fileId, audience, shas[audience], 1, [`lantern walk ${tag} ${audience}`], ['']]),
        };
      }
    }
    expect(out).toEqual({
      absent: { public: { served: 'copy', servable: false, put: '55000' }, members: { served: 'copy', servable: false, put: '55000' } },
      present: { public: { served: 'copy', servable: true, put: 'ok' }, members: { served: 'copy', servable: true, put: 'ok' } },
    });
  });

  it(`a seeded differential (seed ${SEED}): over every state and audience, the put succeeds IFF servableFile answers non-null`, { timeout: 600_000 }, async () => {
    const random = generator(SEED);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
    const weighted = <T>(list: ReadonlyArray<[T, number]>): T => {
      let roll = random() * list.reduce((sum, [, weight]) => sum + weight, 0);
      for (const [value, weight] of list) if ((roll -= weight) < 0) return value;
      return list[0]![0];
    };
    await owner.query(`INSERT INTO tenant (id, name) VALUES ('other-group', 'Another synthetic group') ON CONFLICT DO NOTHING`);
    // Another tenant's cells all show: a read that forgets the tenant finds a cell where this tenant has none.
    for (const audience of AUDIENCES)
      for (const category of [...CATEGORIES, 'image'])
        await owner.query(`INSERT INTO redaction_policy (tenant_id, audience, category, action) VALUES ('other-group', $1, $2, 'show') ON CONFLICT DO NOTHING`, [audience, category]);

    const item = (name: string, marks: ItemSpec['marks'] = [], rest: Partial<ItemSpec> = {}): ItemSpec => ({
      kind: 'item',
      name,
      visibility: 'public',
      life: 'live',
      pdf: true,
      obo: false,
      marks,
      ...rest,
    });
    // One subject for each condition, so every one has a state that turns on it whatever the draw.
    const fixed: Spec[] = [
      item('plain'),
      item('passage carried', [{ kind: 'present', category: 'member_phone' }]),
      item('passage not carried', [{ kind: 'absent', category: 'member_phone' }]),
      item('passage not carried, on behalf of', [{ kind: 'absent', category: 'member_phone' }], { obo: true }),
      item('whole-item mark', [{ kind: 'whole', category: 'member_address' }]),
      item('file mark in this version', [{ kind: 'file-this', category: 'member_email' }]),
      item('file mark in another version only', [{ kind: 'file-other', category: 'member_email' }]),
      item('file mark, another tenant\'s anchor here', [{ kind: 'file-other-tenant-anchor', category: 'member_email' }]),
      item('removed mark', [{ kind: 'removed', category: 'private_venue' }]),
      item('another tenant\'s mark', [{ kind: 'other-tenant', category: 'business_venue' }]),
      item('on behalf of', [], { obo: true }),
      item('members-only', [{ kind: 'absent', category: 'officer_contact' }], { visibility: 'members' }),
      item('officers-only', [], { visibility: 'officers' }),
      item('withdrawn', [], { life: 'withdrawn' }),
      item('draft', [], { life: 'draft' }),
      item('superseded', [], { life: 'superseded' }),
      item('not a PDF', [], { pdf: false }),
      { kind: 'edition', name: 'published issue', status: 'published', pdf: true },
      { kind: 'edition', name: 'proof issue', status: 'proof', pdf: true },
      { kind: 'edition', name: 'published picture', status: 'published', pdf: false },
    ];
    const drawn: Spec[] = [];
    for (let i = 0; i < 30; i++) {
      const pdf = random() < 0.9;
      const kinds: MarkKind[] = pdf
        ? ['whole', 'present', 'absent', 'file-this', 'file-other', 'file-other-tenant-anchor', 'removed', 'other-tenant']
        : ['whole', 'present', 'absent', 'removed', 'other-tenant'];
      const marks = Array.from({ length: weighted<number>([[0, 3], [1, 4], [2, 2], [3, 1]]) }, () => ({ kind: pick(kinds), category: pick(CATEGORIES) }));
      drawn.push(
        item(`drawn ${i}`, marks, {
          visibility: weighted([['public', 5], ['members', 3], ['officers', 2]]),
          life: weighted<Life>([['live', 6], ['withdrawn', 1], ['draft', 1], ['superseded', 1]]),
          pdf,
          obo: random() < 0.4,
        }),
      );
    }
    for (let i = 0; i < 6; i++)
      drawn.push({ kind: 'edition', name: `drawn issue ${i}`, status: pick(['planning', 'collecting', 'drafting', 'proof', 'published'] as const), pdf: random() < 0.85 });
    const subjects: Subject[] = [];
    for (const spec of [...fixed, ...drawn]) subjects.push(await build(spec));
    const items = subjects.flatMap((subject) => (subject.itemId === undefined ? [] : [subject.itemId]));

    const randomCells = (): Cells =>
      Object.fromEntries(CATEGORIES.map((category) => [category, weighted<Action>([['show', 35], ['redact', 35], ['hide', 15], ['missing', 15]])])) as Cells;
    const configs: Config[] = [
      { name: 'all show', public: uniform('show'), members: uniform('show') },
      { name: 'all redact', public: uniform('redact'), members: uniform('redact') },
      { name: 'all hide', public: uniform('hide'), members: uniform('hide') },
      { name: 'all missing', public: uniform('missing'), members: uniform('missing') },
      { name: 'public show, members hide', public: uniform('show'), members: uniform('hide') },
      { name: 'public redact, members show', public: uniform('redact'), members: uniform('show') },
      { name: 'member_name hide only', public: { ...uniform('redact'), member_name: 'hide' }, members: { ...uniform('redact'), member_name: 'missing' } },
      ...Array.from({ length: 7 }, (_, i): Config => ({ name: `drawn ${i}`, public: randomCells(), members: randomCells() })),
      // Back to redact everywhere: rows the drawn configs closed now lie behind the current ones.
      { name: 'all redact again', public: uniform('redact'), members: uniform('redact') },
    ];

    const mismatches: string[] = [];
    const tally: Record<string, number> = {};
    const witnessed: Array<{ subject: Subject; audience: Aud }> = [];
    for (const [c, config] of configs.entries()) {
      await applyConfig(config);
      await recordItems(api.pool, items);
      for (const subject of subjects) {
        for (const audience of AUDIENCES) {
          const s = sha(`${subject.fileId}:${audience}:${c}`);
          await owner.query(`SELECT publication_ledger_record('stored_file', $1, $2, $3, $4, 0)`, [subject.fileId, audience, s, COPY]);
          const servable = (await servableFile(api.pool, subject.fileId, audience)) !== null;
          const put = await outcome(worker, PUT, [subject.fileId, audience, s, 1, [`parity page ${c}`], ['']]);
          tally[`servable=${servable} put=${put}`] = (tally[`servable=${servable} put=${put}`] ?? 0) + 1;
          if ((put === 'ok') !== servable || (put !== 'ok' && put !== '55000'))
            mismatches.push(`seed=${SEED} config=${JSON.stringify(config)} audience=${audience} subject=${describeSpec(subject.spec)} servable=${servable} put=${put}`);
          if (c === configs.length - 1 && !servable && subject.spec.kind === 'item' && subject.spec.name.startsWith('passage not carried')) witnessed.push({ subject, audience });
        }
      }
    }
    const states = Object.values(tally).reduce((sum, count) => sum + count, 0);
    expect(mismatches.slice(0, 20), `${mismatches.length} of ${states} states differ`).toEqual([]);
    expect(states).toBeGreaterThanOrEqual(1000);
    expect(tally['servable=true put=ok']).toBeGreaterThan(100);
    expect(tally['servable=false put=55000']).toBeGreaterThan(100);

    // The passage-mark answer is the version's own current ledger row, for this tenant and audience: no other row will do.
    expect(witnessed.length).toBeGreaterThan(0);
    for (const { subject, audience } of witnessed) {
      const versionId = subject.versionId as string;
      const s = sha(`${subject.fileId}:${audience}:decoy`);
      const decoys: Array<[string, () => Promise<unknown>]> = [
        ['a closed row that gave the item', async () => {
          await owner.query(`SELECT publication_ledger_record('content_version', $1, $2, $3, '{"v":1}', 0)`, [versionId, audience, sha('given')]);
          await owner.query(`SELECT publication_ledger_record('content_version', $1, $2, NULL, '{"v":1}', 0)`, [versionId, audience]);
        }],
        ['the other audience\'s row', () => owner.query(`SELECT publication_ledger_record('content_version', $1, $2, $3, '{"v":1}', 0)`, [versionId, audience === 'public' ? 'members' : 'public', sha('other')])],
        ['a file row with the version\'s id', () => owner.query(`SELECT publication_ledger_record('stored_file', $1, $2, $3, $4, 0)`, [versionId, audience, sha('kind'), COPY])],
        ['another tenant\'s row', () =>
          owner.query(
            `INSERT INTO publication_ledger (seq, tenant_id, subject_kind, subject_id, audience, output_sha256, inputs, passages_withheld, current_from, prev_hash, row_hash)
             VALUES (9000000000000001, 'other-group', 'content_version', $1, $2, $3, '{"v":1}', 0, now(), $4, $5)`,
            [versionId, audience, sha('tenant'), sha('prev'), sha(`row-${versionId}`)],
          )],
      ];
      for (const [why, decoy] of decoys) {
        await owner.query('BEGIN');
        try {
          await owner.query(`SELECT publication_ledger_record('stored_file', $1, $2, $3, $4, 0)`, [subject.fileId, audience, s, COPY]);
          await decoy();
          const put = await outcome(owner, PUT, [subject.fileId, audience, s, 1, ['decoy page'], ['']]);
          if (put !== '55000') mismatches.push(`decoy "${why}": subject=${describeSpec(subject.spec)} audience=${audience} servable=false put=${put}`);
        } finally {
          await owner.query('ROLLBACK');
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});

function sha256Of(bytes: Buffer): Buffer {
  return createHash('sha256').update(bytes).digest();
}
