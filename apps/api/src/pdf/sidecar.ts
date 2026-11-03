// ============================================================================
// UNTRUSTED-PDF-GATE (1): the PDF engine as a sidecar process, meant for a
// container of its own in the worker's pod: its own uid and gid, no Secret in
// its env or volumes, no shared process namespace, no network (README, "The
// engine sidecar", lists what fc's manifest gives it). Started with args from
// the same image, so dumb-init stays PID 1: `node dist/pdf/engine-sidecar.js`.
// The gate sidecar (gate-service.ts) is served by the same code here.
//
//   - At start it refuses (exit 2) an environment holding any variable not on
//     ALLOWED_ENV: an allow-list, so a credential under a name nobody thought
//     of is refused too (fix round 1, S2).
//   - It binds only directly in its own directory (/run/pdf-engine; the gate
//     /run/pdf-gate), each an emptyDir only it and the worker mount, on one
//     unix socket of mode 0660: the socket's group is the pod's fsGroup.
//   - It needs a PID namespace of its own and refuses to be PID 1 (exit 2);
//     after every job it SIGKILLs every process in that namespace but PID 1
//     and itself (pidns.ts), so nothing a job started outlives it (M1).
//   - It watches its socket: at each connection, after each job and every
//     WATCH_MS it compares the path's device and inode with the socket it
//     bound. Replaced or gone, it stops (the entry exits 1, the kubelet
//     restarts it) and the worker's job fails closed (M1).
//   - Per connection: the first bytes within FIRST_BYTES_TIMEOUT_MS, one
//     request frame (engine-protocol.ts) within READ_TIMEOUT_MS and the
//     caps, validated to the field; anything else is dropped without an
//     answer. Then one job in a child forked for it alone with an empty
//     environment (isolated.ts, gate-isolated.ts), killed at its timeout or
//     as soon as the worker hangs up, and one reply.
//   - One job at a time: the worker asks one by one, and a second PDFium heap
//     would only double the peak.
// ============================================================================
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { FIRST_BYTES_TIMEOUT_MS, type Frame, MAX_INPUT_BYTES, MAX_REQUEST_HEADER_BYTES, REQUEST_MAGIC, type SidecarReply, decodeRequest, encodeReply, readFrame } from './engine-protocol.js';
import { ENGINE_CHILD, ENGINE_TIMEOUT_MS, type EngineMessage, isolatedRedact } from './isolated.js';
import { ownNamespaceProblem, sweepNamespace } from './pidns.js';
import { inSocketDir } from './socket-engine.js';

export const ENGINE_SOCKET_DIR = '/run/pdf-engine';
export const DEFAULT_SOCKET = `${ENGINE_SOCKET_DIR}/engine.sock`;
export const SOCKET_MODE = 0o660;
/** A whole request (at most 30 MiB, over a local socket) arrives well within this. */
export const READ_TIMEOUT_MS = 30_000;
/** How often a sidecar checks that its socket is still the one it bound. */
export const WATCH_MS = 1_000;
const MAX_CONNECTIONS = 8;
export const MAX_TIMEOUT_MS = 3_600_000;

/**
 * The only variables a sidecar may hold: what the image sets (NODE_*, YARN_VERSION, SERVICE_VERSION and
 * the ports), what a container runtime sets (PATH, HOME, HOSTNAME, TERM), the locale and zone, the two
 * socket paths, and the API server's address, which the kubelet injects even with enableServiceLinks off.
 */
export const ALLOWED_ENV: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'HOSTNAME',
  'TERM',
  'TZ',
  'LANG',
  'LC_ALL',
  'NODE_ENV',
  'NODE_VERSION',
  'YARN_VERSION',
  'SERVICE_VERSION',
  'GRPC_PORT',
  'HEALTH_PORT',
  'PDF_ENGINE_SOCKET',
  'PDF_GATE_SOCKET',
  'KUBERNETES_SERVICE_HOST',
  'KUBERNETES_SERVICE_PORT',
  'KUBERNETES_SERVICE_PORT_HTTPS',
  'KUBERNETES_PORT',
  'KUBERNETES_PORT_443_TCP',
  'KUBERNETES_PORT_443_TCP_PROTO',
  'KUBERNETES_PORT_443_TCP_PORT',
  'KUBERNETES_PORT_443_TCP_ADDR',
]);

