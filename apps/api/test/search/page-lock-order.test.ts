// ARCHIVE-SEARCH S1 fix 2 (recheck B2): search_page_put takes the item's row lock before the file's,
// in the order a withdrawal or a publish takes them (workflow.ts loadItem and load.ts findIssue lock
// the item FOR UPDATE; the UPDATE then fires search_page_unservable, which locks the files). Taken the
// other way round, a put holding the file and a change holding the item deadlock (40P01), and the
// API answers the change "conflict, try again". R5a, R3a and R3b are the recheck's probes, kept as
// tests. Synthetic data only.
import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentService } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { recordItems } from '../../src/ledger/ledger.js';
import { ENGINE_VERSION, inputsFor } from '../../src/pdf/store.js';
import { type Api, as, insertId, startApi } from '../helpers/api.js';
import { paragraph, publishItem, text } from '../helpers/content.js';
import { APP, APP_PW, WORKER, WORKER_PW, live, url, urlFor } from '../helpers/pg.js';

const PUT = `SELECT search_page_put($1, $2, $3, $4, $5::text[], $6::text[]) AS pages`;
const sha256 = (bytes: Buffer): Buffer => createHash('sha256').update(bytes).digest();
const PUB = as('pub-token');
const WEBMASTER = as('webmaster-token');
const TREASURER = as('treasurer-token');
const WORKERS = 6;
/** What a put may answer while a change races it: written, or refused because the change came first. */
const RACE_CODES = ['ok', '55000', 'late:ok', 'late:55000'];

