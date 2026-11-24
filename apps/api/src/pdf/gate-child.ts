// ============================================================================
// The output gate's process (gate-isolated.ts): one copy in, one verdict out,
// then exit. It reads attacker-made bytes, capped by its parent, and holds no
// environment. It leaves when its parent goes (the IPC channel closes).
//
// ARCHIVE-SEARCH S2: a job of kind "text" is answered with the text of the
// copy's pages instead (gate-text.ts), for the search index.
// ============================================================================
import type { GateJob } from './gate-isolated.js';
import { gateReply } from './gate-rules.js';
import { isTextJob, textReply } from './gate-text.js';
import { withoutCanvasWarnings } from './engine-reply.js';

console.warn = withoutCanvasWarnings(console.warn.bind(console));

process.once('disconnect', () => process.exit(1));
process.once('message', (message) => {
  const reply: Promise<unknown> = isTextJob(message) ? textReply(message) : gateReply(message as GateJob);
  void reply.then((answer) => process.send?.(answer as object, () => process.exit(0)));
});
