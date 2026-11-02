// The real engine sidecar (src/pdf/engine-sidecar.ts) as its own process, on a temp unix socket, for
// the UNTRUSTED-PDF-GATE lift tests. Spawned with an empty environment unless a test gives one, and
// stopped by the PID recorded here, never by name.
import { type ChildProcess, spawn } from 'node:child_process';
import { lstatSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TS_HOOK = fileURLToPath(new URL('./ts-resolve.mjs', import.meta.url));
export const SIDECAR_ENTRY = fileURLToPath(new URL('../../src/pdf/engine-sidecar.ts', import.meta.url));
export const ENGINE_CHILD_SOURCE = fileURLToPath(new URL('../../src/pdf/engine-child.ts', import.meta.url));

/** A stand-in engine child (test/pdf/children). */
export const standIn = (name: string): string => fileURLToPath(new URL(`../pdf/children/${name}.ts`, import.meta.url));

/** A fresh directory for one socket; remove() takes it and everything in it away. */
export function socketDir(): { dir: string; socket: string; remove(): void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'nwfl-sc-'));
  return { dir, socket: path.join(dir, 'engine.sock'), remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface Spawned {
  child: ChildProcess;
  pid: number;
  /** Everything it wrote to stderr so far. */
  stderr(): string;
  /** How it ended. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** SIGTERM, then SIGKILL after 5 s; resolves once it is gone. */
  stop(): Promise<void>;
}

/**
 * Node's flags for running src/ as it is: the resolve hook, and type transforms (pdfium.ts has
 * parameter properties, which type stripping alone refuses). The sidecar hands them on to its children.
 */
export const NODE_FLAGS = ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', '--import', TS_HOOK];

/** Spawns the real sidecar entry with these arguments; listening() waits for it to listen. */
export function spawnSidecar(args: readonly string[], options: { env?: NodeJS.ProcessEnv } = {}): Spawned {
  const child = spawn(process.execPath, [...NODE_FLAGS, SIDECAR_ENTRY, ...args], { env: options.env ?? {}, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return {
    child,
    pid: child.pid as number,
    stderr: () => err,
    exited,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(timer);
    },
  };
}

/** Resolves once the socket exists (the sidecar listens), or rejects when the process ends first. */
export async function listening(spawned: Spawned, socket: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let ended = false;
  void spawned.exited.then(() => (ended = true));
  while (Date.now() < deadline) {
    if (ended) throw new Error(`the sidecar ended before it listened: ${spawned.stderr()}`);
    try {
      if (lstatSync(socket).isSocket() && spawned.stderr().includes('listening')) return;
    } catch {
      // not yet
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`the sidecar did not listen within ${timeoutMs} ms: ${spawned.stderr()}`);
}

/** Sends raw bytes (keeping the write side open unless `end`), and gives back everything the other side sent before it closed. */
export function exchange(socket: string, bytes: Uint8Array, options: { end?: boolean; timeoutMs?: number } = {}): Promise<{ reply: Buffer; error?: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const conn = net.createConnection({ path: socket });
    const timer = setTimeout(() => {
      conn.destroy();
      resolve({ reply: Buffer.concat(chunks), error: 'timeout' });
    }, options.timeoutMs ?? 10_000);
    let error: string | undefined;
    conn.on('data', (chunk: Buffer) => chunks.push(chunk));
    conn.on('error', (e: NodeJS.ErrnoException) => (error = e.code ?? e.message));
    conn.on('close', () => {
      clearTimeout(timer);
      resolve(error === undefined ? { reply: Buffer.concat(chunks) } : { reply: Buffer.concat(chunks), error });
    });
    conn.write(bytes);
    if (options.end === true) conn.end();
  });
}