/** The names (never the values) of variables a sidecar must not hold, sorted: everything off ALLOWED_ENV. */
export function refusedEnv(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((name) => !ALLOWED_ENV.has(name))
    .sort();
}

export interface Sidecar {
  readonly path: string;
  /** Stops listening, kills the jobs in flight (they fail closed) and removes the socket. */
  close(): Promise<void>;
}

/** How a sidecar serves, whatever it serves. */
export interface ServeOptions {
  path: string;
  log: (line: string) => void;
  readTimeoutMs?: number;
  firstBytesTimeoutMs?: number;
  /** After every job, before its reply (pidns.ts sweepNamespace); a throw stops the sidecar. */
  sweep?: () => void;
  /** The socket is not the one bound any more, or a sweep failed: the sidecar has stopped. Default: logged. */
  onFatal?: (reason: string) => void;
  watchMs?: number;
}

/** What a sidecar serves: one kind of request frame, and the job that answers it. */
export interface Protocol<M> {
  magic: Buffer;
  maxHeader: number;
  maxBody: number;
  /** Exactly the typed request, or a FrameError. */
  decode(frame: Frame): M;
  /** The reply frame; never rejects. */
  run(message: M, signal: AbortSignal): Promise<Buffer>;
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

/** Serves one request frame per connection on a unix socket at `options.path`, one job at a time. */
export async function serveFrames<M>(options: ServeOptions, protocol: Protocol<M>): Promise<Sidecar> {
  const { log } = options;
  const connections = new Set<net.Socket>();
  const jobs = new Set<AbortController>();
  let queue: Promise<unknown> = Promise.resolve();
  /** The socket as bound (its device and inode), and the timer that watches it; set once it listens. */
  const bound: { dev?: number; ino?: number; watch?: NodeJS.Timeout } = {};
  let stopped = false;
  const server = net.createServer((socket) => void serve(socket));
  server.maxConnections = MAX_CONNECTIONS;

  /** Stops serving for good: nothing more is accepted or answered. */
  function fail(reason: string): void {
    if (stopped) return;
    stopped = true;
    clearInterval(bound.watch);
    server.close();
    for (const job of jobs) job.abort();
    for (const socket of connections) socket.destroy();
    (options.onFatal ?? log)(reason);
  }

  /** Whether the path still holds the very socket this sidecar bound; stops it when not. */
  function intact(): boolean {
    if (stopped) return false;
    try {
      const now = lstatSync(options.path);
      if (now.isSocket() && now.dev === bound.dev && now.ino === bound.ino) return true;
    } catch {
      // gone
    }
    fail(`the socket at ${options.path} was replaced or removed`);
    return false;
  }

  /** After a job's child is gone: the sweep, then the socket check, before any reply. */
  function afterJob(): void {
    try {
      options.sweep?.();
    } catch (error) {
      fail(`the sweep after a job failed (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`);
    }
    intact();
  }

  /** One job at a time, in order. `job` never rejects, so the queue never breaks. */
  function inTurn(job: () => Promise<Buffer | null>): Promise<Buffer | null> {
    const run = queue.then(job);
    queue = run;
    return run;
  }

  async function serve(socket: net.Socket): Promise<void> {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    socket.on('error', () => {});
    if (!intact()) {
      socket.destroy();
      return;
    }
    let message: M;
    try {
      const frame = await readFrame(socket, {
        magic: protocol.magic,
        maxHeader: protocol.maxHeader,
        maxBody: protocol.maxBody,
        timeoutMs: options.readTimeoutMs ?? READ_TIMEOUT_MS,
        firstBytesTimeoutMs: options.firstBytesTimeoutMs ?? FIRST_BYTES_TIMEOUT_MS,
      });
      message = protocol.decode(frame);
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
      const reply = await inTurn(async () => {
        if (job.signal.aborted) {
          log('dropped a request: the worker hung up before its turn');
          return null;
        }
        try {
          return await protocol.run(message, job.signal);
        } finally {
          afterJob();
        }
      });
      if (reply === null || job.signal.aborted || stopped) socket.destroy();
      else socket.end(reply);
    } finally {
      jobs.delete(job);
    }
  }

  clearStale(options.path);
  // After this, a socket error has no listener: the sidecar crashes, the kubelet restarts it, and the
  // worker's jobs fail closed meanwhile.
  await listen(server, options.path);
  chmodSync(options.path, SOCKET_MODE);
  const stat = lstatSync(options.path);
  bound.dev = stat.dev;
  bound.ino = stat.ino;
  bound.watch = setInterval(intact, options.watchMs ?? WATCH_MS);
  bound.watch.unref();
  let closing: Promise<void> | undefined;
  return {
    path: options.path,
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        stopped = true;
        clearInterval(bound.watch);
        server.close(() => resolve());
        for (const job of jobs) job.abort();
        for (const socket of connections) socket.destroy();
      })),
  };
}

