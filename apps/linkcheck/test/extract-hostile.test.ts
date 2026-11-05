// Hostile annotations at the extractor (SPEC D7): bounded time and memory, and schema refusals.
// Like the whole suite, this runs only in the capped container of scripts/test-contained.sh.
import { describe, expect, it } from 'vitest';
import { ExtractError, type Extraction, extract as isolated } from '../src/extract.js';
import { buildPdf, uriLink } from './helpers/pdf.js';

const WORKER = new URL('./helpers/extract-worker.mjs', import.meta.url);
/** Every hostile file goes through the isolated read, as production reads it. */
const extract = (pdf: Uint8Array, audience: 'public' | 'members'): Promise<Extraction> => isolated(pdf, audience, { workerUrl: WORKER });

const timed = async <T>(run: () => Promise<T>): Promise<{ ms: number; result: PromiseSettledResult<T> }> => {
  const start = performance.now();
  const [result] = await Promise.allSettled([run()]);
  return { ms: performance.now() - start, result: result as PromiseSettledResult<T> };
};

describe('extract against hostile annotations', () => {
  it('refuses 100 000 annotations on one page in bounded time and memory', async () => {
    const annots = Array.from({ length: 100_000 }, () => '<< /Subtype /Link /Rect [0 0 1 1] /A << /S /URI /URI (tel:1) >> >>');
    const pdf = buildPdf([{}]);
    // One page whose /Annots array holds them all inline, so the file stays under 10 MiB.
    const text = Buffer.from(pdf).toString('latin1').replace('/Contents 4 0 R', `/Contents 4 0 R /Annots [${annots.join(' ')}]`);
    const hostile = rebuildXref(text);
    expect(hostile.length).toBeLessThan(10 * 1024 * 1024);
    const before = process.memoryUsage().rss;
    const { ms, result } = await timed(() => extract(hostile, 'public'));
    expect(result.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason).toEqual(new ExtractError('reading the file needed more than 256 MiB'));
    expect(ms).toBeLessThan(25_000);
    expect(process.memoryUsage().rss - before).toBeLessThan(1024 * 1024 * 1024);
  });

  it('refuses a URI of 5 MB as too long without keeping it', async () => {
    const out = await extract(buildPdf([{ annots: [uriLink([0, 0, 10, 10], `https://example.org/${'a'.repeat(5_000_000)}`)] }]), 'public');
    expect(out.links).toEqual([]);
    expect(out.refused).toEqual([{ page: 1, reason: 'too-long' }]);
  });

  it('refuses a rect of overflowing, nested or missing numbers', async () => {
    const out = await extract(
      buildPdf([
        {
          annots: [
            '<< /Subtype /Link /Rect [1e400 0 10 10] /A << /S /URI /URI (https://example.org/a) >> >>',
            `<< /Subtype /Link /Rect [${'['.repeat(5000)}1${']'.repeat(5000)} 0 10 10] /A << /S /URI /URI (https://example.org/b) >> >>`,
            '<< /Subtype /Link /Rect [0 0 10] /A << /S /URI /URI (https://example.org/c) >> >>',
            '<< /Subtype /Link /A << /S /URI /URI (https://example.org/d) >> >>',
          ],
        },
      ]),
      'public',
    ).catch((error: unknown) => error as Error);
    // Either pdf.js refuses the file (a refusal of the whole file) or every one of these links is refused.
    if (out instanceof Error) expect(out).toBeInstanceOf(ExtractError);
    else expect(out.links.filter((l) => l.rect.some((n) => !Number.isFinite(n))).map((l) => l.url)).toEqual([]);
  });

  it('refuses a javascript: or control-laden URI, never writing it out', async () => {
    const out = await extract(
      buildPdf([{ annots: [uriLink([0, 0, 10, 10], 'JaVaScRiPt:alert(1)'), uriLink([0, 0, 10, 10], ' javascript:alert(1)'), uriLink([0, 0, 10, 10], 'https://example.org/\r\nSet-Cookie: x')] }]),
      'public',
    );
    expect(out.links).toEqual([]);
    expect(out.refused.map((r) => r.reason)).toEqual(['scheme', 'scheme', 'control']);
    expect(JSON.stringify(out)).not.toMatch(/alert|Set-Cookie/);
  });
});

/** The helper's PDF with its body edited: offsets recomputed so pdf.js reads it without repair. */
function rebuildXref(text: string): Uint8Array {
  const body = text.slice(0, text.indexOf('xref\n'));
  const offsets: number[] = [];
  for (const match of body.matchAll(/^(\d+) 0 obj$/gm)) offsets[Number(match[1])] = Buffer.byteLength(body.slice(0, match.index), 'latin1');
  const size = offsets.length;
  let out = `${body}xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let i = 1; i < size; i += 1) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${Buffer.byteLength(body, 'latin1')}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}
