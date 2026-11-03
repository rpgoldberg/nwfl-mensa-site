// The sidecars' PID-namespace sweep (UNTRUSTED-PDF-GATE M1), on a made-up /proc tree: nothing here
// sends a signal to a real process. The lift test (test/pdf/engine-sidecar.test.ts) runs the real
// sweep in a PID namespace of its own.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { killGroup } from './isolated.js';
import { ownNamespaceProblem, processIds, realUid, sweepNamespace } from './pidns.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A /proc with these processes (pid: real uid), plus the entries a real one has that are not processes. */
function proc(processes: Record<number, number>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nwfl-proc-'));
  roots.push(root);
  for (const [pid, uid] of Object.entries(processes)) {
    mkdirSync(path.join(root, pid));
    writeFileSync(path.join(root, pid, 'status'), `Name:\tnode\nState:\tS (sleeping)\nPPid:\t1\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
  }
  mkdirSync(path.join(root, 'sys'));
  writeFileSync(path.join(root, 'uptime'), '1.0 1.0\n');
  mkdirSync(path.join(root, 'self'));
  return root;
}

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

describe('processIds and realUid', () => {
  it('lists only the numbered entries, and reads the real uid from status', () => {
    const root = proc({ 1: 10002, 7: 10002, 31: 0 });
    expect(processIds(root)).toEqual([1, 7, 31]);
    expect(realUid(31, root)).toBe(0);
    expect(realUid(7, root)).toBe(10002);
    expect(realUid(99, root)).toBeUndefined();
    writeFileSync(path.join(root, '7', 'status'), 'Name:\tnode\n');
    expect(realUid(7, root)).toBeUndefined();
  });
});

describe('ownNamespaceProblem: whether the sidecar may sweep (it must be in a PID namespace of its own)', () => {
  const self = { pid: 7, ppid: 1, uid: 10002 };

  it('is null in a container of its own: dumb-init as PID 1, the sidecar its child, every process its uid', () => {
    expect(ownNamespaceProblem(self, proc({ 1: 10002, 7: 10002, 12: 10002 }))).toBeNull();
  });

  it('refuses PID 1: it cannot reap orphans, so dumb-init must be PID 1', () => {
    expect(ownNamespaceProblem({ ...self, pid: 1, ppid: 0 }, proc({ 1: 10002 }))).toMatch(/is PID 1.*dumb-init/);
  });

  it('refuses root, a parent other than PID 1, and a namespace another user shares (a shared process namespace)', () => {
    expect(ownNamespaceProblem({ ...self, uid: 0 }, proc({ 1: 0, 7: 0 }))).toMatch(/root/);
    expect(ownNamespaceProblem({ ...self, ppid: 5 }, proc({ 1: 10002, 5: 10002, 7: 10002 }))).toMatch(/parent is not PID 1/);
    // shareProcessNamespace: the pause container (65535), the worker (10001) and linkerd-proxy (2102) are visible.
    expect(ownNamespaceProblem(self, proc({ 1: 65535, 7: 10002, 9: 10001, 11: 2102 }))).toMatch(/another user/);
  });

  it('ignores a process that is gone by the time its status is read', () => {
    const root = proc({ 1: 10002, 7: 10002 });
    mkdirSync(path.join(root, '44'));
    expect(ownNamespaceProblem(self, root)).toBeNull();
  });
});

describe('sweepNamespace: after every job, every process but PID 1 and the sidecar is killed', () => {
  it('kills each other process with SIGKILL, sparing PID 1 and itself', () => {
    const root = proc({ 1: 10002, 7: 10002, 12: 10002, 40: 10002 });
    const sent: Array<[number, string]> = [];
    const killed = sweepNamespace(7, { procRoot: root, kill: (pid, signal) => void sent.push([pid, String(signal)]) });
    expect(killed).toEqual([12, 40]);
    expect(sent).toEqual([
      [12, 'SIGKILL'],
      [40, 'SIGKILL'],
    ]);
  });

  it('passes over a process that ended meanwhile, and throws on any other failure to kill', () => {
    const root = proc({ 1: 10002, 7: 10002, 12: 10002, 40: 10002 });
    const gone = (pid: number): void => {
      if (pid === 12) throw errno('ESRCH');
    };
    expect(sweepNamespace(7, { procRoot: root, kill: gone })).toEqual([40]);
    expect(() =>
      sweepNamespace(7, {
        procRoot: root,
        kill: () => {
          throw errno('EPERM');
        },
      }),
    ).toThrow('EPERM');
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