export interface SidecarOptions extends ServeOptions {
  /** The engine child (default: the built engine-child.js); another module for tests. */
  module?: string;
  /** Per copy. */
  timeoutMs?: number;
}

/** The engine sidecar: a copy per connection, each made in a child of its own (isolated.ts). */
export function startSidecar(options: SidecarOptions): Promise<Sidecar> {
  const engine = { module: options.module ?? ENGINE_CHILD, timeoutMs: options.timeoutMs ?? ENGINE_TIMEOUT_MS };
  /** The copy, or why there is none; never rejects (isolatedRedact rejects with an Error only). */
  async function make(message: EngineMessage, signal: AbortSignal): Promise<SidecarReply> {
    try {
      return await isolatedRedact({ ...engine, signal })(message.original, message.request);
    } catch (error) {
      return { kind: 'failed', message: (error as Error).message };
    }
  }
  return serveFrames(options, {
    magic: REQUEST_MAGIC,
    maxHeader: MAX_REQUEST_HEADER_BYTES,
    maxBody: MAX_INPUT_BYTES,
    decode: decodeRequest,
    run: async (message, signal) => encodeReply(await make(message, signal)),
  });
}

/** What a sidecar's entry sees of its process; tests give a made-up one. */
export interface System {
  pid: number;
  ppid: number;
  uid: number;
  procRoot: string;
  kill: (pid: number, signal: NodeJS.Signals) => void;
}

export interface MainOptions {
  system?: System;
  /** The sidecar stopped (its socket replaced or gone, or a sweep failed): the entry exits 1. */
  onFatal?: (reason: string) => void;
}

const thisProcess = (): System => ({ pid: process.pid, ppid: process.ppid, uid: process.getuid?.() ?? -1, procRoot: '/proc', kill: (pid, signal) => void process.kill(pid, signal) });

/** What one sidecar entry takes: its directory and socket name, and its own arguments beside the common ones. */
export interface SidecarSpec {
  what: 'engine' | 'gate';
  dir: string;
  file: string;
  options: Record<string, { type: 'string' }>;
  usage: string;
}

/** A sidecar's settings, read from its environment and arguments, or the exit code that refuses them. */
export interface Prepared {
  socket: string;
  values: Record<string, string | boolean | undefined>;
  timeoutMs: number | undefined;
  sweep: (() => void) | undefined;
  listening: string;
  onFatal: (reason: string) => void;
}

/** A whole number from 1 to `max`, from an argument; NaN when it is not one, undefined when absent. */
export function wholeArgument(value: string | boolean | undefined, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : Number.NaN;
}

/**
 * The common start of both entries: refuse an environment off the allow-list, unknown arguments, a
 * socket outside the sidecar's own directory, the test-only flags in production, PID 1, and a PID
 * namespace that is not its own (exit 2). Common arguments:
 *   --socket <path>          directly in the sidecar's directory; default <dir>/<file>
 *   --timeout-ms <ms>        per job
 *   --socket-dir <dir>       another directory, for tests (refused when NODE_ENV=production)
 *   --shared-pid-namespace   no sweep, for tests (refused when NODE_ENV=production)
 */
