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
//   - forked detached, so it leads a process group, which is killed after it.
//
// Anything but a well-formed verdict (a crash, a kill, a timeout, a reply
// that is not a verdict) is "unfinished": no pass, so a refused copy, never a
// retry. Used by the gate sidecar (gate-service.ts) for each check, and by the
// worker in the in-pod mode (worker.ts), so no mode parses a copy uncapped.
// ============================================================================
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GATE_CODES, type GateCode, type GateVerdict } from './engine-protocol.js';
import type { ImageAction } from './images.js';
import { engineExecArgv, killGroup } from './isolated.js';

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

/** What a check comes to: the verdict, and the sha256 of the bytes the child checked (null when it gave none). */
export interface GateOutcome {
  verdict: GateVerdict;
  sha256: string | null;
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
}

const UNFINISHED: GateOutcome = { verdict: { pass: false, code: 'unfinished' }, sha256: null };

/** A process's resident memory in bytes, from /proc; 0 once it is gone. */
export function rssOf(pid: number): number {
  try {
    const match = /^VmRSS:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return match === null ? 0 : Number(match[1]) * 1024;
  } catch {
    return 0;
  }
}

/** The child's answer, if it is exactly a verdict and a hash; else undefined. */
function asOutcome(message: unknown): GateOutcome | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const { verdict, sha256 } = message as { verdict?: unknown; sha256?: unknown };
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256) || typeof verdict !== 'object' || verdict === null) return undefined;
  const { pass, code } = verdict as { pass?: unknown; code?: unknown };
  if (pass === true) return { verdict: { pass: true }, sha256 };
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
        resolve(UNFINISHED);
        return;
      }
      const execArgv = [...engineExecArgv(process.execArgv), ...(options.nodeFlags ?? []), `--max-old-space-size=${GATE_HEAP_MB}`];
      const child = fork(options.module ?? GATE_CHILD, [], { env: {}, execArgv, serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'], detached: true });
      let answer: GateOutcome | undefined;
      let settled = false;
      const kill = (): void => void child.kill('SIGKILL');
      const deadline = setTimeout(kill, timeoutMs);
      const watchdog = setInterval(() => {
        if (child.pid !== undefined && rssOf(child.pid) > maxRss) kill();
      }, RSS_POLL_MS);
      signal?.addEventListener('abort', kill, { once: true });
      const settle = (outcome: GateOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearInterval(watchdog);
        signal?.removeEventListener('abort', kill);
        if (child.pid !== undefined) killGroup(child.pid);
        resolve(outcome);
      };
      child.once('message', (message) => {
        answer = asOutcome(message);
      });
      // A child killed for its deadline, its memory or the signal may have answered first: no answer then.
      child.once('exit', (code, killedBy) => settle(code === 0 && killedBy === null && answer !== undefined ? answer : UNFINISHED));
      child.once('error', () => settle(UNFINISHED));
      child.send(job, (error) => {
        if (error !== null) kill();
      });
    });
}
