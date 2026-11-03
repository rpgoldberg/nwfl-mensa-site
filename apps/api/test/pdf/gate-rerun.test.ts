// ============================================================================
// UNTRUSTED-PDF-GATE (2), a lift test pinned in test/gates/untrusted-pdf.test.ts: the redaction
// output gate (src/pdf/gate.ts, src/pdf/gate-rules.ts) re-run outside the engine and outside the
// worker, on every copy the engine returns, before pdf_copy_put. Two transports:
//   - in-pod: the worker forks the engine child, then a capped gate child (gate-isolated.ts);
//   - sidecars: the engine sidecar and the gate sidecar (gate-service.ts), each its own process,
//     here the REAL entries spawned on temp sockets.
// The engine is a stand-in that skipped its own gate (test/pdf/children/identity.ts: the original
// handed back as the "copy"), so what refuses is the re-run alone. The worker parses no PDF on
// either transport: a copy that would crash or stall a parser is refused, and the worker goes on.
// Every name is made up.
// ============================================================================
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import net from 'node:net';
import { PDFDocument, PDFName, PDFString, StandardFonts } from '@cantoo/pdf-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GATE_REPLY_MAGIC, encodeFrame, sha256Hex } from '../../src/pdf/engine-protocol.js';
import { checkCopy } from '../../src/pdf/gate.js';
import { isolatedRedact } from '../../src/pdf/isolated.js';
import { type Redact, RetryableEngineError } from '../../src/pdf/regenerate.js';
import { socketGate } from '../../src/pdf/socket-gate.js';
import { RERUN_REASONS, RERUN_REFUSAL } from '../../src/pdf/rerun.js';
import { readPdf, storeOriginal } from '../../src/pdf/store.js';
import { type EngineOptions, runWorker, workerRedact } from '../../src/pdf/worker.js';
import { type Api, insertId, startApi } from '../helpers/api.js';
import { publishItem } from '../helpers/content.js';
import { WORKER, WORKER_PW, live, url } from '../helpers/pg.js';
import { type ContainedSidecar, containedSidecar, ensureImage, probe, removeLeftovers, runContained } from '../helpers/contained.js';
import { GATE_CHILD_SOURCE, GATE_SIDECAR_ENTRY, NODE_FLAGS, type Spawned, gateStandIn, listening, socketDir, spawnSidecar, standIn } from '../helpers/sidecar.js';
import { CANARIES, leakFixture, linesPdf, smallPictureFixture } from './fixtures.js';
import { flateBomb, manyPages, manyShows } from './hostile.js';

const QUOTE = 'Kestrel Ambry';
const REQUEST = { quotes: [QUOTE], redactsAny: true };
const MiB = 1024 * 1024;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const spawned: Spawned[] = [];
const places: Array<{ remove(): void }> = [];
let engine: { socket: string; dir: string };

/** A real sidecar (the engine's or the gate's) on a fresh socket, listening. */
async function sidecar(entry: 'engine' | 'gate', args: readonly string[] = []): Promise<{ socket: string; dir: string; process: Spawned }> {
  const place = socketDir(entry === 'gate' ? 'gate.sock' : 'engine.sock');
  places.push(place);
  const process = spawnSidecar(['--socket', place.socket, ...args], entry === 'gate' ? { entry: GATE_SIDECAR_ENTRY } : {});
  spawned.push(process);
  await listening(process, place.socket);
  return { socket: place.socket, dir: place.dir, process };
}

/** The worker's engine over the sidecars, as runWorker builds it from PDF_ENGINE_SOCKET and PDF_GATE_SOCKET. */
const overSidecars = (gate: { socket: string; dir: string }, options: EngineOptions = {}): Redact =>
  workerRedact({ PDF_ENGINE_SOCKET: engine.socket, PDF_GATE_SOCKET: gate.socket }, { socketDirs: [engine.dir], gateSocketDirs: [gate.dir], ...options });
