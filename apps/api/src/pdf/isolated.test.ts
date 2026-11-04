// The engine in a process of its own (HARDEN-1 Fix 1): each copy is made in a child that exits after
// it, so PDFium's and pdf.js's heaps go back to the OS, and (fix round 2) that cannot start a process.
// The children here are stand-ins (test/pdf/children), all benign: the ones that start processes run
// only in a capped container (test/pdf/engine-sidecar.test.ts).
import { execFileSync, fork } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { GATE_CHILD_SOURCE, NODE_FLAGS } from '../../test/helpers/sidecar.js';
import { linesPdf } from '../../test/pdf/fixtures.js';
import { PassThrough } from 'node:stream';
import { CHILD_LOG_BYTES, ENGINE_CHILD, engineExecArgv, engineReply, isolatedRedact, relayChildLog, withoutCanvasWarnings } from './isolated.js';
import { CHILD_PERMISSION, guardFlag, limitForks } from './no-fork.js';
import { redactPdf } from './redact.js';

const child = (name: string): string => fileURLToPath(new URL(`../../test/pdf/children/${name}.ts`, import.meta.url));
const guard = (name: string): string => fileURLToPath(new URL(`../../test/pdf/guards/${name}.ts`, import.meta.url));
const REQUEST = { quotes: ['Kestrel'], redactsAny: true };

