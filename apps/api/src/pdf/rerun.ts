// ============================================================================
// UNTRUSTED-PDF-GATE (2): the redaction output gate re-run on every copy an
// engine returns, before pdf_copy_put, outside the engine AND outside the
// worker (fix round 1, M2).
//
// The engine runs the gate on its own copy (redact.ts), but the engine is the
// part that parses untrusted PDFs: if it is subverted, so is its gate, and its
// copy is attacker-made bytes. So the copy is read once more by a gate that
// never ran the engine's code, and never in the worker, which holds the
// database login:
//   - sidecar mode (PDF_GATE_SOCKET, socket-gate.ts): the gate sidecar, its
//     own container and uid, one capped child per check;
//   - in-pod mode (no sockets: the pre-sidecar mode only): a capped child of
//     the worker (gate-isolated.ts), no environment, a heap cap, a memory
//     watchdog and a deadline.
// The worker sends the copy, its sha256, the original (for its pictures), the
// image policy and the quotes as the engine takes them. A pass names the
// copy's own sha256 and carries the bytes the gate checked: its own writing
// of the copy (gate-rules.ts gateReply, fix round 3, M1). Only those bytes
// are stored, once their sha256 is the one the gate names; the engine's copy
// never is, so a reader gets what the gate read. Anything else stores a refused
// copy with a fixed reason per code (RERUN_REASONS), which echoes nothing from
// the copy, the engine or the gate. A gate that cannot be asked fails the job
// retryably (RetryableEngineError), under the attempt cap.
// ============================================================================
import { type GateCode, sha256Hex } from './engine-protocol.js';
import { type GateJob, type GateOutcome, isolatedGate } from './gate-isolated.js';
import { type Redact, RetryableEngineError } from './regenerate.js';

export const RERUN_REASONS: Readonly<Record<GateCode, string>> = {
  withheld: 'the output gate, re-run outside the engine, found withheld text in the copy or could not read all of it',
  rules: 'the output gate, re-run outside the engine, found active content, an attached file or a picture its policy forbids in the copy',
  unfinished: 'the output gate, re-run outside the engine, could not finish checking the copy',
  mismatch: 'the output gate checked other bytes than the copy',
};
export const RERUN_REFUSAL = RERUN_REASONS.withheld;

/** A gate: given a copy with its sha256, a verdict and the sha256 of what it checked. */
export type Gate = (job: GateJob & { sha256: string }) => Promise<GateOutcome>;

/** `engine`, with every copy it returns checked by `gate` (by default the in-pod capped child) before it may be stored. */
export function withGateRerun(engine: Redact, gate: Gate = isolatedGate()): Redact {
  return async (original, request) => {
    const result = await engine(original, request);
    if (result.kind !== 'redacted') return result;
    const copy = result.pdf;
    const sha256 = sha256Hex(copy);
    // The quotes as the engine takes them (redact.ts redactPdf).
    const quotes = [...new Set(request.quotes.map((quote) => quote.trim()).filter((quote) => quote !== ''))];
    let outcome: GateOutcome;
    try {
      outcome = await gate({ copy, original, quotes, image: request.image ?? 'show', sha256 });
    } catch (error) {
      if (error instanceof RetryableEngineError) throw error;
      return { kind: 'refused', reason: RERUN_REASONS.unfinished };
    }
    if (!outcome.verdict.pass) return { kind: 'refused', reason: RERUN_REASONS[outcome.verdict.code] };
    // The pass is about this copy, and the bytes stored are the very bytes the gate checked.
    const { checked } = outcome;
    if (outcome.sha256 !== sha256 || checked === undefined || sha256Hex(checked.pdf) !== checked.sha256) return { kind: 'refused', reason: RERUN_REASONS.mismatch };
    return { ...result, pdf: checked.pdf };
  };
}
