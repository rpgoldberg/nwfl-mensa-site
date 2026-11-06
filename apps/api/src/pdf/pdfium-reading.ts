// ============================================================================
// The engine's own reading of a copy with PDFium, after removal (redact.ts
// verifyRedacted), which the gate makes too (gate-rules.ts gateVerdict,
// LIGATURE fix 1): a quote PDFium still reads, or a glyph with no text, or not
// its own, where read as letters it could finish one (unreadable.ts). The
// gate reads PDFium's map errors so, which pdf.js does not flag: Ghostscript
// re-distils Carlito's ligatures as codes PDFium has no Unicode for, and pdf.js
// reads them as the letters and signs of those codes ("FiC Amberwick").
// ============================================================================
import { matchedChars } from './match.js';
import { Document, pdfium } from './pdfium.js';
import { charUnits, readThrough } from './unreadable.js';

export const UNOPENABLE = 'the PDF could not be opened';

/** Why PDFium's reading of `pdf` holds withheld text (see the header), or null. */
export async function pdfiumBreak(pdf: Uint8Array, quotes: readonly string[]): Promise<string | null> {
  const doc = Document.open(await pdfium(), pdf);
  if (doc === null) return UNOPENABLE;
  try {
    for (let index = 0; index < doc.pageCount; index++) {
      const left = doc.page(index, (page) => {
        const { chars } = page.chars();
        return matchedChars(chars, quotes).size > 0 ? 'readable' : readThrough(charUnits(chars), quotes) ? 'unreadable' : null;
      });
      if (left === 'readable') return `page ${index + 1}: withheld text is still readable after removal`;
      // LIGATURE (unreadable.ts): a glyph with no text left where, read as letters, it could finish a quote.
      if (left === 'unreadable') return `page ${index + 1} has text that cannot be read where a withheld passage may be`;
    }
    return null;
  } finally {
    doc.close();
  }
}
