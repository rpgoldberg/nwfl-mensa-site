// The sidecars' namespace rules (UNTRUSTED-PDF-GATE M1, fix round 2), on a made-up /proc tree with a
// made-up kill: nothing here signals a real process. The lift tests run the real thing as PID 1 in a
// container (test/pdf/engine-sidecar.test.ts, test/pdf/gate-rerun.test.ts).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { killGroup } from './isolated.js';
import { clearNamespace, pid1Problem, processIds, realUid, statusOf } from './pidns.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A /proc with these processes (pid: state letter), all uid 10002, plus entries a real one has that are not processes. */
function proc(processes: Record<number, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nwfl-proc-'));
  roots.push(root);
  for (const [pid, state] of Object.entries(processes)) setProcess(root, Number(pid), state);
  mkdirSync(path.join(root, 'sys'));
  writeFileSync(path.join(root, 'uptime'), '1.0 1.0\n');
  mkdirSync(path.join(root, 'self'));
  return root;
}
function setProcess(root: string, pid: number, state: string): void {
  mkdirSync(path.join(root, String(pid)), { recursive: true });
  writeFileSync(path.join(root, String(pid), 'status'), `Name:\tnode\nState:\t${state} (x)\nPPid:\t1\nUid:\t10002\t10002\t10002\t10002\n`);
}
const gone = (root: string, pid: number): void => rmSync(path.join(root, String(pid)), { recursive: true, force: true });
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

describe('processIds, statusOf and realUid', () => {
  it('lists only the numbered entries, and reads the state and real uid from status', () => {
    const root = proc({ 1: 'S', 7: 'R', 31: 'Z' });
    expect(processIds(root)).toEqual([1, 7, 31]);
    expect(statusOf(31, root)).toEqual({ state: 'Z', uid: 10002 });
    expect(realUid(7, root)).toBe(10002);
    expect(statusOf(99, root)).toBeUndefined();
    writeFileSync(path.join(root, '7', 'status'), 'Name:\tnode\n');
    expect(statusOf(7, root)).toBeUndefined();
  });
});

describe('pid1Problem: the sidecar serves only as PID 1 of its container, and never as root', () => {
  it('is null for PID 1 of a non-root uid', () => {
    expect(pid1Problem({ pid: 1, uid: 10002 })).toBeNull();
  });

  it('refuses any other pid (dumb-init or another init in front of it, or a shared namespace), and root', () => {
    expect(pid1Problem({ pid: 7, uid: 10002 })).toMatch(/is PID 7, not PID 1 of its container: set command, not args/);
    expect(pid1Problem({ pid: 1, uid: 0 })).toMatch(/root/);
  });
});

describe('clearNamespace: before every reply, everything else in the namespace is killed and gone', () => {
  it('sends kill(-1) and is done once the sidecar is alone', async () => {
    const root = proc({ 1: 'S', 12: 'S', 40: 'R' });
    const sent: Array<[number, string]> = [];
    const kill = (pid: number, signal: NodeJS.Signals): void => {
      sent.push([pid, signal]);
      gone(root, 12);
      gone(root, 40);
    };
    expect(await clearNamespace({ self: 1, procRoot: root, kill, intervalMs: 1 })).toBeNull();
    expect(sent).toEqual([[-1, 'SIGKILL']]);
  });

  it('re-sends kill(-1) on every pass, so a process forked meanwhile goes too', async () => {
    const root = proc({ 1: 'S', 12: 'S' });
    let passes = 0;
    const kill = (): void => {
      passes += 1;
      gone(root, 12);
      if (passes === 1) setProcess(root, 13, 'R'); // forked in flight
      else gone(root, 13);
    };
    expect(await clearNamespace({ self: 1, procRoot: root, kill, intervalMs: 1 })).toBeNull();
    expect(passes).toBe(2);
  });

  it('takes ESRCH (nothing else to signal) as nothing left', async () => {
    const root = proc({ 1: 'S' });
    const kill = (): void => {
      throw errno('ESRCH');
    };
    expect(await clearNamespace({ self: 1, procRoot: root, kill })).toBeNull();
  });

  it('gives up with a reason when a process outlives its passes, the kill fails, or a zombie (an orphan) appears', async () => {
    const stays = proc({ 1: 'S', 12: 'R' });
    expect(await clearNamespace({ self: 1, procRoot: stays, kill: () => {}, passes: 3, intervalMs: 1 })).toBe('processes are still in its PID namespace after 3 passes');
    const refused = proc({ 1: 'S', 12: 'R' });
    const eperm = (): void => {
      throw errno('EPERM');
    };
    expect(await clearNamespace({ self: 1, procRoot: refused, kill: eperm })).toBe('the kill before the reply failed (EPERM)');
    const orphan = proc({ 1: 'S', 12: 'Z' });
    expect(await clearNamespace({ self: 1, procRoot: orphan, kill: () => {} })).toMatch(/an orphaned process \(a zombie that is not its own child\)/);
  });

  it('never signals anything unless the caller is PID 1: kill(-1) would reach every process of the uid', async () => {
    const root = proc({ 1: 'S', 7: 'S' });
    const sent: number[] = [];
    await expect(clearNamespace({ self: 7, procRoot: root, kill: (pid) => void sent.push(pid) })).rejects.toThrow('runs only as PID 1');
    expect(sent).toEqual([]);
  });
});

describe('killGroup', () => {
  it('kills the process group the child leads, and passes over one already gone', () => {
    const sent: Array<[number, string]> = [];
    killGroup(321, (pid, signal) => void sent.push([pid, String(signal)]));
    expect(sent).toEqual([[-321, 'SIGKILL']]);
    expect(() =>
      killGroup(321, () => {
        throw errno('ESRCH');
      }),
    ).not.toThrow();
    expect(() =>
      killGroup(321, () => {
        throw errno('EPERM');
      }),
    ).toThrow('EPERM');
  });
});
