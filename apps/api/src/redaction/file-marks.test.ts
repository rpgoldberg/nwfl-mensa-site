// MLOGIN S3: where a file mark's quote is found in a PDF's text layer, page by
// page, as the redaction engine reads it. Every person here is made up.
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { quotesInText } from './file-marks.js';

/** A PDF with one page per list of lines, in Helvetica. */
async function pagesPdf(pages: ReadonlyArray<readonly string[]>): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([612, 792]);
    lines.forEach((line, n) => page.drawText(line, { x: 72, y: 720 - 20 * n, size: 12, font }));
  }
  return doc.save({ useObjectStreams: false });
}

describe('quotesInText', () => {
  it('finds each quote on any page, whatever page found the others, and only those in the text', async () => {
    const pdf = await pagesPdf([['Call Quillon Brask.'], ['Nothing marked here.'], ['Ring 850-555-0142 by Friday.']]);
    expect(await quotesInText(pdf, ['Quillon Brask', '850-555-0142', 'Ysolde Pemberton'])).toEqual([true, true, false]);
  });

  it('reads the text normalized, as the engine matches it: case and spacing do not hide a quote', async () => {
    const pdf = await pagesPdf([['CALL   quillon  BRASK.']]);
    expect(await quotesInText(pdf, ['Quillon Brask'])).toEqual([true]);
  });

  it('finds nothing in bytes it cannot open', async () => {
    expect(await quotesInText(new Uint8Array(Buffer.from('%PDF-1.7 not really a PDF', 'latin1')), ['Quillon Brask', 'Ysolde'])).toEqual([false, false]);
  });
});
