// ============================================================================
// LINKS L3 fix round 1 (S1, N1): what no kept link may meet, read with PDFium
// from the original and the copy, the same way by the engine (which drops a
// link that meets any of it, redact.ts) and by the gate (which refuses the
// whole copy when a kept link meets any of it, gate-links.ts):
//
//   - every glyph of the original that the copy does not hold at its place:
//     its box (PDFium's loose box: its advance, the font's ascent and
//     descent) and its ink. Not only the glyphs whose centre a link covers,
//     as pdf.js's text under a link reads them: any that a link touches;
//   - under an image policy that does not show pictures ("blur", "hide"),
//     every picture the original draws, on every page, on the page or in a
//     form XObject at any depth, with its annotations drawn in as the engine
//     draws them (Ross's rule: a link over anything withheld is removed).
//
// Blank glyphs and the ones PDFium makes up (spaces and line ends it reads
// between words) are not text, so they are not counted. A glyph is the
// copy's when the copy has a glyph of the same text whose box is within
// TOLERANCE of it; each glyph of the copy answers for one of the original's.
// Throws when PDFium cannot open either file, or they differ in pages: then
// neither the engine nor the gate keeps a link (both fail safe, rerun.ts).
// ============================================================================
import type { ImageAction } from './images.js';
import type { PageBox } from './link-annots.js';
import type { Box, PageChar } from './match.js';
import { Document, pdfium } from './pdfium.js';

/** How far, in points, a glyph of the copy may be from the original's to be the same glyph. */
export const TOLERANCE = 0.1;

const isText = (c: PageChar): c is PageChar & { box: Box } => !c.generated && c.box !== null && !/^\s*$/u.test(c.text);
const near = (a: Box, b: Box): boolean => Math.abs(a.left - b.left) <= TOLERANCE && Math.abs(a.bottom - b.bottom) <= TOLERANCE && Math.abs(a.right - b.right) <= TOLERANCE && Math.abs(a.top - b.top) <= TOLERANCE;

/** The glyphs of `original` that `copy` lacks: each one's box, and its ink when it has any. */
function missing(original: readonly PageChar[], copy: readonly PageChar[], page: number): PageBox[] {
  const left = new Map<string, Box[]>();
  for (const c of copy.filter(isText)) {
    const list = left.get(c.text);
    if (list === undefined) left.set(c.text, [c.box]);
    else list.push(c.box);
  }
  const out: PageBox[] = [];
  for (const c of original.filter(isText)) {
    const same = left.get(c.text) ?? [];
    const at = same.findIndex((box) => near(box, c.box));
    if (at >= 0) same.splice(at, 1);
    else out.push(...[c.box, c.ink].filter((box): box is Box => box !== null).map((box) => ({ ...box, page })));
  }
  return out;
}

/** What no kept link may meet, by page (0-based): see the header. */
export async function linkGuardAreas(original: Uint8Array, copy: Uint8Array, image: ImageAction): Promise<PageBox[]> {
  const lib = await pdfium();
  const from = Document.open(lib, original);
  const to = Document.open(lib, copy);
  try {
    if (from === null || to === null) throw new Error('a file cannot be opened to check its links');
    if (from.pageCount !== to.pageCount) throw new Error('the copy has other pages than the original');
    const out: PageBox[] = [];
    for (let index = 0; index < from.pageCount; index++) {
      // As the engine reads a page: its annotations drawn into it first (redact.ts redactPage).
      from.flatten(index);
      const [before, pictures] = from.page(index, (page) => [page.chars().chars, image === 'show' ? [] : page.allPictures()] as const);
      const after = to.page(index, (page) => page.chars().chars);
      out.push(...missing(before, after, index), ...pictures.map((picture) => ({ ...picture, page: index })));
    }
    return out;
  } finally {
    from?.close();
    to?.close();
  }
}
