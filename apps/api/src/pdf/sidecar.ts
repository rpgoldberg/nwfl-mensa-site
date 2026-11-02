// ============================================================================
// UNTRUSTED-PDF-GATE (1): the PDF engine as a sidecar process, meant for a
// container of its own in the worker's pod: its own uid and gid, no Secret in
// its env or volumes, no shared process namespace, no network (README, "The
// engine sidecar", lists what fc's manifest gives it). Started by command from
// the same image: `node dist/pdf/engine-sidecar.js`.
//
//   - At start it refuses (exit 2) an environment holding anything that could
//     be a credential: DATABASE_URL, PG*, SESSION*, *TOKEN*, *SECRET*, *KEY*.
//   - It listens on one unix socket (default /run/pdf-engine/engine.sock, the
//     emptyDir shared with the worker), mode 0660: the socket's group is the
//     pod's fsGroup, which only the two containers mounting it can reach. It
//     opens no other socket and makes no connection.
//   - Per connection: one request frame (engine-protocol.ts), read within
//     READ_TIMEOUT_MS and within the caps, validated to the field; anything
//     else is dropped without an answer. Then one copy, in a child forked for
//     it alone with an empty environment (isolated.ts, CF-ISO-0), killed after
//     ENGINE_TIMEOUT_MS or as soon as the worker hangs up, and one reply.
//   - One copy at a time: the worker makes them one by one, and a second
//     PDFium heap would only double the peak.
// ============================================================================
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { MAX_INPUT_BYTES, MAX_REQUEST_HEADER_BYTES, REQUEST_MAGIC, type SidecarReply, decodeRequest, encodeReply, readFrame } from './engine-protocol.js';
import { ENGINE_CHILD, ENGINE_TIMEOUT_MS, type EngineMessage, isolatedRedact } from './isolated.js';

export const DEFAULT_SOCKET = '/run/pdf-engine/engine.sock';
export const SOCKET_MODE = 0o660;
/** A whole request (at most 10 MiB, over a local socket) arrives well within this. */
export const READ_TIMEOUT_MS = 30_000;
const MAX_CONNECTIONS = 8;
const MAX_TIMEOUT_MS = 3_600_000;
const REFUSED_ENV = /^(?:DATABASE_URL$|PG|SESSION)|TOKEN|SECRET|KEY/i;

/** The names (never the values) of variables the sidecar must not hold, sorted. */
export function refusedEnv(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((name) => REFUSED_ENV.test(name))
    .sort();
}

export interface Sidecar {
  readonly path: string;
  /** Stops listening, kills the copies in flight (their jobs fail closed) and removes the socket. */
  close(): Promise<void>;
}

export interface SidecarOptions {
  path: string;
  /** The engine child (default: the built engine-child.js); another module for tests. */
  module?: string;
  /** Per copy. */
  timeoutMs?: number;
  readTimeoutMs?: number;
  log: (line: string) => void;
}

/** Removes a socket left by a sidecar that died; refuses anything else at the path. */
function clearStale(at: string): void {
  let stat;
  try {
    stat = lstatSync(at);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isSocket()) throw new Error(`${at} is not a socket; the sidecar will not replace it`);
  unlinkSync(at);
}

/** Binds with a umask that leaves the socket 0600 until it is opened to the group (bind is synchronous in listen). */
function listen(server: net.Server, at: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    const previous = process.umask(0o177);
    try {
      server.listen(at, () => {
        server.off('error', reject);
        resolve();
      });
    } finally {
      process.umask(previous);
    }
  });
}