export function prepareSidecar(spec: SidecarSpec, argv: readonly string[], env: NodeJS.ProcessEnv, log: (line: string) => void, options: MainOptions = {}): { code: number } | Prepared {
  const name = `the ${spec.what} sidecar`;
  const system = options.system ?? thisProcess();
  const refused = refusedEnv(env);
  if (refused.length > 0) {
    log(`${name} refuses to start: its environment holds ${refused.join(', ')}, which its allow-list does not name; it must hold no database login, token, secret or key`);
    return { code: 2 };
  }
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { socket: { type: 'string' }, 'timeout-ms': { type: 'string' }, 'socket-dir': { type: 'string' }, 'shared-pid-namespace': { type: 'boolean' }, ...spec.options },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    log(`usage: ${spec.usage}: ${(error as Error).message}`);
    return { code: 2 };
  }
  for (const flag of ['socket-dir', 'shared-pid-namespace']) {
    if (values[flag] !== undefined && env['NODE_ENV'] === 'production') {
      log(`--${flag} is for tests and refused in production`);
      return { code: 2 };
    }
  }
  const dir = (values['socket-dir'] as string | undefined) ?? spec.dir;
  if (!path.posix.isAbsolute(dir) || path.posix.normalize(dir) !== dir || dir.endsWith('/')) {
    log('--socket-dir must be an absolute path');
    return { code: 2 };
  }
  const socket = (values['socket'] as string | undefined) ?? path.posix.join(dir, spec.file);
  if (!inSocketDir(socket, [dir])) {
    log(`--socket must be an absolute path directly in ${dir}, in letters, digits and . _ - only`);
    return { code: 2 };
  }
  const timeoutMs = wholeArgument(values['timeout-ms'], MAX_TIMEOUT_MS);
  if (Number.isNaN(timeoutMs)) {
    log(`--timeout-ms must be a whole number from 1 to ${MAX_TIMEOUT_MS}`);
    return { code: 2 };
  }
  const problem = system.pid === 1 || values['shared-pid-namespace'] !== true ? ownNamespaceProblem(system, system.procRoot) : null;
  if (problem !== null) {
    log(`${name} needs a PID namespace of its own and will not start: ${problem}`);
    return { code: 2 };
  }
  const sweep = values['shared-pid-namespace'] === true ? undefined : (): void => void sweepNamespace(system.pid, { procRoot: system.procRoot, kill: system.kill });
  return {
    socket,
    values,
    timeoutMs,
    sweep,
    listening: `${spec.what} sidecar listening (${sweep === undefined ? 'not sweeping: shared PID namespace, for tests' : 'sweeping its PID namespace after every job'})`,
    onFatal: options.onFatal ?? ((reason) => log(`${name} stops: ${reason}`)),
  };
}

/** Sweeps once (a fresh namespace holds nothing to kill), then starts; exit 1 when it cannot. */
export async function startPrepared(what: string, prepared: Prepared, log: (line: string) => void, start: () => Promise<Sidecar>): Promise<{ code: number } | { sidecar: Sidecar }> {
  try {
    prepared.sweep?.();
    const sidecar = await start();
    log(prepared.listening);
    return { sidecar };
  } catch (error) {
    log(`the ${what} sidecar cannot listen: ${(error as Error).message}`);
    return { code: 1 };
  }
}

const ENGINE_SPEC: SidecarSpec = {
  what: 'engine',
  dir: ENGINE_SOCKET_DIR,
  file: 'engine.sock',
  options: { engine: { type: 'string' } },
  usage: 'engine-sidecar [--socket <path in /run/pdf-engine>] [--timeout-ms <ms>] [--engine <module>] [--socket-dir <dir>] [--shared-pid-namespace]',
};

/**
 * The engine entry's logic (engine-sidecar.ts): prepareSidecar's checks (exit 2), then listen (exit 1
 * when it cannot). Its own argument: --engine <module>, the built engine-child.js by default; a
 * stand-in, for tests. --timeout-ms is per copy, default 300000.
 */
export async function sidecarMain(argv: readonly string[], env: NodeJS.ProcessEnv, log: (line: string) => void, options: MainOptions = {}): Promise<{ code: number } | { sidecar: Sidecar }> {
  const prepared = prepareSidecar(ENGINE_SPEC, argv, env, log, options);
  if ('code' in prepared) return prepared;
  const module = prepared.values['engine'] as string | undefined;
  return startPrepared('engine', prepared, log, () =>
    startSidecar({
      path: prepared.socket,
      log,
      onFatal: prepared.onFatal,
      ...(prepared.sweep === undefined ? {} : { sweep: prepared.sweep }),
      ...(module === undefined ? {} : { module }),
      ...(prepared.timeoutMs === undefined ? {} : { timeoutMs: prepared.timeoutMs }),
    }),
  );
}
