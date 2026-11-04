// ============================================================================
// UNTRUSTED-PDF-GATE M2: the output gate in a capped child of its own.
//
// The gate reads the copy an engine handed back, and the engine is the part
// that may be subverted, so the copy is attacker-made bytes: a Flate stream
// that inflates to gigabytes, a page of millions of strings, 100,000 pages.
// Read in the worker, which holds the database login, such a copy crashed it
// or held it past its lease (the challenger's M2). So every check runs in a
// child forked for it alone (gate-child.ts):
//
//   - an empty environment (CF-ISO-0, as the engine's child), and no
//     --env-file flag passed on;
//   - --max-old-space-size=GATE_HEAP_MB for the V8 heap;
//   - a watchdog that kills it once its resident memory passes
//     GATE_MAX_RSS_BYTES, read from /proc every RSS_POLL_MS: a decoded stream
//     lives outside the V8 heap, so the heap flag alone does not stop a bomb;
//   - a deadline, GATE_TIMEOUT_MS;
//   - forked detached, so it leads a process group, which is killed after it;
//   - no way to start a process (fix round 2, no-fork.ts): RLIMIT_NPROC 1,
//     checked by the child's own failed spawn before it is sent the copy.
//
// Fix round 2 (M2): an unfinished outcome says why the child was stopped
// (cause: memory, deadline, signal, crash or no-fork), so a test can tell a
// watchdog kill from a deadline kill. Fix round 3: a child that ends after
// V8 says its heap ran out is "memory" too (N1); its stderr reaches the log
// only up to CHILD_LOG_BYTES, and its stdout not at all (S2, isolated.ts
// relayChildLog). The in-pod worker passes a smaller cap (worker.ts,
// IN_POD_GATE_MAX_RSS_BYTES, S5).
//
// Anything but a well-formed verdict (a crash, a kill, a timeout, a reply
// that is not a verdict) is "unfinished": no pass, so a refused copy, never a
// retry. Used by the gate sidecar (gate-service.ts) for each check, and by the
// worker in the in-pod mode (worker.ts), so no mode parses a copy uncapped.
// ============================================================================
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type CheckedCopy, GATE_CODES, type GateCode, type GateVerdict, MAX_OUTPUT_BYTES } from './engine-protocol.js';
import type { ImageAction } from './images.js';
import { engineExecArgv, killGroup, relayChildLog } from './isolated.js';
import { CHILD_PERMISSION, type LimitForks, guardFlag, isGuardMessage, limitForks, viaChoom, watchGuard } from './no-fork.js';

/** The built child next to this module (dist/pdf/gate-child.js). */
export const GATE_CHILD = fileURLToPath(new URL('./gate-child.js', import.meta.url));
/** Two minutes: well inside the job's 600 s lease, with the engine's 300 s. */
export const GATE_TIMEOUT_MS = 120_000;
export const GATE_HEAP_MB = 512;
/** The child's whole resident memory; the gate sidecar's container has 1Gi (fc-manifest-needs.md). */
export const GATE_MAX_RSS_BYTES = 768 * 1024 * 1024;
const RSS_POLL_MS = 50;

/** What a gate child is sent: the copy, its original (for its pictures), and what this audience withholds. */
export interface GateJob {
  copy: Uint8Array;
  original: Uint8Array;
  quotes: readonly string[];
  image: ImageAction;
}

/** Why a child gave no verdict: killed past its memory cap or deadline, stopped by the signal, ended on its own, or refused before it was sent the copy. */
export type UnfinishedCause = 'memory' | 'deadline' | 'signal' | 'crash' | 'no-fork';

/** What a check comes to: the verdict, the sha256 of the copy the child was sent (null when it gave none), and on a pass the bytes it checked (M1). */
export interface GateOutcome {
  verdict: GateVerdict;
  sha256: string | null;
  checked?: CheckedCopy;
  /** Set when the child gave no verdict. */
  cause?: UnfinishedCause;
}

export interface IsolatedGateOptions {
  /** The child (default the built gate-child.js); another module, for tests. */
  module?: string;
  timeoutMs?: number;
  maxRssBytes?: number;
  /** Node flags for the child beside the parent's own (for tests: how to load src/ as it is). */
  nodeFlags?: readonly string[];
  /** Kills the child (the sidecar: the worker hung up, or the sidecar is stopping). */
  signal?: AbortSignal;
  /** The guard preloaded in the child (default no-fork.ts CHILD_GUARD); another, for tests. */
  guard?: string;
  /** How the child's process limit is set (default prlimit); another, for tests. */
  limit?: LimitForks;
  /** How the child's resident memory is read (default rssOf); a spy, for tests. */
  rss?: (pid: number) => number;
  /** Where the child's stderr goes, capped (default this process's stderr); a spy, for tests. */
  log?: (chunk: Buffer) => void;
  /** Whether the child runs under the permission model (default true: CHILD_PERMISSION); false only for tests of the layers behind it. */
  permission?: boolean;
}

/** How long a child that ended on its own is given to finish its stderr, where V8 says its heap ran out (N1). */
const LOG_GRACE_MS = 1_000;

