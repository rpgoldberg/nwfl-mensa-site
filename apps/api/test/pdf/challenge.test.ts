// REDACT R3a fix 1: the challenger's crafted PDFs (test/pdf/challenge/, every
// name made up). Each got a marked name out of a copy that only PDFium had
// checked. Now every copy passes an independent output gate before it is
// given: either the copy holds no trace of the name, or there is no copy and
// an officer can read why.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type RedactResult, redactPdf } from '../../src/pdf/redact.js';
import { extractAll, leaked, rawText } from './extract.js';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./challenge/${name}.pdf`, import.meta.url)));

async function leaks(result: RedactResult, needles: readonly string[]): Promise<string[]> {
  if (result.kind !== 'redacted') throw new Error(`expected a redacted copy, got ${JSON.stringify(result)}`);
  const extracted = await extractAll(result.pdf);
  const raw = rawText(result.pdf);
  return needles.filter((needle) => leaked(needle, extracted, raw));
}

describe('the output gate: names PDFium cannot see are never given', () => {
  // [fixture, quote, why PDFium missed it]
  const refused: Array<[string, string, string]> = [
    ['inline-image-desync', 'Yorick Dalgleish', 'an inline image whose size swallows the text after it'],
    ['tj-reorder', 'Farrowgate', 'a TJ whose pieces are drawn in another order than written'],
    ['tounicode-lie', 'Quint Gorvath', 'a ToUnicode map that reads every letter as the next one'],
    ['pattern-text', 'Vesna Holroyd', 'a tiling pattern that draws the name'],
    ['type3-charproc-text', 'Rufus Kettering', 'a Type 3 glyph that draws the name'],
    ['extra-dict-keys', 'Wilmot Crane', '/Comment strings in a resource, form and font dictionary'],
  ];
  for (const [name, quote, why] of refused) {
    it(`gives no copy, with a reason, for ${why} (${name})`, async () => {
      const result = await redactPdf(fixture(name), { quotes: [quote], redactsAny: false });
      expect(result.kind).toBe('refused');
      expect(result.kind === 'refused' ? result.reason : '').toMatch(/withheld text/);
    });
  }

  it('drops a form only another page\'s shared resources point at (shared-resources-form)', async () => {
    const result = await redactPdf(fixture('shared-resources-form'), { quotes: ['Ulla Brackwater'], redactsAny: false });
    expect(await leaks(result, ['Ulla Brackwater', 'Brackwater'])).toEqual([]);
  });

  it('drops a form a page lists but never draws (unused-xobject-p2)', async () => {
    const result = await redactPdf(fixture('unused-xobject-p2'), { quotes: ['Ulla Brackwater'], redactsAny: false });
    expect(await leaks(result, ['Ulla Brackwater', 'Brackwater'])).toEqual([]);
  });

  it('strips the comment and XMP segments from a JPEG, keeping the picture (jpeg-com-xmp)', async () => {
    const result = await redactPdf(fixture('jpeg-com-xmp'), { quotes: ['Xavia Penhallow'], redactsAny: false });
    expect(await leaks(result, ['Xavia Penhallow', 'Penhallow'])).toEqual([]);
    expect(rawText(result.kind === 'redacted' ? result.pdf : new Uint8Array())).toContain('/DCTDecode');
  });
});

describe('the post-rebuild check', () => {
  it('gives no copy when the rebuilt copy has a page PDFium skipped while redacting (page-count-lie)', async () => {
    expect(await redactPdf(fixture('page-count-lie'), { quotes: ['Gwen Ostley'], redactsAny: false })).toEqual({
      kind: 'refused',
      reason: 'page 2: withheld text is still readable after removal',
    });
  });
});

describe('the length hint at a line end', () => {
  it('gives "Ann Lee" and "Ann Leek" the same box when each ends its line', async () => {
    const lee = await redactPdf(fixture('size-lineend-Lee'), { quotes: ['Ann Lee'], redactsAny: false });
    const leek = await redactPdf(fixture('size-lineend-Leek'), { quotes: ['Ann Leek'], redactsAny: false });
    if (lee.kind !== 'redacted' || leek.kind !== 'redacted') throw new Error(JSON.stringify([lee, leek]));
    expect(lee.boxes).toHaveLength(1);
    expect(lee.boxes).toEqual(leek.boxes);
    // The box runs past where either name ends (Leek ends at 300.13).
    expect(lee.boxes[0]?.right).toBeGreaterThan(400);
  });
});

describe('scanned pages', () => {
  it('gives no copy of a page that is a picture with a footer, when the audience redacts anything (scan-plus-footer)', async () => {
    expect(await redactPdf(fixture('scan-plus-footer'), { quotes: [], redactsAny: true })).toEqual({
      kind: 'refused',
      reason: 'page 1 is a scan: pictures cover most of it',
    });
  });
});

describe('letter spacing', () => {
  it('finds a name whose first word alone is letter-spaced (Tc-letterspaced)', async () => {
    const result = await redactPdf(fixture('Tc-letterspaced'), { quotes: ['Juno Blackwood'], redactsAny: false });
    expect(await leaks(result, ['Juno Blackwood', 'Blackwood'])).toEqual([]);
  });
});
