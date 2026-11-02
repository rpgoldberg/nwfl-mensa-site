// ============================================================================
// UNTRUSTED-PDF-GATE (2), a lift test pinned in test/gates/untrusted-pdf.test.ts: the redaction
// output gate (src/pdf/gate.ts) re-run in the worker, outside the engine, on every copy the engine
// returns, over either transport, before pdf_copy_put. The engine here is a stand-in that skipped
// its own gate (test/pdf/children/identity.ts: the original handed back as the "copy"), so what
// refuses is the worker's re-run alone. Every name is made up.
// ============================================================================
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkCopy } from '../../src/pdf/gate.js';
import { isolatedRedact } from '../../src/pdf/isolated.js';
import type { Redact } from '../../src/pdf/regenerate.js';
import { RERUN_REFUSAL } from '../../src/pdf/rerun.js';
import { readPdf, storeOriginal } from '../../src/pdf/store.js';
import { runWorker, workerRedact } from '../../src/pdf/worker.js';
import { type Api, insertId, startApi } from '../helpers/api.js';
import { publishItem } from '../helpers/content.js';
import { WORKER, WORKER_PW, live, url } from '../helpers/pg.js';
import { type Spawned, listening, socketDir, spawnSidecar, standIn } from '../helpers/sidecar.js';
import { CANARIES, leakFixture, linesPdf } from './fixtures.js';

const QUOTE = 'Kestrel Ambry';
const REQUEST = { quotes: [QUOTE], redactsAny: true };

let place: ReturnType<typeof socketDir>;
let sidecar: Spawned;
/** The worker's engine, as runWorker builds it, over each transport; both run the identity stand-in. */
let transports: Array<[string, Redact]>;

beforeAll(async () => {
  place = socketDir();
  sidecar = spawnSidecar(['--socket', place.socket, '--engine', standIn('identity')]);
  await listening(sidecar, place.socket);
  transports = [
    ['in-pod child', workerRedact({}, { engine: standIn('identity') })],
    ['sidecar', workerRedact({ PDF_ENGINE_SOCKET: place.socket }, { socketDirs: [place.dir] })],
  ];
});

afterAll(async () => {
  await sidecar?.stop();
  place?.remove();
});

describe('UNTRUSTED-PDF-GATE: the output gate, re-run in the worker on what the engine returns', () => {
  it('UNTRUSTED-PDF-GATE gate re-run: the stand-in engine lets marked text through on its own', async () => {
    const original = await linesPdf([`Rides: call ${QUOTE}.`]);
    const result = await isolatedRedact({ module: standIn('identity') })(original, REQUEST);
    expect(result.kind).toBe('redacted');
    expect(await checkCopy((result as { pdf: Uint8Array }).pdf, [QUOTE])).not.toBeNull();
  });

  it('UNTRUSTED-PDF-GATE gate re-run: refuses a copy with the marked text still in it, on both transports, with a reason that names no withheld text', async () => {
    const original = await linesPdf(['Picnic flyer', `Rides: call ${QUOTE}.`]);
    for (const [name, redact] of transports) {
      expect(await redact(original, REQUEST), name).toEqual({ kind: 'refused', reason: RERUN_REFUSAL });
    }
    expect(RERUN_REFUSAL).not.toMatch(/Kestrel|Ambry/);
  });

  it('UNTRUSTED-PDF-GATE gate re-run: finds marked text off the page too (metadata, annotations, attachments), on both transports', async () => {
    const original = await leakFixture();
    for (const name of ['metadata', 'annotation', 'attachment', 'javascript'] as const) {
      for (const [transport, redact] of transports) {
        expect(await redact(original, { quotes: [CANARIES[name].quote], redactsAny: true }), `${name} over the ${transport}`).toEqual({ kind: 'refused', reason: RERUN_REFUSAL });
      }
    }
  });

  it('UNTRUSTED-PDF-GATE gate re-run: passes a clean copy, bytes intact, on both transports', async () => {
    const clean = await linesPdf(['Picnic flyer', 'Rides: ask at the desk.']);
    for (const [name, redact] of transports) {
      const result = await redact(clean, REQUEST);
      expect(result.kind, name).toBe('redacted');
      expect(Buffer.from((result as { pdf: Uint8Array }).pdf).equals(Buffer.from(clean)), name).toBe(true);
    }
  });
});

