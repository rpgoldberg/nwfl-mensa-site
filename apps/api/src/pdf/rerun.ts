// ============================================================================
// UNTRUSTED-PDF-GATE (2): the redaction output gate (gate.ts), re-run in the
// worker on every copy an engine returns, before pdf_copy_put.
//
// The engine runs the gate on its own copy (redact.ts), but the engine is the
// part that parses untrusted PDFs: if it is subverted, so is its gate. So the
// worker, which never ran the engine's code, reads the bytes it was handed
// once more, over either transport (the in-pod child or the sidecar,
// worker.ts). Only a pass goes on to be stored; a hit, or a gate that cannot
// read the copy, stores a refused copy with RERUN_REFUSAL, a fixed reason that
// echoes nothing from the copy or the engine.
//
// Cost: pdf.js and pdf-lib now load in the worker process too (the gate's
// readers, no PDFium), and read each copy once more.
// ============================================================================
import { checkCopy } from './gate.js';
import type { Redact } from './regenerate.js';

export const RERUN_REFUSAL = 'the output gate, re-run in the worker, found withheld text in the copy';

type Gate = (pdf: Uint8Array, quotes: readonly string[]) => Promise<string | null>;

/** `engine`, with every copy it returns checked again by the output gate here; `gate` is for tests. */
export function withGateRerun(engine: Redact, gate: Gate = checkCopy): Redact {
  return async (original, request) => {
    const result = await engine(original, request);
    if (result.kind !== 'redacted') return result;
    // The quotes as the engine takes them (redact.ts redactPdf).
    const quotes = [...new Set(request.quotes.map((quote) => quote.trim()).filter((quote) => quote !== ''))];
    let found: string | null;
    try {
      found = await gate(result.pdf, quotes);
    } catch {
      found = 'the gate could not read the copy';
    }
    return found === null ? result : { kind: 'refused', reason: RERUN_REFUSAL };
  };
}
