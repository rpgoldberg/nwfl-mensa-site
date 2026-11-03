// The no-fork guard's parent side (UNTRUSTED-PDF-GATE M1, fix round 2). The handshake runs on a
// made-up child here; isolated.test.ts and gate-isolated.test.ts run it through real children, and the
// lift tests show, in a capped container, that a child's spawn and fork fail with EAGAIN.
import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BLOCKED, CHILD_GUARD, PRLIMIT, guardFlag, isGuardMessage, limitForks, watchGuard } from './no-fork.js';

/** A made-up child: messages in, what the parent sent out. */
function fakeChild(pid: number | null = 4242): { child: ChildProcess; sent: unknown[]; say: (message: unknown) => void } {
  const emitter = new EventEmitter() as unknown as ChildProcess & { pid: number | undefined; connected: boolean };
  const sent: unknown[] = [];
  Object.assign(emitter, { pid: pid ?? undefined, connected: true, send: (message: unknown, done?: () => void) => void (sent.push(message), done?.()) });
  return { child: emitter, sent, say: (message) => void emitter.emit('message', message) };
}
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('the guard\'s constants', () => {
  it('preloads child-guard.ts here (child-guard.js once built), runs util-linux prlimit by absolute path, and wants EAGAIN', () => {
    expect(path.basename(CHILD_GUARD)).toBe('child-guard.ts');
    expect(guardFlag('/x/guard.js')).toBe('--import=file:///x/guard.js');
    expect(PRLIMIT).toBe('/usr/bin/prlimit');
    expect(BLOCKED).toBe('EAGAIN');
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
