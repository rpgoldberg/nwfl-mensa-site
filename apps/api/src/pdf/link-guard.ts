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
//     draws them (Ross's rule: a link over anything withheld is removed);
//   - under those policies too (fix round 2, F1), the WHOLE of every page
//     whose resources reach a tiling pattern that holds a picture: a picture
//     XObject, or an inline picture in its content, in the pattern itself or
//     in what it reaches (forms, nested patterns, soft-mask groups, Type 3
//     glyphs). The page is reached from its own resources (inherited ones
//     too) and from its annotations' appearances (normal, rollover, down,
//     every state). PDFium lists no object of a pattern's content, so where
//     such a picture lands is not known: no link is kept on that page. A
//     pattern's content that cannot be decoded (an unknown filter, or
//     /DecodeParms, which pdf-lib does not apply) counts as holding one; a
//     pattern with no resources of its own reads its parent's, kind by kind,
//     as pdf.js merges them. This is read from the original with pdf-lib;
//     nothing else of a pattern is read (a shading pattern paints no picture).
//
// Blank glyphs and the ones PDFium makes up (spaces and line ends it reads
// between words) are not text, so they are not counted. A glyph is the
// copy's when the copy has a glyph of the same text whose box is within
// TOLERANCE of it; each glyph of the copy answers for one of the original's.
// Throws when PDFium cannot open either file, or they differ in pages: then
// neither the engine nor the gate keeps a link (both fail safe, rerun.ts).
// ============================================================================
import { PDFArray, PDFDict, PDFDocument, PDFName, type PDFObject, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from '@cantoo/pdf-lib';
import { type ImageAction, hasInlinePicture } from './images.js';
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

/** A whole page, as an area no link on it can miss. */
const WHOLE_PAGE: Box = { left: -Number.MAX_VALUE, bottom: -Number.MAX_VALUE, right: Number.MAX_VALUE, top: Number.MAX_VALUE };

/** The resource kinds through which content draws other content or pictures. */
const KINDS = ['XObject', 'Pattern', 'Font', 'ExtGState'] as const;
type Kinds = ReadonlyMap<(typeof KINDS)[number], PDFDict>;

/** Something that draws, with the resources it reads (its own, else its parent's, kind by kind), and whether it is inside a tiling pattern. */
interface Drawer {
  owner: PDFObject;
  resources: PDFObject | undefined;
  contents: readonly PDFObject[];
  parent: Kinds;
  inPattern: boolean;
}

/** The pages (0-based) whose resources or annotation appearances reach a tiling pattern that holds a picture: see the header. */
export async function patternPicturePages(pdf: Uint8Array): Promise<Set<number>> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false, ignoreEncryption: true });
  const look = (value: PDFObject | undefined): PDFObject | undefined => (value instanceof PDFRef ? doc.context.lookup(value) : value);
  const dictOf = (value: PDFObject | undefined): PDFDict | undefined => {
    const found = look(value);
    return found instanceof PDFDict ? found : undefined;
  };
  const entries = (value: PDFObject | undefined): PDFObject[] => [...(dictOf(value)?.entries() ?? [])].map(([, item]) => look(item) as PDFObject);
  const names = new Map<object, number>();
  const nameOf = (object: object | undefined): number => {
    if (object === undefined) return 0;
    if (!names.has(object)) names.set(object, names.size + 1);
    return names.get(object) as number;
  };
  const inline = new Map<PDFObject, boolean>();
  /** Whether a content stream holds an inline picture, or cannot be read to tell. */
  const holdsInline = (stream: PDFObject): boolean => {
    let found = inline.get(stream);
    if (found === undefined) {
      try {
        found = !(stream instanceof PDFRawStream) || stream.dict.has(PDFName.of('DecodeParms')) || hasInlinePicture(decodePDFRawStream(stream).decode());
      } catch {
        found = true;
      }
      inline.set(stream, found);
    }
    return found;
  };
  const kindsOf = (resources: PDFObject | undefined, parent: Kinds): Kinds => {
    const own = dictOf(resources);
    const out = new Map<(typeof KINDS)[number], PDFDict>();
    for (const kind of KINDS) {
      const dict = dictOf(own?.get(PDFName.of(kind))) ?? parent.get(kind);
      if (dict !== undefined) out.set(kind, dict);
    }
    return out;
  };
  /** Whether anything these drawers reach, inside a tiling pattern, is a picture. */
  const reaches = (start: Drawer[]): boolean => {
    const seen = new Set<string>();
    const pending = [...start];
    for (let drawer = pending.pop(); drawer !== undefined; drawer = pending.pop()) {
      const { owner, contents, inPattern } = drawer;
      const kinds = kindsOf(drawer.resources, drawer.parent);
      const key = [nameOf(owner), inPattern, ...KINDS.map((kind) => nameOf(kinds.get(kind)))].join();
      if (seen.has(key)) continue;
      seen.add(key);
      if (inPattern && contents.some(holdsInline)) return true;
      const under = (stream: PDFObject, pattern: boolean): Drawer | undefined =>
        stream instanceof PDFStream ? { owner: stream, resources: stream.dict.get(PDFName.of('Resources')), contents: [stream], parent: kinds, inPattern: pattern } : undefined;
      for (const item of entries(kinds.get('XObject'))) {
        // Any XObject but a form is taken for a picture.
        if (!(item instanceof PDFStream)) continue;
        if (look(item.dict.get(PDFName.of('Subtype'))) !== PDFName.of('Form')) {
          if (inPattern) return true;
          continue;
        }
        pending.push(under(item, inPattern) as Drawer);
      }
      // Every pattern that is a stream is a tiling pattern (a shading pattern is a dictionary).
      for (const item of entries(kinds.get('Pattern'))) if (item instanceof PDFStream) pending.push(under(item, true) as Drawer);
      for (const item of entries(kinds.get('Font'))) {
        const procs = item instanceof PDFDict ? entries(item.get(PDFName.of('CharProcs'))) : [];
        if (procs.length > 0) pending.push({ owner: item, resources: (item as PDFDict).get(PDFName.of('Resources')), contents: procs, parent: kinds, inPattern });
      }
      for (const item of entries(kinds.get('ExtGState'))) {
        const group = under(look(dictOf(dictOf(item)?.get(PDFName.of('SMask')))?.get(PDFName.of('G'))) as PDFObject, inPattern);
        if (group !== undefined) pending.push(group);
      }
    }
    return false;
  };
  const out = new Set<number>();
  for (const [index, page] of doc.getPages().entries()) {
    const own = page.node.Resources();
    const kinds = kindsOf(own, new Map());
    const appearances: Drawer[] = [];
    const annots = look(page.node.get(PDFName.of('Annots')));
    // Every appearance of every annotation (normal, rollover, down; a stream, or a dictionary of states).
    for (const annot of annots instanceof PDFArray ? annots.asArray() : []) {
      const ap = dictOf(dictOf(annot)?.get(PDFName.of('AP')));
      for (const key of ['N', 'R', 'D']) {
        const value = look(ap?.get(PDFName.of(key)));
        for (const stream of value instanceof PDFDict ? entries(value) : [value]) {
          if (stream instanceof PDFStream) appearances.push({ owner: stream, resources: stream.dict.get(PDFName.of('Resources')), contents: [stream], parent: kinds, inPattern: false });
        }
      }
    }
    if (reaches([{ owner: page.node, resources: own, contents: [], parent: new Map(), inPattern: false }, ...appearances])) out.add(index);
  }
  return out;
}

/** What no kept link may meet, by page (0-based): see the header. */
export async function linkGuardAreas(original: Uint8Array, copy: Uint8Array, image: ImageAction): Promise<PageBox[]> {
  const lib = await pdfium();
  const patterned = image === 'show' ? new Set<number>() : await patternPicturePages(original);
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
      if (patterned.has(index)) out.push({ ...WHOLE_PAGE, page: index });
    }
    return out;
  } finally {
    from?.close();
    to?.close();
  }
}
