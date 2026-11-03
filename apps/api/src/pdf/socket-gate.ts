// ============================================================================
// UNTRUSTED-PDF-GATE M2: the worker's side of the gate sidecar (gate-service.ts).
//
// With PDF_GATE_SOCKET set (worker.ts), every copy is checked by the gate
// sidecar over that unix socket, one connection per check: the worker sends
// the copy and its original with their sha256s, the quotes and the image
// policy, and gets back a verdict with the sha256 of the bytes the gate
// checked (rerun.ts compares it with the copy it will store). The worker
// itself parses nothing.
//
// A gate that cannot be asked (its socket missing or not a socket, the
// sidecar dead, hanging up, answering garbage or late) fails the job closed,
// retryably, as the engine's transport does (socket-engine.ts askSidecar),
// under the attempt cap; never a fallback, never a pass. A check that cannot
// be sent (over a cap) gives no pass: the copy is refused.
// ============================================================================
import { GATE_REPLY_MAGIC, MAX_GATE_REPLY_HEADER_BYTES, decodeGateReply, encodeGateRequest, sha256Hex } from './engine-protocol.js';
import type { GateJob, GateOutcome } from './gate-isolated.js';
import { RetryableEngineError } from './regenerate.js';
import { askSidecar } from './socket-engine.js';

/** The gate gives a check 120 s (gate-isolated.ts); the worker waits 30 s more for the reply. */
export const GATE_SOCKET_TIMEOUT_MS = 150_000;

/** A gate that checks each copy in the gate sidecar listening on `path`. */
export function socketGate(options: { path: string; timeoutMs?: number }): (job: GateJob & { sha256: string }) => Promise<GateOutcome> {
  const timeoutMs = options.timeoutMs ?? GATE_SOCKET_TIMEOUT_MS;
  return async (job) => {
    let frame: Buffer;
    try {
      frame = encodeGateRequest({ copy: job.copy, original: job.original, quotes: [...job.quotes], image: job.image, sha256: job.sha256, originalSha256: sha256Hex(job.original) });
    } catch {
      return { verdict: { pass: false, code: 'unfinished' }, sha256: null };
    }
    const reply = await askSidecar(options.path, frame, { what: 'gate', magic: GATE_REPLY_MAGIC, maxHeader: MAX_GATE_REPLY_HEADER_BYTES, maxBody: 0, timeoutMs });
    try {
      return decodeGateReply(reply);
    } catch (error) {
      throw new RetryableEngineError(`the gate sidecar gave no usable reply: ${(error as Error).message}`);
    }
  };
}
