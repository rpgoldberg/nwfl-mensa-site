// ============================================================================
// UNTRUSTED-PDF-GATE M1: nothing a job starts outlives the job.
//
// A sidecar's per-job child parses untrusted bytes, so it may be subverted.
// Killing the child, or its process group, is not enough: a grandchild that
// calls setsid leaves both, and could then take the sidecar's socket over and
// answer later jobs (the challenger's M1). So after every job each sidecar
// SIGKILLs every process in its PID namespace but PID 1 and itself, found by
// reading /proc, where a setsid cannot hide.
//
// That is safe only in a PID namespace of the sidecar's own, as in its
// container under fc's manifest: dumb-init as PID 1 (it reaps the orphans;
// Node cannot reap a process it did not fork, so the sidecar refuses to BE
// PID 1), the sidecar its child, and every process its own uid. In a shared
// process namespace the pause container, the worker and linkerd-proxy show
// up under other uids, and the sidecar refuses to start (sidecar.ts). On a
// developer's machine it must never sweep: tests run it with
// --shared-pid-namespace, or in a namespace of its own made with unshare.
// ============================================================================
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

type Kill = (pid: number, signal: NodeJS.Signals) => void;

const realKill: Kill = (pid, signal) => void process.kill(pid, signal);

/** The pids /proc lists (its numbered entries). */
export function processIds(procRoot = '/proc'): number[] {
  return readdirSync(procRoot)
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .sort((a, b) => a - b);
}

/** A process's real uid, from its status; undefined once it is gone (or its status has none). */
export function realUid(pid: number, procRoot = '/proc'): number | undefined {
  let status: string;
  try {
    status = readFileSync(path.join(procRoot, String(pid), 'status'), 'utf8');
  } catch {
    return undefined;
  }
  const match = /^Uid:\s+(\d+)/m.exec(status);
  return match === null ? undefined : Number(match[1]);
}

/**
 * Null when the sidecar may sweep: it is not PID 1, not root, its parent is PID 1, and every process
 * it can see runs as its uid. Otherwise why not.
 */
export function ownNamespaceProblem(self: { pid: number; ppid: number; uid: number }, procRoot = '/proc'): string | null {
  if (self.pid === 1) return 'it is PID 1, and cannot reap orphans: keep the image ENTRYPOINT (args, not command) so dumb-init is PID 1';
  if (self.uid === 0) return 'it runs as root';
  if (self.ppid !== 1) return 'its parent is not PID 1, so the PID namespace is not its container\'s';
  for (const pid of processIds(procRoot)) {
    const uid = realUid(pid, procRoot);
    if (uid !== undefined && uid !== self.uid) return 'a process of another user is in its PID namespace (a shared process namespace)';
  }
  return null;
}

/** SIGKILLs every process but PID 1 and `self`; returns the pids it signalled. Throws on any failure but ESRCH. */
export function sweepNamespace(self: number, options: { procRoot?: string; kill?: Kill } = {}): number[] {
  const kill = options.kill ?? realKill;
  const killed: number[] = [];
  for (const pid of processIds(options.procRoot)) {
    if (pid === 1 || pid === self) continue;
    try {
      kill(pid, 'SIGKILL');
      killed.push(pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  return killed;
}
