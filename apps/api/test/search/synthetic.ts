// Synthetic PDFs for the search tests, made here with pdf-lib: never a real issue. Every name is made up.
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';

/** A PDF with one page per list of lines, in Helvetica. */
export async function pagesPdf(pages: ReadonlyArray<readonly string[]>): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([612, 792]);
    lines.forEach((line, n) => page.drawText(line, { x: 72, y: 720 - 20 * n, size: 12, font }));
  }
  return doc.save({ useObjectStreams: false });
}

/** A PDF of `count` pages with nothing on them. */
export async function blankPdf(count: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (let n = 0; n < count; n++) doc.addPage([200, 200]);
  return doc.save({ useObjectStreams: true });
}
