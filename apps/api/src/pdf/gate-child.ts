// ============================================================================
// The output gate's process (gate-isolated.ts): one copy in, one verdict out,
// then exit. It reads attacker-made bytes, capped by its parent, and holds no
// environment. It leaves when its parent goes (the IPC channel closes).
// ============================================================================
import type { GateJob } from './gate-isolated.js';
import { gateReply } from './gate-rules.js';
import { withoutCanvasWarnings } from './isolated.js';

console.warn = withoutCanvasWarnings(console.warn.bind(console));

process.once('disconnect', () => process.exit(1));
process.once('message', (message) => {
  void gateReply(message as GateJob).then((reply) => process.send?.(reply, () => process.exit(0)));
});
