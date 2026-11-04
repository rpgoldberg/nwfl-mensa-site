// A stand-in engine child that tries to start a process every way Node offers, after its guard and
// limit (no-fork.ts), and refuses its copy with what happened as JSON: each attempt's error code
// ("started" if one ran), its thread count, and whether its threaded work (zlib, pbkdf2) still runs.
// Under the permission model (fix round 4, S2) Node refuses each attempt itself, some by a throw: the code
// of either is what it saw. Containers only (test/pdf/contained/no-fork.ts).
import { execFileSync, fork, spawn, spawnSync } from 'node:child_process';
import { pbkdf2 } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzip, gzipSync } from 'node:zlib';

const code = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? String(error);
const started = (start: () => ReturnType<typeof spawn>): Promise<string> =>
  new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = start();
    } catch (error) {
      resolve(code(error));
      return;
    }
    child.once('spawn', () => {
      child.kill('SIGKILL');
      resolve('started');
    });
    child.once('error', (error) => resolve(code(error)));
  });
const tried = (start: () => void): string => {
  try {
    start();
    return 'started';
  } catch (error) {
    return code(error);
  }
};

async function attempt(): Promise<void> {
  const threads = Number(/^Threads:\s+(\d+)/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1]);
  const outcome: Record<string, unknown> = { threads };
  outcome['spawnSync'] = tried(() => {
    const { error } = spawnSync('/bin/true', [], { stdio: 'ignore' });
    if (error !== undefined) throw error;
  });
  outcome['execFileSync'] = tried(() => void execFileSync('/bin/true', [], { stdio: 'ignore' }));
  outcome['spawn'] = await started(() => spawn('/bin/true', [], { stdio: 'ignore' }));
  outcome['fork'] = await started(() => fork('/dev/null', [], { stdio: 'ignore', execArgv: [] }));
  outcome['zlib'] = await new Promise((resolve) => gunzip(gzipSync(Buffer.alloc(1 << 20, 7)), (error, out) => resolve(error === null ? out.length : code(error))));
  outcome['pbkdf2'] = await new Promise((resolve) => pbkdf2('a', 'b', 1_000, 32, 'sha256', (error, key) => resolve(error === null ? key.length : code(error))));
  outcome['threadsAfter'] = Number(/^Threads:\s+(\d+)/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1]);
  process.send?.({ ok: true, result: { kind: 'refused', reason: JSON.stringify(outcome) } }, () => process.exit(0));
}

process.once('message', () => void attempt());
