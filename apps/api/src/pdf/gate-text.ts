// ============================================================================
// ARCHIVE-SEARCH S2: what the gate's child answers a "text" job
// (gate-child.ts, text-protocol.ts): the text of a stored copy's pages, for
// the search index.
//
// The copy is one the gate passed and wrote itself (gate-rules.ts gateReply),
// read here with pdf.js exactly as the gate's own reading reads it (gate.ts
// readerFinds: the same getDocument options, the same getTextContent). Each
// page's items go through the index's one line-end rule (search/text.ts
// pageText), so the text stored is the text the reader's find will see.
//
// Before a page's text is taken, the gate's own test is put to it again
// (gate.ts spells) with what the copy's audience withholds, and then the same
// quotes are looked for in the very text that would be indexed (match.ts
// textMatches, after the line-end join: S2 challenge M1, a split the gate's
// readings do not join). One finding either way and the answer is
// "withheld", with no text of any page. The gate passed these
// bytes for these quotes, so this never fires on a sound copy; it is there so
// that a fault upstream (the wrong copy, the wrong audience's quotes, a
// stored copy older than the gate's rule) cannot reach an index.
//
// It answers by code, never by content: "over-cap" past 300 pages, 64 KiB a
// page or an extra, or 4 MiB in all; "unfinished" for a copy pdf.js cannot
// read. It runs only in the gate's capped child: nothing here is cheap or safe
// to run beside a database login.
// ============================================================================
import { type PageText, pageText } from '../search/text.js';
import { sha256Hex } from './engine-protocol.js';
import { loadPdfJs, spells } from './gate.js';
import { textMatches } from './match.js';
import { TEXT_MAX_BYTES, TEXT_MAX_PAGES, TEXT_MAX_PAGE_BYTES, type TextReply } from './text-protocol.js';

/** What the gate's child is sent for a reading: the copy and what its audience withholds. */
export interface TextJob {
  kind: 'text';
  copy: Uint8Array;
  quotes: readonly string[];
}

/** Whether a message to the gate's child asks for text; anything else is a check. */
export const isTextJob = (message: unknown): message is TextJob => typeof message === 'object' && message !== null && (message as { kind?: unknown }).kind === 'text';

const bytesOf = (value: string): number => Buffer.byteLength(value, 'utf8');

/** One page's text from pdf.js's items: the text items alone, through the line-end rule, with no NUL (Postgres holds none). */
export function pageOf(items: readonly unknown[]): PageText {
  const strings = items.flatMap((item) => {
    const { str, hasEOL } = item as { str?: unknown; hasEOL?: unknown };
    return typeof str === 'string' ? [{ str: str.replaceAll('\u0000', ''), hasEOL: hasEOL === true }] : [];
  });
  return pageText(strings);
}

/** The reading of one copy: its pages' text, or the code that says why there is none. Never rejects. */
export async function textReply(job: TextJob, caps: { pageBytes?: number; bytes?: number } = {}): Promise<TextReply> {
  const sha256 = sha256Hex(job.copy);
  const pageBytes = caps.pageBytes ?? TEXT_MAX_PAGE_BYTES;
  const allBytes = caps.bytes ?? TEXT_MAX_BYTES;
  try {
    const { getDocument } = await loadPdfJs();
    const task = getDocument({ data: new Uint8Array(job.copy), verbosity: 0, disableFontFace: true });
    try {
      const doc = await task.promise;
      if (doc.numPages > TEXT_MAX_PAGES) return { sha256, code: 'over-cap' };
      const pages: PageText[] = [];
      let total = 0;
      for (let n = 1; n <= doc.numPages; n++) {
        const content = await (await doc.getPage(n)).getTextContent();
        if (spells(content, job.quotes, n) !== null) return { sha256, code: 'withheld' };
        const page = pageOf(content.items);
        // And to the text itself, as it would be indexed: the line-end join can read a name the gate's readings do not
        // (a hyphen, then an empty item that ends the line in another font). Not the gate's word on it: the index's.
        if (textMatches(page.text, job.quotes) || textMatches(page.extra, job.quotes)) return { sha256, code: 'withheld' };
        const [textBytes, extraBytes] = [bytesOf(page.text), bytesOf(page.extra)];
        total += textBytes + extraBytes;
        if (textBytes > pageBytes || extraBytes > pageBytes || total > allBytes) return { sha256, code: 'over-cap' };
        pages.push(page);
      }
      return { sha256, pages };
    } finally {
      await task.destroy();
    }
  } catch {
    return { sha256, code: 'unfinished' };
  }
}
