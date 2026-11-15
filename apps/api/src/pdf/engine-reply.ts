// ============================================================================
// The PDF children's side of isolated.ts: what a child is sent and answers,
// and the console filter it installs. Split out (LG-N3) so the children
// (engine-child.ts, gate-child.ts) load only this, never the parent's log
// relay and the site redactor it uses (platform/), nor OpenTelemetry.
// isolated.ts re-exports all of it.
// ============================================================================
import type { RedactRequest, RedactResult } from './redact.js';
import type { Redact } from './regenerate.js';

/** What the worker sends a child. */
export interface EngineMessage {
  original: Uint8Array;
  request: RedactRequest;
}

/** What a child answers. */
export type EngineReply = { ok: true; result: RedactResult } | { ok: false; message: string };

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
