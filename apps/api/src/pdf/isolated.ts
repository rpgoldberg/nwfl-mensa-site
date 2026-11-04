// ============================================================================
// HARDEN-1 Fix 1: the redaction engine in a process of its own, one per copy.
//
// PDFium's WebAssembly memory only grows, and pdf.js keeps its own heap, so a
// worker that ran the engine in-process stayed at its largest file's peak
// (about 1.2 GiB for a 10 MiB photo PDF). The worker now forks a child for
// each copy (engine-child.ts): the child gets the original and the request,
// answers with the result and exits, and its memory goes back to the OS. The
// worker itself only claims, reads and writes the database.
//
// The child cannot start a process (fix round 2, no-fork.ts): it is forked
// with child-guard.ts preloaded, its RLIMIT_NPROC is set to 1, and it is sent
// the original only once its own attempt to spawn failed with EAGAIN. It is
// also forked detached, so it leads a process group, which is killed once it
// exits. A sidecar, PID 1 of its container, also kills everything else in its
// namespace before each reply (pidns.ts).
//
// A child that dies without an answer (a crash, or killed by the kernel when
// it runs out of memory) or takes longer than the timeout is a failed engine:
// the job stores a refused copy with the reason (regenerate.ts make()), never
// a partial one, and finishes the file, so the lease does not linger.
//
// pdf.js warns three times as it loads that the optional canvas is absent
// (gate.ts); a child loads it once per copy, so the child drops exactly those
// three lines (withoutCanvasWarnings). What it writes to stderr reaches the
// worker's log up to CHILD_LOG_BYTES, a crash included; the rest, and all of
// its stdout, is dropped (fix round 3, S2: a subverted child could fill the
// container log, and the kubelet evicts the pod for it).
// ============================================================================
import { fork } from 'node:child_process';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { CHILD_PERMISSION, type LimitForks, guardFlag, isGuardMessage, limitForks, viaChoom, watchGuard } from './no-fork.js';
import type { RedactRequest, RedactResult } from './redact.js';
import type { Redact } from './regenerate.js';

/** What the worker sends a child. */
export interface EngineMessage {
  original: Uint8Array;
  request: RedactRequest;
}

/** What a child answers. */
export type EngineReply = { ok: true; result: RedactResult } | { ok: false; message: string };

/** The built child next to this module (dist/pdf/engine-child.js). */
export const ENGINE_CHILD = fileURLToPath(new URL('./engine-child.js', import.meta.url));

/**
 * The child's whole environment (CF-ISO-0): nothing. The child parses untrusted PDFs, so it must not
 * inherit the worker's (PGPASSWORD, PGUSER, PGHOST and the rest). It is forked by absolute path with
 * process.execPath, so it needs no PATH; it reads no variable it needs (a probe of every process.env
 * read during real copies found only Node's own and the absent optional canvas's), and its copies
 * are byte-identical with and without the worker's environment. Add a name here only with that proof.
 * Residual: the child runs as the same uid, so it could still read /proc/<ppid>/environ; closing that
 * needs a separate uid or no-new-privs in the worker's securityContext.
 */
export const ENGINE_ENV: Readonly<NodeJS.ProcessEnv> = Object.freeze({});

/**
 * The parent's Node flags a child may keep (fix round 6, S2b): the sidecars' --disable-sigusr1, two that only
 * change what is logged, and those the test runner and the TypeScript loader need. Anything else the worker or a
 * sidecar was started with is dropped, so no environment file, no grant or audit mode of the permission model, and
 * no flag a later Node adds reaches a child. Names are read with _ as -, as Node reads them.
 */
const KEPT_FLAGS = new Set(['--disable-sigusr1', '--enable-source-maps', '--no-warnings', '--experimental-import-meta-resolve', '--experimental-strip-types', '--experimental-transform-types']);
/** Kept with their value, given as --flag=value or as the next argument. */
const KEPT_WITH_VALUE = new Set(['--disable-warning', '--import', '--require', '-r', '--conditions', '-C']);

/**
 * The child's Node flags: those of the worker's own (fork() passes process.execArgv on) on the lists above, each
 * with its value. Before this was a list of what to drop (CF-ISO-0 N1: --env-file; fix round 4 and 5, S2: the
 * permission model's flags and grants); the round-6 challenge got --permission-audit and --allow_fs_write=* past it.
 */
export function engineExecArgv(argv: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] as string;
    const [raw = '', value] = flag.split(/=(.*)/s, 2);
    const name = raw.startsWith('--') ? `--${raw.slice(2).replaceAll('_', '-')}` : raw;
    if (KEPT_FLAGS.has(name) && value === undefined) kept.push(flag);
    else if (KEPT_WITH_VALUE.has(name)) {
      if (value !== undefined) kept.push(flag);
      else if (i + 1 < argv.length) kept.push(flag, argv[++i] as string);
    }
  }
  return kept;
}