const unfinished = (cause: UnfinishedCause): GateOutcome => ({ verdict: { pass: false, code: 'unfinished' }, sha256: null, cause });

/**
 * The child's Node flags: the parent's without any --env-file (both spellings) or grant, the test's, the permission
 * model's (after those, so none undoes them: fix round 5, S2), the heap cap, then the guard.
 */
export function gateExecArgv(parent: readonly string[], nodeFlags: readonly string[] = [], guard?: string, permission = true): string[] {
  return [...engineExecArgv(parent), ...nodeFlags, ...(permission ? CHILD_PERMISSION : []), `--max-old-space-size=${GATE_HEAP_MB}`, guardFlag(guard)];
}

/** A process's resident memory in bytes, from /proc; 0 once it is gone. */
export function rssOf(pid: number): number {
  try {
    const match = /^VmRSS:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return match === null ? 0 : Number(match[1]) * 1024;
  } catch {
    return 0;
  }
}

const isHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/** The bytes a pass carries, if they are bytes within the output cap with a hash; else undefined. */
function asChecked(value: unknown): CheckedCopy | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { pdf, sha256 } = value as { pdf?: unknown; sha256?: unknown };
  if (!(pdf instanceof Uint8Array) || pdf.byteLength === 0 || pdf.byteLength > MAX_OUTPUT_BYTES || !isHash(sha256)) return undefined;
  return { pdf, sha256 };
}

/** The child's answer, if it is exactly a verdict and a hash (and, for a pass, the bytes it checked); else undefined. */
function asOutcome(message: unknown): GateOutcome | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const { verdict, sha256, checked } = message as { verdict?: unknown; sha256?: unknown; checked?: unknown };
  if (!isHash(sha256) || typeof verdict !== 'object' || verdict === null) return undefined;
  const { pass, code } = verdict as { pass?: unknown; code?: unknown };
  if (pass === true) {
    const bytes = asChecked(checked);
    return bytes === undefined ? undefined : { verdict: { pass: true }, sha256, checked: bytes };
  }
  if (pass === false && GATE_CODES.includes(code as GateCode)) return { verdict: { pass: false, code: code as GateCode }, sha256 };
  return undefined;
}

/** A gate that checks each copy in a new capped child process. Never rejects. */
export function isolatedGate(options: IsolatedGateOptions = {}): (job: GateJob) => Promise<GateOutcome> {
  const timeoutMs = options.timeoutMs ?? GATE_TIMEOUT_MS;
  const maxRss = options.maxRssBytes ?? GATE_MAX_RSS_BYTES;
  const { signal } = options;
  return (job) =>
    new Promise<GateOutcome>((resolve) => {
      if (signal?.aborted === true) {
        resolve(unfinished('signal'));
        return;
      }
      const execArgv = gateExecArgv(process.execArgv, options.nodeFlags, options.guard, options.permission !== false);
      const child = fork(options.module ?? GATE_CHILD, [], { env: {}, ...viaChoom(execArgv), serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'], detached: true });
      const log = relayChildLog(child.stderr, options.log);
      let answer: GateOutcome | undefined;
      let settled = false;
      let cause: UnfinishedCause | undefined;
      const rss = options.rss ?? rssOf;
      /** The first reason to stop the child is the one reported. */
      const stopFor = (why: UnfinishedCause): void => {
        cause ??= why;
        child.kill('SIGKILL');
      };
      const onAbort = (): void => stopFor('signal');
      const deadline = setTimeout(() => stopFor('deadline'), timeoutMs);
      const watchdog = setInterval(() => {
        if (child.pid !== undefined && rss(child.pid) > maxRss) stopFor('memory');
      }, RSS_POLL_MS);
      signal?.addEventListener('abort', onAbort, { once: true });
      const settle = (outcome: GateOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearInterval(watchdog);
        signal?.removeEventListener('abort', onAbort);
        if (child.pid !== undefined) killGroup(child.pid);
        resolve(outcome);
      };
      child.on('message', (message) => {
        if (!isGuardMessage(message) && answer === undefined) answer = asOutcome(message) ?? { ...unfinished('crash') };
      });
      watchGuard(
        child,
        options.limit ?? limitForks,
        () =>
          child.send(job, (error) => {
            if (error !== null) stopFor('crash');
          }),
        () => stopFor('no-fork'),
      );
      // A child killed for its deadline, its memory or the signal may have answered first: no answer then.
      child.once('exit', (code, killedBy) => {
        const done = cause === undefined && code === 0 && killedBy === null && answer !== undefined && answer.cause === undefined;
        if (done || cause !== undefined) {
          settle(done ? (answer as GateOutcome) : unfinished(cause as UnfinishedCause));
          return;
        }
        // It ended on its own: V8's heap-out-of-memory line, if any, may still be in its stderr (N1).
        let grace: NodeJS.Timeout | undefined;
        const waited = new Promise<void>((resolve) => {
          grace = setTimeout(resolve, LOG_GRACE_MS);
        });
        void Promise.race([log.ended, waited]).then(() => {
          clearTimeout(grace);
          settle(unfinished(log.heapOutOfMemory() ? 'memory' : 'crash'));
        });
      });
      child.once('error', () => settle(unfinished('crash')));
    });
}
