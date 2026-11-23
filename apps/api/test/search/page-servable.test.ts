// ARCHIVE-SEARCH S1 fix 1 (challenge M1): the page writer stores only text its audience may open,
// and the rows go, in the change's own transaction, when the audience may open it no longer.
// P1a, P1b, P1c and P1e are the challenger's probes, kept as tests; R1a and R1b (fix 2) are the recheck's,
// for an item posted on behalf of a member. Synthetic data only.
import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentService } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { servableFile } from '../../src/content/files.js';
import { recordItems } from '../../src/ledger/ledger.js';
import { ENGINE_VERSION, inputsFor } from '../../src/pdf/store.js';
import { type Api, as, insertId, startApi } from '../helpers/api.js';
import { paragraph, publishItem, text } from '../helpers/content.js';
import { WORKER, WORKER_PW, live, url, urlFor } from '../helpers/pg.js';

const PUT = `SELECT search_page_put($1, $2, $3, $4, $5::text[], $6::text[]) AS pages`;
const COPY = { v: 1, served: 'copy' };
const sha256 = (bytes: Buffer): Buffer => createHash('sha256').update(bytes).digest();
const sha = (seed: string): Buffer => sha256(Buffer.from(seed));
const PUB = as('pub-token');
const WEBMASTER = as('webmaster-token');
const TREASURER = as('treasurer-token');