describe.skipIf(!live)('search_page_put locks the item before the file, as a withdrawal or a publish does', () => {
  let api: Api;
  let owner: pg.Client;
  let app: pg.Client;
  const workers: pg.Client[] = [];
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
    expect.fail('the put was never blocked on a lock');
  };
  /** A published item with one public PDF and its stored original, a ready public copy, and the ledger saying it is served. */
  const indexed = async (title: string): Promise<{ itemId: string; fileId: string; s: Buffer }> => {
    const k = ++n;
    const bytes = Buffer.from(`synthetic lock-order pdf ${k}`);
    const made = await publishItem(api.pool, {
      slug: `lock-order-${k}`,
      officeId: office,
      title,
      body: { blocks: [paragraph(text(`${title}.`))] },
      files: [{ objectKey: `lock-order-${k}.pdf`, audience: 'public', bytes }],
    });
    const fileId = (await api.pool.query<{ id: string }>(`SELECT id FROM stored_file WHERE version_id = $1`, [made.versionId])).rows[0]!.id;
    await owner.query(`SELECT pdf_original_put($1, $2, 'sub-author', ARRAY['nwfl-officers'], NULL)`, [fileId, bytes]);
    const inputs = await inputsFor(api.pool, fileId, 'public');
    expect(inputs?.kind).toBe('copy');
    const copy = Buffer.from(`synthetic public copy of ${fileId}`);
    await owner.query(`INSERT INTO pdf_copy (file_id, input_hash, engine, status, bytes) VALUES ($1, $2, $3, 'ready', $4)`, [
      fileId,
      (inputs as { hash: Buffer }).hash,
      ENGINE_VERSION,
      copy,
    ]);
    await recordItems(api.pool, [made.itemId]);
    return { itemId: made.itemId, fileId, s: sha256(copy) };
  };
  const rows = async (fileId: string): Promise<string[]> =>
    (await owner.query<{ text: string }>(`SELECT text FROM search_page_public WHERE file_id = $1 ORDER BY page`, [fileId])).rows.map((row) => row.text);
  const leftover = async (fileIds: string[]): Promise<Record<string, string[]>> => {
    const left: Record<string, string[]> = {};
    for (const fileId of fileIds) {
      const found = await rows(fileId);
      if (found.length > 0) left[fileId] = found;
    }
    return left;
  };
  /** Puts in a loop until the change is done, then once more: the codes, counted, the last marked late. */
  const putUntil = async (worker: pg.Client, item: { fileId: string; s: Buffer }, label: string, done: () => boolean, codes: Record<string, number>, most: number) => {
    for (let k = 0; k < most && !done(); k++) {
      const code = await outcome(worker, PUT, [item.fileId, 'public', item.s, 1, [`${label} ${k}`], ['']]);
      codes[code] = (codes[code] ?? 0) + 1;
    }
    const last = `late:${await outcome(worker, PUT, [item.fileId, 'public', item.s, 1, [`late ${label}`], ['']])}`;
    codes[last] = (codes[last] ?? 0) + 1;
  };

  beforeAll(async () => {
    api = await startApi('nwfl_searchlockorder');
    office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
    const database = (await api.pool.query<{ db: string }>(`SELECT current_database() AS db`)).rows[0]!.db;
    owner = await connect(urlFor('postgres', new URL(url as string).password, database));
    app = await connect(urlFor(APP, APP_PW, database));
    for (let i = 0; i < WORKERS; i++) workers.push(await connect(urlFor(WORKER, WORKER_PW, database)));
  });

  afterAll(async () => {
    for (const client of [owner, app, ...workers]) await client?.end();
    await api?.close();
  });

  it('R5a: a put that meets a withdrawal holding the item waits for it, then is refused: no deadlock, no row', async () => {
    const item = await indexed('Lock order');
    const worker = workers[0]!;
    const workerPid = await pid(worker);
    // As the API withdraws: the item locked first (workflow.ts loadItem), as the app role.
    await app.query('BEGIN');
    await app.query(`SELECT 1 FROM content_item i WHERE i.id = $1 FOR UPDATE OF i`, [item.itemId]);
    const put = outcome(worker, PUT, [item.fileId, 'public', item.s, 1, ['lock order page'], ['']]);
    await blocked(workerPid);
    // The UPDATE fires search_page_unservable, which locks the file: free, as the put waits on the item.
    const change = await outcome(app, `UPDATE content_item SET state = 'withdrawn', withdrawn_at = now(), updated_at = now() WHERE id = $1`, [item.itemId]);
    await app.query(change === 'ok' ? 'COMMIT' : 'ROLLBACK');
    expect({ change, put: await put }).toEqual({ change: 'ok', put: '55000' });
    expect(await rows(item.fileId)).toEqual([]);
  });

  it('R3a: 12 withdrawals through the API, each raced by puts in a loop: every withdrawal lands, no deadlock, no row left', async () => {
    const content = api.client(ContentService);
    const items = [];
    for (let i = 0; i < 12; i++) items.push(await indexed(`Race withdraw ${i}`));
    const codes: Record<string, number> = {};
    const errors: string[] = [];
    await Promise.all(
      items.map(async (item, i) => {
        let done = false;
        const change = (async () => {
          await new Promise((resolve) => setTimeout(resolve, (i * 7) % 40));
          await content.withdraw({ itemId: item.itemId }, WEBMASTER).catch((error: unknown) => errors.push(`withdraw ${i}: ${String(error)}`));
          done = true;
        })();
        // A pg client runs one query at a time, so two items that share a worker interleave their puts.
        await Promise.all([change, putUntil(workers[i % WORKERS]!, item, `race page ${i}`, () => done, codes, 30)]);
      }),
    );
    expect(errors).toEqual([]);
    expect(Object.keys(codes).filter((code) => !RACE_CODES.includes(code))).toEqual([]);
    expect(await leftover(items.map((item) => item.fileId))).toEqual({});
  });

  it('R3b: 5 new versions published through the API, each raced by puts for the old file: every publish lands, no deadlock, no row left', async () => {
    const content = api.client(ContentService);
    const items = [];
    for (let i = 0; i < 5; i++) items.push(await indexed(`Race publish ${i}`));
    const codes: Record<string, number> = {};
    const errors: string[] = [];
    await Promise.all(
      items.map(async (item, i) => {
        let done = false;
        const change = (async () => {
          try {
            await content.saveDraft({ itemId: item.itemId, title: `Race publish ${i}`, bodyMarkup: `Second text ${i}.` }, PUB);
            const hash = (await content.markReady({ itemId: item.itemId, targets: { website: true, newsletter: false, email: false } }, PUB)).item?.working
              ?.contentHash as Uint8Array;
            await content.approve({ itemId: item.itemId, contentHash: hash }, TREASURER);
            await content.publish({ itemId: item.itemId, contentHash: hash }, WEBMASTER);
          } catch (error) {
            errors.push(`publish ${i}: ${String(error)}`);
          }
          done = true;
        })();
        await Promise.all([change, putUntil(workers[i % WORKERS]!, item, `old version page ${i}`, () => done, codes, 60)]);
      }),
    );
    expect(errors).toEqual([]);
    expect(Object.keys(codes).filter((code) => !RACE_CODES.includes(code))).toEqual([]);
    expect(await leftover(items.map((item) => item.fileId))).toEqual({});
  });
});
