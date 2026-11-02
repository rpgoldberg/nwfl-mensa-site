// ============================================================================
// UNTRUSTED-PDF-GATE (1), a lift test pinned in test/gates/untrusted-pdf.test.ts: the PDF engine as
// a sidecar process of its own, reached over a unix socket, still forking a child per copy. Every
// test here spawns the REAL entry (src/pdf/engine-sidecar.ts) on a temp socket, with an empty
// environment unless it says otherwise, and stops it by its recorded PID. What the container adds
// (its own uid, no secrets, no shared process namespace) is fc's manifest; README, "The engine
// sidecar". Every name is made up.
// ============================================================================
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES,
  MAX_QUOTES,
  MAX_QUOTE_CHARS,
  MAX_REQUEST_HEADER_BYTES,
  REPLY_MAGIC,
  REQUEST_MAGIC,
  encodeFrame,
  encodeRequest,
} from '../../src/pdf/engine-protocol.js';
import { checkCopy } from '../../src/pdf/gate.js';
import { RetryableEngineError, regenerateOne } from '../../src/pdf/regenerate.js';
import { socketRedact } from '../../src/pdf/socket-engine.js';
import { MAX_ORIGINAL_BYTES, readPdf, storeOriginal } from '../../src/pdf/store.js';
import { workerRedact } from '../../src/pdf/worker.js';
import { type Api, insertId, startApi } from '../helpers/api.js';
import { publishItem } from '../helpers/content.js';
import { live } from '../helpers/pg.js';
import { type Spawned, exchange, listening, socketDir, spawnSidecar, standIn } from '../helpers/sidecar.js';
import { extractAll } from './extract.js';
import { linesPdf } from './fixtures.js';

const REQUEST = { quotes: ['Kestrel Ambry'], redactsAny: true };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
/** A request frame's 12-byte prefix, declaring these lengths, with nothing after it. */
const prefix = (headerLength: number, bodyLength: number): Buffer => Buffer.concat([REQUEST_MAGIC, u32(headerLength), u32(bodyLength)]);
/** A request frame with these raw header bytes. */
const rawFrame = (header: Buffer, body: Uint8Array): Buffer => Buffer.concat([REQUEST_MAGIC, u32(header.length), u32(body.length), header, body]);

const started: Spawned[] = [];
const dirs: Array<{ remove(): void }> = [];

/** The real sidecar on a fresh socket, listening. */
async function sidecar(args: readonly string[] = [], env?: NodeJS.ProcessEnv): Promise<{ spawned: Spawned; socket: string; dir: string }> {
  const place = socketDir();
  dirs.push(place);
  const spawned = spawnSidecar(['--socket', place.socket, ...args], env === undefined ? {} : { env });
  started.push(spawned);
  await listening(spawned, place.socket);
  return { spawned, socket: place.socket, dir: place.dir };
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((spawned) => spawned.stop()));
  for (const dir of dirs.splice(0)) dir.remove();
});

