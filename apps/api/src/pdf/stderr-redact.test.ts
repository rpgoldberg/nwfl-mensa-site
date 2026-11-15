// LG-N3: what the PDF sidecars and their children write to stderr passes through the site redactor
// before it reaches the log. Streams only: no PDF and no child process here.
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { relayChildLog } from './isolated.js';
import { stderrLines } from './sidecar.js';

// Made-up: an address and a bearer token, the shapes a library's error text can carry.
const EMAIL = 'pat.example@example.org';
const TOKEN = 'Bearer abcDEF123.ghi-jkl_mno';

describe("relayChildLog: a child's stderr, redacted", () => {
  it('masks a secret or an address in a line, even one split across chunks', async () => {
    const stream = new PassThrough();
    const logged: Buffer[] = [];
    const log = relayChildLog(stream, (chunk) => void logged.push(chunk));
    stream.write('engine: opening for pat.exa');
    stream.write(`mple@example.org\nauth ${TOKEN.slice(0, 12)}`);
    stream.end(`${TOKEN.slice(12)} refused\nlast line, no newline`);
    await log.ended;
    const text = Buffer.concat(logged).toString();
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain('abcDEF123');
    expect(text).toBe('engine: opening for [REDACTED]\nauth [REDACTED] refused\nlast line, no newline');
  });

  it('masks what it passes before the cap, and still says once that the rest is dropped', async () => {
    const stream = new PassThrough();
    const logged: Buffer[] = [];
    const log = relayChildLog(stream, (chunk) => void logged.push(chunk), 40);
    stream.end(`x ${EMAIL} and more after the cap ${EMAIL}\n`);
    await log.ended;
    const text = Buffer.concat(logged).toString();
    expect(text).not.toMatch(/pat\.example|example\.org/);
    expect(text).toBe("x [REDACTED] and more after\n[the rest of this child's log is dropped]\n");
  });

  it('keeps a long line whole: no cut of its own below the cap', async () => {
    const stream = new PassThrough();
    const logged: Buffer[] = [];
    const log = relayChildLog(stream, (chunk) => void logged.push(chunk));
    stream.end(`${'a'.repeat(10_000)}\n`);
    await log.ended;
    expect(Buffer.concat(logged).toString()).toBe(`${'a'.repeat(10_000)}\n`);
  });

  it('flushes the last part when the stream fails or closes without ending', async () => {
    for (const how of ['error', 'close'] as const) {
      const stream = new PassThrough();
      const logged: Buffer[] = [];
      const log = relayChildLog(stream, (chunk) => void logged.push(chunk));
      stream.write(`dying ${EMAIL}`);
      await new Promise((r) => setImmediate(r));
      if (how === 'error') stream.destroy(new Error('x'));
      else stream.destroy();
      await log.ended;
      expect(Buffer.concat(logged).toString(), how).toBe('dying [REDACTED]');
    }
  });
});

describe('stderrLines: a sidecar’s own lines, redacted', () => {
  it('writes each line through the redactor, with its newline', () => {
    const out: string[] = [];
    const log = stderrLines((text) => void out.push(text));
    log(`the engine sidecar cannot listen: ${TOKEN} for ${EMAIL}`);
    expect(out).toEqual(['the engine sidecar cannot listen: [REDACTED] for [REDACTED]\n']);
  });

  it('writes to stderr by default', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      stderrLines()(`x ${EMAIL}`);
      expect(spy.mock.calls.map((c) => c[0])).toEqual(['x [REDACTED]\n']);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the sidecar entrypoints', () => {
  it('both log through stderrLines', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const file of ['./engine-sidecar.ts', './gate-sidecar.ts']) {
      const source = await readFile(new URL(file, import.meta.url), 'utf8');
      expect(source, file).toMatch(/^const log = stderrLines\(\);$/m);
      expect(source, file).not.toMatch(/process\.stderr\.write/);
    }
  });
});

// The redactor stays on the parent side: an untrusted child loads no more than it did (no fc-shared, no
// OpenTelemetry), so the children's own import graph never reaches platform/.
describe('the PDF children', () => {
  it('never load the platform modules the redactor lives in', async () => {
    const { readFile } = await import('node:fs/promises');
    const seen = new Set<string>();
    const walk = async (file: string): Promise<void> => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = await readFile(new URL(file, import.meta.url), 'utf8');
      for (const [, spec] of source.matchAll(/^import (?!type )[^'"]*['"](\.[^'"]+)\.js['"]/gm)) {
        const next = new URL(`${spec}.ts`, new URL(file, import.meta.url)).pathname;
        await walk(`file://${next}`);
      }
    };
    for (const child of ['./engine-child.ts', './gate-child.ts', './child-guard.ts']) await walk(new URL(child, import.meta.url).href);
    expect([...seen].filter((f) => f.includes('/platform/'))).toEqual([]);
    expect(seen.size).toBeGreaterThan(5);
  });
});
