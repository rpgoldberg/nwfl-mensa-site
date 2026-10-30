// ============================================================================
// FILE MARKS (0020, MLOGIN S3): a content item's passages in its stored PDFs.
//
// A document's words are in its PDFs, not in its text, so its marks are
// anchored in its files. Each quote is looked for in the text layer of every
// stored PDF of the item, read as the redaction engine reads a page (PDFium's
// characters, annotations and form fields drawn in, match.ts's readings), and
// the mark is added with the files it was found in (redaction_mark_add_file).
//
// Fail closed: a quote found in none of the item's PDFs is refused, and with
// it every mark of the call, before any is added. A PDF that cannot be opened
// anchors nothing. A refusal names the mark by its place in the list, never
// by its quote.
// ============================================================================
import type { Db } from '../db/pool.js';
import { matchedChars } from '../pdf/match.js';
import { Document, pdfium } from '../pdf/pdfium.js';

type Query = Pick<Db, 'query'>;

export class FileMarkError extends Error {}

export interface FileMark {
  quote: string;
  category: string;
}

/** For each quote, whether it is in the PDF's text layer; none is when the PDF cannot be opened. */
export async function quotesInText(pdf: Uint8Array, quotes: readonly string[]): Promise<boolean[]> {
  const found = quotes.map(() => false);
  const doc = Document.open(await pdfium(), pdf);
  if (doc === null) return found;
  try {
    for (let index = 0; index < doc.pageCount; index++) {
      doc.flatten(index);
      const chars = doc.page(index, (page) => page.chars().chars);
      const waiting = quotes.flatMap((quote, i) => (found[i] === true ? [] : [{ quote, i }]));
      // One pass for all of them first: most pages hold none.
      if (matchedChars(chars, waiting.map((entry) => entry.quote)).size === 0) continue;
      for (const { quote, i } of waiting) found[i] = matchedChars(chars, [quote]).size > 0;
    }
  } finally {
    doc.close();
  }
  return found;
}

/**
 * Adds the marks to the item as file marks, each anchored in the item's stored PDFs whose text
 * holds its quote, and returns their ids in order. Run it in the caller's transaction.
 */
export async function addFileMarks(
  db: Query,
  input: { itemId: string; marks: readonly FileMark[]; sub: string; groups: readonly string[]; trace?: string },
): Promise<string[]> {
  const { rows: files } = await db.query<{ id: string; bytes: Buffer }>(
    `SELECT f.id, pdf_original_read(f.id, 'officers') AS bytes FROM stored_file f
       JOIN content_version v ON v.id = f.version_id JOIN pdf_original o ON o.file_id = f.id
      WHERE v.item_id = $1 AND f.mime_type = 'application/pdf' ORDER BY f.id`,
    [input.itemId],
  );
  if (files.length === 0) throw new FileMarkError('the item has no stored PDF to anchor a file mark in');
  const quotes = input.marks.map((mark) => mark.quote);
  const found = await Promise.all(files.map((file) => quotesInText(new Uint8Array(file.bytes), quotes)));
  const anchors = quotes.map((_, i) => files.filter((_, f) => found[f]?.[i] === true).map((file) => file.id));
  const missing = anchors.findIndex((list) => list.length === 0);
  if (missing >= 0) throw new FileMarkError(`marks[${missing}]: the quote is not in the text layer of any of the item's PDFs`);
  const ids: string[] = [];
  for (const [i, mark] of input.marks.entries()) {
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM redaction_mark_add_file($1, $2, $3, $4, $5, $6, $7)`, [
      input.itemId,
      mark.quote,
      mark.category,
      anchors[i],
      input.sub,
      [...input.groups],
      input.trace ?? null,
    ]);
    ids.push((rows[0] as { id: string }).id);
  }
  return ids;
}