export async function startSidecar(options: SidecarOptions): Promise<Sidecar> {
  const { log } = options;
  const engine = { module: options.module ?? ENGINE_CHILD, timeoutMs: options.timeoutMs ?? ENGINE_TIMEOUT_MS };
  const connections = new Set<net.Socket>();
  const jobs = new Set<AbortController>();
  let queue: Promise<unknown> = Promise.resolve();

  /** One copy at a time, in order. `job` is make(), which never rejects, so the queue never breaks. */
  function inTurn(job: () => Promise<SidecarReply>): Promise<SidecarReply> {
    const run = queue.then(job);
    queue = run;
    return run;
  }

  /** The copy, or why there is none; never rejects (isolatedRedact rejects with an Error only). */
  async function make(message: EngineMessage, signal: AbortSignal): Promise<SidecarReply> {
    if (signal.aborted) {
      log('dropped a request: the worker hung up before its turn');
      return { kind: 'failed', message: 'the worker hung up' };
    }
    try {
      return await isolatedRedact({ ...engine, signal })(message.original, message.request);
    } catch (error) {
      return { kind: 'failed', message: (error as Error).message };
    }
  }

  async function serve(socket: net.Socket): Promise<void> {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    socket.on('error', () => {});
    let message: EngineMessage;
    try {
      message = decodeRequest(await readFrame(socket, { magic: REQUEST_MAGIC, maxHeader: MAX_REQUEST_HEADER_BYTES, maxBody: MAX_INPUT_BYTES, timeoutMs: options.readTimeoutMs ?? READ_TIMEOUT_MS }));
    } catch (error) {
      log(`refused a request: ${(error as Error).message}`);
      socket.destroy();
      return;
    }
    // From here the worker only waits: more bytes are a broken request, and an end means it is gone.
    const job = new AbortController();
    jobs.add(job);
    const gone = (): void => job.abort();
    socket.on('data', () => {
      log('refused a request: bytes after the frame');
      gone();
    });
    socket.once('end', gone);
    socket.once('close', gone);
    try {
      const reply = await inTurn(() => make(message, job.signal));
      if (job.signal.aborted) socket.destroy();
      else socket.end(encodeReply(reply));
    } finally {
      jobs.delete(job);
    }
  }

  clearStale(options.path);
  const server = net.createServer((socket) => void serve(socket));
  server.maxConnections = MAX_CONNECTIONS;
  // After this, a socket error has no listener: the sidecar crashes, the kubelet restarts it, and the
  // worker's jobs fail closed meanwhile.
  await listen(server, options.path);
  chmodSync(options.path, SOCKET_MODE);
  let closing: Promise<void> | undefined;
  return {
    path: options.path,
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const job of jobs) job.abort();
        for (const socket of connections) socket.destroy();
      })),
  };
}

/**
 * The entry's logic (engine-sidecar.ts): refuse a credential in the environment (exit 2), read the
 * arguments (exit 2 on any it does not know), start listening (exit 1 when it cannot).
 *   --socket <absolute path>   default /run/pdf-engine/engine.sock
 *   --engine <module>          default the built engine-child.js; a stand-in, for tests
 *   --timeout-ms <ms>          per copy, default 300000
 */
export async function sidecarMain(argv: readonly string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<{ code: number } | { sidecar: Sidecar }> {
  const refused = refusedEnv(env);
  if (refused.length > 0) {
    log(`the engine sidecar refuses to start: its environment holds ${refused.join(', ')}; it must hold no database login, token, secret, key or session`);
    return { code: 2 };
  }
  let values: { socket?: string; engine?: string; 'timeout-ms'?: string };
  try {
    ({ values } = parseArgs({ args: [...argv], options: { socket: { type: 'string' }, engine: { type: 'string' }, 'timeout-ms': { type: 'string' } }, strict: true, allowPositionals: false }));
  } catch (error) {
    log(`usage: engine-sidecar [--socket <absolute path>] [--engine <module>] [--timeout-ms <ms>]: ${(error as Error).message}`);
    return { code: 2 };
  }
  const socket = values.socket ?? DEFAULT_SOCKET;
  if (!path.isAbsolute(socket)) {
    log('--socket must be an absolute path');
    return { code: 2 };
  }
  const timeout = values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']);
  if (timeout !== undefined && !(Number.isInteger(timeout) && timeout >= 1 && timeout <= MAX_TIMEOUT_MS)) {
    log(`--timeout-ms must be a whole number from 1 to ${MAX_TIMEOUT_MS}`);
    return { code: 2 };
  }
  try {
    const sidecar = await startSidecar({ path: socket, log, ...(values.engine === undefined ? {} : { module: values.engine }), ...(timeout === undefined ? {} : { timeoutMs: timeout }) });
    log('engine sidecar listening');
    return { sidecar };
  } catch (error) {
    log(`the engine sidecar cannot listen: ${(error as Error).message}`);
    return { code: 1 };
  }
}
