// HARDEN-1 Fix 1: an engine process that crashes or is killed (out of memory) leaves a refused copy,
// never a partial one, and the file leaves the queue: the lease is finished, not left to expire.
// Every name is made up.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isolatedRedact } from '../../src/pdf/isolated.js';
import { drain } from '../../src/pdf/regenerate.js';
import { storeOriginal } from '../../src/pdf/store.js';
import { type Api, insertId, startApi } from '../helpers/api.js';
import { publishItem } from '../helpers/content.js';
import { live } from '../helpers/pg.js';
import { linesPdf } from './fixtures.js';

const STORER = { sub: 'sub-officer', groups: ['nwfl-members', 'nwfl-officers'] };
const child = (name: string): string => fileURLToPath(new URL(`./children/${name}.ts`, import.meta.url));

describe.skipIf(!live)('the engine process dies mid-file', () => {
  let api: Api;
  let file: string;

  beforeAll(async () => {
    api = await startApi('nwfl_isolated');
    const office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
    const bytes = await linesPdf(['Picnic flyer', 'Rides: call 850-555-0199.']);
    const { versionId } = await publishItem(api.pool, { slug: 'flyer', officeId: office, title: 'Flyer', body: { blocks: [] }, files: [{ objectKey: 'k-flyer', audience: 'public', bytes }] });
    file = (await api.pool.query<{ id: string }>(`SELECT id FROM stored_file WHERE version_id = $1`, [versionId])).rows[0]!.id;
    await storeOriginal(api.pool, { fileId: file, bytes, ...STORER });
  }, 60_000);

  afterAll(async () => {
    await api?.close();
  });

  it('stores a refused copy with the reason, finishes the file and records nothing served', async () => {
    expect(await drain(api.worker, { redact: isolatedRedact({ module: child('oom') }) })).toBe(1);
    const copies = await api.pool.query<{ status: string; reason: string | null; has_bytes: boolean }>(
      `SELECT status, reason, bytes IS NOT NULL AS has_bytes FROM pdf_copy WHERE file_id = $1`,
      [file],
    );
    expect(copies.rows.length).toBeGreaterThan(0);
    for (const copy of copies.rows) {
      expect(copy).toEqual({ status: 'refused', reason: 'the engine failed: the engine process ended without a copy (SIGKILL)', has_bytes: false });
    }
    expect((await api.pool.query(`SELECT 1 FROM pdf_regen WHERE file_id = $1`, [file])).rowCount).toBe(0);
    const served = await api.pool.query(`SELECT 1 FROM publication_ledger WHERE subject_id = $1 AND audience = 'public' AND output_sha256 IS NOT NULL`, [file]);
    expect(served.rowCount).toBe(0);
  });
});
