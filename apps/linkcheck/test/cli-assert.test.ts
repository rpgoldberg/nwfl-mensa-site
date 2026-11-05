// S3 (round 2): check asserts that every kept URL is its own kept form before it writes check.json. The
// checker cannot produce such a result (parseKept refuses it first), so checkAll is replaced here by one
// that returns a result with the non-idempotent kept form round 1 could write ('#' in a local part).
import { describe, expect, it, vi } from 'vitest';
import type { CheckResult } from '../src/check.js';
import { type Io, main } from '../src/cli.js';
import { readPdf } from '../src/extract.js';
import { buildPdf, uriLink } from './helpers/pdf.js';

vi.mock('../src/check.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/check.js')>();
  const bad: CheckResult = { url: 'mailto:a%23b@example.org', kind: 'mail', verdict: 'ok', reasons: [], notes: [], keepable: true, kept: 'mailto:a#b@example.org', chain: [] };
  return { ...real, checkAll: () => Promise.resolve([bad]) };
});

describe('check', () => {
  it('writes no check.json when a kept URL is not its own kept form', async () => {
    const pdf = buildPdf([{ text: [{ x: 72, y: 700, str: 'Write to us' }], annots: [uriLink([72, 696, 150, 712], 'mailto:a%23b@example.org')] }]);
    const files = new Map<string, string | Uint8Array>([['/in/p.pdf', pdf]]);
    const err: string[] = [];
    const io = {
      readFile: (path: string) => {
        const got = files.get(path) ?? '';
        return Promise.resolve(typeof got === 'string' ? new TextEncoder().encode(got) : got);
      },
      writeFile: (path: string, data: string) => {
        files.set(path, data);
        return Promise.resolve();
      },
      print: () => undefined,
      warn: (line: string) => err.push(line),
      env: {},
      now: () => new Date('2026-11-05T04:00:00.000Z'),
      checkDeps: () => ({}),
      extract: (bytes: Uint8Array, audience: 'public' | 'members') => readPdf(bytes, audience),
    } as unknown as Io;
    expect(await main(['extract', '--audience', 'public', '--in', '/in/p.pdf', '--out', '/o'], io)).toBe(0);
    expect(await main(['check', '--issue-date', '2026-09-01', '--out', '/o', '/o/extract-public.json'], io)).toBe(1);
    expect(files.has('/o/check.json')).toBe(false);
    expect(err).toEqual(['linkcheck: an unexpected error (Error)']);
  });
});