/** The worker's engine in the pod: the identity child, then the real gate child, capped as `options` says. */
const inPod = (options: EngineOptions = {}): Redact => workerRedact({}, { engine: standIn('identity'), gateChild: GATE_CHILD_SOURCE, gateNodeFlags: NODE_FLAGS, ...options });

/** Both transports, the gate at its own limits: benign copies only, so on the host. */
let transports: Array<[string, Redact]>;

beforeAll(async () => {
  engine = await sidecar('engine', ['--engine', standIn('identity')]);
  const gate = await sidecar('gate');
  transports = [
    ['in-pod children', inPod()],
    ['sidecars', overSidecars(gate)],
  ];
}, 60_000);

afterAll(async () => {
  await Promise.all(spawned.map((process) => process.stop()));
  for (const place of places) place.remove();
});

describe('UNTRUSTED-PDF-GATE: the output gate, re-run outside the engine and the worker, on what the engine returns', () => {
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

  it('UNTRUSTED-PDF-GATE gate re-run: refuses active content, and an original picture kept where the policy blurs or hides it, on both transports (S3)', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage([612, 792]).drawText('Picnic flyer', { x: 72, y: 720, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
    doc.catalog.set(PDFName.of('OpenAction'), doc.context.obj({ S: 'JavaScript', JS: PDFString.of("app.launchURL('https://example.invalid/x', true);") }));
    const active = await doc.save({ useObjectStreams: false });
    // 4 x 4: under BLUR_MAX and under keepsPicture's window, so only the gate's sample check sees it kept.
    const picture = await smallPictureFixture(4);
    for (const [name, redact] of transports) {
      expect(await redact(active, { quotes: [QUOTE], redactsAny: true, image: 'blur' }), name).toEqual({ kind: 'refused', reason: RERUN_REASONS.rules });
      for (const image of ['blur', 'hide'] as const) {
        expect(await redact(picture, { quotes: [], redactsAny: true, image }), `${name}, ${image}`).toEqual({ kind: 'refused', reason: RERUN_REASONS.rules });
      }
      expect((await redact(picture, { quotes: [], redactsAny: true, image: 'show' })).kind, name).toBe('redacted');
    }
  });

  it('UNTRUSTED-PDF-GATE gate re-run: refuses a copy when the gate names other bytes than the copy, on both transports', async () => {
    const clean = await linesPdf(['Picnic flyer']);
    // The gate's own child names other bytes: the gate sidecar, and the worker in the pod, refuse.
    const wrongGate = await sidecar('gate', ['--gate', gateStandIn('wrongsha')]);
    expect(await overSidecars(wrongGate)(clean, REQUEST)).toEqual({ kind: 'refused', reason: RERUN_REASONS.mismatch });
    expect(await workerRedact({}, { engine: standIn('identity'), gateChild: gateStandIn('wrongsha') })(clean, REQUEST)).toEqual({ kind: 'refused', reason: RERUN_REASONS.mismatch });
    // A gate that says "pass" for other bytes than it was sent: the worker compares, and refuses.
    const fake = socketDir('gate.sock');
    places.push(fake);
    const liar = net.createServer((conn) => {
      conn.on('error', () => {});
      conn.once('data', () => conn.end(encodeFrame(GATE_REPLY_MAGIC, { v: 1, verdict: 'pass', sha256: sha256Hex(Buffer.from('another copy')) })));
    });
    await new Promise<void>((resolve) => liar.listen(fake.socket, resolve));
    try {
      expect(await overSidecars({ socket: fake.socket, dir: fake.dir })(clean, REQUEST)).toEqual({ kind: 'refused', reason: RERUN_REASONS.mismatch });
    } finally {
      await new Promise((resolve) => liar.close(resolve));
    }
  }, 60_000);

  it('UNTRUSTED-PDF-GATE gate re-run: the gate sidecar starts with no variable off its allow-list, and binds only in /run/pdf-gate', async () => {
    const place = socketDir('gate.sock');
    places.push(place);
    const withSecret = spawnSidecar(['--socket', place.socket], { entry: GATE_SIDECAR_ENTRY, env: { DB_PASSWORD: 'canary-db' } });
    spawned.push(withSecret);
    expect(await withSecret.exited).toEqual({ code: 2, signal: null });
    expect(withSecret.stderr()).toContain('DB_PASSWORD');
    expect(withSecret.stderr()).not.toContain('canary');
    const elsewhere = spawnSidecar(['--socket', place.socket, '--socket-dir', '/run/pdf-gate'], { entry: GATE_SIDECAR_ENTRY });
    spawned.push(elsewhere);
    expect(await elsewhere.exited).toEqual({ code: 2, signal: null });
    expect(elsewhere.stderr()).toContain('--socket must be an absolute path directly in /run/pdf-gate');
  });

  it('UNTRUSTED-PDF-GATE gate re-run: the gate sidecar holds no network socket, through a check; its unix socket is all it listens on', async () => {
    const gate = await sidecar('gate');
    const clean = await linesPdf(['Picnic flyer']);
    expect((await overSidecars(gate)(clean, REQUEST)).kind).toBe('redacted');
    const pid = gate.process.pid;
    const held = readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
      try {
        const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
        return match === null ? [] : [match[1] as string];
      } catch {
        return [];
      }
    });
    const inet = ['tcp', 'tcp6', 'udp', 'udp6', 'raw', 'raw6', 'udplite', 'udplite6'].flatMap((table) => {
      try {
        return readFileSync(`/proc/${pid}/net/${table}`, 'utf8').trim().split('\n').slice(1).map((line) => line.trim().split(/\s+/)[9] as string);
      } catch {
        return [];
      }
    });
    expect(held.length).toBeGreaterThan(0);
    expect(held.filter((inode) => inet.includes(inode))).toEqual([]);
    const listener = readFileSync(`/proc/${pid}/net/unix`, 'utf8').split('\n').find((line) => line.endsWith(` ${gate.socket}`));
    expect(listener).toBeDefined();
    expect(held).toContain((listener as string).trim().split(/\s+/)[6]);
  });
});

