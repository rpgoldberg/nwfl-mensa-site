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
//
// Fix round 4 (S2, N2): every child also runs under Node's permission model
// with read access only (CHILD_PERMISSION): through node:fs it cannot write,
// create, rename, remove or chmod a file (so it cannot squat or chmod its
// sidecar's socket), and it cannot load native code (so it cannot make itself
// dumpable or lower its oom_score_adj), or start a process, a worker or a WASI
// instance. Its spawn is then refused before the kernel sees it, with
// ERR_ACCESS_DENIED, which the parent accepts as it accepts EAGAIN: the limit
// stays underneath.
//
// Fix round 5 (S2): the model does not check every writer. Measured on node
// 24.22.1: node:sqlite opens database files itself, V8 flags set at run time
// (v8.setFlagsFromString) write trace files, Web Storage writes its file once
// a parent's flags turn it on, and a listen on a unix socket leaves its
// socket file. So CHILD_PERMISSION also turns node:sqlite and Web Storage
// off and freezes V8's flags (a child that sets one aborts), and comes after
// every flag the child inherits, so none of them turns a writer back on; the
// guard (child-guard.ts) refuses a listen. The model does not cover network
// either: a pod's NetworkPolicy bounds that.
// ============================================================================
import { type ChildProcess, execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The guard next to this module: the built child-guard.js, or child-guard.ts when the source runs as is. */
export const CHILD_GUARD = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './child-guard.ts' : './child-guard.js', import.meta.url));
/** The absolute path, so no PATH is looked up; util-linux's, in the image and on any Linux host. */
export const PRLIMIT = '/usr/bin/prlimit';
/** util-linux choom, by absolute path (in the base image, as prlimit is): it sets a child's oom_score_adj, then runs node. */
export const CHOOM = '/usr/bin/choom';
/**
 * Every engine and gate child's oom_score_adj (fix round 3, S5): the kernel's first pick when a container's memory
 * runs out. On k3s with cgroup v2 it kills the whole container then (memory.oom.group, fix round 4): if the kernel
 * acts, the container restarts and the job is retried under the attempt cap.
 */
export const CHILD_OOM_SCORE_ADJ = 1000;

/**
 * fork() options that start a child's node through choom, with these Node flags, so its oom_score_adj is
 * CHILD_OOM_SCORE_ADJ from its first instruction. node cannot raise its own: the image makes it
 * non-dumpable (0711, fix round 3, S6), and a non-dumpable process's /proc/self files are root's. The
 * guard checks the value (child-guard.ts) and ends a child without it. Same pid: choom execs node.
 */
export function viaChoom(execArgv: readonly string[]): { execPath: string; execArgv: string[] } {
  return { execPath: CHOOM, execArgv: ['-n', String(CHILD_OOM_SCORE_ADJ), '--', process.execPath, ...execArgv] };
}
/** What the guard may see from its own spawn once the limit holds: the kernel's EAGAIN, or the permission model's refusal. */
export const BLOCKED: ReadonlySet<string> = new Set(['EAGAIN', 'ERR_ACCESS_DENIED']);
/**
 * Node's permission model, read access only, for every engine and gate child (fix round 4, S2), with the writers it
 * does not check turned off (fix round 5, S2). It comes after every flag the child inherits.
 */
export const CHILD_PERMISSION: readonly string[] = ['--permission', '--allow-fs-read=*', '--no-experimental-sqlite', '--freeze-flags-after-init', '--no-experimental-webstorage'];

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
 * "listening" it calls `ready` if the child's spawn was refused (BLOCKED), else `refuse`. A limit
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
      if (BLOCKED.has(message.probe)) ready();
      else refuse(`it could still start a process (${message.probe})`);
    }
  });
}
