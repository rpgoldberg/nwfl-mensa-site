// ============================================================================
// UNTRUSTED-PDF-GATE: the worker's side of the engine sidecar (sidecar.ts),
// and the socket paths and transport it shares with the gate's (socket-gate.ts).
//
// With PDF_ENGINE_SOCKET set (worker.ts), every copy is made by the sidecar
// over that unix socket, one connection per copy (engine-protocol.ts), and
// PDF_GATE_SOCKET must be set too: the gate sidecar checks every copy. Each
// path must be absolute, in plain path letters only (no whitespace, no
// control character: a YAML block scalar's trailing newline is refused at
// start), and directly in its own directory: /run/pdf-engine for the engine,
// /run/pdf-gate for the gate, two emptyDirs, so the engine cannot reach the
// gate's socket. Anything else stops the worker at start.
//
// The job fails closed, and is retried (RetryableEngineError: no copy is
// stored and the file stays queued until its lease ends, at most
// MAX_ENGINE_ATTEMPTS times, regenerate.ts) when the socket is missing or is
// not a socket (a symlink is not), the sidecar cannot be reached or hangs
// up, a reply is malformed or over a cap, or no reply comes within the
// timeout. There is never a fallback to an in-pod child. A reply that says
// the engine failed on this file (its child crashed or ran out of time inside
// the sidecar) is an engine failure, as it is in the pod: a refused copy. So
// is a request that cannot be sent at all (over a cap): the same request
// would fail the same way every time, so it is refused, never retried.
// ============================================================================
import { lstat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { Env } from '../db/pool.js';
import { type Frame, FrameError, MAX_OUTPUT_BYTES, MAX_REPLY_HEADER_BYTES, REPLY_MAGIC, decodeReply, encodeRequest, readFrame } from './engine-protocol.js';
import { type Redact, RetryableEngineError } from './regenerate.js';

/** The directories the engine's socket may be in: the engine's emptyDir's mount point. */
export const ENGINE_SOCKET_DIRS: readonly string[] = ['/run/pdf-engine'];
/** The directories the gate's socket may be in: the gate's own emptyDir, never the engine's. */
export const GATE_SOCKET_DIRS: readonly string[] = ['/run/pdf-gate'];
/** The sidecar gives a copy 5 minutes (isolated.ts); the worker waits 30 s more for the reply. */
export const SOCKET_TIMEOUT_MS = 330_000;
/** sun_path holds 108 bytes on Linux, the last a NUL. */
const MAX_SOCKET_PATH_BYTES = 107;
const PATH_LETTERS = /^[A-Za-z0-9._/-]+$/;

/** Whether `value` is an absolute socket path, in plain path letters, directly in one of `dirs`. */
export function inSocketDir(value: string, dirs: readonly string[]): boolean {
  const name = path.posix.basename(value);
  return (
    PATH_LETTERS.test(value) &&
    path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    !value.endsWith('/') &&
    name !== '.' &&
    name !== '..' &&
    dirs.includes(path.posix.dirname(value)) &&
    Buffer.byteLength(value) <= MAX_SOCKET_PATH_BYTES
  );
}

/** A socket path from `variable`, checked; undefined when unset. */
function socketPathFrom(env: Env, variable: string, dirs: readonly string[]): string | undefined {
  const value = env[variable];
  if (value === undefined) return undefined;
  if (!inSocketDir(value, dirs)) throw new Error(`${variable} must be an absolute path directly in ${dirs.join(' or ')}, in letters, digits and . _ - only`);
  return value;
}

/** PDF_ENGINE_SOCKET, checked; undefined when unset. Throws for a path that is not directly in an allowed directory. */
export const engineSocketPath = (env: Env, dirs: readonly string[] = ENGINE_SOCKET_DIRS): string | undefined => socketPathFrom(env, 'PDF_ENGINE_SOCKET', dirs);

/** PDF_GATE_SOCKET, checked; undefined when unset. */
export const gateSocketPath = (env: Env, dirs: readonly string[] = GATE_SOCKET_DIRS): string | undefined => socketPathFrom(env, 'PDF_GATE_SOCKET', dirs);

/**
 * Both sockets, checked together: PDF_GATE_SOCKET is required whenever PDF_ENGINE_SOCKET is set, and the
 * two must be in different directories. Throws otherwise, so the worker refuses to start.
 */
export function workerSockets(env: Env, dirs: { engineDirs?: readonly string[] | undefined; gateDirs?: readonly string[] | undefined } = {}): { engine?: string; gate?: string } {
  const engine = engineSocketPath(env, dirs.engineDirs);
  const gate = gateSocketPath(env, dirs.gateDirs);
  if (engine !== undefined && gate === undefined) throw new Error('PDF_GATE_SOCKET must be set whenever PDF_ENGINE_SOCKET is: no copy is stored without the gate sidecar');
  if (engine !== undefined && gate !== undefined && path.posix.dirname(engine) === path.posix.dirname(gate)) throw new Error('PDF_ENGINE_SOCKET and PDF_GATE_SOCKET must be in different directories');
  return { ...(engine === undefined ? {} : { engine }), ...(gate === undefined ? {} : { gate }) };
}

/** Throws a RetryableEngineError unless `at` is a socket (not a link to one). */
async function mustBeSocket(at: string, what: 'engine' | 'gate'): Promise<void> {
  let stat;
  try {
    stat = await lstat(at);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new RetryableEngineError(code === 'ENOENT' ? `the ${what} socket is missing` : `the ${what} socket cannot be checked (${code})`);
  }
  if (!stat.isSocket()) throw new RetryableEngineError(`the ${what} socket path holds something other than a socket`);
}

/**
 * Sends one request frame to a sidecar and reads its one reply frame, to the end of the connection.
 * Every failure of the transport is a RetryableEngineError.
 */
export async function askSidecar(
  at: string,
  frame: Buffer,
  options: { what: 'engine' | 'gate'; magic: Buffer; maxHeader: number; maxBody: number; timeoutMs: number },
): Promise<Frame> {
  const { what, timeoutMs } = options;
  await mustBeSocket(at, what);
  const socket = net.createConnection({ path: at });
  let connected = false;
  socket.once('connect', () => (connected = true));
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RetryableEngineError(`the ${what} sidecar took longer than ${timeoutMs} ms`)), timeoutMs);
  });
  const read = readFrame(socket, { magic: options.magic, maxHeader: options.maxHeader, maxBody: options.maxBody, untilEnd: true });
  // The sidecar may hang up before it has read everything (a refusal); the read reports that. The
  // write side stays open until the reply: the sidecar takes an end before it as the worker gone.
  socket.on('error', () => {});
  socket.write(frame);
  try {
    return await Promise.race([read, late]);
  } catch (error) {
    if (!(error instanceof FrameError)) throw error;
    if (!connected) throw new RetryableEngineError(`the ${what} sidecar could not be reached (${error.message.replace(/^the connection failed \((.*)\)$/, '$1')})`);
    throw new RetryableEngineError(`the ${what} sidecar gave no usable reply: ${error.message}`);
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

/** An engine that makes each copy in the sidecar listening on `path`. */
export function socketRedact(options: { path: string; timeoutMs?: number }): Redact {
  const timeoutMs = options.timeoutMs ?? SOCKET_TIMEOUT_MS;
  return async (original, request) => {
    let frame: Buffer;
    try {
      frame = encodeRequest(original, request);
    } catch (error) {
      return { kind: 'refused', reason: `the engine request could not be sent: ${(error as Error).message}` };
    }
    const reply = await askSidecar(options.path, frame, { what: 'engine', magic: REPLY_MAGIC, maxHeader: MAX_REPLY_HEADER_BYTES, maxBody: MAX_OUTPUT_BYTES, timeoutMs });
    let result;
    try {
      result = decodeReply(reply);
    } catch (error) {
      throw new RetryableEngineError(`the engine sidecar gave no usable reply: ${(error as Error).message}`);
    }
    if (result.kind === 'failed') throw new Error(result.message);
    return result;
  };
}