describe('UNTRUSTED-PDF-GATE: the engine sidecar, as its own process', () => {
  it('UNTRUSTED-PDF-GATE sidecar: refuses to start when its environment holds a database login, a token, a secret, a key or a session variable, naming no value', async () => {
    const planted: Record<string, string> = {
      DATABASE_URL: 'postgres://u:canary-db@h/d',
      PGPASSWORD: 'canary-pg-password',
      PGHOST: 'canary-pg-host.invalid',
      GH_TOKEN: 'canary-token',
      APP_SECRET: 'canary-secret',
      SIGNING_KEY: 'canary-key',
      SESSION_COOKIE: 'canary-session',
      pgpassword: 'canary-lower-case',
    };
    await Promise.all(
      Object.entries(planted).map(async ([name, value]) => {
        const place = socketDir();
        dirs.push(place);
        const spawned = spawnSidecar(['--socket', place.socket], { env: { NODE_ENV: 'production', [name]: value } });
        started.push(spawned);
        expect(await spawned.exited, name).toEqual({ code: 2, signal: null });
        expect(spawned.stderr(), name).toContain(name);
        expect(spawned.stderr(), name).not.toContain(value);
        expect(existsSync(place.socket), name).toBe(false);
      }),
    );
    // What the image and Kubernetes set is harmless, and it starts.
    const { spawned } = await sidecar([], { NODE_ENV: 'production', SERVICE_VERSION: '0.1.0', HOME: '/', KUBERNETES_SERVICE_HOST: '10.0.0.1', GRPC_PORT: '50051' });
    await spawned.stop();
    expect(await spawned.exited).toEqual({ code: 0, signal: null });
  });

  it('UNTRUSTED-PDF-GATE sidecar: listens on a socket of mode 0660, makes a copy with the real engine, and removes the socket on SIGTERM', async () => {
    const { spawned, socket } = await sidecar();
    const stat = lstatSync(socket);
    expect(stat.isSocket()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o660);
    const original = await linesPdf(['Picnic flyer', 'Rides: call Kestrel Ambry.']);
    const result = await socketRedact({ path: socket })(original, REQUEST);
    expect(result.kind).toBe('redacted');
    const copy = (result as { pdf: Uint8Array }).pdf;
    expect(await checkCopy(copy, REQUEST.quotes)).toBeNull();
    const text = await extractAll(copy);
    expect(text).toContain('Picnic flyer');
    expect(text).not.toContain('Kestrel');
    await spawned.stop();
    expect(await spawned.exited).toEqual({ code: 0, signal: null });
    expect(existsSync(socket)).toBe(false);
  }, 60_000);

  it('UNTRUSTED-PDF-GATE sidecar: holds no network socket; its unix socket is all it listens on', async () => {
    const { spawned, socket } = await sidecar(['--engine', standIn('refuse')]);
    await socketRedact({ path: socket })(Uint8Array.from([1]), REQUEST);
    const held = readdirSync(`/proc/${spawned.pid}/fd`).flatMap((fd) => {
      try {
        const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${spawned.pid}/fd/${fd}`));
        return match === null ? [] : [match[1] as string];
      } catch {
        return [];
      }
    });
    const inet = ['tcp', 'tcp6', 'udp', 'udp6', 'raw', 'raw6', 'udplite', 'udplite6'].flatMap((table) => {
      try {
        return readFileSync(`/proc/${spawned.pid}/net/${table}`, 'utf8').trim().split('\n').slice(1).map((line) => line.trim().split(/\s+/)[9] as string);
      } catch {
        return [];
      }
    });
    expect(held.length).toBeGreaterThan(0);
    expect(held.filter((inode) => inet.includes(inode))).toEqual([]);
    const listener = readFileSync(`/proc/${spawned.pid}/net/unix`, 'utf8').split('\n').find((line) => line.endsWith(` ${socket}`));
    expect(listener).toBeDefined();
    expect(held).toContain((listener as string).trim().split(/\s+/)[6]);
  });

  it('UNTRUSTED-PDF-GATE sidecar: caps the input; a frame declaring more than 10 MiB, or a header over its cap, gets no reply, and the worker never sends one', async () => {
    expect(MAX_INPUT_BYTES).toBe(MAX_ORIGINAL_BYTES);
    const { socket } = await sidecar(['--engine', standIn('refuse')]);
    // The sidecar reads the 12-byte prefix, sees the declared size and hangs up without reading on.
    expect(await exchange(socket, prefix(64, MAX_INPUT_BYTES + 1))).toEqual({ reply: Buffer.alloc(0) });
    expect(await exchange(socket, prefix(MAX_REQUEST_HEADER_BYTES + 1, 1))).toEqual({ reply: Buffer.alloc(0) });
    const over = socketRedact({ path: socket })(new Uint8Array(MAX_INPUT_BYTES + 1), REQUEST);
    await expect(over).rejects.toBeInstanceOf(RetryableEngineError);
    await expect(over).rejects.toThrow('the original is outside the engine input cap');
    await expect(socketRedact({ path: socket })(new Uint8Array(0), REQUEST)).rejects.toBeInstanceOf(RetryableEngineError);
    // And it still serves.
    expect(await socketRedact({ path: socket })(Uint8Array.from([1]), REQUEST)).toEqual({ kind: 'refused', reason: 'refused by the engine process' });
  });

  it('UNTRUSTED-PDF-GATE sidecar: caps the output; a copy over 20 MiB is never sent, and a reply declaring one fails the job closed', async () => {
    expect(MAX_OUTPUT_BYTES).toBe(20 * 1024 * 1024);
    const { socket } = await sidecar(['--engine', standIn('big')]);
    const big = socketRedact({ path: socket })(Uint8Array.from([1]), REQUEST);
    // The engine's failure, as the in-pod child's would be: stored as a refused copy, not retried.
    await expect(big).rejects.toThrow('the copy is outside the engine output cap');
    await expect(big).rejects.not.toBeInstanceOf(RetryableEngineError);
    // A sidecar that declares a copy over the cap is not read on.
    const place = socketDir();
    dirs.push(place);
    const fake = net.createServer((conn) => {
      conn.on('error', () => {});
      conn.resume();
      conn.end(Buffer.concat([REPLY_MAGIC, u32(2), u32(MAX_OUTPUT_BYTES + 1)]));
    });
    await new Promise<void>((resolve) => fake.listen(place.socket, resolve));
    try {
      const declared = socketRedact({ path: place.socket })(Uint8Array.from([1]), REQUEST);
      await expect(declared).rejects.toBeInstanceOf(RetryableEngineError);
      await expect(declared).rejects.toThrow('the body is over its cap');
    } finally {
      await new Promise((resolve) => fake.close(resolve));
    }
  }, 30_000);

  it('UNTRUSTED-PDF-GATE sidecar: times out; a copy past its limit is killed in the sidecar, and a sidecar that does not answer in time fails the job closed and frees its slot', async () => {
    const inner = await sidecar(['--engine', standIn('selective'), '--timeout-ms', '300']);
    const killed = socketRedact({ path: inner.socket })(Uint8Array.from([1]), { quotes: ['hang'], redactsAny: true });
    await expect(killed).rejects.toThrow('the engine process took longer than 300 ms');
    await expect(killed).rejects.not.toBeInstanceOf(RetryableEngineError);
    // The sidecar's own limit is the default (5 min); the worker gives up first here.
    const outer = await sidecar(['--engine', standIn('selective')]);
    const late = socketRedact({ path: outer.socket, timeoutMs: 400 })(Uint8Array.from([1]), { quotes: ['hang'], redactsAny: true });
    await expect(late).rejects.toBeInstanceOf(RetryableEngineError);
    await expect(late).rejects.toThrow('took longer than 400 ms');
    // The worker hung up, so the sidecar killed that copy's child: the next copy is not stuck behind it.
    const next = await socketRedact({ path: outer.socket, timeoutMs: 5_000 })(Uint8Array.from([1]), { quotes: ['quick'], redactsAny: true });
    expect(next).toEqual({ kind: 'refused', reason: 'answered' });
  });

  it('UNTRUSTED-PDF-GATE sidecar: answers a malformed request with nothing and keeps serving', async () => {
    const { spawned, socket } = await sidecar(['--engine', standIn('refuse')]);
    const body = Uint8Array.from([1, 2, 3]);
    const good = encodeRequest(body, REQUEST);
    const header = (value: unknown): Buffer => encodeFrame(REQUEST_MAGIC, value, body);
    const cases: Array<[string, Buffer, boolean?]> = [
      ['not a frame', Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n')],
      ['a reply frame sent as a request', encodeFrame(REPLY_MAGIC, { v: 1, kind: 'original' })],
      ['cut short', good.subarray(0, good.length - 1), true],
      ['bytes after the frame', Buffer.concat([good, Buffer.from('x')])],
      ['a header that is not JSON', rawFrame(Buffer.from('{"v":1,'), body)],
      ['a header that is not UTF-8', rawFrame(Buffer.from([0x22, 0xff, 0xfe, 0x22]), body)],
      ['a header that is a list', header([])],
      ['another version', header({ ...REQUEST, v: 2 })],
      ['a path beside the request', header({ ...REQUEST, v: 1, path: '/etc/passwd' })],
      ['an environment beside the request', header({ ...REQUEST, v: 1, env: { PGPASSWORD: 'x' } })],
      ['a quote that is not text', header({ v: 1, quotes: [7], redactsAny: true })],
      ['too many quotes', header({ v: 1, quotes: Array.from({ length: MAX_QUOTES + 1 }, () => 'abc'), redactsAny: true })],
      ['a quote too long', header({ v: 1, quotes: ['x'.repeat(MAX_QUOTE_CHARS + 1)], redactsAny: true })],
      ['redactsAny not a boolean', header({ v: 1, quotes: [], redactsAny: 'yes' })],
      ['an unknown image action', header({ v: 1, quotes: [], redactsAny: true, image: 'melt' })],
      ['no original', encodeFrame(REQUEST_MAGIC, { ...REQUEST, v: 1 })],
    ];
    for (const [name, bytes, end] of cases) {
      expect(await exchange(socket, bytes, { end: end === true }), name).toEqual({ reply: Buffer.alloc(0) });
    }
    expect(spawned.stderr()).toMatch(/refused a request/);
    expect(spawned.stderr()).not.toContain('passwd');
    expect(await socketRedact({ path: socket })(Uint8Array.from([1]), REQUEST)).toEqual({ kind: 'refused', reason: 'refused by the engine process' });
  });

  it('UNTRUSTED-PDF-GATE sidecar: the worker fails the job closed on a malformed reply', async () => {
    const place = socketDir();
    dirs.push(place);
    let reply: Buffer = Buffer.alloc(0);
    const fake = net.createServer((conn) => {
      conn.on('error', () => {});
      conn.once('data', () => conn.end(reply));
    });
    await new Promise<void>((resolve) => fake.listen(place.socket, resolve));
    const frame = (value: unknown, body?: Uint8Array): Buffer => encodeFrame(REPLY_MAGIC, value, body);
    try {
      const cases: Array<[string, Buffer]> = [
        ['nothing', Buffer.alloc(0)],
        ['not a frame', Buffer.from('HTTP/1.1 200 OK\r\n\r\n')],
        ['a request frame sent back', encodeFrame(REQUEST_MAGIC, { v: 1, kind: 'original' })],
        ['cut short', frame({ v: 1, kind: 'original' }).subarray(0, 14)],
        ['bytes after the frame', Buffer.concat([frame({ v: 1, kind: 'original' }), Buffer.from('x')])],
        ['a header that is not JSON', Buffer.concat([REPLY_MAGIC, u32(3), u32(0), Buffer.from('{{{')])],
        ['another version', frame({ v: 2, kind: 'original' })],
        ['an unknown kind', frame({ v: 1, kind: 'leaked' })],
        ['an environment beside the result', frame({ v: 1, kind: 'original', env: { PGPASSWORD: 'x' } })],
        ['a copy with no bytes', frame({ v: 1, kind: 'redacted' })],
        ['a refusal with bytes', frame({ v: 1, kind: 'refused', reason: 'no' }, Uint8Array.from([1]))],
        ['a refusal with no reason', frame({ v: 1, kind: 'refused' })],
        ['a reason too long', frame({ v: 1, kind: 'refused', reason: 'x'.repeat(1001) })],
        ['a failure whose message is not text', frame({ v: 1, kind: 'failed', message: 7 })],
      ];
      for (const [name, bytes] of cases) {
        reply = bytes;
        const job = socketRedact({ path: place.socket, timeoutMs: 5_000 })(Uint8Array.from([1]), REQUEST);
        await expect(job, name).rejects.toBeInstanceOf(RetryableEngineError);
      }
    } finally {
      await new Promise((resolve) => fake.close(resolve));
    }
  });

  it('UNTRUSTED-PDF-GATE sidecar: a killed sidecar fails the job closed, as do a socket with no sidecar and no socket at all; nothing falls back to the in-pod child', async () => {
    const { spawned, socket, dir } = await sidecar(['--engine', standIn('slow')]);
    // The in-pod child named here would answer "refused by the engine process" if the worker ever fell back to it.
    const redact = workerRedact({ PDF_ENGINE_SOCKET: socket }, { socketDirs: [dir], engine: standIn('refuse') });
    const original = await linesPdf(['Picnic flyer']);
    const job = redact(original, REQUEST);
    await sleep(400);
    process.kill(spawned.pid, 'SIGKILL');
    await expect(job).rejects.toBeInstanceOf(RetryableEngineError);
    expect(await spawned.exited).toEqual({ code: null, signal: 'SIGKILL' });
    // The socket is left behind with no one listening.
    expect(lstatSync(socket).isSocket()).toBe(true);
    const refusedConnection = redact(original, REQUEST);
    await expect(refusedConnection).rejects.toBeInstanceOf(RetryableEngineError);
    await expect(refusedConnection).rejects.toThrow('the engine sidecar could not be reached (ECONNREFUSED)');
    rmSync(socket);
    const missing = redact(original, REQUEST);
    await expect(missing).rejects.toBeInstanceOf(RetryableEngineError);
    await expect(missing).rejects.toThrow('the engine socket is missing');
  });

  it('UNTRUSTED-PDF-GATE sidecar: forks a fresh child for every copy, with an empty environment; two jobs share no process and no state', async () => {
    const { spawned, socket } = await sidecar(['--engine', standIn('state')], { NODE_ENV: 'production', SERVICE_VERSION: '0.1.0' });
    const report = async (): Promise<{ pid: number; ppid: number; copies: number; sawMarker: boolean; env: string[] }> => {
      const result = await socketRedact({ path: socket })(Uint8Array.from([1]), REQUEST);
      expect(result.kind).toBe('refused');
      return JSON.parse((result as { reason: string }).reason) as { pid: number; ppid: number; copies: number; sawMarker: boolean; env: string[] };
    };
    const first = await report();
    const second = await report();
    expect(first.pid).not.toBe(second.pid);
    expect([first.ppid, second.ppid]).toEqual([spawned.pid, spawned.pid]);
    expect([first.pid, second.pid]).not.toContain(spawned.pid);
    expect([first.copies, second.copies]).toEqual([1, 1]);
    expect([first.sawMarker, second.sawMarker]).toEqual([false, false]);
    expect([first.env, second.env]).toEqual([[], []]);
  });

  it('UNTRUSTED-PDF-GATE sidecar: takes over a stale socket, but will not start over a file or a link at its path', async () => {
    const stale = await sidecar(['--engine', standIn('refuse')]);
    process.kill(stale.spawned.pid, 'SIGKILL');
    await stale.spawned.exited;
    expect(lstatSync(stale.socket).isSocket()).toBe(true);
    const again = spawnSidecar(['--socket', stale.socket, '--engine', standIn('refuse')]);
    started.push(again);
    await listening(again, stale.socket);
    expect(await socketRedact({ path: stale.socket })(Uint8Array.from([1]), REQUEST)).toEqual({ kind: 'refused', reason: 'refused by the engine process' });
    for (const make of [(at: string) => writeFileSync(at, 'kept'), (at: string) => symlinkSync('/dev/null', at)]) {
      const place = socketDir();
      dirs.push(place);
      make(place.socket);
      const refused = spawnSidecar(['--socket', place.socket]);
      started.push(refused);
      expect(await refused.exited).toEqual({ code: 1, signal: null });
      expect(refused.stderr()).toContain('is not a socket');
      expect(lstatSync(place.socket).isSocket()).toBe(false);
    }
  });
});

describe.skipIf(!live)('UNTRUSTED-PDF-GATE: a job whose sidecar is gone, on a real database', () => {
  const STORER = { sub: 'sub-officer', groups: ['nwfl-members', 'nwfl-officers'] };
  const PHONE = '850-555-0199';
  let api: Api;
  let file: string;

  beforeAll(async () => {
    api = await startApi('nwfl_sidecar');
    const office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
    const bytes = await linesPdf(['Picnic flyer', `Rides: call ${PHONE}.`]);
    const { itemId, versionId } = await publishItem(api.pool, { slug: 'flyer', officeId: office, title: 'Flyer', body: { blocks: [] }, files: [{ objectKey: 'k-flyer', audience: 'public', bytes }] });
    file = (await api.pool.query<{ id: string }>(`SELECT id FROM stored_file WHERE version_id = $1`, [versionId])).rows[0]!.id;
    await storeOriginal(api.pool, { fileId: file, bytes, ...STORER });
    await api.pool.query(`SELECT redaction_mark_add('content_item', $1, 'body', $2, 'member_phone', $3, $4, NULL)`, [itemId, PHONE, STORER.sub, STORER.groups]);
  }, 60_000);

  afterAll(async () => {
    await api?.close();
  });

  it('UNTRUSTED-PDF-GATE sidecar: stores no copy and leaves the file queued, never the in-pod child; with the sidecar back, the next run makes the copies', async () => {
    const place = socketDir();
    dirs.push(place);
    const redact = workerRedact({ PDF_ENGINE_SOCKET: place.socket }, { socketDirs: [place.dir], engine: standIn('refuse') });
    await expect(regenerateOne(api.worker, { redact, leaseSeconds: 1 })).rejects.toBeInstanceOf(RetryableEngineError);
    expect((await api.pool.query(`SELECT 1 FROM pdf_copy WHERE file_id = $1`, [file])).rowCount).toBe(0);
    expect((await api.pool.query(`SELECT 1 FROM pdf_regen WHERE file_id = $1`, [file])).rowCount).toBe(1);
    // The sidecar comes back, with the real engine; once the lease is over the file is taken again.
    const spawned = spawnSidecar(['--socket', place.socket]);
    started.push(spawned);
    await listening(spawned, place.socket);
    await sleep(1_100);
    expect(await regenerateOne(api.worker, { redact, leaseSeconds: 120 })).toEqual({ fileId: file, done: true });
    const copies = await api.pool.query<{ status: string }>(`SELECT status FROM pdf_copy WHERE file_id = $1`, [file]);
    expect(copies.rows.length).toBeGreaterThan(0);
    expect(copies.rows.every((copy) => copy.status === 'ready')).toBe(true);
    // The public withholds the phone (0012); members are shown it.
    const pub = await readPdf(api.pool, file, 'public');
    expect(pub).toMatchObject({ kind: 'pdf', original: false });
    expect(await checkCopy((pub as { pdf: Uint8Array }).pdf, [PHONE])).toBeNull();
    expect((await api.pool.query(`SELECT 1 FROM pdf_regen WHERE file_id = $1`, [file])).rowCount).toBe(0);
  }, 90_000);
});