/** SIGKILLs the process group `pid` leads (a child forked detached); nothing when it is gone. */
export function killGroup(pid: number, kill: (pid: number, signal: NodeJS.Signals) => void = (target, signal) => void process.kill(target, signal)): void {
  try {
    kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/** Ten minutes is the job's lease; a copy that takes half of it is given up. */
export const ENGINE_TIMEOUT_MS = 300_000;

/** The child's side: runs the engine on one message; never throws. */
export async function engineReply(message: EngineMessage, redact: Redact): Promise<EngineReply> {
  try {
    return { ok: true, result: await redact(message.original, message.request) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

const CANVAS_WARNING = /^Warning: Cannot (?:load "@napi-rs\/canvas" package|polyfill `(?:DOMMatrix|Path2D)`)/;

/** console.warn without pdf.js's load-time canvas warnings (the image leaves the canvas out on purpose). */
export function withoutCanvasWarnings(warn: (...args: unknown[]) => void): (...args: unknown[]) => void {
  return (...args) => {
    if (typeof args[0] === 'string' && CANVAS_WARNING.test(args[0])) return;
    warn(...args);
  };
}

export interface IsolatedOptions {
  /** The child (default the built engine-child.js); another module, for tests. */
  module?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** The guard preloaded in the child (default no-fork.ts CHILD_GUARD); another, for tests. */
  guard?: string;
  /** How the child's process limit is set (default prlimit); another, for tests. */
  limit?: LimitForks;
  /** Where the child's stderr goes, capped (default this process's stderr); a spy, for tests. */
  log?: (chunk: Buffer) => void;
  /** Whether the child runs under the permission model (default true: CHILD_PERMISSION); false only for tests of the layers behind it. */
  permission?: boolean;
}

/** How much of one child's stderr reaches the log (S2). */
export const CHILD_LOG_BYTES = 64 * 1024;
/** What V8 writes when a heap runs out, before it aborts (N1). */
const HEAP_OOM = 'JavaScript heap out of memory';
const DROPPED = "\n[the rest of this child's log is dropped]\n";

/** A child's stderr, read to its end: whether V8 said its heap ran out, and when the stream is done. */
export interface ChildLog {
  ended: Promise<void>;
  heapOutOfMemory(): boolean;
}

/**
 * Reads a child's stderr to its end: the first `cap` bytes go to `write`, then one line saying the rest is
 * dropped, and the rest is read and dropped, so the child never blocks on a full pipe and never fills the
 * log. Notes V8's heap-out-of-memory line wherever it falls (N1).
 */
export function relayChildLog(stream: Readable | null, write: (chunk: Buffer) => void = (chunk) => void process.stderr.write(chunk), cap = CHILD_LOG_BYTES): ChildLog {
  let left = cap;
  let noted = false;
  let tail = '';
  let oom = false;
  const ended = new Promise<void>((resolve) => {
    if (stream === null) {
      resolve();
      return;
    }
    stream.on('data', (chunk: Buffer) => {
      const part = chunk.subarray(0, left);
      left -= part.length;
      if (part.length > 0) write(part);
      if (part.length < chunk.length && !noted) {
        noted = true;
        write(Buffer.from(DROPPED));
      }
      const text = tail + chunk.toString('latin1');
      if (text.includes(HEAP_OOM)) oom = true;
      tail = text.slice(-HEAP_OOM.length);
    });
    stream.once('end', resolve);
    stream.once('close', resolve);
    stream.once('error', resolve);
  });
  return { ended, heapOutOfMemory: () => oom };
}

/**
 * An engine that runs each call in a new child process, which cannot start a process of its own
 * (no-fork.ts): it is sent the original only once its limit holds. `signal` (the sidecar's: the
 * worker hung up, or the sidecar is stopping) kills the child and fails the call.
 */
export function isolatedRedact(options: IsolatedOptions = {}): Redact {
  const timeoutMs = options.timeoutMs ?? ENGINE_TIMEOUT_MS;
  const { signal } = options;
  return (original, request) =>
    new Promise<RedactResult>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new Error('the engine process was stopped'));
        return;
      }
      // The permission model's flags after the inherited ones, so none of those undoes them (fix round 5, S2).
      const execArgv = [...engineExecArgv(process.execArgv), ...(options.permission === false ? [] : CHILD_PERMISSION), guardFlag(options.guard)];
      const child = fork(options.module ?? ENGINE_CHILD, [], { env: { ...ENGINE_ENV }, ...viaChoom(execArgv), serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'], detached: true });
      relayChildLog(child.stderr, options.log);
      let reply: EngineReply | undefined;
      let late = false;
      let stopped = false;
      let unguarded: string | undefined;
      const timer = setTimeout(() => {
        late = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      const stop = (): void => {
        stopped = true;
        child.kill('SIGKILL');
      };
      signal?.addEventListener('abort', stop, { once: true });
      child.on('message', (message) => {
        if (!isGuardMessage(message) && reply === undefined) reply = message as EngineReply;
      });
      watchGuard(
        child,
        options.limit ?? limitForks,
        () => child.send({ original, request } satisfies EngineMessage, () => {}),
        (why) => {
          unguarded = why;
          child.kill('SIGKILL');
        },
      );
      child.once('exit', (code, killedBy) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        if (child.pid !== undefined) killGroup(child.pid);
        if (unguarded !== undefined) reject(new Error(`the engine process was refused: ${unguarded}`));
        else if (stopped) reject(new Error('the engine process was stopped'));
        else if (late) reject(new Error(`the engine process took longer than ${timeoutMs} ms`));
        else if (reply === undefined) reject(new Error(`the engine process ended without a copy (${killedBy ?? `exit ${code}`})`));
        else if (reply.ok) resolve(reply.result);
        else reject(new Error(reply.message));
      });
    });
}
