// ============================================================================
// UNTRUSTED-PDF-GATE M1 (fix round 2): a per-copy child cannot start a process.
//
// Every engine and gate child (isolated.ts, gate-isolated.ts) is forked with
// child-guard.ts preloaded. Before the child's own module runs, the guard
// starts the thread pool (so every thread the child needs exists), says it
// is ready, and waits. The parent then sets the child's RLIMIT_NPROC to 1
// with prlimit: no new process or thread, whatever else of the uid runs on
// the node (the kernel counts the limit per uid across the node, so a limit
// of 1 leaves no slack). The guard then tries to spawn a process on purpose
// and reports the result once the child's own module is listening; the
// parent sends the job only on EAGAIN. A limit that cannot be set, a spawn
// that works, or any other answer refuses the copy (fail closed).
//
// Measured in a container: after the limit, spawn and fork fail with EAGAIN,
// and the child's threaded work (zlib, crypto, fs, wasm, GC) still runs on
// the threads it already has.
// ============================================================================
import { type ChildProcess, execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The guard next to this module: the built child-guard.js, or child-guard.ts when the source runs as is. */
export const CHILD_GUARD = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './child-guard.ts' : './child-guard.js', import.meta.url));
/** The absolute path, so no PATH is looked up; util-linux's, in the image and on any Linux host. */
export const PRLIMIT = '/usr/bin/prlimit';
/** What the guard must see from its own spawn once the limit holds. */
export const BLOCKED = 'EAGAIN';

/** The Node flag that preloads `guard` in a child (it must come after any flag that loads the TS hook). */
export const guardFlag = (guard: string = CHILD_GUARD): string => `--import=${pathToFileURL(guard).href}`;

/** Sets a child's RLIMIT_NPROC to 1 (soft and hard). Rejects when it cannot. */
export type LimitForks = (pid: number) => Promise<void>;

export const limitForks: LimitForks = (pid) =>
  new Promise((resolve, reject) => {
    execFile(PRLIMIT, ['--pid', String(pid), '--nproc=1:1'], { env: {}, timeout: 5_000 }, (error) => {
      if (error === null) resolve();
      else reject(Object.assign(new Error(error.message), { code: error.code }));
    });
  });

/** What the guard sends; the child's own answer is any other message. */
export type GuardMessage = { guard: 'ready' } | { guard: 'listening'; probe: string };

export const isGuardMessage = (message: unknown): message is GuardMessage => typeof message === 'object' && message !== null && 'guard' in message;

/**
 * The parent's side of the guard's handshake on `child`: on "ready" it limits the child; on
 * "listening" it calls `ready` if the child's spawn was refused with EAGAIN, else `refuse`. A limit
 * that fails calls `refuse` with why. Every other message is the caller's.
 */
export function watchGuard(child: ChildProcess, limit: LimitForks, ready: () => void, refuse: (why: string) => void): void {
  child.on('message', (message) => {
    if (!isGuardMessage(message)) return;
    if (message.guard === 'ready') {
      if (child.pid === undefined) return;
      limit(child.pid).then(
        () => void (child.connected && child.send({ guard: 'limited' }, () => {})),
        (error: Error) => refuse(`its limit on starting processes could not be set (${(error as NodeJS.ErrnoException).code ?? error.message})`),
      );
    } else if (message.guard === 'listening') {
      if (message.probe === BLOCKED) ready();
      else refuse(`it could still start a process (${message.probe})`);
    }
  });
}
