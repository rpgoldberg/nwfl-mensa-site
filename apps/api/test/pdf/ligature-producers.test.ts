// LIGATURE fix 1 (F1): Ghostscript 10.05.1 re-distilling a WeasyPrint 62.3 file (test/pdf/challenge/gs-wp-*.pdf, the
// challenger's honest producer files, every name made up). Ghostscript writes each ligature glyph as a wrong but
// readable code point: in Noto Serif fi U+0856, fl U+0857, ff U+0853, ffl U+0855 and ffi "f" and U+00CF; in Carlito ti
// U+08A2 and tt U+08B0, and others as letters and signs PDFium has no Unicode for (a map error). Several names are
// hyphenated across lines too. Each named quote is boxed or its copy refused by the engine, and the gate refuses a copy
// that shows it on its own.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gateVerdict } from '../../src/pdf/gate-rules.js';
import { redactPdf } from '../../src/pdf/redact.js';
import { extractAll } from './extract.js';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./challenge/${name}.pdf`, import.meta.url)));

/** Each named quote, and a piece of it no ligature breaks, which no copy may show. */
const NAMED: ReadonlyArray<readonly [string, RegExp]> = [
  ['Fifi Amberwick', /Amberwick/],
  ['Orla Penfleet', /Orla Pen/],
  ['Tiffin Ashgrove', /Ashgrove/],
  ['Ferncliff', /Ferncli/],
  ['Bartolomeo Effingtonshirecastle', /ngtonshire/],
  ['Hieronymus Wafflestaffordshire', /eronymus/],
];

describe.each(['gs-wp-noto-std', 'gs-wp-carlito-std'])('LIGATURE fix 1: %s', (file) => {
  const original = fixture(file);

  it.each(NAMED)('the engine boxes %s or refuses the copy', async (quote, piece) => {
    const result = await redactPdf(original, { quotes: [quote], redactsAny: true, image: 'show' });
    if (result.kind === 'redacted') {
      expect(result.boxes.length).toBeGreaterThan(0);
      expect(await extractAll(result.pdf)).not.toMatch(piece);
      expect(await gateVerdict({ copy: result.pdf, original, quotes: [quote], image: 'show' })).toEqual({ pass: true });
    } else expect(result.kind).toBe('refused');
  });

  it.each(NAMED)('the gate alone refuses a copy that shows %s', async (quote) => {
    expect(await gateVerdict({ copy: original, original, quotes: [quote], image: 'show' })).toEqual({ pass: false, code: 'withheld' });
  });
});

describe('LIGATURE fix 1: a request with no quote on the Ghostscript files', () => {
  it('is served where it was: the Noto file has no map error', async () => {
    const result = await redactPdf(fixture('gs-wp-noto-std'), { quotes: [], redactsAny: true, image: 'show' });
    expect(result.kind).toBe('redacted');
  });

  it('is refused where it was: PDFium has no Unicode for some of the Carlito file\'s glyphs', async () => {
    expect(await redactPdf(fixture('gs-wp-carlito-std'), { quotes: [], redactsAny: true, image: 'show' })).toEqual({ kind: 'refused', reason: 'page 1 has text that cannot be read' });
  });
});

describe('LIGATURE fix 2 (S1): gs-wp-noto-std with a name and a passage not on the page', () => {
  const PASSAGE = 'The attendees list for the October potluck is withheld from the public edition of this newsletter.';

  it('boxes the name as it does alone, and the gate passes the copy', async () => {
    const original = fixture('gs-wp-noto-std');
    const quotes = ['Orla Penfleet', PASSAGE];
    const result = await redactPdf(original, { quotes, redactsAny: true, image: 'show' });
    if (result.kind !== 'redacted') throw new Error(`expected a copy, got ${JSON.stringify(result)}`);
    expect(result.boxes.length).toBeGreaterThan(0);
    expect(await extractAll(result.pdf)).not.toMatch(/Orla Pen/);
    expect(await gateVerdict({ copy: result.pdf, original, quotes, image: 'show' })).toEqual({ pass: true });
  });
});
