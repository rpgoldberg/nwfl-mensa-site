// ============================================================================
// GLYPHMAP (BOXLABEL round 2, R2-2): the text a copy's glyph names draw.
//
// A simple font (Type1, MMType1, TrueType) draws, for each code, the glyph its
// encoding names: its /Differences, its base encoding, or a Type1 program's own
// encoding. The text layers the checks read take a font's /ToUnicode first,
// and the glyph check (drawn.ts) reads pdf.js's fontChar, which is the name's
// letter only in a font that is not embedded and only for a name pdf.js
// knows: in an embedded font it is a code in the Private Use Area. PDFium
// (Chrome) also drops a name's suffix: Q.alt, a.sc and uni0051.alt draw Q, a
// and Q. Measured on main (red/a-kinds.txt), a run whose codes and /ToUnicode
// read "Private" while its glyph names spell a withheld quote drew the quote
// in PDFium, and passed the gate, for every kind of simple font (not embedded,
// Type1, CFF, TrueType) and every name PDFium takes a letter from.
//
// So the gate and the engine also read each copy as PDFium reads it once the
// /ToUnicode is taken out of its fonts: PDFium then takes each code's letter
// from the glyph name, by the rules it draws by, and a quote found there is
// withheld text. A name that gives no letter (g123, cid45, glyph00012, f_f, an
// unknown name) is read as its code, as PDFium reads it: for such a name it
// draws nothing or the code's own glyph, and the code is in the content
// stream, which checkCopy reads. Left as they are: Type0 and Type3 fonts (a
// composite font draws by glyph id; a Type3 glyph is a drawing, which drawn.ts
// reads) and a TrueType font with no /Encoding, as LibreOffice embeds every
// TrueType font: it draws by code through its program's cmap, and PDFium reads
// its codes as Mac Roman letters, which spell nothing it draws
// (red/D3-truetype-by-code-red.txt). What a font program's own cmap or outlines
// draw is the limit of any text gate (text drawn as curves).
// ============================================================================
import { PDFArray, PDFDict, PDFDocument, PDFName, type PDFObject, PDFRawStream } from '@cantoo/pdf-lib';
import { matchedChars } from './match.js';
import { Document, pdfium } from './pdfium.js';

const TO_UNICODE = PDFName.of('ToUnicode');
const SUBTYPE = PDFName.of('Subtype');
const ENCODING = PDFName.of('Encoding');
const UNREADABLE = 'the copy could not be read';

/** `pdf` with the /ToUnicode taken out of every font that draws by glyph name, or `pdf` itself when none has one. */
async function withoutToUnicode(pdf: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false, throwOnInvalidObject: true });
  let changed = false;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    // Direct objects only: every indirect one is enumerated, so no reference is followed and none can loop.
    const pending: PDFObject[] = [object];
    for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
      const value = item instanceof PDFRawStream ? item.dict : item;
      if (value instanceof PDFArray) {
        for (let i = 0; i < value.size(); i++) pending.push(value.get(i));
      } else if (value instanceof PDFDict) {
        const subtype = value.lookup(SUBTYPE);
        const kind = subtype instanceof PDFName ? subtype.decodeText() : undefined;
        // Fonts that do not draw by glyph name keep theirs (see the header): Type0, Type3, and TrueType with no /Encoding.
        const kept = kind === 'Type0' || kind === 'Type3' || (kind === 'TrueType' && !value.has(ENCODING));
        if (value.has(TO_UNICODE) && !kept) {
          value.delete(TO_UNICODE);
          changed = true;
        }
        for (const [, entry] of value.entries()) pending.push(entry);
      }
    }
  }
  return changed ? doc.save({ useObjectStreams: false }) : pdf;
}

/** Why the glyph names of `pdf`'s fonts, read as PDFium draws them, spell a withheld quote, or null (see the header). */
export async function namedBreak(pdf: Uint8Array, quotes: readonly string[]): Promise<string | null> {
  if (quotes.length === 0) return null;
  let named: Uint8Array;
  try {
    named = await withoutToUnicode(pdf);
  } catch {
    return UNREADABLE;
  }
  const doc = Document.open(await pdfium(), named);
  if (doc === null) return UNREADABLE;
  try {
    for (let index = 0; index < doc.pageCount; index++) {
      const spelt = doc.page(index, (page) => matchedChars(page.chars().chars, quotes).size > 0);
      if (spelt) return `page ${index + 1}: withheld text is in the glyph names PDFium draws`;
    }
    return null;
  } finally {
    doc.close();
  }
}
