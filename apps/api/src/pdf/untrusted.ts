// ============================================================================
// UNTRUSTED-PDF-GATE (NEEDS.md): whether an untrusted PDF may reach the parser.
//
// Today the only PDFs parsed are the issue loader's (load/load.ts), which Ross
// runs by hand. An officer upload (R3d), the archive import (ARCH-1) or any new
// RPC or tool that stores an original waits until BOTH hold:
//   1. the engine runs as a sidecar in the worker pod: its own uid, no env
//      secrets, no secret volumes, no shared process namespace, reached over a
//      unix socket on an emptyDir, still forking per copy inside;
//   2. the redaction output gate is re-run outside the engine on every copy,
//      before pdf_copy_put.
// test/gates/untrusted-pdf.test.ts fails while this is false and anything
// besides the loader stores an original, a migration lets another role call
// pdf_original_put, or a request message carries bytes. It also fails if this
// is set to true while either test below is missing:
//   sidecar test: test/pdf/engine-sidecar.test.ts
//   gate re-run test: test/pdf/gate-rerun.test.ts
// ============================================================================

/** True only once the sidecar and the out-of-child gate re-run, and their tests above, exist. */
export const UNTRUSTED_PDF_READY: boolean = false;
