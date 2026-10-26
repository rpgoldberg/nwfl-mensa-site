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

/** Ten minutes is the job's lease; a copy that takes half of it is given up. */
const DEFAULT_TIMEOUT_MS = 300_000;

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

/** An engine that runs each call in a new child process. */
export function isolatedRedact(options: { module?: string; timeoutMs?: number } = {}): Redact {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (original, request) =>
    new Promise<RedactResult>((resolve, reject) => {
      const child = fork(options.module ?? ENGINE_CHILD, [], { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      let reply: EngineReply | undefined;
      let late = false;
      const timer = setTimeout(() => {
        late = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.once('message', (message) => {
        reply = message as EngineReply;
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (late) reject(new Error(`the engine process took longer than ${timeoutMs} ms`));
        else if (reply === undefined) reject(new Error(`the engine process ended without a copy (${signal ?? `exit ${code}`})`));
        else if (reply.ok) resolve(reply.result);
        else reject(new Error(reply.message));
      });
      const message: EngineMessage = { original, request };
      child.send(message);
    });
}