describe('isolatedRedact', () => {
  it('runs the engine in a child and hands back its copy, bytes intact', async () => {
    const result = await isolatedRedact({ module: child('echo') })(Uint8Array.from([1, 2, 3]), REQUEST);
    expect(result).toEqual({ kind: 'redacted', pdf: Uint8Array.from([3, 2, 1]) });
  });

  it('passes on a refusal from the child', async () => {
    expect(await isolatedRedact({ module: child('refuse') })(Uint8Array.from([1]), REQUEST)).toEqual({ kind: 'refused', reason: 'refused by the engine process' });
  });

  it('fails when the engine threw in the child', async () => {
    await expect(isolatedRedact({ module: child('fail') })(Uint8Array.from([1]), REQUEST)).rejects.toThrow('the engine threw');
  });

  it('fails when the child dies without an answer: a crash, or a kill (out of memory)', async () => {
    await expect(isolatedRedact({ module: child('crash') })(Uint8Array.from([1]), REQUEST)).rejects.toThrow('the engine process ended without a copy (exit 3)');
    await expect(isolatedRedact({ module: child('oom') })(Uint8Array.from([1]), REQUEST)).rejects.toThrow('the engine process ended without a copy (SIGKILL)');
    await expect(isolatedRedact({ module: child('missing') })(Uint8Array.from([1]), REQUEST)).rejects.toThrow('the engine process ended without a copy (exit 1)');
  });

  it('logs at most CHILD_LOG_BYTES of the child\'s stderr and none of its stdout (S2: a subverted child could fill the container log)', async () => {
    const logged: Buffer[] = [];
    expect(await isolatedRedact({ module: child('noisy'), log: (chunk) => void logged.push(chunk) })(Uint8Array.from([1]), REQUEST)).toEqual({ kind: 'refused', reason: 'refused by the noisy engine' });
    const text = Buffer.concat(logged).toString('latin1');
    expect(text.startsWith('noisy-start ')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(CHILD_LOG_BYTES + 100);
    expect(text).not.toContain('o'.repeat(64));
  });

  it('drops all of each child\'s stdout: a parent running the engine and the gate children writes none (fix round 4, integrity S1)', async () => {
    const parent = fork(fileURLToPath(new URL('../../test/pdf/children/stdout-parent.ts', import.meta.url)), [], { env: {}, execArgv: NODE_FLAGS, stdio: ['ignore', 'pipe', 'ignore', 'ipc'] });
    const out: Buffer[] = [];
    parent.stdout?.on('data', (chunk: Buffer) => void out.push(chunk));
    const said = new Promise<unknown>((resolve) => parent.once('message', resolve));
    await new Promise((resolve) => parent.once('exit', resolve));
    expect(await said).toEqual({ engine: { kind: 'refused', reason: 'refused by the noisy engine' }, gate: { pass: true } });
    expect(Buffer.concat(out).length).toBe(0);
  });

  it('runs its child under Node\'s permission model with read access only: it cannot write, make, rename, remove or chmod a file, load native code or start a process (fix round 4, S2), nor listen on a socket (fix round 5b, S2)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nwfl-iso-'));
    try {
      writeFileSync(path.join(dir, 'kept'), 'x');
      const result = await isolatedRedact({ module: child('try-write') })(Uint8Array.from([1]), { quotes: [dir], redactsAny: true });
      const denied = 'ERR_ACCESS_DENIED';
      expect(JSON.parse((result as { reason: string }).reason)).toEqual({ write: denied, mkdir: denied, rename: denied, remove: denied, chmod: denied, dlopen: 'ERR_DLOPEN_DISABLED', spawn: denied, listen: denied, listen2: denied, createServerHandle: denied, namedHandle: denied, left: 'kept' });
      expect(readdirSync(dir)).toEqual(['kept']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sets the child\'s oom_score_adj to 1000 in its guard, the kernel\'s first pick if it acts (S5)', async () => {
    expect(await isolatedRedact({ module: child('oom-score') })(Uint8Array.from([1]), REQUEST)).toEqual({ kind: 'refused', reason: '1000' });
  });

  it('kills a child that takes too long', async () => {
    await expect(isolatedRedact({ module: child('hang'), timeoutMs: 300 })(Uint8Array.from([1]), REQUEST)).rejects.toThrow('the engine process took longer than 300 ms');
  });

  it('gives the child no environment: the worker\'s database login and every other variable stay behind', async () => {
    // CF-ISO-0: the child parses untrusted PDFs. Through the real fork, with the worker's PG* set.
    const planted = { PGHOST: 'pg.example.invalid', PGUSER: 'nwfl_worker', PGPASSWORD: 'canary-pg-password', DATABASE_URL: 'postgres://u:canary@h/d', SOME_TOKEN: 'canary-token' };
    const before = { ...process.env };
    Object.assign(process.env, planted);
    try {
      const result = await isolatedRedact({ module: child('env') })(Uint8Array.from([1]), REQUEST);
      expect(result.kind).toBe('refused');
      const seen = JSON.parse((result as { reason: string }).reason) as string[];
      expect(seen.filter((name) => name.startsWith('PG'))).toEqual([]);
      expect(seen).toEqual([]);
    } finally {
      for (const name of Object.keys(planted)) {
        if (before[name] === undefined) delete process.env[name];
        else process.env[name] = before[name];
      }
    }
  });

  it('gives the child none of an --env-file the worker was started with (CF-ISO-0 N1)', () => {
    // fork() passes the parent's Node flags on, so without a filter the child would load the file itself.
    const dir = mkdtempSync(path.join(tmpdir(), 'nwfl-envfile-'));
    try {
      const file = path.join(dir, 'worker.env');
      writeFileSync(file, 'PGPASSWORD=canary-from-env-file\nPGUSER=nwfl_worker\n', { mode: 0o600 });
      const parent = fileURLToPath(new URL('../../test/pdf/children/env-file-parent.mjs', import.meta.url));
      const out = execFileSync(process.execPath, [`--env-file=${file}`, parent], { env: {}, encoding: 'utf8' });
      expect(JSON.parse((JSON.parse(out) as { reason: string }).reason)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the permission model on in the child of a parent started with --permission-audit or underscore grants (fix round 6, S2b: flags6)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nwfl-flags-'));
    try {
      writeFileSync(path.join(dir, 'kept'), 'x');
      const parent = fileURLToPath(new URL('../../test/pdf/children/flags-parent.mjs', import.meta.url));
      // Node takes grants only with --permission, so the underscore grants come with it (and a read grant, to load the stand-in).
      const grants = ['--permission', '--allow-fs-read=*', '--allow_fs_write=*', '--allow_child_process', '--allow_worker', '--allow_addons'];
      for (const flags of [['--permission-audit'], ['--permission_audit'], grants]) {
        const out = execFileSync(process.execPath, [...flags, '--disable-warning=ExperimentalWarning', '--experimental-transform-types', parent, 'try-write', dir], { env: {}, encoding: 'utf8' });
        const outcome = JSON.parse((JSON.parse(out) as { reason: string }).reason) as Record<string, string>;
        expect([outcome['write'], outcome['spawn'], outcome['left']], flags.join(' ')).toEqual(['ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED', 'kept']);
      }
      expect(readdirSync(dir)).toEqual(['kept']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives the child only the parent\'s flags on its allowlist, each name read with _ as -, as Node reads it: no environment file, no grant or audit mode of the permission model, nothing else (fix round 6, S2b)', () => {
    expect(
      engineExecArgv(['--max-old-space-size=512', '--env-file=/a', '--env-file', '/b', '--env-file-if-exists=/c', '--env-file-if-exists', '/d', '--import', 'x', '--enable-source-maps']),
    ).toEqual(['--import', 'x', '--enable-source-maps']);
    expect(engineExecArgv(['--env-file'])).toEqual([]);
    expect(engineExecArgv(['--import'])).toEqual([]);
    // No flag of the permission model a parent may have been started with: the child gets CHILD_PERMISSION alone (fix round 4, S2).
    expect(engineExecArgv(['--permission', '--allow-fs-write=*', '--allow-fs-write', '/x', '--allow-fs-read', '/', '--allow-child-process', '--allow-worker', '--allow-addons', '--allow-wasi'])).toEqual([]);
    expect(engineExecArgv(['--allow-inspector', '--allow-openssl-store', '--allow-net', '--allow-net=x', '--experimental-sqlite', '--experimental-webstorage', '--localstorage-file=/x', '--no-freeze-flags-after-init'])).toEqual([]);
    // The round-6 challenge's (flags6): the audit mode, which turns the model off with --permission after it, and the underscore spellings.
    expect(engineExecArgv(['--permission-audit', '--permission_audit', '--allow_fs_write=*', '--allow_child_process', '--allow_worker', '--allow_addons', '--experimental_permission', '--env_file=/x', '--env_file', '/y', '--no_freeze_flags_after_init'])).toEqual([]);
    // What the test runner and the TypeScript loader need, either spelling, values in both forms.
    const kept = ['--experimental-import-meta-resolve', '--require', '/s.cjs', '-r', '/t.cjs', '--conditions', 'development', '-C', 'node', '--conditions=x', '--import=file:///h.mjs', '--experimental_transform_types', '--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--disable-warning', 'DEP0040', '--no-warnings', '--disable-sigusr1', '--enable_source_maps'];
    expect(engineExecArgv(kept)).toEqual(kept);
    // A value of a dropped flag is dropped with it, never left for Node to read as a flag or a script.
    expect(engineExecArgv(['--title', 'x', '--disable-sigusr1', 'stray'])).toEqual(['--disable-sigusr1']);
  });

  it('puts the permission model\'s flags after every flag the child inherits, then the guard, so none it inherits can undo them (fix round 5, S2)', async () => {
    const flags = async (permission?: boolean): Promise<string[]> => JSON.parse(((await isolatedRedact({ module: child('argv'), permission })(Uint8Array.from([1]), REQUEST)) as { reason: string }).reason) as string[];
    const given = await flags();
    expect(given.slice(-1 - CHILD_PERMISSION.length)).toEqual([...CHILD_PERMISSION, guardFlag()]);
    expect(given.slice(0, -1 - CHILD_PERMISSION.length)).toEqual(engineExecArgv(process.execArgv));
    expect(await flags(false)).toEqual([...engineExecArgv(process.execArgv), guardFlag()]);
  });

  it('gives the child RLIMIT_NPROC 1 before it is sent the original (no-fork, fix round 2)', async () => {
    const result = await isolatedRedact({ module: child('limits') })(Uint8Array.from([1]), REQUEST);
    expect(result).toMatchObject({ kind: 'refused' });
    expect((result as { reason: string }).reason).toMatch(/^Max processes\s+1\s+1\s+processes/);
  });

  it('refuses the copy, before the child is sent the original, when its limit cannot be set or its spawn still works', async () => {
    // The mark stand-in signals this process as soon as it is sent a job.
    let ran = 0;
    const heard = (): void => void (ran += 1);
    process.on('SIGURG', heard);
    try {
      const me = { quotes: [String(process.pid)], redactsAny: true };
      const failing = (): Promise<void> => Promise.reject(Object.assign(new Error('prlimit: not found'), { code: 'ENOENT' }));
      await expect(isolatedRedact({ module: child('mark'), limit: failing })(Uint8Array.from([1]), me)).rejects.toThrow(
        'the engine process was refused: its limit on starting processes could not be set (ENOENT)',
      );
      await expect(isolatedRedact({ module: child('mark'), guard: guard('lies') })(Uint8Array.from([1]), me)).rejects.toThrow(
        'the engine process was refused: it could still start a process (a process started (exit 0))',
      );
      // The control: sent a job, it signals.
      expect(await isolatedRedact({ module: child('mark') })(Uint8Array.from([1]), me)).toEqual({ kind: 'refused', reason: 'refused by the engine process' });
      await vi.waitFor(() => expect(ran).toBe(1));
    } finally {
      process.off('SIGURG', heard);
    }
  });

  it('runs the real engine and gate children to their exit when their parent goes away (N3: no orphan)', async () => {
    for (const module of [fileURLToPath(new URL('./engine-child.ts', import.meta.url)), GATE_CHILD_SOURCE]) {
      const real = fork(module, [], { env: {}, execArgv: [...NODE_FLAGS, guardFlag()], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      const exited = new Promise<number | null>((resolve) => real.once('exit', (code) => resolve(code)));
      real.on('message', (message) => {
        const { guard: step } = message as { guard?: string };
        if (step === 'ready') void limitForks(real.pid as number).then(() => real.send({ guard: 'limited' }));
        // Its own module listens for a job now: the parent goes away instead of sending one.
        else if (step === 'listening') real.disconnect();
      });
      const t0 = Date.now();
      expect(await exited, module).toBe(1);
      expect(Date.now() - t0, module).toBeLessThan(20_000);
    }
  }, 40_000);

  it('kills the child when its signal aborts (the sidecar: a worker that hung up, or a stop), and forks none for a signal already aborted', async () => {
    const controller = new AbortController();
    const job = isolatedRedact({ module: child('hang'), signal: controller.signal })(Uint8Array.from([1]), REQUEST);
    setTimeout(() => controller.abort(), 200);
    await expect(job).rejects.toThrow('the engine process was stopped');
    await expect(isolatedRedact({ module: child('missing'), signal: AbortSignal.abort() })(Uint8Array.from([1]), REQUEST)).rejects.toThrow('the engine process was stopped');
  });

  it('runs the built engine-child.js next to it by default', () => {
    expect(ENGINE_CHILD).toMatch(/[/\\]pdf[/\\]engine-child\.js$/);
  });
});

describe('engineReply (the child\'s side)', () => {
  it('answers with the engine\'s result', async () => {
    const reply = await engineReply({ original: await linesPdf(['Phone Kestrel now.']), request: REQUEST }, redactPdf);
    expect(reply.ok && reply.result.kind).toBe('redacted');
  });

  it('answers with the message when the engine throws, and never throws itself', async () => {
    expect(await engineReply({ original: Uint8Array.from([1]), request: REQUEST }, () => Promise.reject(new Error('no wasm')))).toEqual({ ok: false, message: 'no wasm' });
    // A non-Error rejection, as a WebAssembly abort can give.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    expect(await engineReply({ original: Uint8Array.from([1]), request: REQUEST }, () => Promise.reject('odd'))).toEqual({ ok: false, message: 'odd' });
  });
});

describe('withoutCanvasWarnings (the child\'s console.warn)', () => {
  it('drops only pdf.js\'s three load-time canvas warnings', () => {
    const seen: unknown[][] = [];
    const warn = withoutCanvasWarnings((...args: unknown[]) => void seen.push(args));
    warn('Warning: Cannot load "@napi-rs/canvas" package: "Error: Cannot find module \'@napi-rs/canvas\'\nRequire stack:\n- /app/x".');
    warn('Warning: Cannot polyfill `DOMMatrix`, rendering may be broken.');
    warn('Warning: Cannot polyfill `Path2D`, rendering may be broken.');
    warn('Warning: something else');
    warn(42);
    expect(seen).toEqual([['Warning: something else'], [42]]);
  });
});

describe('relayChildLog (a child\'s stderr, capped)', () => {
  it('passes on the first bytes up to the cap, says once that the rest is dropped, reads to the end, and spots a V8 heap OOM across chunks (S2, N1)', async () => {
    const stream = new PassThrough();
    const logged: Buffer[] = [];
    const log = relayChildLog(stream, (chunk) => void logged.push(chunk), 10);
    stream.write('0123456');
    stream.write('789abc');
    stream.write('...JavaScript heap ');
    stream.end('out of memory\n');
    await log.ended;
    expect(Buffer.concat(logged).toString()).toBe("0123456789\n[the rest of this child's log is dropped]\n");
    expect(log.heapOutOfMemory()).toBe(true);
    const quiet = new PassThrough();
    const other = relayChildLog(quiet, () => {}, 10);
    quiet.end('a crash');
    await other.ended;
    expect(other.heapOutOfMemory()).toBe(false);
    const none = relayChildLog(null);
    await none.ended;
    expect(none.heapOutOfMemory()).toBe(false);
  });
});
