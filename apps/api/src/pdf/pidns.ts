// ============================================================================
// UNTRUSTED-PDF-GATE M1 (fix round 2): nothing a job starts outlives the job.
//
// A sidecar's per-job child parses untrusted bytes, so it may be subverted.
// What holds it in, most load-bearing first (README, "The engine sidecar"):
//
//   1. The sidecar is PID 1 of its container (fc's manifest: `command`, so no
//      dumb-init). The kernel does not deliver SIGKILL or SIGSTOP to PID 1
//      from inside its PID namespace, nor any signal it has no handler for,
//      so a child cannot freeze it. Node's inspector signal (SIGUSR1) is
//      taken by a JS listener and `--disable-sigusr1`, and so is every other
//      signal Node lets it hold (sidecar.ts holdSignals). A child can still
//      make it exit (fix round 3, N2): it fails closed, with no reply.
//   2. A child cannot start a process (no-fork.ts: RLIMIT_NPROC 1, checked
//      by the child's own failed spawn before it gets any input).
//   3. Before every reply the sidecar sends SIGKILL to every other process
//      in its namespace (kill(-1), which spares PID 1) and re-reads /proc
//      until it is alone (clearNamespace below). Anything left, or a zombie
//      (an orphan: the sidecar's own children are reaped before this runs),
//      is doubt: the sidecar exits 1 without replying, and the kernel kills
//      everything in the namespace with it.
//   4. It checks its socket before every reply too (sidecar.ts).
//
// The /proc reading here is best-effort on its own (round 2's challenge
// showed a single pass misses a process that forks and exits between the
// read and the kill); 1 and 2 are what make it hold.
//
// kill(-1) from anything but PID 1 would signal every process of the uid on
// the machine, so clearNamespace refuses to run unless the caller is PID 1.
// ============================================================================
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export type Kill = (pid: number, signal: NodeJS.Signals) => void;

/** The pids /proc lists (its numbered entries). */
export function processIds(procRoot = '/proc'): number[] {
  return readdirSync(procRoot)
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .sort((a, b) => a - b);
}

/** A process's state letter (R, S, Z ...) and real uid, from its status; undefined once it is gone. */
export function statusOf(pid: number, procRoot = '/proc'): { state: string; uid: number } | undefined {
  let status: string;
  try {
    status = readFileSync(path.join(procRoot, String(pid), 'status'), 'utf8');
  } catch {
    return undefined;
  }
  const state = /^State:\s+(\S)/m.exec(status);
  const uid = /^Uid:\s+(\d+)/m.exec(status);
  return state === null || uid === null ? undefined : { state: state[1] as string, uid: Number(uid[1]) };
}

/** A process's real uid; undefined once it is gone (or its status has none). */
export const realUid = (pid: number, procRoot = '/proc'): number | undefined => statusOf(pid, procRoot)?.uid;

/** Null when the sidecar may serve: it is PID 1 of its container and not root. Otherwise why not. */
export function pid1Problem(self: { pid: number; uid: number }): string | null {
  if (self.uid === 0) return 'it runs as root';
  if (self.pid !== 1) return `it is PID ${self.pid}, not PID 1 of its container: set command, not args, so node is PID 1 and no init runs`;
  return null;
}

export interface ClearOptions {
  /** Must be 1. */
  self: number;
  procRoot?: string;
  kill: Kill;
  /** How many /proc passes before it gives up; each re-sends kill(-1). */
  passes?: number;
  intervalMs?: number;
}

/**
 * Kills every other process in the PID namespace and waits until the sidecar is alone. Null when it
 * is; otherwise what is left. Throws when the caller is not PID 1, before signalling anything.
 */
export async function clearNamespace(options: ClearOptions): Promise<string | null> {
  if (options.self !== 1) throw new Error('clearNamespace runs only as PID 1: kill(-1) would reach every process of the uid');
  const passes = options.passes ?? 50;
  const interval = options.intervalMs ?? 20;
  for (let pass = 0; pass < passes; pass += 1) {
    try {
      options.kill(-1, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return `the kill before the reply failed (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`;
    }
    const others = processIds(options.procRoot).filter((pid) => pid !== options.self);
    const states = others.map((pid) => statusOf(pid, options.procRoot)).filter((status) => status !== undefined);
    if (states.some((status) => status.state === 'Z')) return 'an orphaned process (a zombie that is not its own child) is in its PID namespace';
    if (states.length === 0) return null;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return `processes are still in its PID namespace after ${passes} passes`;
}
