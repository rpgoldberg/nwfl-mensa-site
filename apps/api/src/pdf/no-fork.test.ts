// The no-fork guard's parent side (UNTRUSTED-PDF-GATE M1, fix round 2). The handshake runs on a
// made-up child here; isolated.test.ts and gate-isolated.test.ts run it through real children, and the
// lift tests show, in a capped container, that a child's spawn and fork fail with EAGAIN.
import { type ChildProcess, fork, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BLOCKED, CHILD_GUARD, CHILD_OOM_SCORE_ADJ, CHILD_PERMISSION, CHOOM, PRLIMIT, guardFlag, isGuardMessage, limitForks, viaChoom, watchGuard } from './no-fork.js';
import { NODE_FLAGS } from '../../test/helpers/sidecar.js';

/** A made-up child: messages in, what the parent sent out. */
function fakeChild(pid: number | null = 4242): { child: ChildProcess; sent: unknown[]; say: (message: unknown) => void } {
  const emitter = new EventEmitter() as unknown as ChildProcess & { pid: number | undefined; connected: boolean };
  const sent: unknown[] = [];
  Object.assign(emitter, { pid: pid ?? undefined, connected: true, send: (message: unknown, done?: () => void) => void (sent.push(message), done?.()) });
  return { child: emitter, sent, say: (message) => void emitter.emit('message', message) };
}
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('the guard\'s constants', () => {
  it('preloads child-guard.ts here (child-guard.js once built), runs util-linux prlimit by absolute path, and wants EAGAIN or the permission model\'s refusal', () => {
    expect(path.basename(CHILD_GUARD)).toBe('child-guard.ts');
    expect(guardFlag('/x/guard.js')).toBe('--import=file:///x/guard.js');
    expect(PRLIMIT).toBe('/usr/bin/prlimit');
    expect([...BLOCKED]).toEqual(['EAGAIN', 'ERR_ACCESS_DENIED']);
    // Fix round 4 (S2): every child runs under Node's permission model, read access only; fix round 5 (S2):
    // with node:sqlite and run-time V8 flags off, the two writers the model does not check, and Web Storage.
    expect(CHILD_PERMISSION).toEqual(['--permission', '--allow-fs-read=*', '--no-experimental-sqlite', '--freeze-flags-after-init', '--no-experimental-webstorage']);
    expect(isGuardMessage({ guard: 'ready' })).toBe(true);
    expect(isGuardMessage({ ok: true })).toBe(false);
    expect(isGuardMessage(null)).toBe(false);
  });
});

