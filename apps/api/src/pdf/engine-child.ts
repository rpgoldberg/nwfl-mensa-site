// ============================================================================
// The redaction engine's process (isolated.ts): one message in, one answer
// out, then exit, so PDFium's and pdf.js's memory goes back to the OS.
// ============================================================================
import { type EngineMessage, engineReply, withoutCanvasWarnings } from './isolated.js';
import { redactPdf } from './redact.js';

console.warn = withoutCanvasWarnings(console.warn.bind(console));

process.once('message', (message) => {
  void engineReply(message as EngineMessage, redactPdf).then((reply) => process.send?.(reply, () => process.exit(0)));
});
