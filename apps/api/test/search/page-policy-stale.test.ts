// ARCHIVE-SEARCH S1 fix 4: search_file_servable's passage-mark answer is the version's ledger row (fix 3), which the
// app re-records with every mark and policy change made through the API. A policy cell written OUTSIDE the API (as
// 0022 wrote its change) re-records nothing: the row would still say "output" for an audience the item is now hidden
// from, and once the worker regenerated the copy, the put would index it. A trigger on redaction_policy makes the row
// count only once the app has re-recorded the version since (version_rerecorded): until then the put refuses.
// B1a and B3b are the recheck's probes, kept as tests. Synthetic data only.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MarkField, MarkSubjectKind, RedactionAction, RedactionAudience, RedactionCategory, RedactionPolicyService } from '../../src/gen/nwfl/mensa/v1/redaction_pb.js';
import { servableFile } from '../../src/content/files.js';
import { recordItems, renderFile, renderVersion } from '../../src/ledger/ledger.js';
import { backfillItems } from '../../src/search/backfill.js';
import { ENGINE_VERSION, inputsFor } from '../../src/pdf/store.js';
import { type Api, OFFICER, insertId, startApi } from '../helpers/api.js';
import { paragraph, publishItem, text } from '../helpers/content.js';
import { WORKER, WORKER_PW, live, url, urlFor } from '../helpers/pg.js';

const PUT = `SELECT search_page_put($1, $2, $3, $4, $5::text[], $6::text[]) AS pages`;
type Aud = 'public' | 'members';
interface Attempt {
  put: string;
  served: string | undefined;
  servable: boolean;
  rows: string[];
}

