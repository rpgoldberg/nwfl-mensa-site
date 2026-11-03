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
// The child is forked detached, so it leads a process group, and that group is
// killed once it exits: whatever it started without leaving the group goes
// with it. A sidecar also sweeps its whole PID namespace after each copy
// (pidns.ts), which a grandchild in a session of its own cannot leave.
//
// A child that dies without an answer (a crash, or killed by the kernel when
// it runs out of memory) or takes longer than the timeout is a failed engine:
// the job stores a refused copy with the reason (regenerate.ts make()), never
// a partial one, and finishes the file, so the lease does not linger.
//
// pdf.js warns three times as it loads that the optional canvas is absent
// (gate.ts); a child loads it once per copy, so the child drops exactly those
// three lines (withoutCanvasWarnings). Everything else it writes, a crash
// included, reaches the worker's log.
// ============================================================================
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

const ENV_FILE_FLAGS = new Set(['--env-file', '--env-file-if-exists']);

/**
 * The child's Node flags: the worker's own (fork() passes process.execArgv on), minus any that load an
 * environment file (CF-ISO-0 N1). Without this, a worker started with --env-file would hand the child
 * the very variables ENGINE_ENV keeps out. Both spellings: --env-file=<path> and --env-file <path>.
 */
export function engineExecArgv(argv: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] as string;
    const name = flag.split('=', 1)[0] as string;
    if (!ENV_FILE_FLAGS.has(name)) kept.push(flag);
    else if (!flag.includes('=')) i += 1;
  }
  return kept;
}

/**
 * SIGKILLs the process group `pid` leads (a child forked detached); nothing when it is gone. Here, with
 * no import, so a plain `node` (type stripping, no resolve hook) can load this module, as the
 * --env-file test does.
 */
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

/**
 * An engine that runs each call in a new child process. `signal` (the sidecar's: the worker hung up,
 * or the sidecar is stopping) kills the child and fails the call.
 */
export function isolatedRedact(options: { module?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Redact {
  const timeoutMs = options.timeoutMs ?? ENGINE_TIMEOUT_MS;
  const { signal } = options;
  return (original, request) =>
    new Promise<RedactResult>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new Error('the engine process was stopped'));
        return;
      }
      const child = fork(options.module ?? ENGINE_CHILD, [], { env: { ...ENGINE_ENV }, execArgv: engineExecArgv(process.execArgv), serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'], detached: true });
      let reply: EngineReply | undefined;
      let late = false;
      let stopped = false;
      const timer = setTimeout(() => {
        late = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      const stop = (): void => {
        stopped = true;
        child.kill('SIGKILL');
      };
      signal?.addEventListener('abort', stop, { once: true });
      child.once('message', (message) => {
        reply = message as EngineReply;
      });
      child.once('exit', (code, killedBy) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        if (child.pid !== undefined) killGroup(child.pid);
        if (stopped) reject(new Error('the engine process was stopped'));
        else if (late) reject(new Error(`the engine process took longer than ${timeoutMs} ms`));
        else if (reply === undefined) reject(new Error(`the engine process ended without a copy (${killedBy ?? `exit ${code}`})`));
        else if (reply.ok) resolve(reply.result);
        else reject(new Error(reply.message));
      });
      const message: EngineMessage = { original, request };
      child.send(message);
    });
}
