// ============================================================================
// UNTRUSTED-PDF-GATE M1 (fix round 2): preloaded in every engine and gate
// child (`--import`, no-fork.ts), so it runs before the child's own module
// and before the child is given anything to parse.
//
//   0. Checks its own oom_score_adj is 1000 (fix round 3, S5), so when a
//      pod's memory runs out the kernel takes this child, never the sidecar
//      or the worker. Its parent starts it through choom, which sets it
//      (no-fork.ts viaChoom): node cannot, being non-dumpable in the image.
//      A child without it is ended (exit 1), and its copy is refused.
//   1. Starts the libuv thread pool (one fs call) and loads node:tls (Node
//      reads its CA certificates on a thread of its own when tls first
//      loads; the real children load it, measured), so every thread the
//      child will use exists before its process limit is set. pdf.js's
//      optional canvas would start a thread pool of its own later, so it is
//      not in the image (Dockerfile, --omit=optional): with it, a child
//      that can make no thread aborts, and its copy is refused.
//   2. Says "ready" and waits for "limited" (the parent has set RLIMIT_NPROC
//      to 1). A parent that goes away ends it.
//   3. Tries to spawn /bin/true on purpose. With the limit it fails with
//      EAGAIN; the result goes to the parent once the child's own module
//      listens for its job, and the parent sends the job only on EAGAIN.
// Not covered in-process (it runs only in children); the tests drive it
// through real children (isolated.test.ts, gate-isolated.test.ts, the lift
// tests).
// ============================================================================
import { spawnSync } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import process from 'node:process';

const gone = (): never => process.exit(1);
process.once('disconnect', gone);
if (readFileSync('/proc/self/oom_score_adj', 'utf8').trim() !== '1000') gone();
await import('node:tls');
await fs.stat('/');
await new Promise<void>((resolve) => {
  const limited = (message: unknown): void => {
    if (typeof message !== 'object' || message === null || (message as { guard?: unknown }).guard !== 'limited') return;
    process.off('message', limited);
    resolve();
  };
  process.on('message', limited);
  process.send?.({ guard: 'ready' });
});
const probe = spawnSync('/bin/true', [], { env: {}, stdio: 'ignore' });
const code = probe.error === undefined ? `a process started (exit ${probe.status})` : ((probe.error as NodeJS.ErrnoException).code ?? 'unknown');
// From here the child's own disconnect handler is the one that ends it.
process.off('disconnect', gone);
const tell = (event: string | symbol): void => {
  if (event !== 'message') return;
  process.off('newListener', tell);
  setImmediate(() => process.send?.({ guard: 'listening', probe: code }));
};
process.on('newListener', tell);