describe('watchGuard: the job goes to the child only once its limit holds', () => {
  it('limits the child on "ready", tells it "limited", and calls ready on an EAGAIN probe', async () => {
    const { child, sent, say } = fakeChild();
    const limited: number[] = [];
    const calls: string[] = [];
    const limit = (pid: number): Promise<void> => {
      limited.push(pid);
      return Promise.resolve();
    };
    watchGuard(child, limit, () => void calls.push('ready'), (why) => void calls.push(why));
    say({ ok: true, result: {} });
    say({ guard: 'ready' });
    await tick();
    expect(limited).toEqual([4242]);
    expect(sent).toEqual([{ guard: 'limited' }]);
    say({ guard: 'listening', probe: 'EAGAIN' });
    expect(calls).toEqual(['ready']);
    // Under the permission model a spawn is refused before the kernel sees it (fix round 4, S2).
    const denied = fakeChild();
    watchGuard(denied.child, limit, () => void calls.push('ready too'), (why) => void calls.push(why));
    denied.say({ guard: 'listening', probe: 'ERR_ACCESS_DENIED' });
    expect(calls).toEqual(['ready', 'ready too']);
  });

  it('refuses when the limit cannot be set, or the child could still start a process', async () => {
    const failing = fakeChild();
    const why: string[] = [];
    watchGuard(failing.child, () => Promise.reject(Object.assign(new Error('x'), { code: 'EPERM' })), () => void why.push('ready'), (reason) => void why.push(reason));
    failing.say({ guard: 'ready' });
    await tick();
    expect(why).toEqual(['its limit on starting processes could not be set (EPERM)']);
    expect(failing.sent).toEqual([]);
    const plain = fakeChild();
    watchGuard(plain.child, () => Promise.reject(new Error('no code')), () => {}, (reason) => void why.push(reason));
    plain.say({ guard: 'ready' });
    await tick();
    expect(why.at(-1)).toBe('its limit on starting processes could not be set (no code)');
    const spawns = fakeChild();
    watchGuard(spawns.child, async () => {}, () => void why.push('ready'), (reason) => void why.push(reason));
    spawns.say({ guard: 'listening', probe: 'a process started (exit 0)' });
    expect(why.at(-1)).toBe('it could still start a process (a process started (exit 0))');
  });

  it('does nothing for a child with no pid, or one already gone when its limit is set', async () => {
    const nopid = fakeChild(null);
    let limits = 0;
    const count = (): Promise<void> => {
      limits += 1;
      return Promise.resolve();
    };
    watchGuard(nopid.child, count, () => {}, () => {});
    nopid.say({ guard: 'ready' });
    await tick();
    expect(limits).toBe(0);
    const gone = fakeChild();
    (gone.child as unknown as { connected: boolean }).connected = false;
    watchGuard(gone.child, async () => {}, () => {}, () => {});
    gone.say({ guard: 'ready' });
    await tick();
    expect(gone.sent).toEqual([]);
  });
});

describe('viaChoom and the guard\'s oom_score_adj check (fix round 3, S5)', () => {
  it('starts node through util-linux choom by absolute path with oom_score_adj 1000, then the flags', () => {
    expect(CHOOM).toBe('/usr/bin/choom');
    expect(CHILD_OOM_SCORE_ADJ).toBe(1000);
    expect(viaChoom(['--max-old-space-size=512', '--import=file:///g.js'])).toEqual({ execPath: CHOOM, execArgv: ['-n', '1000', '--', process.execPath, '--max-old-space-size=512', '--import=file:///g.js'] });
  });

  const started = (options: { execPath?: string; execArgv: string[] }): Promise<{ code: number | null; ready: boolean }> =>
    new Promise((resolve) => {
      const child = fork(fileURLToPath(new URL('../../test/pdf/children/hang.ts', import.meta.url)), [], { env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], ...options });
      let ready = false;
      child.on('message', (message) => {
        if ((message as { guard?: string }).guard !== 'ready') return;
        ready = true;
        child.kill('SIGKILL');
      });
      child.once('exit', (code) => resolve({ code, ready }));
    });
  // A child inherits its parent's score: on a runner already at 1000 a child started without choom has it too (fix round 4, N6).
  const INHERITS_1000 = readFileSync('/proc/self/oom_score_adj', 'utf8').trim() === '1000';

  it.skipIf(INHERITS_1000)('ends a child started without choom before it says ready (skipped, and so reported, on a runner whose own oom_score_adj is already 1000)', async () => {
    expect(await started({ execArgv: [...NODE_FLAGS, guardFlag()] })).toEqual({ code: 1, ready: false });
  });

  it('lets a child started through choom say ready', async () => {
    expect((await started(viaChoom([...NODE_FLAGS, guardFlag()]))).ready).toBe(true);
  });
});

describe('limitForks', () => {
  it('sets RLIMIT_NPROC to 1, soft and hard, on a running process, and fails for one that is gone', async () => {
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => sleeper.once('spawn', resolve));
      await limitForks(sleeper.pid as number);
      const line = readFileSync(`/proc/${sleeper.pid}/limits`, 'utf8').split('\n').find((entry) => entry.startsWith('Max processes'));
      expect(line).toMatch(/^Max processes\s+1\s+1\s+processes/);
    } finally {
      sleeper.kill('SIGKILL');
    }
    await expect(limitForks(2 ** 22 + 7)).rejects.toThrow();
  });
});
