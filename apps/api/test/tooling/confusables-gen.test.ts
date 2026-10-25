// src/redaction/confusables.ts is generated (REDACT R2a fix 4). The generator
// and its input are in the repo: scripts/confusables-gen.ts reads Unicode
// confusables.txt 18.0.0 from scripts/unicode/ (gzip, checked by sha256), so
// regenerating the table needs no network and reproduces the committed file
// byte for byte, or this fails.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { PINNED, generate, main, readPinned } from '../../scripts/confusables-gen.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TABLE = path.join(ROOT, 'src/redaction/confusables.ts');
const INPUT = path.join(ROOT, PINNED.file);
const scratch = mkdtempSync(path.join(os.tmpdir(), 'nwfl-confusables-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('scripts/confusables-gen.ts', () => {
  it('is pinned to confusables.txt 18.0.0, by the sha256 the generated table names', () => {
    expect(PINNED.version).toBe('18.0.0');
    expect(PINNED.sha256).toBe('6ed3ee967c9dfdf6677d563c9985182fbc50a2efb7d6059cd57b2e2ce18f5b92');
    expect(readFileSync(TABLE, 'utf8')).toContain(`version ${PINNED.version}, 2026-08-06;\n// sha256 ${PINNED.sha256})`);
    const text = readPinned(readFileSync(INPUT));
    expect(createHash('sha256').update(text).digest('hex')).toBe(PINNED.sha256);
  });

  it('regenerates src/redaction/confusables.ts byte for byte, offline', () => {
    const generated = generate(readPinned(readFileSync(INPUT)));
    // The fold uses the runtime's Unicode tables; a different Node may classify a new letter differently.
    expect(Buffer.from(generated).equals(readFileSync(TABLE)), `differs under Node ${process.version} (Unicode ${process.versions.unicode})`).toBe(true);
  });

  it('refuses an input that is not the pinned file', () => {
    const text = readPinned(readFileSync(INPUT));
    expect(() => readPinned(gzipSync(Buffer.from(text.replace('0251', '0252'))))).toThrow(/sha256/);
    expect(() => readPinned(Buffer.from('not gzip'))).toThrow();
  });

  it('writes the table, and with --check, fails when the committed one differs', async () => {
    const out = path.join(scratch, 'confusables.ts');
    const logs: string[] = [];
    expect(main(['--out', out], { root: ROOT, log: (line) => logs.push(line) })).toBe(0);
    expect(readFileSync(out).equals(readFileSync(TABLE))).toBe(true);
    expect(logs.join('\n')).toMatch(/808 entries/);
    expect(main(['--check', '--out', out], { root: ROOT, log: (line) => logs.push(line) })).toBe(0);
    writeFileSync(out, 'stale');
    expect(main(['--check', '--out', out], { root: ROOT, log: (line) => logs.push(line) })).toBe(1);
    expect(logs.at(-1)).toMatch(/differs/);
    expect(main(['--bogus'], { root: ROOT, log: (line) => logs.push(line) })).toBe(2);

    // And as a command, run by Node itself (type stripping), against the committed table.
    const run = await new Promise<{ code: number; out: string }>((resolve) =>
      execFile(process.execPath, ['scripts/confusables-gen.ts', '--check'], { cwd: ROOT }, (error, stdout, stderr) =>
        resolve({ code: error === null ? 0 : 1, out: `${stdout}${stderr}` }),
      ),
    );
    expect(run.code, run.out).toBe(0);
  });
});