describe.skipIf(!live)('UNTRUSTED-PDF-GATE: the re-run decides what reaches pdf_copy_put, in the worker process', () => {
  const STORER = { sub: 'sub-officer', groups: ['nwfl-members', 'nwfl-officers'] };
  const PHONE = '850-555-0199';
  let api: Api;
  let database: string;
  let office: string;

  /** A published file with its original stored and the phone number marked on its item; queued. */
  async function markedFile(slug: string, lines: readonly string[]): Promise<string> {
    const bytes = await linesPdf(lines);
    const { itemId, versionId } = await publishItem(api.pool, { slug, officeId: office, title: slug, body: { blocks: [] }, files: [{ objectKey: `k-${slug}`, audience: 'public', bytes }] });
    const file = (await api.pool.query<{ id: string }>(`SELECT id FROM stored_file WHERE version_id = $1`, [versionId])).rows[0]!.id;
    await storeOriginal(api.pool, { fileId: file, bytes, ...STORER });
    await api.pool.query(`SELECT redaction_mark_add('content_item', $1, 'body', $2, 'member_phone', $3, $4, NULL)`, [itemId, PHONE, STORER.sub, STORER.groups]);
    return file;
  }

  /** runWorker, as src/worker.ts starts it, until the queue is empty. */
  async function runTheWorker(env: Record<string, string>): Promise<unknown[]> {
    const target = new URL(url as string);
    const errors: unknown[] = [];
    const job = runWorker({
      env: { PGHOST: target.hostname, PGPORT: target.port, PGDATABASE: database, PGUSER: WORKER, PGPASSWORD: WORKER_PW, ...env },
      engine: standIn('identity'),
      socketDirs: [place.dir],
      intervalMs: 20,
      onError: (error) => errors.push(error),
    });
    const deadline = Date.now() + 30_000;
    while ((await api.pool.query(`SELECT 1 FROM pdf_regen`)).rowCount !== 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    await job.stop();
    return errors;
  }

  async function copies(file: string): Promise<Array<{ status: string; reason: string | null; bytes: Buffer | null }>> {
    return (await api.pool.query<{ status: string; reason: string | null; bytes: Buffer | null }>(`SELECT status, reason, bytes FROM pdf_copy WHERE file_id = $1`, [file])).rows;
  }

  beforeAll(async () => {
    api = await startApi('nwfl_rerun');
    database = new URL((api.pool as unknown as { options: { connectionString: string } }).options.connectionString).pathname.slice(1);
    office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
  }, 60_000);

  afterAll(async () => {
    await api?.close();
  });

  for (const [transport, env] of [
    ['in-pod child', (): Record<string, string> => ({})],
    ['sidecar', (): Record<string, string> => ({ PDF_ENGINE_SOCKET: place.socket })],
  ] as const) {
    it(`UNTRUSTED-PDF-GATE gate re-run: over the ${transport}, a copy with the marked text is stored refused with no bytes, and a clean one ready`, async () => {
      const leaky = await markedFile(`leaky-${transport.replace(/\W/g, '')}`, ['Picnic flyer', `Rides: call ${PHONE}.`]);
      const clean = await markedFile(`clean-${transport.replace(/\W/g, '')}`, ['Picnic flyer', 'Rides: ask at the desk.']);
      expect(await runTheWorker(env())).toEqual([]);
      // The public withholds the phone (0012), so its copy is refused before pdf_copy_put could store bytes.
      expect(await readPdf(api.pool, leaky, 'public')).toEqual({ kind: 'refused', reason: RERUN_REFUSAL });
      const refused = await copies(leaky);
      expect(refused.some((copy) => copy.status === 'refused' && copy.reason === RERUN_REFUSAL && copy.bytes === null)).toBe(true);
      const served = await readPdf(api.pool, clean, 'public');
      expect(served).toMatchObject({ kind: 'pdf', original: false });
      expect(await checkCopy((served as { pdf: Uint8Array }).pdf, [PHONE])).toBeNull();
      for (const copy of await copies(clean)) expect(copy.status).toBe('ready');
    }, 60_000);
  }
});