describe.skipIf(!live)('a policy cell written outside the API: the put refuses a passage-marked item until the app re-records it', () => {
  let api: Api;
  let owner: pg.Client;
  let holder: pg.Client;
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
  const seeded = async (title: string): Promise<{ itemId: string; versionId: string; fileId: string }> => {
    const k = ++n;
    const bytes = Buffer.from(`synthetic stale pdf ${k}`);
    const made = await publishItem(api.pool, {
      slug: `stale-${k}`,
      officeId: office,
      title,
      body: { blocks: [paragraph(text(`${title}, at the marsh.`))] },
      files: [{ objectKey: `stale-${k}.pdf`, audience: 'public', bytes }],
    });
    const fileId = (await api.pool.query<{ id: string }>(`SELECT id FROM stored_file WHERE version_id = $1`, [made.versionId])).rows[0]!.id;
    await owner.query(`SELECT pdf_original_put($1, $2, 'sub-author', ARRAY['nwfl-officers'], NULL)`, [fileId, bytes]);
    return { ...made, fileId };
  };
  /** The copy the audience's current inputs call for, as the worker makes it (one per inputs: audiences may share it). */
  const copyFor = async (fileId: string, audience: Aud): Promise<void> => {
    const inputs = await inputsFor(api.pool, fileId, audience);
    if (inputs?.kind !== 'copy') return;
    await owner.query(`INSERT INTO pdf_copy (file_id, input_hash, engine, status, bytes) VALUES ($1, $2, $3, 'ready', $4) ON CONFLICT DO NOTHING`, [
      fileId,
      inputs.hash,
      ENGINE_VERSION,
      Buffer.from(`synthetic ${audience} copy of ${fileId} ${++n}`),
    ]);
  };
  /** The regeneration worker's append for a file (ledger.ts recordClaimedFile, without the claim): the file's rows only. */
  const workerRecordsFile = async (fileId: string): Promise<void> => {
    for (const audience of ['public', 'members', 'officers'] as const) {
      const rendering = await renderFile(api.pool, fileId, audience);
      await owner.query(`SELECT publication_ledger_record('stored_file', $1, $2, $3, $4, $5)`, [fileId, audience, rendering.output, rendering.inputs, rendering.withheld]);
    }
  };
  const rows = async (audience: Aud, fileId: string): Promise<string[]> =>
    (await owner.query<{ text: string }>(`SELECT text FROM search_page_${audience} WHERE file_id = $1 ORDER BY page`, [fileId])).rows.map((row) => row.text);
  /** A put as the worker makes it, of the copy the ledger now names for the audience; and what servableFile says. */
  const attempt = async (fileId: string, audience: Aud, page: string): Promise<Attempt> => {
    const led = (
      await owner.query<{ output: Buffer | null; served: string }>(
        `SELECT output_sha256 AS output, inputs->>'served' AS served FROM publication_ledger
          WHERE subject_kind = 'stored_file' AND subject_id = $1 AND audience = $2 AND current_to IS NULL`,
        [fileId, audience],
      )
    ).rows[0];
    const put = led?.output ? await outcome(worker, PUT, [fileId, audience, led.output, 1, [page], ['']]) : 'no-ledger-output';
    return { put, served: led?.served, servable: (await servableFile(api.pool, fileId, audience)) !== null, rows: await rows(audience, fileId) };
  };
  const versionRow = async (versionId: string, audience: Aud): Promise<string> => {
    const row = (
      await owner.query<{ out: Buffer | null }>(
        `SELECT output_sha256 AS out FROM publication_ledger WHERE subject_kind = 'content_version' AND subject_id = $1 AND audience = $2 AND current_to IS NULL`,
        [versionId, audience],
      )
    ).rows[0];
    return row === undefined ? 'no-row' : row.out === null ? 'null' : 'output';
  };
  const mark = (itemId: string, quote: string, field = MarkField.BODY) =>
    api
      .client(RedactionPolicyService)
      .addRedactionMark({ subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: itemId, field, quote, category: RedactionCategory.MEMBER_PHONE }, OFFICER);
  const cell = async (audience: string, category: string): Promise<string | undefined> =>
    (await owner.query<{ action: string }>(`SELECT action FROM redaction_policy WHERE tenant_id = 'nwflorida' AND audience = $1 AND category = $2`, [audience, category]))
      .rows[0]?.action;
  /** As 0022 wrote its change: the cell set in SQL, no re-record. */
  const setCell = (audience: string, category: string, action: string) =>
    owner.query(`UPDATE redaction_policy SET action = $3 WHERE tenant_id = 'nwflorida' AND audience = $1 AND category = $2`, [audience, category, action]);
  const withCells = async (cells: Array<[string, string, string]>, body: () => Promise<void>): Promise<void> => {
    const before: Array<[string, string, string | undefined]> = [];
    for (const [audience, category] of cells) before.push([audience, category, await cell(audience, category)]);
    try {
      for (const [audience, category, action] of cells) await setCell(audience, category, action);
      await body();
    } finally {
      for (const [audience, category, action] of before) await setCell(audience, category, action as string);
    }
  };
  /** An item indexed for the public while member_phone shows, with a body mark carrying `quote`. */
  const indexedUnderShow = async (title: string, quote: string): Promise<{ itemId: string; versionId: string; fileId: string }> => {
    const item = await seeded(title);
    await mark(item.itemId, quote);
    await copyFor(item.fileId, 'public');
    await recordItems(api.pool, [item.itemId]);
    expect(await versionRow(item.versionId, 'public')).toBe('output');
    expect((await attempt(item.fileId, 'public', `${title} indexed`)).put).toBe('ok');
    return item;
  };
  /** After a policy change: the worker regenerates the copy and re-records the file (only the file). */
  const regenerated = async (fileId: string, page: string): Promise<Attempt> => {
    await copyFor(fileId, 'public');
    await workerRecordsFile(fileId);
    return attempt(fileId, 'public', page);
  };

  const pid = async (client: pg.ClientBase): Promise<number> => (await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
  /**
   * Waits until `work` settles or the backend `backend` waits on a lock, whichever comes first, and says which. No
   * sleep decides it: each arm ends the wait as soon as it holds.
   */
  const settledOrBlocked = async (work: Promise<unknown>, backend: number): Promise<'settled' | 'blocked'> => {
    let settled = false;
    work.then(
      () => (settled = true),
      () => (settled = true),
    );
    for (;;) {
      if (settled) return 'settled';
      const { rows: found } = await owner.query<{ wait: string | null }>(`SELECT wait_event_type AS wait FROM pg_stat_activity WHERE pid = $1`, [backend]);
      if (found[0]?.wait === 'Lock') return 'blocked';
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const RAW_TIGHTEN = `UPDATE redaction_policy SET action = 'redact' WHERE tenant_id = 'nwflorida' AND audience = 'public' AND category = 'member_phone'`;

  beforeAll(async () => {
    api = await startApi('nwfl_searchstale');
    office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
    const database = (await api.pool.query<{ db: string }>(`SELECT current_database() AS db`)).rows[0]!.db;
    owner = await connect(urlFor('postgres', new URL(url as string).password, database));
    holder = await connect(urlFor('postgres', new URL(url as string).password, database));
    worker = await connect(urlFor(WORKER, WORKER_PW, database));
  });

  afterAll(async () => {
    for (const client of [owner, holder, worker]) await client?.end();
    await api?.close();
  });

  it('B1a: indexed, then a TITLE mark the version does not carry (public redacts, members show): the public refused, members put', async () => {
    await withCells(
      [
        ['public', 'member_phone', 'redact'],
        ['members', 'member_phone', 'show'],
        // A redacting cell in each audience, so each is served a copy.
        ['public', 'member_email', 'redact'],
        ['members', 'member_email', 'redact'],
      ],
      async () => {
        const item = await seeded('Harbor cleanup');
        for (const audience of ['public', 'members'] as const) await copyFor(item.fileId, audience);
        await recordItems(api.pool, [item.itemId]);
        expect((await attempt(item.fileId, 'public', 'harbor cleanup public')).put).toBe('ok');
        await mark(item.itemId, 'Wren Halloway 850-555-0163', MarkField.TITLE);
        expect({ public: await versionRow(item.versionId, 'public'), members: await versionRow(item.versionId, 'members') }).toEqual({ public: 'null', members: 'output' });
        for (const audience of ['public', 'members'] as const) await copyFor(item.fileId, audience);
        await recordItems(api.pool, [item.itemId]);
        expect(await attempt(item.fileId, 'public', 'harbor cleanup public again')).toEqual({ put: '55000', served: 'copy', servable: false, rows: [] });
        expect(await attempt(item.fileId, 'members', 'harbor cleanup members again')).toMatchObject({ put: 'ok', servable: true });
      },
    );
  });

  it('B3b: member_phone show to redact in SQL, a body mark not carried: the regenerated copy is refused, and still after the app re-records', async () => {
    await withCells(
      [
        ['public', 'member_phone', 'show'],
        ['public', 'member_email', 'redact'],
      ],
      async () => {
      const item = await indexedUnderShow('Bird walk', 'Quinn Ellery 850-555-0127');
      await setCell('public', 'member_phone', 'redact');
      expect(await rows('public', item.fileId)).toEqual([]);
      // The version's row still says "output": nothing re-recorded it.
      expect(await versionRow(item.versionId, 'public')).toBe('output');
      expect(await regenerated(item.fileId, 'bird walk regenerated')).toEqual({ put: '55000', served: 'copy', servable: false, rows: [] });
      await recordItems(api.pool, [item.itemId]);
      expect(await versionRow(item.versionId, 'public')).toBe('null');
      expect(await attempt(item.fileId, 'public', 'bird walk re-recorded')).toEqual({ put: '55000', served: 'copy', servable: false, rows: [] });
    });
  });

  it('B3b: the same change with the quote carried: refused (fail closed) until the app re-records THIS version, then put', async () => {
    await withCells(
      [
        ['public', 'member_phone', 'show'],
        ['public', 'member_email', 'redact'],
      ],
      async () => {
      const item = await indexedUnderShow('Heron count', 'Heron count');
      const sibling = await seeded('Egret count');
      await setCell('public', 'member_phone', 'redact');
      expect(await regenerated(item.fileId, 'heron count regenerated')).toMatchObject({ put: '55000', servable: true });
      // Another item re-recorded after the change does not answer for this one.
      await recordItems(api.pool, [sibling.itemId]);
      expect((await attempt(item.fileId, 'public', 'heron count, a sibling re-recorded')).put).toBe('55000');
      // Nor does this version re-recorded for members alone (as the boot backfill puts one audience at a time).
      const members = (
        await owner.query<{ out: Buffer }>(
          `SELECT output_sha256 AS out FROM publication_ledger WHERE subject_kind = 'content_version' AND subject_id = $1 AND audience = 'members' AND current_to IS NULL`,
          [item.versionId],
        )
      ).rows[0]!.out;
      await owner.query(`SELECT search_item_put($1, 'members', $2, 'Heron count', 'Heron count, at the marsh.')`, [item.versionId, members]);
      expect((await attempt(item.fileId, 'public', 'heron count, members re-recorded')).put).toBe('55000');
      await recordItems(api.pool, [item.itemId]);
      expect(await attempt(item.fileId, 'public', 'heron count re-recorded')).toEqual({ put: 'ok', served: 'copy', servable: true, rows: ['heron count re-recorded'] });
    });
  });

  it('B3b: a cell deleted and inserted again in SQL (an upsert, two statements) is a change too', async () => {
    await withCells(
      [
        ['public', 'member_phone', 'show'],
        ['public', 'member_email', 'redact'],
      ],
      async () => {
      const item = await indexedUnderShow('Owl prowl', 'Owl prowl');
      await owner.query(`DELETE FROM redaction_policy WHERE tenant_id = 'nwflorida' AND audience = 'public' AND category = 'member_phone'`);
      await owner.query(`INSERT INTO redaction_policy (tenant_id, audience, category, action) VALUES ('nwflorida', 'public', 'member_phone', 'redact')`);
      expect(await regenerated(item.fileId, 'owl prowl regenerated')).toMatchObject({ put: '55000', servable: true });
      await recordItems(api.pool, [item.itemId]);
      expect((await attempt(item.fileId, 'public', 'owl prowl re-recorded')).put).toBe('ok');
    });
  });

  it('a version the app never re-recorded since 0032 (its row from before, maybe before a change in SQL) is refused until it is', async () => {
    await withCells(
      [
        ['public', 'member_phone', 'redact'],
        ['public', 'member_email', 'redact'],
      ],
      async () => {
        const item = await seeded('Dune hike');
        // The mark and the rows as a version recorded before 0032 has them: no search_item_put has run for it.
        await owner.query(`SELECT redaction_mark_add('content_item', $1, 'body', 'Dune hike', 'member_phone', 'sub-officer', ARRAY['nwfl-officers'], NULL)`, [item.itemId]);
        await copyFor(item.fileId, 'public');
        await workerRecordsFile(item.fileId);
        const version = await renderVersion(api.pool, item.versionId, 'public');
        expect(version.output).not.toBeNull();
        await owner.query(`SELECT publication_ledger_record('content_version', $1, 'public', $2, $3, $4)`, [item.versionId, version.output, version.inputs, version.withheld]);
        expect(await attempt(item.fileId, 'public', 'dune hike, never re-recorded')).toMatchObject({ put: '55000', servable: true });
        await recordItems(api.pool, [item.itemId]);
        expect((await attempt(item.fileId, 'public', 'dune hike re-recorded')).put).toBe('ok');
      },
    );
  });

  it('B3b, the API path: the change re-records in its own transaction, so the put is right at once both ways', async () => {
    await withCells(
      [
        ['public', 'member_phone', 'show'],
        ['public', 'member_email', 'redact'],
      ],
      async () => {
      const hidden = await indexedUnderShow('Moth night', 'Sage Merriweather 850-555-0188');
      const carried = await indexedUnderShow('Frog chorus', 'Frog chorus');
      await api
        .client(RedactionPolicyService)
        .proposeRedactionChange({ audience: RedactionAudience.PUBLIC, category: RedactionCategory.MEMBER_PHONE, action: RedactionAction.REDACT }, OFFICER);
      expect(await cell('public', 'member_phone')).toBe('redact');
      expect(await regenerated(hidden.fileId, 'moth night regenerated')).toEqual({ put: '55000', served: 'copy', servable: false, rows: [] });
      expect(await regenerated(carried.fileId, 'frog chorus regenerated')).toEqual({ put: 'ok', served: 'copy', servable: true, rows: ['frog chorus regenerated'] });
    });
  });

  describe('the two ledger locks a re-record is ordered by (0016): recordItems takes it before it renders, a policy write before it writes', () => {
    it('a policy write in SQL holds (uncommitted) when a re-record starts: the re-record waits, then renders the new policy; the hidden item is refused', async () => {
      await withCells(
        [
          ['public', 'member_phone', 'show'],
          ['public', 'member_email', 'redact'],
        ],
        async () => {
          // One item, so its version is the first subject recorded and the public its first audience: nothing about
          // the order of uuids can let a render run before the lock is taken.
          const item = await indexedUnderShow('Rail survey', 'Morgan Pike 850-555-0149');
          await holder.query('BEGIN');
          const recorder = await api.pool.connect();
          let state: 'settled' | 'blocked' | undefined;
          try {
            await holder.query(RAW_TIGHTEN);
            // Asked before the work starts: a client runs one query at a time.
            const recorderPid = await pid(recorder);
            await recorder.query('BEGIN');
            const record = recordItems(recorder, [item.itemId]);
            // The write holds the ledger lock (its BEFORE trigger), so the re-record's first statement waits on it.
            state = await settledOrBlocked(record, recorderPid);
            await holder.query('COMMIT');
            await record;
            await recorder.query('COMMIT');
          } finally {
            // Never leave the write open for the next test, whatever failed above (a no-op once committed).
            await holder.query('ROLLBACK');
            recorder.release();
          }
          expect(state).toBe('blocked');
          expect(await versionRow(item.versionId, 'public')).toBe('null');
          expect(await regenerated(item.fileId, 'rail survey regenerated')).toEqual({ put: '55000', served: 'copy', servable: false, rows: [] });
        },
      );
    });

    it('a re-record holds (uncommitted, rendered under the old policy) when a policy write in SQL starts: the write waits; the stamp predates it', async () => {
      await withCells(
        [
          ['public', 'member_phone', 'show'],
          ['public', 'member_email', 'redact'],
        ],
        async () => {
          const item = await indexedUnderShow('Fern walk', 'Fern walk');
          const recorder = await api.pool.connect();
          let state: 'settled' | 'blocked' | undefined;
          try {
            const holderPid = await pid(holder);
            await recorder.query('BEGIN');
            await recordItems(recorder, [item.itemId]);
            const write = holder.query(RAW_TIGHTEN);
            state = await settledOrBlocked(write, holderPid);
            await recorder.query('COMMIT');
            await write;
          } finally {
            recorder.release();
          }
          expect(state).toBe('blocked');
          // Recorded under show, before the write: no longer trusted, though the quote is carried.
          expect(await regenerated(item.fileId, 'fern walk regenerated')).toMatchObject({ put: '55000', servable: true });
          await recordItems(api.pool, [item.itemId]);
          expect((await attempt(item.fileId, 'public', 'fern walk re-recorded')).put).toBe('ok');
        },
      );
    });
  });

  describe('the boot backfill re-records what a policy write in SQL left unconfirmed', () => {
    it('after the write the items are refused; the backfill, in batches, brings back exactly those servableFile serves, and a second run has nothing to do', async () => {
      await withCells(
        [
          ['public', 'member_phone', 'show'],
          ['public', 'member_email', 'redact'],
          ['members', 'member_email', 'redact'],
        ],
        async () => {
          const carried = await indexedUnderShow('Crane watch', 'Crane watch');
          const hidden = await indexedUnderShow('Snipe count', 'Jordan Vale 850-555-0152');
          await setCell('public', 'member_phone', 'redact');
          expect(await regenerated(carried.fileId, 'crane watch regenerated')).toMatchObject({ put: '55000', servable: true });
          expect(await regenerated(hidden.fileId, 'snipe count regenerated')).toMatchObject({ put: '55000', servable: false });
          const first = await backfillItems(api.pool, { batch: 1 });
          for (const item of [carried, hidden]) {
            for (const audience of ['public', 'members'] as const) {
              await copyFor(item.fileId, audience);
              await workerRecordsFile(item.fileId);
              const after = await attempt(item.fileId, audience, `${audience} after the backfill`);
              expect(after.put === 'ok', `${audience} ${JSON.stringify(after)}`).toBe(after.servable);
            }
          }
          expect((await attempt(carried.fileId, 'public', 'crane watch back')).put).toBe('ok');
          expect(await attempt(hidden.fileId, 'public', 'snipe count still hidden')).toMatchObject({ put: '55000', servable: false });
          expect(first.rerecorded).toBeGreaterThanOrEqual(2);
          expect((await backfillItems(api.pool, { batch: 1 })).rerecorded).toBe(0);
          // A write in SQL that changes nothing is still a write: refused until the backfill re-records again.
          await owner.query(`UPDATE redaction_policy SET action = action WHERE tenant_id = 'nwflorida' AND audience = 'public' AND category = 'member_address'`);
          expect((await attempt(carried.fileId, 'public', 'crane watch after a no-op write')).put).toBe('55000');
          expect((await backfillItems(api.pool)).rerecorded).toBeGreaterThanOrEqual(1);
          expect((await attempt(carried.fileId, 'public', 'crane watch back again')).put).toBe('ok');
        },
      );
    });

    // S1 recheck 5, N2: the policy write queued every file (pdf_stale_on_policy) and deleted its rows; a worker run
    // that finished BEFORE the backfill restored the stamp had its put refused (55000), and nothing ran it again.
    it('queues again each file of a re-recorded item that its audience may open now but whose copy has no rows; not a hidden one, nor one indexed', async () => {
      await withCells(
        [
          ['public', 'member_phone', 'show'],
          ['public', 'member_email', 'redact'],
          // Members redact phones too, so the item whose quote is not carried is hidden from both audiences. (With
          // members shown phones, members may open it, and its members copy lacking rows is rightly queued.)
          ['members', 'member_phone', 'redact'],
          ['members', 'member_email', 'redact'],
          ['public', 'business_venue', 'show'],
          ['members', 'business_venue', 'show'],
        ],
        async () => {
          const queued = async (fileId: string): Promise<boolean> => (await owner.query(`SELECT 1 FROM pdf_regen WHERE file_id = $1`, [fileId])).rows.length === 1;
          const carried = await indexedUnderShow('Ibis roost', 'Ibis roost');
          const hidden = await indexedUnderShow('Rail survey', 'Morgan Fallow 850-555-0181');
          // Indexed for both audiences and re-recorded by the backfill too, but its mark is shown everywhere: no stamp
          // is needed, so its regenerated copy is put before the backfill and it has its rows.
          const shown = await seeded('Kite festival');
          await api
            .client(RedactionPolicyService)
            .addRedactionMark({ subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: shown.itemId, field: MarkField.BODY, quote: 'Kite festival', category: RedactionCategory.BUSINESS_VENUE }, OFFICER);
          await setCell('public', 'member_phone', 'redact');
          expect(await regenerated(carried.fileId, 'ibis roost regenerated')).toMatchObject({ put: '55000', servable: true });
          expect(await regenerated(hidden.fileId, 'rail survey regenerated')).toMatchObject({ put: '55000', servable: false });
          expect((await attempt(hidden.fileId, 'members', 'rail survey members')).servable).toBe(false);
          for (const audience of ['public', 'members'] as const) await copyFor(shown.fileId, audience);
          await workerRecordsFile(shown.fileId);
          for (const audience of ['public', 'members'] as const) expect((await attempt(shown.fileId, audience, `kite festival ${audience}`)).put).toBe('ok');
          // The worker's runs finished (pdf_regen_finish): nothing of the three is queued.
          const files = [carried.fileId, hidden.fileId, shown.fileId];
          await owner.query(`DELETE FROM pdf_regen WHERE file_id = ANY ($1::uuid[])`, [files]);
          const first = await backfillItems(api.pool, { batch: 1 });
          expect(first.rerecorded).toBeGreaterThanOrEqual(3);
          expect(first.requeued).toBeGreaterThanOrEqual(1);
          expect({ carried: await queued(carried.fileId), hidden: await queued(hidden.fileId), shown: await queued(shown.fileId) }).toEqual({ carried: true, hidden: false, shown: false });
          // The worker's run of the queued file: its copy is put now, and the PDF is back in search.
          expect(await regenerated(carried.fileId, 'ibis roost back')).toMatchObject({ put: 'ok', servable: true, rows: ['ibis roost back'] });
          await owner.query(`DELETE FROM pdf_regen WHERE file_id = ANY ($1::uuid[])`, [files]);
          // Nothing left to re-record, so nothing is queued again.
          expect(await backfillItems(api.pool)).toMatchObject({ ran: true, rerecorded: 0, requeued: 0 });
          expect(await Promise.all(files.map(queued))).toEqual([false, false, false]);
        },
      );
    });
  });
});