describe.skipIf(!live)('UNTRUSTED-PDF-GATE: the re-run decides what reaches pdf_copy_put, in the worker process', () => {
  const STORER = { sub: 'sub-officer', groups: ['nwfl-members', 'nwfl-officers'] };
  const PHONE = '850-555-0199';
  let api: Api;
  let database: string;
  let office: string;
  let gate: { socket: string; dir: string };

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
      gateChild: GATE_CHILD_SOURCE,
      gateNodeFlags: NODE_FLAGS,
      socketDirs: [engine.dir],
      gateSocketDirs: [gate.dir],
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
    gate = await sidecar('gate');
  }, 60_000);

  afterAll(async () => {
    await api?.close();
  });

  for (const [transport, env] of [
    ['in-pod children', (): Record<string, string> => ({})],
    ['sidecars', (): Record<string, string> => ({ PDF_ENGINE_SOCKET: engine.socket, PDF_GATE_SOCKET: gate.socket })],
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

describe('UNTRUSTED-PDF-GATE: hostile copies and hostile checks, with the gate sidecar as PID 1 of a capped container (fix round 2)', () => {
  // Memory-heavy, process-starting and hostile cases run only in containers under the safety caps
  // (test/helpers/contained.ts): the gate sidecar as PID 1 with the test as the worker over its
  // socket's directory, and the in-pod transport as a probe script in a container of its own.
  const GATE_SOCK = '/run/pdf-gate/gate.sock';
  const hostile = gateStandIn('hostile');
  const contained: ContainedSidecar[] = [];
  beforeAll(() => ensureImage(), 300_000);
  afterEach(async () => {
    await Promise.all(contained.splice(0).map((gate) => gate.remove()));
  });
  afterAll(() => removeLeftovers());
  const gateIn = async (args: readonly string[]): Promise<ContainedSidecar> => {
    const gate = await containedSidecar('gate', args);
    contained.push(gate);
    return gate;
  };
  const COPY = Uint8Array.from(Buffer.from('a copy'));
  const check = (gate: ContainedSidecar, quotes: string[], copy: Uint8Array = COPY, timeoutMs = 30_000) =>
    socketGate({ path: gate.socket, timeoutMs })({ copy, original: Uint8Array.from([9]), quotes, image: 'blur', sha256: sha256Hex(copy) });
  const PASS = { verdict: { pass: true }, sha256: sha256Hex(COPY) };
  type InPod = { result: unknown; ms: number; cause: string | null; causeMs: number };

  it('UNTRUSTED-PDF-GATE gate re-run: refuses a Flate bomb (a 1 MiB copy inflating to 1 GiB) at the gate\'s memory cap, for memory, on both transports, and the worker goes on', async () => {
    const bomb = await flateBomb(1024);
    expect(bomb.byteLength).toBeLessThan(2 * MiB);
    const { result: inPodRun } = await runContained<InPod>(probe('in-pod-gate'), ['bomb', '384', '60000']);
    expect(inPodRun.result).toEqual({ kind: 'refused', reason: RERUN_REASONS.unfinished });
    expect(inPodRun.cause).toBe('memory');
    expect(inPodRun.causeMs).toBeLessThan(30_000);
    const gate = await gateIn(['--max-rss-mb', '384', '--timeout-ms', '60000']);
    const before = process.memoryUsage().rss;
    const t0 = Date.now();
    expect(await overSidecars(gate)(bomb, REQUEST)).toEqual({ kind: 'refused', reason: RERUN_REASONS.unfinished });
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(gate.stderr()).toContain('a check was unfinished (memory)');
    // The bytes were inflated in the gate's child, never here.
    expect(process.memoryUsage().rss - before).toBeLessThan(256 * MiB);
    expect((await overSidecars(gate)(await linesPdf(['Picnic flyer']), REQUEST)).kind).toBe('redacted');
  }, 240_000);

  it('UNTRUSTED-PDF-GATE gate re-run: refuses a 24 KB copy drawing 2,000,000 strings, on both transports, and the worker goes on', async () => {
    const shows = manyShows(2_000_000);
    expect(shows.byteLength).toBeLessThan(64 * 1024);
    const { result: inPodRun } = await runContained<InPod>(probe('in-pod-gate'), ['shows', '384', '60000']);
    expect(inPodRun.result).toEqual({ kind: 'refused', reason: RERUN_REASONS.unfinished });
    const gate = await gateIn(['--max-rss-mb', '384', '--timeout-ms', '60000']);
    expect(await overSidecars(gate)(shows, REQUEST)).toEqual({ kind: 'refused', reason: RERUN_REASONS.unfinished });
    expect(gate.stderr()).toMatch(/a check was unfinished \((memory|crash)\)/);
    expect((await overSidecars(gate)(await linesPdf(['Picnic flyer']), REQUEST)).kind).toBe('redacted');
  }, 240_000);

  it('UNTRUSTED-PDF-GATE gate re-run: refuses a copy of 20,000 pages at the gate\'s deadline, on both transports, and the worker goes on', async () => {
    const pages = manyPages(20_000);
    const { result: inPodRun } = await runContained<InPod>(probe('in-pod-gate'), ['pages', '768', '3000']);
    expect(inPodRun.result).toEqual({ kind: 'refused', reason: RERUN_REASONS.unfinished });
    expect(inPodRun.cause).toBe('deadline');
    const gate = await gateIn(['--timeout-ms', '3000']);
    const t0 = Date.now();
    expect(await overSidecars(gate)(pages, REQUEST)).toEqual({ kind: 'refused', reason: RERUN_REASONS.unfinished });
    // The deadline is 3 s; forking the child and loading pdf.js come on top.
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(gate.stderr()).toContain('a check was unfinished (deadline)');
  }, 240_000);

  it('UNTRUSTED-PDF-GATE gate re-run: kills a check whose memory passes its cap at the watchdog, for memory, long before its deadline (M2)', async () => {
    // The hog takes about 512 MiB outside the heap and then idles: without the watchdog it would be
    // killed at the 10 s deadline instead, and the log would say so.
    const gate = await gateIn(['--gate', gateStandIn('hog'), '--max-rss-mb', '200', '--timeout-ms', '10000']);
    const t0 = Date.now();
    expect(await check(gate, ['x'])).toEqual({ verdict: { pass: false, code: 'unfinished' }, sha256: sha256Hex(COPY) });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(gate.stderr()).toContain('a check was unfinished (memory)');
  }, 120_000);

  it('UNTRUSTED-PDF-GATE gate re-run: a check\'s fork-and-exit hop chain starts nothing; the gate sidecar is still the only process and serves the next check', async () => {
    const gate = await gateIn(['--gate', hostile, '--timeout-ms', '5000']);
    const inode = lstatSync(gate.socket).ino;
    expect(await check(gate, ['hop', GATE_SOCK])).toEqual(PASS);
    expect(readFileSync(`${gate.socket}.said`, 'utf8')).toBe('hop: started 0 of 8 (EAGAIN)');
    await sleep(2_500);
    expect(gate.processes()).toBe(1);
    expect(lstatSync(gate.socket).ino).toBe(inode);
    expect(await check(gate, ['echo'])).toEqual(PASS);
  }, 120_000);

  it('UNTRUSTED-PDF-GATE gate re-run: a check that sends its parent SIGSTOP, then SIGKILL, changes nothing: PID 1 neither stops nor dies, and serves the next check', async () => {
    const gate = await gateIn(['--gate', hostile, '--timeout-ms', '5000']);
    expect(await check(gate, ['hit-parent', GATE_SOCK])).toEqual(PASS);
    expect(readFileSync(`${gate.socket}.said`, 'utf8')).toMatch(/^parent 1 after SIGSTOP: [RS]; after SIGKILL: [RS]$/);
    expect(await check(gate, ['echo'])).toEqual(PASS);
  }, 120_000);

  for (const mode of ['stop-steal', 'steal'] as const) {
    it(`UNTRUSTED-PDF-GATE gate re-run: a check that ${mode === 'stop-steal' ? 'freezes the gate sidecar (SIGSTOP) and ' : ''}takes its socket over gets no verdict out: the sidecar exits 1 before any, and later checks fail closed (S1)`, async () => {
      const gate = await gateIn(['--gate', hostile, '--timeout-ms', '5000']);
      await expect(check(gate, [mode, GATE_SOCK])).rejects.toBeInstanceOf(RetryableEngineError);
      expect((await gate.exited).code).toBe(1);
      expect(gate.stderr()).toContain(`the socket at ${GATE_SOCK} was replaced or removed`);
      expect((JSON.parse(readFileSync(`${gate.socket}.stolen`, 'utf8')) as { parent: string }).parent).toMatch(/^[RS]$/);
      for (const text of ['MEMBERS ONLY roster note', 'public flyer']) {
        await expect(check(gate, ['echo'], Uint8Array.from(Buffer.from(text)), 10_000), text).rejects.toBeInstanceOf(RetryableEngineError);
      }
    }, 120_000);
  }

  it('UNTRUSTED-PDF-GATE gate re-run: as PID 1, the gate sidecar closes its listener and exits 0 promptly on SIGTERM and SIGINT (S1)', async () => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      const gate = await gateIn(['--gate', gateStandIn('pass')]);
      const t0 = Date.now();
      gate.signal(signal);
      expect((await gate.exited).code, signal).toBe(0);
      expect(Date.now() - t0, signal).toBeLessThan(5_000);
      expect(gate.stderr(), signal).toContain(`gate sidecar stopping (${signal})`);
      expect(existsSync(gate.socket), signal).toBe(false);
    }
  }, 120_000);

  it('UNTRUSTED-PDF-GATE gate re-run: the gate sidecar will not serve behind an init (not PID 1)', async () => {
    await expect(containedSidecar('gate', [], { init: true })).rejects.toThrow(/exit 2\).*the gate sidecar must be PID 1 of its container and will not start/s);
  }, 120_000);
});
