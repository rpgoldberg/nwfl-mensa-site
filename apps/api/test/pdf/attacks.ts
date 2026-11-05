// What a subverted per-copy child tries (UNTRUSTED-PDF-GATE M1, fix round 2, adapted from the round-2
// challenge's integrity probes), shared by the hostile stand-ins (children/hostile.ts and
// gate-children/hostile.ts). Run ONLY in a capped container (test/helpers/contained.ts), where the
// sidecar is PID 1 and its socket is at its production path. Each attack says what it managed.
//
//   hop          8 fork-and-exit chains of /bin/sh (each hop starts the next and exits, so a single
//                pass over /proc misses it); a chain that runs out becomes a thief (below).
//   steal        the child itself takes the socket path over and answers every later job with the
//                job before's bytes (a cross-job leak), and stays.
//   stop-steal   SIGSTOP to its parent first (so its socket watch would stop), then steal.
//   stop-parent  SIGSTOP to its parent during its own job; kill-parent: SIGKILL.
import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { GATE_REPLY_MAGIC, REPLY_MAGIC, encodeFrame, sha256Hex } from '../../src/pdf/engine-protocol.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The parent's state letter from /proc (T: stopped), or "gone". */
export function stateOf(pid: number): string {
  try {
    return /^State:\s+(\S)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? '?';
  } catch {
    return 'gone';
  }
}

/** The thief's server: every frame is answered with the bytes of the frame before (a leak across jobs). */
export function thiefSource(socket: string): string {
  const gate = socket.endsWith('gate.sock');
  return `
    const fs = require('node:fs'); const net = require('node:net'); const crypto = require('node:crypto');
    const socket = ${JSON.stringify(socket)};
    try { process.kill(1, 'SIGSTOP'); } catch {}
    try { fs.unlinkSync(socket); } catch {}
    let previous = Buffer.from('LEAK: nothing yet');
    net.createServer((conn) => {
      const chunks = [];
      conn.on('error', () => {});
      conn.on('data', (c) => {
        chunks.push(c);
        const all = Buffer.concat(chunks);
        if (all.length < 12 || all.length < 12 + all.readUInt32BE(4) + all.readUInt32BE(8)) return;
        const body = all.subarray(12 + all.readUInt32BE(4));
        const head = Buffer.from(JSON.stringify(${gate} ? { v: 2, verdict: 'pass', sha256: crypto.createHash('sha256').update(previous).digest('hex') } : { v: 2, kind: 'redacted', kept: [] }));
        const prefix = Buffer.alloc(12); prefix.write(${JSON.stringify(gate ? 'NGA1' : 'NWA1')}, 0, 'latin1'); prefix.writeUInt32BE(head.length, 4); prefix.writeUInt32BE(${gate} ? 0 : previous.length, 8);
        conn.end(${gate} ? Buffer.concat([prefix, head]) : Buffer.concat([prefix, head, previous]));
        previous = Buffer.from(body);
      });
    }).listen(socket, () => fs.chmodSync(socket, 0o660));
    setTimeout(() => process.exit(0), 120000);
  `;
}

/** Starts the hop chains; resolves with how many started and the errors of those that did not. */
async function hop(socket: string): Promise<string> {
  const script = 'n=$(($2 - 1)); if [ "$n" -le 0 ]; then exec "$3" -e "$4"; fi; /bin/sh -c "$0" "$0" "$1" "$n" "$3" "$4" & exit 0';
  const outcomes = await Promise.all(
    Array.from(
      { length: 8 },
      () =>
        new Promise<string>((resolve) => {
          try {
            const chain = spawn('/bin/sh', ['-c', script, script, 'nwfl-hop', '4000', process.execPath, thiefSource(socket)], { detached: true, stdio: 'ignore' });
            chain.once('spawn', () => resolve('started'));
            chain.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
            chain.unref();
          } catch (error) {
            resolve((error as NodeJS.ErrnoException).code ?? (error as Error).message);
          }
        }),
    ),
  );
  const started = outcomes.filter((outcome) => outcome === 'started').length;
  return `hop: started ${started} of 8 (${[...new Set(outcomes.filter((outcome) => outcome !== 'started'))].join(', ') || 'no errors'})`;
}

/** Takes the socket path over in this process, serving the leak; `stop` sends SIGSTOP to the parent first. */
async function steal(socket: string, stop: boolean): Promise<string> {
  if (stop) process.kill(process.ppid, 'SIGSTOP');
  await sleep(100);
  const parent = stateOf(process.ppid);
  try {
    unlinkSync(socket);
  } catch (error) {
    // Gone already; anything else (the permission model's ERR_ACCESS_DENIED) ends the attack.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let previous = Buffer.from('LEAK: nothing yet');
  const gate = socket.endsWith('gate.sock');
  await new Promise<void>((resolve) => {
    net
      .createServer((conn) => {
        const chunks: Buffer[] = [];
        conn.on('error', () => {});
        conn.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          const all = Buffer.concat(chunks);
          if (all.length < 12 || all.length < 12 + all.readUInt32BE(4) + all.readUInt32BE(8)) return;
          conn.end(gate ? encodeFrame(GATE_REPLY_MAGIC, { v: 2, verdict: 'pass', sha256: sha256Hex(previous) }) : encodeFrame(REPLY_MAGIC, { v: 2, kind: 'redacted', kept: [] }, previous));
          previous = Buffer.from(all.subarray(12 + all.readUInt32BE(4)));
        });
      })
      .listen(socket, resolve);
  });
  writeFileSync(`${socket}.stolen`, JSON.stringify({ pid: process.pid, parent }));
  return `stole the socket; its parent was ${parent}`;
}

/** SIGSTOP, then SIGKILL, to the parent during the child's own job: what the parent was after each. */
async function hitParent(): Promise<string> {
  const parent = process.ppid;
  process.kill(parent, 'SIGSTOP');
  await sleep(200);
  const stopped = stateOf(parent);
  process.kill(parent, 'SIGKILL');
  await sleep(200);
  return `parent ${parent} after SIGSTOP: ${stopped}; after SIGKILL: ${stateOf(parent)}`;
}

/** Runs one attack; `holds` is whether the child must stay alive (it serves a stolen socket). One that throws says its code. */
export async function attack(mode: string, socket: string): Promise<{ said: string; holds: boolean }> {
  try {
    if (mode === 'hop') return { said: await hop(socket), holds: false };
    if (mode === 'steal' || mode === 'stop-steal') return { said: await steal(socket, mode === 'stop-steal'), holds: true };
    if (mode === 'hit-parent') return { said: await hitParent(), holds: false };
    return { said: `no attack named ${mode}`, holds: false };
  } catch (error) {
    return { said: `${mode}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, holds: false };
  }
}
