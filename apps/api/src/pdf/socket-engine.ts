// ============================================================================
// UNTRUSTED-PDF-GATE: the worker's side of the engine sidecar (sidecar.ts).
//
// With PDF_ENGINE_SOCKET set (worker.ts), every copy is made by the sidecar
// over that unix socket, one connection per copy (engine-protocol.ts). The
// path must be absolute and directly in an allowed directory, /run/pdf-engine,
// the emptyDir both containers mount; anything else stops the worker at start.
//
// The job fails closed, and is retried (RetryableEngineError: no copy is
// stored and the file stays queued until its lease ends) when the socket is
// missing or is not a socket, the sidecar cannot be reached or hangs up, a
// reply is malformed or over a cap, or no reply comes within the timeout.
// There is never a fallback to the in-pod child. A reply that says the engine
// failed on this file (its child crashed or ran out of time inside the
// sidecar) is an engine failure, as it is in the pod: a refused copy.
// ============================================================================
import { lstat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { Env } from '../db/pool.js';
import { FrameError, MAX_OUTPUT_BYTES, MAX_REPLY_HEADER_BYTES, REPLY_MAGIC, decodeReply, encodeRequest, readFrame } from './engine-protocol.js';
import { type Redact, RetryableEngineError } from './regenerate.js';

/** The directories a socket may be in: the shared emptyDir's mount point. */
export const ENGINE_SOCKET_DIRS: readonly string[] = ['/run/pdf-engine'];
/** The sidecar gives a copy 5 minutes (isolated.ts); the worker waits 30 s more for the reply. */
export const SOCKET_TIMEOUT_MS = 330_000;
/** sun_path holds 108 bytes on Linux, the last a NUL. */
const MAX_SOCKET_PATH_BYTES = 107;

/** PDF_ENGINE_SOCKET, checked; undefined when unset. Throws for a path that is not directly in an allowed directory. */
export function engineSocketPath(env: Env, dirs: readonly string[] = ENGINE_SOCKET_DIRS): string | undefined {
  const value = env['PDF_ENGINE_SOCKET'];
  if (value === undefined) return undefined;
  const name = path.posix.basename(value);
  const ok =
    path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    !value.endsWith('/') &&
    name !== '.' &&
    name !== '..' &&
    dirs.includes(path.posix.dirname(value)) &&
    Buffer.byteLength(value) <= MAX_SOCKET_PATH_BYTES;
  if (!ok) throw new Error(`PDF_ENGINE_SOCKET must be an absolute path directly in ${dirs.join(' or ')}`);
  return value;
}

/** Throws a RetryableEngineError unless `at` is a socket (not a link to one). */
async function mustBeSocket(at: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(at);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new RetryableEngineError(code === 'ENOENT' ? 'the engine socket is missing' : `the engine socket cannot be checked (${code})`);
  }
  if (!stat.isSocket()) throw new RetryableEngineError('the engine socket path holds something other than a socket');
}

/** An engine that makes each copy in the sidecar listening on `path`. */
export function socketRedact(options: { path: string; timeoutMs?: number }): Redact {
  const timeoutMs = options.timeoutMs ?? SOCKET_TIMEOUT_MS;
  return async (original, request) => {
    let frame: Buffer;
    try {
      frame = encodeRequest(original, request);
    } catch (error) {
      throw new RetryableEngineError(`the engine request could not be sent: ${(error as Error).message}`);
    }
    await mustBeSocket(options.path);
    const socket = net.createConnection({ path: options.path });
    let connected = false;
    socket.once('connect', () => (connected = true));
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new RetryableEngineError(`the engine sidecar took longer than ${timeoutMs} ms`)), timeoutMs);
    });
    const read = readFrame(socket, { magic: REPLY_MAGIC, maxHeader: MAX_REPLY_HEADER_BYTES, maxBody: MAX_OUTPUT_BYTES, untilEnd: true });
    // The sidecar may hang up before it has read everything (a refusal); the read reports that. The
    // write side stays open until the reply: the sidecar takes an end before it as the worker gone.
    socket.on('error', () => {});
    socket.write(frame);
    try {
      const reply = decodeReply(await Promise.race([read, late]));
      if (reply.kind === 'failed') throw new Error(reply.message);
      return reply;
    } catch (error) {
      if (!(error instanceof FrameError)) throw error;
      if (!connected) throw new RetryableEngineError(`the engine sidecar could not be reached (${error.message.replace(/^the connection failed \((.*)\)$/, '$1')})`);
      throw new RetryableEngineError(`the engine sidecar gave no usable reply: ${error.message}`);
    } finally {
      clearTimeout(timer);
      socket.destroy();
    }
  };
}