describe.skipIf(!live)('search_page_put: only a file the audience may open, and its rows gone when that stops', () => {
  let api: Api;
  let owner: pg.Client;
  let other: pg.Client;
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
  const pid = async (client: pg.Client): Promise<number> => (await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
  const blocked = async (backend: number): Promise<void> => {
    for (let tries = 0; tries < 200; tries++) {
      const { rows } = await owner.query<{ wait: string | null }>(`SELECT wait_event_type AS wait FROM pg_stat_activity WHERE pid = $1`, [backend]);
      if (rows[0]?.wait === 'Lock') return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect.fail('the second connection was never blocked on a lock');
  };
  /** A published item with one public PDF, attached before approval, and its stored original. */
  const seeded = async (
    title: string,
    visibility: 'public' | 'members' | 'officers' = 'public',
    onBehalfOf?: string,
  ): Promise<{ itemId: string; versionId: string; fileId: string }> => {
    const k = ++n;
    const bytes = Buffer.from(`synthetic servable pdf ${k}`);
    const made = await publishItem(api.pool, {
      slug: `servable-${k}`,
      officeId: office,
      title,
      visibility,
      body: { blocks: [paragraph(text(`${title}.`))] },
      files: [{ objectKey: `servable-${k}.pdf`, audience: 'public', bytes }],
      ...(onBehalfOf === undefined ? {} : { onBehalfOf }),
    });
    const fileId = (await api.pool.query<{ id: string }>(`SELECT id FROM stored_file WHERE version_id = $1`, [made.versionId])).rows[0]!.id;
    await owner.query(`SELECT pdf_original_put($1, $2, 'sub-author', ARRAY['nwfl-officers'], NULL)`, [fileId, bytes]);
    return { ...made, fileId };
  };
  /** A ready copy for the audience's CURRENT inputs, as the worker would make; returns its sha. */
  const copyFor = async (fileId: string, audience: 'public' | 'members'): Promise<Buffer> => {
    const inputs = await inputsFor(api.pool, fileId, audience);
    expect(inputs?.kind, `${audience} inputs`).toBe('copy');
    const bytes = Buffer.from(`synthetic ${audience} copy of ${fileId}`);
    await owner.query(`INSERT INTO pdf_copy (file_id, input_hash, engine, status, bytes) VALUES ($1, $2, $3, 'ready', $4)`, [
      fileId,
      (inputs as { hash: Buffer }).hash,
      ENGINE_VERSION,
      bytes,
    ]);
    return sha256(bytes);
  };
  const ledgerFile = async (fileId: string, audience: string): Promise<{ output: Buffer | null; served: string } | undefined> =>
    (
      await owner.query<{ output: Buffer | null; served: string }>(
        `SELECT output_sha256 AS output, inputs->>'served' AS served FROM publication_ledger
          WHERE subject_kind = 'stored_file' AND subject_id = $1 AND audience = $2 AND current_to IS NULL`,
        [fileId, audience],
      )
    ).rows[0];
  /** The ledger says the audience is served a copy with this sha, as the worker's own append would. */
  const serve = (fileId: string, audience: string, output: Buffer, client: pg.Client = owner) =>
    client.query(`SELECT publication_ledger_record('stored_file', $1, $2, $3, $4, 0)`, [fileId, audience, output, COPY]);
  const rows = async (table: string, fileId: string): Promise<string[]> =>
    (await owner.query<{ text: string }>(`SELECT text FROM ${table} WHERE file_id = $1 ORDER BY page`, [fileId])).rows.map((row) => row.text);
  /** Both audiences hold a page for the file. */
  const indexBoth = async (fileId: string): Promise<void> => {
    await serve(fileId, 'public', sha(`p-${fileId}`));
    await serve(fileId, 'members', sha(`m-${fileId}`));
    expect(await outcome(worker, PUT, [fileId, 'public', sha(`p-${fileId}`), 1, ['public page'], ['']])).toBe('ok');
    expect(await outcome(worker, PUT, [fileId, 'members', sha(`m-${fileId}`), 1, ['members page'], ['']])).toBe('ok');
  };
  const both = async (fileId: string): Promise<string[]> => [...(await rows('search_page_public', fileId)), ...(await rows('search_page_members', fileId))];
  const edition = async (slug: string, status: string): Promise<{ editionId: string; fileId: string }> => {
    const editionId = await insertId(
      api.pool,
      `INSERT INTO edition (slug, title, kind, period_start, period_end, status) VALUES ($1, 'November 2026', 'regular', '2026-11-01', '2026-11-30', $2) RETURNING id`,
      [slug, status],
    );
    const bytes = Buffer.from(`synthetic issue ${slug}`);
    const fileId = await insertId(
      api.pool,
      `INSERT INTO stored_file (edition_id, object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ($1, $2, 'issue.pdf', 'application/pdf', $3, sha256($4), 'public') RETURNING id`,
      [editionId, `issue-${slug}`, bytes.length, bytes],
    );
    return { editionId, fileId };
  };

  beforeAll(async () => {
    api = await startApi('nwfl_searchservable');
    office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
    const database = (await api.pool.query<{ db: string }>(`SELECT current_database() AS db`)).rows[0]!.db;
    const password = new URL(url as string).password;
    owner = await connect(urlFor('postgres', password, database));
    other = await connect(urlFor('postgres', password, database));
    worker = await connect(urlFor(WORKER, WORKER_PW, database));
  });

  afterAll(async () => {
    for (const client of [owner, other, worker]) await client?.end();
    await api?.close();
  });

  describe('the put refuses a file the audience may not open, though the ledger says a copy is served (55000)', () => {
    it('P1a: an officers-only item\'s PDF, for the public and for members', async () => {
      const item = await seeded('Board minutes', 'officers');
      const s = await copyFor(item.fileId, 'public');
      await recordItems(api.pool, [item.itemId]);
      expect(await ledgerFile(item.fileId, 'public')).toEqual({ output: s, served: 'copy' });
      expect(await servableFile(api.pool, item.fileId, 'public')).toBeNull();
      expect(await outcome(worker, PUT, [item.fileId, 'public', s, 1, ['board vote on the zarquonite budget'], ['']])).toBe('55000');
      await serve(item.fileId, 'members', sha('officers-members'));
      expect(await outcome(worker, PUT, [item.fileId, 'members', sha('officers-members'), 1, ['board vote, members'], ['']])).toBe('55000');
      expect(await both(item.fileId)).toEqual([]);
    });

    it('P1b: a never-published draft\'s PDF', async () => {
      const itemId = await insertId(api.pool, `INSERT INTO content_item (slug, kind, office_id) VALUES ('servable-draft', 'article', $1) RETURNING id`, [office]);
      const versionId = await insertId(
        api.pool,
        `INSERT INTO content_version (item_id, n, title, visibility, body_ast, created_by_sub, acting_office_id) VALUES ($1, 1, 'Draft', 'public', $2, 'sub-author', $3) RETURNING id`,
        [itemId, JSON.stringify({ blocks: [paragraph(text('Draft.'))] }), office],
      );
      const bytes = Buffer.from('synthetic draft pdf');
      const fileId = await insertId(
        api.pool,
        `INSERT INTO stored_file (version_id, object_key, filename, mime_type, size_bytes, sha256, audience, role) VALUES ($1, 'draft.pdf', 'draft.pdf', 'application/pdf', $2, sha256($3), 'public', 'primary') RETURNING id`,
        [versionId, bytes.length, bytes],
      );
      await owner.query(`SELECT pdf_original_put($1, $2, 'sub-author', ARRAY['nwfl-officers'], NULL)`, [fileId, bytes]);
      const s = await copyFor(fileId, 'public');
      await recordItems(api.pool, [itemId]);
      expect((await ledgerFile(fileId, 'public'))?.served).toBe('copy');
      expect(await outcome(worker, PUT, [fileId, 'public', s, 1, ['draft only: the vorpalite rumour'], ['']])).toBe('55000');
      expect(await rows('search_page_public', fileId)).toEqual([]);
    });

    it('a PDF of an edition not yet published; a published edition\'s is put', async () => {
      const proof = await edition('2026-11', 'proof');
      await serve(proof.fileId, 'public', sha('proof'));
      expect(await outcome(worker, PUT, [proof.fileId, 'public', sha('proof'), 1, ['proof issue'], ['']])).toBe('55000');
      const published = await edition('2026-12', 'published');
      await serve(published.fileId, 'public', sha('issue'));
      expect(await outcome(worker, PUT, [published.fileId, 'public', sha('issue'), 1, ['the issue'], ['']])).toBe('ok');
      expect(await rows('search_page_public', proof.fileId)).toEqual([]);
      expect(await rows('search_page_public', published.fileId)).toEqual(['the issue']);
    });

    it('a file that is not a PDF', async () => {
      const made = await publishItem(api.pool, {
        slug: 'servable-png',
        officeId: office,
        title: 'A picture',
        body: { blocks: [paragraph(text('A picture.'))] },
        files: [{ objectKey: 'servable.png', audience: 'public', mimeType: 'image/png', bytes: Buffer.from('synthetic png') }],
      });
      const fileId = (await api.pool.query<{ id: string }>(`SELECT id FROM stored_file WHERE version_id = $1`, [made.versionId])).rows[0]!.id;
      await serve(fileId, 'public', sha('png'));
      expect(await outcome(worker, PUT, [fileId, 'public', sha('png'), 1, ['picture words'], ['']])).toBe('55000');
    });
  });

  describe('a change that stops the audience opening the file deletes both audiences\' rows, in its transaction', () => {
    it('P1c: a withdrawal: the rows go, and a put after it is refused', async () => {
      const content = api.client(ContentService);
      const item = await seeded('Quiz night');
      const s = await copyFor(item.fileId, 'public');
      await recordItems(api.pool, [item.itemId]);
      expect(await outcome(worker, PUT, [item.fileId, 'public', s, 1, ['quiz answers: xylocarp'], ['']])).toBe('ok');
      await serve(item.fileId, 'members', sha('quiz-members'));
      expect(await outcome(worker, PUT, [item.fileId, 'members', sha('quiz-members'), 1, ['quiz, members'], ['']])).toBe('ok');
      // As the app role does it: the trigger, a definer, deletes rows the app may not touch.
      expect(await content.withdraw({ itemId: item.itemId }, WEBMASTER).then(() => 'ok', (error: unknown) => String(error))).toBe('ok');
      expect(await servableFile(api.pool, item.fileId, 'public')).toBeNull();
      expect(await both(item.fileId)).toEqual([]);
      const led = await ledgerFile(item.fileId, 'public');
      expect(await outcome(worker, PUT, [item.fileId, 'public', led?.output ?? s, 1, ['quiz answers: xylocarp, again'], ['']])).toBe('55000');
      expect(await both(item.fileId)).toEqual([]);
    });

    it('P1e: a new version published: the superseded version\'s rows go, and a put for its file is refused', async () => {
      const content = api.client(ContentService);
      const item = await seeded('Bulletin');
      const s = await copyFor(item.fileId, 'public');
      await recordItems(api.pool, [item.itemId]);
      expect(await outcome(worker, PUT, [item.fileId, 'public', s, 1, ['retracted bulletin: wibblequartz'], ['']])).toBe('ok');
      await content.saveDraft({ itemId: item.itemId, title: 'Bulletin', bodyMarkup: 'Second bulletin, the first was retracted.' }, PUB);
      const hash = (await content.markReady({ itemId: item.itemId, targets: { website: true, newsletter: false, email: false } }, PUB)).item?.working?.contentHash as Uint8Array;
      await content.approve({ itemId: item.itemId, contentHash: hash }, TREASURER);
      const v2 = (await content.publish({ itemId: item.itemId, contentHash: hash }, WEBMASTER)).item?.live?.id;
      expect(v2).not.toBe(item.versionId);
      expect(await servableFile(api.pool, item.fileId, 'public')).toBeNull();
      expect(await rows('search_page_public', item.fileId)).toEqual([]);
      const led = await ledgerFile(item.fileId, 'public');
      expect(await outcome(worker, PUT, [item.fileId, 'public', led?.output ?? s, 1, ['retracted bulletin: wibblequartz'], ['']])).toBe('55000');
    });

    it('an edition leaving published (the forward-only guard set aside, as nothing else allows it)', async () => {
      const issue = await edition('2027-01', 'published');
      await indexBoth(issue.fileId);
      await owner.query('BEGIN');
      try {
        await owner.query(`ALTER TABLE edition DISABLE TRIGGER edition_status_forward`);
        await owner.query(`UPDATE edition SET title = 'Retitled' WHERE id = $1`, [issue.editionId]);
        expect(await both(issue.fileId)).toHaveLength(2);
        await owner.query(`UPDATE edition SET status = 'proof' WHERE id = $1`, [issue.editionId]);
        expect(await both(issue.fileId)).toEqual([]);
      } finally {
        await owner.query('ROLLBACK');
      }
      expect(await both(issue.fileId)).toHaveLength(2);
    });

    it('a version\'s visibility changing (the freeze set aside, as nothing else allows it on a live version)', async () => {
      const item = await seeded('Open notice');
      await indexBoth(item.fileId);
      await owner.query('BEGIN');
      try {
        await owner.query(`ALTER TABLE content_version DISABLE TRIGGER content_version_freeze`);
        await owner.query(`UPDATE content_version SET summary = 'Unchanged visibility' WHERE id = $1`, [item.versionId]);
        expect(await both(item.fileId)).toHaveLength(2);
        await owner.query(`UPDATE content_version SET visibility = 'members' WHERE id = $1`, [item.versionId]);
        expect(await both(item.fileId)).toEqual([]);
      } finally {
        await owner.query('ROLLBACK');
      }
      expect(await both(item.fileId)).toHaveLength(2);
    });

    it('keeps the rows through an item change that leaves it served: a new slug, with state and live version set unchanged', async () => {
      const item = await seeded('Renamed notice');
      await indexBoth(item.fileId);
      await owner.query(`UPDATE content_item SET slug = $2, state = state, live_version_id = live_version_id WHERE id = $1`, [item.itemId, `renamed-${item.itemId.slice(0, 8)}`]);
      expect(await both(item.fileId)).toHaveLength(2);
    });

    it('a withdrawal that arrives while a put holds the file waits, then deletes what the put wrote', async () => {
      const item = await seeded('Race withdraw');
      await serve(item.fileId, 'public', sha('race-w'));
      const otherPid = await pid(other);
      await worker.query('BEGIN');
      await worker.query(PUT, [item.fileId, 'public', sha('race-w'), 1, ['the page'], ['']]);
      const change = outcome(other, `UPDATE content_item SET state = 'withdrawn', withdrawn_at = now() WHERE id = $1`, [item.itemId]);
      await blocked(otherPid);
      await worker.query('COMMIT');
      expect(await change).toBe('ok');
      expect(await rows('search_page_public', item.fileId)).toEqual([]);
    });

    it('a put that arrives while a withdrawal holds the file waits, then is refused', async () => {
      const item = await seeded('Race put');
      await serve(item.fileId, 'public', sha('race-p'));
      const workerPid = await pid(worker);
      await other.query('BEGIN');
      await other.query(`UPDATE content_item SET state = 'withdrawn', withdrawn_at = now() WHERE id = $1`, [item.itemId]);
      const put = outcome(worker, PUT, [item.fileId, 'public', sha('race-p'), 1, ['the page'], ['']]);
      await blocked(workerPid);
      await other.query('COMMIT');
      expect(await put).toBe('55000');
      expect(await rows('search_page_public', item.fileId)).toEqual([]);
    });
  });

  // Last: these change the policy, and put it back.
  describe('an item posted on behalf of a member, which servableFile hides when the audience\'s member_name is hide (redact.ts itemHidden)', () => {
    const setCell = (audience: string, action: string) =>
      owner.query(`UPDATE redaction_policy SET action = $2 WHERE tenant_id = 'nwflorida' AND audience = $1 AND category = 'member_name'`, [audience, action]);
    const cellNow = async (audience: string): Promise<string | undefined> =>
      (
        await owner.query<{ action: string }>(`SELECT action FROM redaction_policy WHERE tenant_id = 'nwflorida' AND audience = $1 AND category = 'member_name'`, [
          audience,
        ])
      ).rows[0]?.action;
    /** Runs `body` with the cells set so, then puts each back as it was. */
    const withCells = async (cells: Record<string, string>, body: () => Promise<void>): Promise<void> => {
      const before = new Map<string, string | undefined>();
      for (const audience of Object.keys(cells)) before.set(audience, await cellNow(audience));
      try {
        for (const [audience, action] of Object.entries(cells)) await setCell(audience, action);
        await body();
      } finally {
        for (const [audience, action] of before) await setCell(audience, action as string);
      }
    };

    it('R1a: the public\'s member_name at hide: the public\'s put is refused, though the ledger says a copy is served; members\' is put', async () => {
      await withCells({ public: 'hide', members: 'show' }, async () => {
        const item = await seeded('Picnic hosted for a member', 'public', 'Avery Quill');
        const s = await copyFor(item.fileId, 'public');
        await recordItems(api.pool, [item.itemId]);
        expect(await ledgerFile(item.fileId, 'public')).toEqual({ output: s, served: 'copy' });
        expect(await servableFile(api.pool, item.fileId, 'public')).toBeNull();
        expect(await outcome(worker, PUT, [item.fileId, 'public', s, 1, ['picnic at the home of Avery Quill, gate code zorbleflax'], ['']])).toBe('55000');
        expect(await rows('search_page_public', item.fileId)).toEqual([]);
        expect(await servableFile(api.pool, item.fileId, 'members')).not.toBeNull();
        await serve(item.fileId, 'members', sha('picnic-members'));
        expect(await outcome(worker, PUT, [item.fileId, 'members', sha('picnic-members'), 1, ['picnic, members'], ['']])).toBe('ok');
        expect(await rows('search_page_members', item.fileId)).toEqual(['picnic, members']);
      });
    });

    it('R1b: already indexed, then the public\'s member_name set to hide: the change deletes the rows, and a put of the new copy is refused', async () => {
      const item = await seeded('Potluck hosted for a member', 'public', 'Blake Zephyr');
      const s = await copyFor(item.fileId, 'public');
      await recordItems(api.pool, [item.itemId]);
      expect(await outcome(worker, PUT, [item.fileId, 'public', s, 1, ['potluck at the home of Blake Zephyr'], ['']])).toBe('ok');
      await withCells({ public: 'hide' }, async () => {
        expect(await servableFile(api.pool, item.fileId, 'public')).toBeNull();
        expect(await rows('search_page_public', item.fileId)).toEqual([]);
        await serve(item.fileId, 'public', sha('potluck-new-copy'));
        expect(await outcome(worker, PUT, [item.fileId, 'public', sha('potluck-new-copy'), 1, ['potluck at the home of Blake Zephyr, again'], ['']])).toBe('55000');
        expect(await rows('search_page_public', item.fileId)).toEqual([]);
      });
    });

    it('the members\' member_name at hide and the public\'s at show: only the members\' put is refused', async () => {
      await withCells({ public: 'show', members: 'hide' }, async () => {
        const item = await seeded('Garden tour hosted for a member', 'public', 'Casey Thornwick');
        await serve(item.fileId, 'members', sha('garden-members'));
        await serve(item.fileId, 'public', sha('garden-public'));
        expect(await servableFile(api.pool, item.fileId, 'members')).toBeNull();
        expect(await outcome(worker, PUT, [item.fileId, 'members', sha('garden-members'), 1, ['garden tour, members'], ['']])).toBe('55000');
        expect(await servableFile(api.pool, item.fileId, 'public')).not.toBeNull();
        expect(await outcome(worker, PUT, [item.fileId, 'public', sha('garden-public'), 1, ['garden tour'], ['']])).toBe('ok');
        expect(await both(item.fileId)).toEqual(['garden tour']);
      });
    });

    it('a missing member_name cell reads as hide, as resolveAction reads it', async () => {
      const item = await seeded('Book swap hosted for a member', 'public', 'Dana Ferrowick');
      await serve(item.fileId, 'public', sha('swap-public'));
      const before = await cellNow('public');
      await owner.query(`DELETE FROM redaction_policy WHERE tenant_id = 'nwflorida' AND audience = 'public' AND category = 'member_name'`);
      try {
        expect(await servableFile(api.pool, item.fileId, 'public')).toBeNull();
        expect(await outcome(worker, PUT, [item.fileId, 'public', sha('swap-public'), 1, ['book swap at the home of Dana Ferrowick'], ['']])).toBe('55000');
        expect(await rows('search_page_public', item.fileId)).toEqual([]);
      } finally {
        await owner.query(`INSERT INTO redaction_policy (tenant_id, audience, category, action) VALUES ('nwflorida', 'public', 'member_name', $1)`, [before]);
      }
    });

    it('is put at redact (the name withheld, the item kept), and at hide for an item posted on behalf of no one', async () => {
      await withCells({ public: 'redact' }, async () => {
        const item = await seeded('Hike hosted for a member', 'public', 'Emery Valcourt');
        await serve(item.fileId, 'public', sha('hike-public'));
        expect(await servableFile(api.pool, item.fileId, 'public')).not.toBeNull();
        expect(await outcome(worker, PUT, [item.fileId, 'public', sha('hike-public'), 1, ['hike, the name withheld'], ['']])).toBe('ok');
      });
      await withCells({ public: 'hide' }, async () => {
        const item = await seeded('Club picnic');
        await serve(item.fileId, 'public', sha('club-public'));
        expect(await servableFile(api.pool, item.fileId, 'public')).not.toBeNull();
        expect(await outcome(worker, PUT, [item.fileId, 'public', sha('club-public'), 1, ['club picnic'], ['']])).toBe('ok');
        expect(await rows('search_page_public', item.fileId)).toEqual(['club picnic']);
      });
    });
  });
});
