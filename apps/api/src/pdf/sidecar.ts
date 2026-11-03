// ============================================================================
// UNTRUSTED-PDF-GATE (1): the PDF engine as a sidecar process, meant for a
// container of its own in the worker's pod: its own uid and gid, no Secret in
// its env or volumes, no shared process namespace, no network (README, "The
// engine sidecar", lists what fc's manifest gives it). From the same image,
// started with `command: ["node", "--disable-sigusr1", "dist/pdf/
// engine-sidecar.js"]`, so node is PID 1 and no init runs (fix round 2). The
// gate sidecar (gate-service.ts) is served by the same code here.
//
//   - At start it refuses (exit 2) an environment holding any variable not on
//     ALLOWED_ENV: an allow-list, so a credential under a name nobody thought
//     of is refused too (fix round 1, S2).
//   - It binds only directly in its own directory (/run/pdf-engine; the gate
//     /run/pdf-gate), each an emptyDir only it and the worker mount, on one
//     unix socket of mode 0660: the socket's group is the pod's fsGroup.
//   - It must be PID 1 of its container and not root (exit 2), and in
//     production it needs --disable-sigusr1 (exit 2). As PID 1 the kernel
//     keeps SIGKILL, SIGSTOP and every signal it has no handler for away from
//     it, so a child cannot freeze it; Node's inspector signal is taken by a
//     listener and the flag, and so is every other signal Node lets it hold
//     (holdSignals). A child can still make it exit (fix round 3, N2): it
//     fails closed, with no reply.
//   - Each job's child cannot start a process (no-fork.ts). Before every
//     reply the sidecar kills everything else in its namespace and waits
//     until it is alone (pidns.ts clearNamespace), then checks that its
//     socket path still holds the socket it bound (device and inode) with
//     mode 0660 and its owner and group as bound (fix round 3, S1). Either
//     failing stops it without a reply (the entry exits 1, and the kernel
//     kills the whole namespace with it); the worker's job fails closed. It
//     also checks the socket at each connection and every WATCH_MS.
//   - Per connection: the first bytes within FIRST_BYTES_TIMEOUT_MS, one
//     request frame (engine-protocol.ts) within READ_TIMEOUT_MS and the
//     caps, validated to the field; anything else is dropped without an
//     answer. Then one job in a child forked for it alone with an empty
//     environment (isolated.ts, gate-isolated.ts), killed at its timeout or
//     as soon as the worker hangs up, and one reply.
//   - One job at a time: the worker asks one by one, and a second PDFium heap
//     would only double the peak.
// ============================================================================
import { type Stats, chmodSync, lstatSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { FIRST_BYTES_TIMEOUT_MS, type Frame, MAX_INPUT_BYTES, MAX_REQUEST_HEADER_BYTES, REQUEST_MAGIC, type SidecarReply, decodeRequest, encodeReply, readFrame } from './engine-protocol.js';
import { ENGINE_CHILD, ENGINE_TIMEOUT_MS, type EngineMessage, isolatedRedact } from './isolated.js';
import { type Kill, clearNamespace, pid1Problem } from './pidns.js';
import { inSocketDir } from './socket-engine.js';

export const ENGINE_SOCKET_DIR = '/run/pdf-engine';
export const DEFAULT_SOCKET = `${ENGINE_SOCKET_DIR}/engine.sock`;
export const SOCKET_MODE = 0o660;
/** A whole request (at most 30 MiB, over a local socket) arrives well within this. */
export const READ_TIMEOUT_MS = 30_000;
/** How often a sidecar checks that its socket is still the one it bound. */
export const WATCH_MS = 1_000;
/** Connections past this are closed at once (net.Server maxConnections). */
export const MAX_CONNECTIONS = 8;
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
  /** After every job, before its reply (pidns.ts clearNamespace): null when the namespace is clear; a reason, or a throw, stops the sidecar. */
  sweep?: () => Promise<string | null>;
  /** The socket is not the one bound any more, or the namespace is not clear: the sidecar has stopped. Default: logged. */
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
/** The socket as bound: its device and inode, and its mode, owner and group. */
export interface BoundSocket {
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  gid: number;
}

/**
 * How the entry at the socket's path differs from the socket as bound: "gone" (removed, or another file or
 * socket in its place), "changed" (the same socket with another mode than SOCKET_MODE, or another owner or
 * group: a child of the sidecar's uid can chmod it in place and lock the worker out, fix round 3, S1), or null.
 */
export function socketDrift(bound: BoundSocket, now: Pick<Stats, 'dev' | 'ino' | 'mode' | 'uid' | 'gid' | 'isSocket'> | undefined): 'gone' | 'changed' | null {
  if (now === undefined || !now.isSocket() || now.dev !== bound.dev || now.ino !== bound.ino) return 'gone';
  if ((now.mode & 0o7777) !== SOCKET_MODE || now.uid !== bound.uid || now.gid !== bound.gid) return 'changed';
  return null;
}

export async function serveFrames<M>(options: ServeOptions, protocol: Protocol<M>): Promise<Sidecar> {
  const { log } = options;
  const connections = new Set<net.Socket>();
  const jobs = new Set<AbortController>();
  let queue: Promise<unknown> = Promise.resolve();
  /** The socket as bound, and the timer that watches it; set once it listens. */
  const bound: { socket?: BoundSocket; watch?: NodeJS.Timeout } = {};
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

  /** Whether the path still holds the very socket this sidecar bound, with its mode, owner and group; stops it when not. */
  function intact(): boolean {
    if (stopped) return false;
    let now: Stats | undefined;
    try {
      now = lstatSync(options.path);
    } catch {
      now = undefined;
    }
    const drift = socketDrift(bound.socket as BoundSocket, now);
    if (drift === null) return true;
    fail(drift === 'gone' ? `the socket at ${options.path} was replaced or removed` : `the socket at ${options.path} changed its mode or owner`);
    return false;
  }

  /** After a job's child is gone: the namespace cleared, then the socket checked, before any reply. */
  async function afterJob(): Promise<void> {
    let problem: string | null;
    try {
      problem = (await options.sweep?.()) ?? null;
    } catch (error) {
      problem = `its check failed (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`;
    }
    if (problem !== null) fail(`its PID namespace is not clear before a reply: ${problem}`);
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
          await afterJob();
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
  const { dev, ino, mode, uid, gid } = lstatSync(options.path);
  bound.socket = { dev, ino, mode, uid, gid };
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

/** What a sidecar's entry sees of its process; tests give a made-up one (never the real kill with pid 1). */
export interface System {
  pid: number;
  uid: number;
  procRoot: string;
  kill: Kill;
  execArgv: readonly string[];
}

export interface MainOptions {
  system?: System;
  /** The sidecar stopped (its socket replaced or gone, or its namespace not clear before a reply): the entry exits 1. */
  onFatal?: (reason: string) => void;
}

const thisProcess = (): System => ({ pid: process.pid, uid: process.getuid?.() ?? -1, procRoot: '/proc', kill: (pid, signal) => void process.kill(pid, signal), execArgv: process.execArgv });

/**
 * The signals that end a process by default and that Node lets a listener take, beside SIGTERM and SIGINT
 * (the entries' clean stop) and the faults (SIGSEGV, SIGBUS, SIGFPE, SIGILL), which must still end it.
 */
export const HELD_SIGNALS: readonly NodeJS.Signals[] = ['SIGHUP', 'SIGQUIT', 'SIGTRAP', 'SIGABRT', 'SIGUSR2', 'SIGALRM', 'SIGVTALRM', 'SIGPROF', 'SIGIO', 'SIGPWR', 'SIGSTKFLT', 'SIGSYS', 'SIGXCPU', 'SIGXFSZ'];

/**
 * Takes SIGUSR1, and each of HELD_SIGNALS, with a listener that does nothing. Node's own SIGUSR1 handler
 * starts the inspector on 127.0.0.1:9229, which a child could then drive over loopback; as PID 1 the
 * sidecar still gets any signal it has a handler for. The others (fix round 3, N2): the kernel drops a
 * signal with no handler that a child sends PID 1, but a burst of one Node handles (SIGCHLD) followed by
 * one of these ended PID 1 in the round-3 challenge. Real-time signals cannot be listened for in Node,
 * so a child can still make the sidecar exit; it fails closed (no reply, the job retried). It cannot
 * freeze it. The entries call this first; --disable-sigusr1 is required too.
 */
export function holdSignals(target: Pick<NodeJS.Process, 'on'> = process): void {
  target.on('SIGUSR1', () => {});
  for (const signal of HELD_SIGNALS) target.on(signal, () => {});
}

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
  sweep: (() => Promise<string | null>) | undefined;
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
 * socket outside the sidecar's own directory, the test-only flags in production, root, any pid but 1,
 * and, in production, a missing --disable-sigusr1 (exit 2). Common arguments:
 *   --socket <path>          directly in the sidecar's directory; default <dir>/<file>
 *   --timeout-ms <ms>        per job
 *   --socket-dir <dir>       another directory, for tests (refused when NODE_ENV=production)
 *   --shared-pid-namespace   not PID 1 and nothing cleared, for tests (refused when NODE_ENV=production)
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
  const shared = values['shared-pid-namespace'] === true;
  const problem = shared ? (system.uid === 0 ? 'it runs as root' : null) : pid1Problem(system);
  if (problem !== null) {
    log(`${name} must be PID 1 of its container and will not start: ${problem}`);
    return { code: 2 };
  }
  if (env['NODE_ENV'] === 'production' && !system.execArgv.includes('--disable-sigusr1')) {
    log(`${name} will not start without --disable-sigusr1: as PID 1 it still gets SIGUSR1, which would open Node's inspector to a child`);
    return { code: 2 };
  }
  const sweep = shared ? undefined : (): Promise<string | null> => clearNamespace({ self: system.pid, procRoot: system.procRoot, kill: system.kill });
  return {
    socket,
    values,
    timeoutMs,
    sweep,
    listening: `${spec.what} sidecar listening (${sweep === undefined ? 'not PID 1: shared PID namespace, for tests; nothing is cleared' : 'PID 1: clearing its PID namespace before every reply'})`,
    onFatal: options.onFatal ?? ((reason) => log(`${name} stops: ${reason}`)),
  };
}

/** Clears its namespace once (a fresh one holds nothing else), then starts; exit 1 when it cannot. */
export async function startPrepared(what: string, prepared: Prepared, log: (line: string) => void, start: () => Promise<Sidecar>): Promise<{ code: number } | { sidecar: Sidecar }> {
  try {
    const problem = (await prepared.sweep?.()) ?? null;
    if (problem !== null) throw new Error(`its PID namespace is not clear: ${problem}`);
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
