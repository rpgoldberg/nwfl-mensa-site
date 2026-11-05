// ============================================================================
// LINKS L3: the gate's own proof that no kept link sits over anything
// withheld (SPEC D1, step 4), without trusting the engine's boxes.
//
// pdf.js reads the text each link lies over: for every Link annotation, the
// glyphs whose centre falls inside its rect (PDFPageProxy.getAnnotations,
// data.overlaidText, pdfjs-dist 6.4.299). It reads the copy as it is, and the
// original with its own annotations taken out and the copy's links written
// in the engine's one shape at the same places (link-annots.ts writeLinks).
// The two texts, without their spaces, must be the same for every kept link:
// a box's "withheld" label under a link, or a removed glyph, makes them
// differ, and then the whole copy is refused. A glyph whose centre is outside
// the rect does not count on either side; the engine's own check (any rect
// that meets a box or removed ink is dropped) is the stricter one.
//
// The copy is also read for its annotations as pdf.js sees them: each one a
// Link to https://<origin>/out/<id> for a kept id, each id once and on its
// own page, and nothing else (the pdf-lib rules read the same, acceptedLinks).
// ============================================================================
import { PDFDict, PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { loadPdfJs } from './gate.js';
import { type EngineLink, type LinkRequest, linkUri, writeLinks } from './link-annots.js';

const UNREADABLE = 'the text under the links cannot be read';
const DIFFERS = (page: number): string => `page ${page}: the text under a link is not the original's`;

interface Read {
  /** The text under each link, by id, and the page it is on. */
  text: Map<string, { page: number; text: string }>;
  /** Whether pdf.js read an annotation that is not one link to our origin by a kept id, or one id twice. */
  stray: boolean;
}

/** pdf.js's reading of every annotation of `pdf`: the text under each link to the leaving page by a kept id. */
async function underLinks(pdf: Uint8Array, origin: string, kept: ReadonlySet<string>): Promise<Read> {
  const { getDocument } = await loadPdfJs();
  const task = getDocument({ data: new Uint8Array(pdf), verbosity: 0, disableFontFace: true });
  const read: Read = { text: new Map(), stray: false };
  try {
    const doc = await task.promise;
    for (let n = 1; n <= doc.numPages; n++) {
      for (const annotation of (await (await doc.getPage(n)).getAnnotations({ intent: 'display' })) as Array<{ subtype?: unknown; unsafeUrl?: unknown; overlaidText?: unknown }>) {
        const id = [...kept].find((candidate) => annotation.unsafeUrl === linkUri(origin, candidate));
        if (annotation.subtype !== 'Link' || id === undefined || read.text.has(id)) {
          read.stray = true;
          continue;
        }
        read.text.set(id, { page: n, text: typeof annotation.overlaidText === 'string' ? annotation.overlaidText : '' });
      }
    }
  } finally {
    await task.destroy();
  }
  return read;
}

/** The original with no annotation of its own (pages and page-tree nodes alike) and the links written as the engine writes them. */
async function probeOf(original: Uint8Array, origin: string, links: readonly EngineLink[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(original, { updateMetadata: false, ignoreEncryption: true });
  for (const [, object] of doc.context.enumerateIndirectObjects()) if (object instanceof PDFDict) object.delete(PDFName.of('Annots'));
  if (links.some((link) => link.page > doc.getPageCount())) throw new Error('a link is past the original\'s pages');
  writeLinks(doc, origin, links);
  return doc.save({ useObjectStreams: false });
}

const squashed = (text: string): string => text.replace(/\s+/gu, '');

/**
 * Why the text under the copy's links is not the original's, or pdf.js reads other annotations in the copy than the
 * kept links, or null. Null at once when nothing was kept (the rules then refuse any annotation).
 */
export async function linkTextBreak(copy: Uint8Array, original: Uint8Array, request: LinkRequest): Promise<string | null> {
  const kept = new Set(request.kept ?? []);
  if (kept.size === 0) return null;
  const origin = request.origin ?? '';
  const links = (request.links ?? []).filter((link) => kept.has(link.id));
  let inCopy: Read;
  let inOriginal: Read;
  try {
    inCopy = await underLinks(copy, origin, kept);
    inOriginal = await underLinks(await probeOf(original, origin, links), origin, kept);
  } catch {
    return UNREADABLE;
  }
  if (inCopy.stray || inCopy.text.size !== kept.size || links.length !== kept.size) return 'pdf.js reads other annotations in the copy than the links the engine kept';
  for (const link of links) {
    const ours = inCopy.text.get(link.id);
    const theirs = inOriginal.text.get(link.id);
    if (ours === undefined || theirs === undefined || ours.page !== link.page || squashed(ours.text) !== squashed(theirs.text)) return DIFFERS(link.page);
  }
  return null;
}
