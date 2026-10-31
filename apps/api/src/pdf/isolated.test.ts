// The engine in a process of its own (HARDEN-1 Fix 1): each copy is made in a child that exits after
// it, so PDFium's and pdf.js's heaps go back to the OS. The children here are stand-ins (test/pdf/children).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { linesPdf } from '../../test/pdf/fixtures.js';
import { ENGINE_CHILD, engineExecArgv, engineReply, isolatedRedact, withoutCanvasWarnings } from './isolated.js';
import { redactPdf } from './redact.js';

const child = (name: string): string => fileURLToPath(new URL(`../../test/pdf/children/${name}.ts`, import.meta.url));
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

  it('drops only the flags that load an environment file from the child\'s Node flags', () => {
    expect(
      engineExecArgv(['--max-old-space-size=512', '--env-file=/a', '--env-file', '/b', '--env-file-if-exists=/c', '--env-file-if-exists', '/d', '--import', 'x', '--enable-source-maps']),
    ).toEqual(['--max-old-space-size=512', '--import', 'x', '--enable-source-maps']);
    expect(engineExecArgv(['--env-file'])).toEqual([]);
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
