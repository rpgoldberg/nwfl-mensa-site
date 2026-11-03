// Every hostile, process-starting or memory-heavy case of the UNTRUSTED-PDF-GATE lift tests runs here,
// in a capped container, never on the host (fix round 2): --memory=2g --memory-swap=2g
// --pids-limit=512 --cpus=2 --network none, a read-only root, no capabilities, no new privileges, and
// this uid. The image is the Dockerfile's own pinned base (node, trixie-slim, util-linux's prlimit);
// apps/api is mounted read-only at its own path, so the sources run as they are (NODE_FLAGS).
//
//   - containedSidecar: a real sidecar entry as PID 1 of its container (node is the entrypoint, with
//     no init and no shell, as fc's manifest's `command` runs it), its socket directory bind-mounted
//     from a temp directory here, so the test is the worker and connects from the host.
//   - runContained: a probe script (test/pdf/contained) as PID 1 of its container, which prints one
//     line of JSON.
// Containers are named here and removed by that name, never by pattern.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_SIDECAR_ENTRY, NODE_FLAGS, SIDECAR_ENTRY } from './sidecar.js';

/** apps/api, mounted read-only at the same path inside every container. */
export const API = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
/** The Dockerfile's base image, digest-pinned: the production image's own node and util-linux. */
export const NODE_IMAGE = (/^ARG NODE_IMAGE=(\S+)$/m.exec(readFileSync(path.join(API, 'Dockerfile'), 'utf8')) as RegExpExecArray)[1] as string;
/** The safety caps (the coordinator's, round 2): every contained case runs under all of them. */
export const CAPS = ['--memory=2g', '--memory-swap=2g', '--pids-limit=512', '--cpus=2', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp'];

const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
/** Every container started here and not yet seen to exit, by name. */
const running = new Set<string>();

/** Pulls the base image once if this host does not have it (the containers themselves have no network). */
export function ensureImage(): void {
  try {
    execFileSync('docker', ['image', 'inspect', NODE_IMAGE], { stdio: 'ignore' });
  } catch {
    execFileSync('docker', ['pull', '--quiet', NODE_IMAGE], { stdio: 'ignore', timeout: 300_000 });
  }
}

interface Run {
  name: string;
  process: ChildProcess;
  stdout(): string;
  stderr(): string;
  exited: Promise<{ code: number | null }>;
}

function dockerRun(mounts: readonly string[], command: readonly string[], extra: readonly string[] = []): Run {
  const name = `nwfl-lift-${randomUUID().slice(0, 12)}`;
  const child = spawn('docker', ['run', '--rm', '--name', name, ...CAPS, ...extra, '--user', user, '-v', `${API}:${API}:ro`, ...mounts.flatMap((mount) => ['-v', mount]), '--entrypoint', command[0] as string, NODE_IMAGE, ...command.slice(1)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
  running.add(name);
  const exited = new Promise<{ code: number | null }>((resolve) =>
    child.once('exit', (code) => {
      running.delete(name);
      resolve({ code });
    }),
  );
  return { name, process: child, stdout: () => out, stderr: () => err, exited };
}

/** Removes a container by its name, running or not (each was started with --rm). */
function removeByName(name: string): void {
  try {
    execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 60_000 });
  } catch {
    // already gone
  }
}

/** Removes the container and waits for its `docker run` to end. */
async function remove(run: Run): Promise<void> {
  removeByName(run.name);
  await run.exited;
}

/** For an afterAll: removes every container this file started that is still up (a test that timed out included). */
export function removeLeftovers(): void {
  for (const name of running) removeByName(name);
}

export interface ContainedSidecar {
  /** The socket's directory and path on the host. */
  dir: string;
  socket: string;
  stderr(): string;
  exited: Promise<{ code: number | null }>;
  /** Sends a signal to PID 1 (the sidecar) from outside, as the kubelet does. */
  signal(signal: NodeJS.Signals): void;
  /** How many processes the container holds now (docker top), the sidecar included. */
  processes(): number;
  /** Removes the container and the directory. */
  remove(): Promise<void>;
}

/**
 * Starts a real sidecar entry as PID 1 of a capped container, bound at its production path
 * (/run/pdf-engine/engine.sock or /run/pdf-gate/gate.sock) in a directory mounted from the host, and
 * waits until it listens.
 */
export async function containedSidecar(
  entry: 'engine' | 'gate',
  args: readonly string[] = [],
  options: { init?: boolean; production?: boolean; withoutFlag?: boolean; timeoutMs?: number } = {},
): Promise<ContainedSidecar> {
  const dir = mkdtempSync(path.join(tmpdir(), `nwfl-ct-${entry}-`));
  const inside = entry === 'engine' ? '/run/pdf-engine' : '/run/pdf-gate';
  const socket = path.join(dir, entry === 'engine' ? 'engine.sock' : 'gate.sock');
  const flag = options.withoutFlag === true ? [] : ['--disable-sigusr1'];
  const run = dockerRun([`${dir}:${inside}`], ['node', ...flag, ...NODE_FLAGS, entry === 'engine' ? SIDECAR_ENTRY : GATE_SIDECAR_ENTRY, ...args], [
    ...(options.init === true ? ['--init'] : []),
    ...(options.production === true ? ['-e', 'NODE_ENV=production'] : []),
  ]);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const handle: ContainedSidecar = {
    dir,
    socket,
    stderr: () => run.stderr(),
    exited: run.exited,
    signal: (signal) => void execFileSync('docker', ['kill', '--signal', signal, run.name], { stdio: 'ignore' }),
    processes: () => execFileSync('docker', ['top', run.name], { encoding: 'utf8' }).trim().split('\n').length - 1,
    remove: async () => {
      await remove(run);
      rmSync(dir, { recursive: true, force: true });
    },
  };
  const deadline = Date.now() + timeoutMs;
  let ended = false;
  void run.exited.then(() => (ended = true));
  for (;;) {
    if (ended) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`the contained ${entry} sidecar ended (exit ${run.process.exitCode}) before it listened: ${run.stderr()}`);
    }
    try {
      if (lstatSync(socket).isSocket() && run.stderr().includes('listening')) return handle;
    } catch {
      // not yet
    }
    if (Date.now() > deadline) {
      await handle.remove();
      throw new Error(`the contained ${entry} sidecar did not listen within ${timeoutMs} ms: ${run.stderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Runs a probe script (test/pdf/contained) as PID 1 of a capped container and parses the last line it prints. */
export async function runContained<T>(script: string, args: readonly string[] = [], timeoutMs = 120_000): Promise<{ code: number | null; result: T; stderr: string }> {
  const run = dockerRun([], ['node', ...NODE_FLAGS, script, ...args]);
  const timer = setTimeout(() => void remove(run), timeoutMs);
  const { code } = await run.exited;
  clearTimeout(timer);
  const last = run.stdout().trim().split('\n').at(-1) ?? '';
  let result: T;
  try {
    result = JSON.parse(last) as T;
  } catch {
    throw new Error(`the contained probe printed no result (exit ${code}): ${run.stdout()} ${run.stderr()}`);
  }
  return { code, result, stderr: run.stderr() };
}

/** A probe script in test/pdf/contained. */
export const probe = (name: string): string => fileURLToPath(new URL(`../pdf/contained/${name}.ts`, import.meta.url));
