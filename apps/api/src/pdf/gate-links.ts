// ============================================================================
// LINKS L3: the gate's own proof that no kept link sits over anything
// withheld (SPEC D1, step 4), without trusting the engine's boxes. Two
// readings, each refusing the whole copy:
//
//   1. pdf.js reads the text each link lies over: for every Link annotation,
//      the glyphs whose centre falls inside its rect (PDFPageProxy
//      .getAnnotations, data.overlaidText, pdfjs-dist 6.4.299). It reads the
//      copy as it is, and the original with its own annotations taken out and
//      the copy's links written in the engine's one shape at the same places
//      (link-annots.ts writeLinks). The two texts, without their spaces, must
//      be the same for every kept link: a box's "withheld" label under a
//      link, or a removed glyph, makes them differ. A glyph whose centre is
//      outside the rect does not count here, so this reading alone does not
//      prove that no withheld glyph is under a link;
//   2. so the link guard (link-guard.ts, fix round 1, N1 and S1) reads the
//      original and the copy with PDFium, and no kept rect may meet (touching
//      counts) the box or the ink of any glyph of the original missing from
//      the copy, however little of it the rect covers, nor, under an image
//      policy that does not show pictures, any picture PDFium reads in the
//      original; and no kept link may lie on a page of the original that
//      reaches a tiling pattern holding a picture (fix round 2, F1: PDFium
//      gives no place for one, so the whole page counts).
//      The engine drops a link the guard would refuse, so only a subverted or
//      broken engine meets this.
//
// The copy is also read for its annotations as pdf.js sees them: each one a
// Link to https://<origin>/out/<id> for a kept id, each id once and on its
// own page, and nothing else (the pdf-lib rules read the same, acceptedLinks).
// ============================================================================
import { PDFDict, PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { loadPdfJs } from './gate.js';
import type { ImageAction } from './images.js';
import { type EngineLink, type LinkRequest, boxOf, linkUri, meets, writeLinks } from './link-annots.js';
import { linkGuardAreas } from './link-guard.js';

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
 * kept links, or a kept link meets what the link guard reads as withheld under `image` ("show" when absent), or null.
 * Null at once when nothing was kept (the rules then refuse any annotation).
 */
export async function linkTextBreak(copy: Uint8Array, original: Uint8Array, request: LinkRequest & { image?: ImageAction }): Promise<string | null> {
  const kept = new Set(request.kept ?? []);
  if (kept.size === 0) return null;
  const origin = request.origin ?? '';
  const links = (request.links ?? []).filter((link) => kept.has(link.id));
  let inCopy: Read;
  let inOriginal: Read;
  let withheld: Awaited<ReturnType<typeof linkGuardAreas>>;
  try {
    inCopy = await underLinks(copy, origin, kept);
    inOriginal = await underLinks(await probeOf(original, origin, links), origin, kept);
    withheld = await linkGuardAreas(original, copy, request.image ?? 'show');
  } catch {
    return UNREADABLE;
  }
  if (inCopy.stray || inCopy.text.size !== kept.size || links.length !== kept.size) return 'pdf.js reads other annotations in the copy than the links the engine kept';
  for (const link of links) {
    const ours = inCopy.text.get(link.id);
    const theirs = inOriginal.text.get(link.id);
    if (ours === undefined || theirs === undefined || ours.page !== link.page || squashed(ours.text) !== squashed(theirs.text)) return DIFFERS(link.page);
  }
  const over = links.find((link) => withheld.some((area) => area.page === link.page - 1 && meets(boxOf(link.rect), area)));
  return over === undefined ? null : `page ${over.page}: a link meets what the copy withholds`;
}
