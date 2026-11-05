// ============================================================================
// UNTRUSTED-PDF-GATE S3: what the gate re-checks on a copy besides its text.
//
// The engine's sanitizer (sanitize.ts) and picture policy (images.ts) leave a
// copy with nothing but what draws its pages. A subverted engine need not, so
// the gate (in its own capped child, gate-isolated.ts) checks that what it was
// handed still looks so:
//
//   1. No active content and no attached files, anywhere: no key /JS,
//      /JavaScript, /OpenAction, /AA, /URI, /EmbeddedFile(s), /EF, /XFA,
//      /AcroForm or /Annots; no action dictionary (/S naming an action type,
//      or /Type /Action), no file specification, no annotation; no
//      encryption. A URI to a file is an action, so it is refused with them.
//      (An empty /Annots list, which annotates nothing, is let through.)
//      No /Linearized either (fix round 5, M1): pdf.js takes page 1 of a
//      linearized file from its /O, which need not be in the page tree. The
//      sanitizer writes none, and the gate's own writing drops the key.
//      Under every policy, forms, tiling patterns, Type 3 fonts and soft
//      masks drawn more than MAX_NESTING deep, or in a loop, are refused
//      before pdf.js reads them (fix round 5, S3: forms nested 1,500 deep
//      ran pdf.js's stack out, and it carried on as if the page ended).
//   2. Pictures, where the policy changes them ("blur" or "hide"):
//      - every picture XObject is what the policy draws: under "hide" the
//        1 x 1 grey fill; under "blur" that fill, or a Flate 8-bit grey or
//        RGB picture of at most BLUR_MAX pixels a side with no other keys and
//        exactly its samples. A re-encoded original (a JPEG, a larger Flate
//        picture, one with a mask) has another shape;
//      - no inline picture in any content (a page's, a form's, a tiling
//        pattern's, a Type 3 glyph's), BI read as pdf.js's lexer reads it
//        ("qBI" is q then BI), and a page's /Contents array read joined, as
//        pdf.js joins it, as well as stream by stream (fix round 4, M1);
//      - no /DecodeParms on a stream that is not a picture: pdf-lib decodes
//        no predictor, so it would read such content wrong (fix round 4);
//      - no axial or radial gradient drawn from a sampled function, or from
//        a list or stitching of functions with one in it (fix round 5, S1:
//        64 such gradients, one per row, drew the photo); a soft mask's
//        group is read as content, as pdf.js draws it, /Subtype or not;
//      - what pdf.js draws from the copy, read from its operator lists
//        (drawn.ts, fix round 4): no inline picture, no picture larger than
//        the policy draws, no shading drawn as a lattice or a mesh, the very
//        pages pdf-lib's tree gives (fix round 5), each read to its end;
//      - no run of an original picture's samples is in the copy (the
//        engine's own check, keepsPicture, on the original the worker sends),
//        and no picture of the copy has exactly the samples of an original
//        picture that blurring changes: an original small enough to have the
//        blur's shape, kept, is caught by one or the other. A picture of one
//        grey is its own blur, so it may come through unchanged.
//
//   3. One reading (fix round 3, M1): pdf-lib keeps the last definition of
//      an object and ignores the xref; a viewer follows the xref. So:
//      - a copy whose structure is not the sanitizer's (pdf-structure.ts: one
//        xref table, one definition per object where the xref says) is
//        refused before any rule is read;
//      - every value a rule reads is resolved (lookup), as a viewer resolves
//        it, and a structural name or number (/S, /Subtype, /Type,
//        /PatternType, /Filter) given by reference is refused: the sanitizer
//        writes them direct;
//      - the page tree is one a viewer reads as pdf-lib does (fix round 4,
//        M1): every node /Type /Pages with its /Kids and their /Count, every
//        leaf /Type /Page, each once, by reference (pdf.js takes any kid
//        without /Kids for a page; pdf-lib skips one with no /Type);
//      - gateReply checks, and hands back, its own writing of the copy: what
//        pdf-lib read, written again (no object streams, no incremental
//        update). Only those bytes are stored (rerun.ts): the bytes stored
//        are the bytes the gate checked.
//
//   4. Links (LINKS L3): the one exception to rule 1. The worker tells the
//      gate the links the engine was given (id, page, rect, label), their
//      origin and the ids the engine says it kept. acceptedLinks
//      (link-annots.ts) lets through exactly the engine's annotation shape
//      for those ids, each once, on its page, at its rect, with its label,
//      pointing byte for byte to https://<origin>/out/<id>, listed by
//      reference in its page's /Annots and referenced from nowhere else; any
//      other annotation, action, /URI, /AP or /AA stays refused. Then pdf.js
//      reads the text under each link in the copy and in the original
//      (gate-links.ts): any difference refuses the whole copy. And (fix
//      round 1) the link guard reads both with PDFium (link-guard.ts): a kept
//      link that meets the box of a glyph the copy lacks, or under "blur" or
//      "hide" any picture PDFium reads, or lies on a page that reaches a
//      tiling pattern holding a picture (fix round 2), refuses it too. All
//      are "rules"; the worker then
//      asks for the copy with no links (rerun.ts). With no links kept the
//      rules are as before.
//
// Out of scope, as for any text gate: withheld text written so a reader does
// not see it as text (reversed, encoded, drawn as curves or as a picture), a
// picture rebuilt from many small tiles or from vector shapes (gradients of
// many linear pieces among them). README, "The gate sidecar", lists these
// limits.
// ============================================================================
import { PDFArray, type PDFContext, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, type PDFObject, PDFRawStream, PDFRef, PDFString, decodePDFRawStream } from '@cantoo/pdf-lib';
import { PDF_WS, operandBreak } from './content.js';
import { type GateCode, type GateReply, type GateVerdict, MAX_OUTPUT_BYTES, sha256Hex } from './engine-protocol.js';
import { type PageRef, drawnBreak } from './drawn.js';
import { checkCopy } from './gate.js';
import type { GateJob } from './gate-isolated.js';
import { linkTextBreak } from './gate-links.js';
import { type Accepted, type LinkRequest, acceptedLinks } from './link-annots.js';
import { BLUR_MAX, FILL_GRAY, type ImageAction, type Pixels, blurred, decodePicture, hasInlinePicture, keepsPicture, pictureWindows } from './images.js';
import { structureBreak } from './pdf-structure.js';

const FORBIDDEN_KEYS = new Set(['JS', 'JavaScript', 'OpenAction', 'AA', 'URI', 'EmbeddedFile', 'EmbeddedFiles', 'EF', 'XFA', 'AcroForm', 'Annots', 'Linearized']);
const LINEARIZED = PDFName.of('Linearized');
const ACTION_TYPES = new Set([
  'GoTo',
  'GoToR',
  'GoToE',
  'GoToDp',
  'Launch',
  'Thread',
  'URI',
  'Sound',
  'Movie',
  'Hide',
  'Named',
  'SubmitForm',
  'ResetForm',
  'ImportData',
  'JavaScript',
  'SetOCGState',
  'Rendition',
  'Trans',
  'GoTo3DView',
  'RichMediaExecute',
]);
const FORBIDDEN_TYPES = new Set(['Action', 'Filespec', 'EmbeddedFile', 'Annot']);
const FILL_KEYS = new Set(['Type', 'Subtype', 'Width', 'Height', 'ColorSpace', 'BitsPerComponent', 'Length']);
const BLUR_KEYS = new Set([...FILL_KEYS, 'Filter']);

/** Keys whose value says what a dictionary is or how its bytes read: the sanitizer writes them direct (M1). */
const STRUCTURAL = new Set(['S', 'Subtype', 'Type', 'PatternType', 'Filter']);
const indirect = (value: PDFObject): boolean => value instanceof PDFRef || (value instanceof PDFArray && value.asArray().some((item) => item instanceof PDFRef));

// Values are read resolved, as a viewer reads them (M1).
const nameIn = (dict: PDFDict, key: string): string | undefined => {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFName ? value.decodeText() : undefined;
};
const numberIn = (dict: PDFDict, key: string): number | undefined => {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFNumber ? value.asNumber() : undefined;
};

const isEmptyList = (value: unknown): boolean => value instanceof PDFArray && value.size() === 0;

/** Why an object (with what it holds directly) breaks rule 1, or null. Collects the Type 3 glyphs it names. `pages`: those whose /Annots hold only accepted links (rule 4). */
function activeIn(object: PDFObject | undefined, glyphs: PDFObject[], pages: ReadonlySet<PDFDict> = new Set()): string | null {
  if (object instanceof PDFRawStream) return activeIn(object.dict, glyphs);
  if (object instanceof PDFArray) {
    for (const value of object.asArray()) {
      const found = activeIn(value, glyphs);
      if (found !== null) return found;
    }
    return null;
  }
  if (!(object instanceof PDFDict)) return null;
  for (const [key, value] of object.entries()) {
    // An empty annotation list (pdf-lib writes one on a new page) annotates nothing; a page's accepted links are read by acceptedLinks.
    if (key.decodeText() === 'Annots' && (isEmptyList(object.lookup(key)) || pages.has(object))) continue;
    if (FORBIDDEN_KEYS.has(key.decodeText())) return `it holds /${key.decodeText()}`;
    if (STRUCTURAL.has(key.decodeText()) && indirect(value)) return `its /${key.decodeText()} is not direct`;
    const found = activeIn(value, glyphs);
    if (found !== null) return found;
  }
  const action = nameIn(object, 'S');
  if (action !== undefined && ACTION_TYPES.has(action)) return 'it holds an action';
  const type = nameIn(object, 'Type');
  if (type !== undefined && FORBIDDEN_TYPES.has(type)) return `it holds a dictionary of type /${type}`;
  if (nameIn(object, 'Subtype') === 'Type3') {
    const procs = object.lookupMaybe(PDFName.of('CharProcs'), PDFDict);
    for (const [, proc] of procs?.entries() ?? []) glyphs.push(proc);
  }
  return null;
}

/** Whether a picture XObject is exactly what `image` ("blur" or "hide") draws. */
function drawnByPolicy(picture: PDFRawStream, image: 'blur' | 'hide'): boolean {
  const { dict } = picture;
  const keys = dict.keys().map((key) => key.decodeText());
  const width = numberIn(dict, 'Width');
  const height = numberIn(dict, 'Height');
  const space = nameIn(dict, 'ColorSpace');
  if (numberIn(dict, 'BitsPerComponent') !== 8 || width === undefined || height === undefined) return false;
  const fill = keys.every((key) => FILL_KEYS.has(key)) && width === 1 && height === 1 && space === 'DeviceGray' && picture.contents.length === 1 && picture.contents[0] === FILL_GRAY;
  if (fill || image === 'hide') return fill;
  const channels = space === 'DeviceGray' ? 1 : space === 'DeviceRGB' ? 3 : 0;
  const sized = Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && Math.max(width, height) <= BLUR_MAX;
  if (!keys.every((key) => BLUR_KEYS.has(key)) || nameIn(dict, 'Filter') !== 'FlateDecode' || channels === 0 || !sized) return false;
  try {
    return decodePDFRawStream(picture).decode().length === width * height * channels;
  } catch {
    return false;
  }
}

/** Every content stream of the copy, in groups read as one: each page's /Contents (an array is joined, as pdf.js joins it), each form, tiling pattern and Type 3 glyph alone. */
function contentGroups(doc: PDFDocument, glyphs: readonly PDFObject[]): PDFObject[][] {
  const { context } = doc;
  const out: PDFObject[][] = [];
  for (const page of doc.getPages()) {
    const listed = context.lookup(page.node.get(PDFName.of('Contents')));
    if (listed instanceof PDFArray) out.push(listed.asArray().map((ref) => context.lookup(ref) as PDFObject));
    else if (listed !== undefined) out.push([listed]);
  }
  for (const [, object] of context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream && (nameIn(object.dict, 'Subtype') === 'Form' || numberIn(object.dict, 'PatternType') === 1)) out.push([object]);
  }
  out.push(...glyphs.map((glyph) => [glyph instanceof PDFRef ? (context.lookup(glyph) as PDFObject) : glyph]));
  return out;
}

class TreeBreak extends Error {}
/** Page trees deeper than this are refused: the sanitizer writes one level. */
const MAX_TREE_DEPTH = 32;

/**
 * Why the page tree is not one pdf.js and pdf-lib read alike (fix round 4, M1), or null: every node /Type /Pages
 * with /Kids and their /Count, every leaf /Type /Page with no /Kids, each once, each kid by reference.
 */
function pageTreeBreak(doc: PDFDocument): string | null {
  const { context } = doc;
  const seen = new Set<PDFObject>();
  const count = (ref: PDFObject | undefined, depth: number): number => {
    const node = ref instanceof PDFRef ? context.lookup(ref) : undefined;
    if (!(node instanceof PDFDict) || seen.has(node) || depth > MAX_TREE_DEPTH) throw new TreeBreak();
    seen.add(node);
    const kids = node.lookup(PDFName.of('Kids'));
    if (depth > 0 && nameIn(node, 'Type') === 'Page' && kids === undefined) return 1;
    if (nameIn(node, 'Type') !== 'Pages' || !(kids instanceof PDFArray)) throw new TreeBreak();
    const pages = kids.asArray().reduce((sum: number, kid) => sum + count(kid, depth + 1), 0);
    if (numberIn(node, 'Count') !== pages) throw new TreeBreak();
    return pages;
  };
  try {
    count(doc.catalog.get(PDFName.of('Pages')), 0);
    return null;
  } catch {
    return 'the page tree: every node must be /Type /Pages with its /Kids and their /Count, every leaf /Type /Page, each once';
  }
}

/** Every dictionary an object holds directly: itself (a stream's own), and those in its arrays and dictionaries, at any depth. */
function* dictsIn(object: PDFObject | undefined): Generator<PDFDict> {
  const value = object instanceof PDFRawStream ? object.dict : object;
  if (value instanceof PDFDict) {
    yield value;
    for (const [, item] of value.entries()) yield* dictsIn(item);
  } else if (value instanceof PDFArray) {
    for (const item of value.asArray()) yield* dictsIn(item);
  }
}

/** A content stream's bytes, or null when pdf-lib cannot decode it. */
function contentOf(stream: PDFObject | undefined): Uint8Array | null {
  if (!(stream instanceof PDFRawStream)) return null;
  try {
    return decodePDFRawStream(stream).decode();
  } catch {
    return null;
  }
}

/** Whether a function is sampled (Type 0), or a list or stitching (Type 3) of functions with one in it (fix round 5, S1). */
function sampledFunction(context: PDFContext, value: PDFObject | undefined, seen: Set<PDFObject>): boolean {
  const fn = value instanceof PDFRef ? context.lookup(value) : value;
  if (fn === undefined || seen.has(fn)) return false;
  seen.add(fn);
  if (fn instanceof PDFArray) return fn.asArray().some((item) => sampledFunction(context, item, seen));
  const dict = fn instanceof PDFRawStream ? fn.dict : fn;
  if (!(dict instanceof PDFDict)) return false;
  const type = numberIn(dict, 'FunctionType');
  return type === 0 || (type === 3 && sampledFunction(context, dict.get(PDFName.of('Functions')), seen));
}

const DEVICE_SPACES = new Set(['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'G', 'RGB', 'CMYK']);
const CIE_SPACES = new Set(['CalGray', 'CalRGB', 'Lab']);
/** The most colours an Indexed space under a gradient may hold (fix round 6, S1-6): a longer palette is a row of samples. */
export const PALETTE_MAX = 4;
const SPACE = 'a gradient is drawn in a colour space with a table or program of its own';

/** Whether a type 2 (exponential) function: a tint transform that is no table and no program (fix round 6, S1-6). */
function linearFunction(context: PDFContext, value: PDFObject | undefined): boolean {
  const fn = value instanceof PDFRef ? context.lookup(value) : value;
  const dict = fn instanceof PDFRawStream ? fn.dict : fn;
  return dict instanceof PDFDict && numberIn(dict, 'FunctionType') === 2;
}

/**
 * Whether a gradient's colour space draws its colours as given (fix round 6, S1-6): a device or CIE space, an
 * ICCBased one whose /Alternate (which pdf.js may draw in) is so, a Separation or DeviceN one (no attributes) over
 * such a space with a type 2 tint, or a palette of at most PALETTE_MAX colours in a string over such a space. A name
 * other than a device space's is one pdf.js looks up in the page's resources: not plain.
 */
function plainSpace(context: PDFContext, value: PDFObject | undefined, depth = 0): boolean {
  const space = value instanceof PDFRef ? context.lookup(value) : value;
  if (space instanceof PDFName) return DEVICE_SPACES.has(space.decodeText());
  if (!(space instanceof PDFArray) || depth > 4) return false;
  const family = context.lookup(space.get(0));
  const name = family instanceof PDFName ? family.decodeText() : '';
  const at = (index: number): PDFObject | undefined => context.lookup(space.get(index));
  if (CIE_SPACES.has(name)) return space.size() === 2;
  if (name === 'ICCBased') {
    const profile = at(1);
    const alternate = profile instanceof PDFRawStream ? profile.dict.get(PDFName.of('Alternate')) : undefined;
    return space.size() === 2 && profile instanceof PDFRawStream && (alternate === undefined || plainSpace(context, alternate, depth + 1));
  }
  if (name === 'Separation' || name === 'DeviceN') return space.size() === 4 && plainSpace(context, space.get(2), depth + 1) && linearFunction(context, space.get(3));
  if (name === 'Indexed') {
    const high = at(2);
    const table = at(3);
    const colours = high instanceof PDFNumber ? high.asNumber() + 1 : 0;
    const plainTable = (table instanceof PDFString || table instanceof PDFHexString) && table.asBytes().length <= PALETTE_MAX * 4;
    return space.size() === 4 && Number.isInteger(colours) && colours >= 1 && colours <= PALETTE_MAX && plainTable && plainSpace(context, space.get(1), depth + 1);
  }
  return false;
}

const TRANSFER_KEYS = ['TR', 'TR2', 'BG', 'BG2', 'UCR', 'UCR2'];
const PLAIN_TRANSFER = new Set(['Identity', 'Default']);
const typeOf = (dict: PDFDict, key: PDFName): number | string => {
  const value = dict.lookup(key);
  return value instanceof PDFNumber ? value.asNumber() : String(value);
};

/**
 * Why a dictionary is of a class "blur" and "hide" refuse wherever it is (fix round 6, M-6 and S1-6), or null: a
 * shading of a type other than 2 or 3 (function-based and mesh shadings draw a picture of their own); a gradient in a
 * colour space that is not plain; a function of a type other than 0, 2 or 3 (a PostScript program among them); a
 * transfer, black-generation or undercolour-removal function other than /Identity or /Default.
 */
function classBreak(context: PDFContext, dict: PDFDict): string | null {
  const shading = PDFName.of('ShadingType');
  if (dict.has(shading)) {
    const type = typeOf(dict, shading);
    if (type !== 2 && type !== 3) return `a shading of type ${type}`;
    const spaces = ['ColorSpace', 'CS'].map((key) => PDFName.of(key)).filter((key) => dict.has(key));
    if (spaces.length === 0 || spaces.some((key) => !plainSpace(context, dict.get(key)))) return SPACE;
  }
  const fn = PDFName.of('FunctionType');
  if (dict.has(fn)) {
    const type = typeOf(dict, fn);
    if (type !== 0 && type !== 2 && type !== 3) return `a function of type ${type}`;
  }
  for (const key of TRANSFER_KEYS) {
    const value = dict.lookup(PDFName.of(key));
    if (value !== undefined && !(value instanceof PDFName && PLAIN_TRANSFER.has(value.decodeText()))) return `a transfer, black-generation or undercolour-removal function (/${key})`;
  }
  return null;
}

/** Forms, tiling patterns, Type 3 fonts and soft masks drawn deeper than this from a page, or in a loop, are refused (fix round 5, S3). */
export const MAX_NESTING = 32;
const NESTING = `forms, patterns, Type 3 glyphs or soft masks nest more than ${MAX_NESTING} deep, or in a loop`;
/**
 * How many times the cap reads a drawer with resources it has not read it with before; past this the copy is refused
 * (fix round 6, S3-6). A drawer reached with the same resources is read once, however many ways; one whose names
 * are looked up through its parents' resources too can be reached with as many as it has ways in.
 */
export const MAX_DRAWS = 100_000;
const DRAWS = `forms, patterns, Type 3 glyphs or soft masks are drawn in more than ${MAX_DRAWS} ways`;
const NAME_TOKEN = new RegExp(`/([^${PDF_WS}()<>\\[\\]{}/%]*)`, 'g');

/**
 * What draws content of its own (a page, a form, a tiling pattern, a Type 3 font's glyphs, a soft mask's group), with
 * its own /Resources; a page's content streams are read joined too, as pdf.js joins them, and a tiling pattern's
 * resources are merged with its parent's, as pdf.js merges them (fix round 6, S3-6).
 */
interface Drawer {
  node: PDFObject;
  content: readonly PDFObject[];
  resources: PDFDict | undefined;
  joined?: boolean;
  merged?: boolean;
}

/** The resource kinds a drawer's names are followed through. */
const KINDS = ['XObject', 'Pattern', 'Font', 'ExtGState'] as const;
/**
 * The operators that draw from each kind (Do; scn and SCN; Tf; gs, which sets a soft mask or a font too): a
 * drawer's names are looked up in a kind only when its content holds one (fix round 6, S3-6: with a pattern's
 * resources merged with its parent's, a font named as the pattern was read as the pattern drawing itself). Operators
 * cannot be escaped, so a content stream draws from a kind only when it holds those bytes.
 */
const DRAWS_FROM: Readonly<Record<(typeof KINDS)[number], RegExp>> = { XObject: /Do/, Pattern: /scn|SCN/, Font: /Tf/, ExtGState: /gs/ };
/** The dictionary of each kind a drawer looks its names up in, and a key that says which they are. */
interface Effective {
  key: string;
  dicts: ReadonlyArray<PDFDict | undefined>;
}

/**
 * Why the copy's forms, tiling patterns, Type 3 fonts and soft masks nest more than MAX_NESTING deep from a page, or
 * in a loop (fix round 5, S3), or are reached in more than MAX_DRAWS ways (fix round 6, S3-6), or null. Each is
 * followed from the names its content holds (every name, a little more than it draws; a page's over its streams
 * joined too, so a name split across two is read) in the resources pdf.js reads it with: its own, or its parent's
 * when it has none; for a tiling pattern, each kind from its own, else from its parent's (pdf.js merges them; fix
 * round 6, S3-6). Anything that cannot be read so is refused.
 */
function nestingBreak(doc: PDFDocument): string | null {
  const { context } = doc;
  const resolve = (value: PDFObject | undefined): PDFObject | undefined => (value instanceof PDFRef ? context.lookup(value) : value);
  const own = (dict: PDFDict): PDFDict | undefined => dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
  const byName = new Map<PDFDict, Map<string, PDFObject | undefined>>();
  const named = (dict: PDFDict | undefined): Map<string, PDFObject | undefined> => {
    if (dict === undefined) return new Map();
    let names = byName.get(dict);
    if (names === undefined) {
      names = new Map(dict.entries().map(([name, value]) => [name.decodeText(), resolve(value)]));
      byName.set(dict, names);
    }
    return names;
  };
  const ids = new Map<PDFDict, number>();
  const idOf = (dict: PDFDict | undefined): number => {
    if (dict === undefined) return -1;
    const id = ids.get(dict) ?? ids.size;
    ids.set(dict, id);
    return id;
  };
  const effective = (dicts: ReadonlyArray<PDFDict | undefined>): Effective => ({ key: dicts.map(idOf).join(','), dicts });
  const ofResources = (resources: PDFDict | undefined, parent: Effective | undefined, merged: boolean): Effective | undefined => {
    if (resources === undefined) return parent;
    const dicts = KINDS.map((key, k) => resources.lookupMaybe(PDFName.of(key), PDFDict) ?? (merged ? parent?.dicts[k] : undefined));
    return effective(dicts);
  };
  const used = new Map<PDFObject, { names: Set<string>; kinds: boolean[] }>();
  const namesOf = (drawer: Drawer): { names: Set<string>; kinds: boolean[] } => {
    let read = used.get(drawer.node);
    if (read === undefined) {
      read = { names: new Set(), kinds: KINDS.map(() => false) };
      const texts = drawer.content.map(contentOf).filter((bytes) => bytes !== null);
      for (const bytes of drawer.joined === true && texts.length > 1 ? [...texts, Buffer.concat(texts)] : texts) {
        const text = Buffer.from(bytes).toString('latin1');
        for (const [, raw] of text.matchAll(NAME_TOKEN)) read.names.add((raw as string).replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))));
        KINDS.forEach((key, k) => {
          if (DRAWS_FROM[key].test(text)) (read as { kinds: boolean[] }).kinds[k] = true;
        });
      }
      used.set(drawer.node, read);
    }
    return read;
  };
  const type3 = (font: PDFObject | undefined): Drawer[] =>
    font instanceof PDFDict && nameIn(font, 'Subtype') === 'Type3' ? [{ node: font, content: (font.lookupMaybe(PDFName.of('CharProcs'), PDFDict)?.values() ?? []).map(resolve).filter((proc) => proc !== undefined), resources: own(font) }] : [];
  const drawn = (stream: PDFObject | undefined, is: boolean, merged = false): Drawer[] => (stream instanceof PDFRawStream && is ? [{ node: stream, content: [stream], resources: own(stream.dict), merged }] : []);
  const children = (drawer: Drawer, reads: Effective | undefined): Drawer[] => {
    const { names, kinds } = namesOf(drawer);
    const [forms, patterns, fonts, states] = KINDS.map((_, k) => named(kinds[k] === true ? reads?.dicts[k] : undefined)) as [Map<string, PDFObject | undefined>, Map<string, PDFObject | undefined>, Map<string, PDFObject | undefined>, Map<string, PDFObject | undefined>];
    const out: Drawer[] = [];
    for (const name of names) {
      const form = forms.get(name);
      out.push(...drawn(form, form instanceof PDFRawStream && nameIn(form.dict, 'Subtype') === 'Form'));
      const pattern = patterns.get(name);
      out.push(...drawn(pattern, pattern instanceof PDFRawStream && numberIn(pattern.dict, 'PatternType') === 1, true), ...type3(fonts.get(name)));
      const state = states.get(name);
      if (!(state instanceof PDFDict)) continue;
      const mask = state.lookup(PDFName.of('SMask'));
      out.push(...drawn(mask instanceof PDFDict ? mask.lookup(PDFName.of('G')) : undefined, true));
      const font = state.lookup(PDFName.of('Font'));
      out.push(...type3(font instanceof PDFArray ? resolve(font.get(0)) : undefined));
    }
    return out;
  };
  // Each drawer's height (itself and the deepest chain under it) with the resources it reads, so one reached many
  // ways with the same is read once. A loop never ends, so it runs past MAX_NESTING as a deep chain does.
  const heights = new Map<PDFObject, Map<string, number>>();
  let draws = 0;
  const height = (drawer: Drawer, parent: Effective | undefined, depth: number): number => {
    const reads = ofResources(drawer.resources, parent, drawer.merged === true);
    const key = reads?.key ?? '';
    const known = heights.get(drawer.node)?.get(key);
    if (depth + (known ?? 1) - 1 > MAX_NESTING) throw new Error(NESTING);
    if (known !== undefined) return known;
    if (++draws > MAX_DRAWS) throw new Error(DRAWS);
    let deepest = 1;
    for (const child of children(drawer, reads)) deepest = Math.max(deepest, 1 + height(child, reads, depth + 1));
    heights.set(drawer.node, (heights.get(drawer.node) ?? new Map<string, number>()).set(key, deepest));
    return deepest;
  };
  try {
    for (const page of doc.getPages()) {
      const listed = resolve(page.node.get(PDFName.of('Contents')));
      const reads = ofResources(page.node.Resources(), undefined, false);
      const top: Drawer = { node: page.node, content: listed instanceof PDFArray ? listed.asArray().map(resolve).filter((part) => part !== undefined) : listed === undefined ? [] : [listed], resources: undefined, joined: true };
      for (const child of children(top, reads)) height(child, reads, 1);
    }
    return null;
  } catch (error) {
    return error instanceof Error && error.message === DRAWS ? DRAWS : NESTING;
  }
}

/** Why the copy breaks the sanitizer's rules or the picture policy's shape (or null), and the pages pdf-lib's tree gives, in order. */
async function readRules(copy: Uint8Array, image: ImageAction, links: LinkRequest = {}): Promise<{ broken: string | null; pages: PageRef[] }> {
  // One reading first (M1): no encryption, no second trailer, no shadowed object.
  const structure = await structureBreak(copy);
  if (structure !== null) return { broken: `the structure: ${structure}`, pages: [] };
  const doc = await PDFDocument.load(copy, { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: true });
  // pdf-lib counts pages only through a tree that passed pageTreeBreak (it throws on some others).
  const broken = (reason: string | null): { broken: string | null; pages: PageRef[] } => ({
    broken: reason,
    pages: reason === null ? doc.getPages().map((page) => ({ num: page.ref.objectNumber, gen: page.ref.generationNumber })) : [],
  });
  const { context } = doc;
  const tree = pageTreeBreak(doc);
  if (tree !== null) return broken(tree);
  const accepted: Accepted | string = acceptedLinks(doc, links);
  if (typeof accepted === 'string') return broken(`the links: ${accepted}`);
  const glyphs: PDFObject[] = [];
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (accepted.annots.has(object)) continue;
    const found = activeIn(object, glyphs, accepted.pages);
    if (found !== null) return broken(`object ${ref.objectNumber}: ${found}`);
  }
  const nesting = nestingBreak(doc);
  if (nesting !== null) return broken(nesting);
  if (image === 'show') return broken(null);
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const picture = nameIn(object.dict, 'Subtype') === 'Image';
    if (picture && !drawnByPolicy(object, image)) return broken(`object ${ref.objectNumber}: a picture is not what the "${image}" policy draws`);
    if (!picture && object.dict.has(PDFName.of('DecodeParms'))) return broken(`object ${ref.objectNumber}: a stream that is not a picture has /DecodeParms`);
  }
  const masks: PDFObject[][] = [];
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    for (const dict of dictsIn(object)) {
      const type = numberIn(dict, 'ShadingType');
      if ((type === 2 || type === 3) && sampledFunction(context, dict.get(PDFName.of('Function')), new Set())) return broken(`object ${ref.objectNumber}: a gradient is drawn from a sampled function`);
      const kind = classBreak(context, dict);
      if (kind !== null) return broken(`object ${ref.objectNumber}: ${kind}`);
      // pdf.js draws a soft mask's group as a form, /Subtype or not.
      const mask = dict.lookup(PDFName.of('SMask'));
      const group = mask instanceof PDFDict ? mask.lookup(PDFName.of('G')) : undefined;
      if (group instanceof PDFRawStream) masks.push([group]);
    }
  }
  for (const group of [...contentGroups(doc, glyphs), ...masks]) {
    const decoded: Uint8Array[] = [];
    for (const stream of group) {
      if (!(stream instanceof PDFRawStream)) return broken('a page has content that is not a stream');
      try {
        decoded.push(decodePDFRawStream(stream).decode());
      } catch {
        return broken('a content stream cannot be read');
      }
    }
    if ([...decoded, Buffer.concat(decoded)].some(hasInlinePicture)) return broken(`an inline picture is in a content stream under the "${image}" policy`);
    // Each stream alone (fix round 6, M-6): one that ends with operands is refused, so no operator takes operands
    // across two of a page's streams, however a reader joins them.
    for (const part of decoded) {
      const operands = operandBreak(part);
      if (operands !== null) return broken(operands);
    }
  }
  return broken(null);
}

/** Why the copy breaks the sanitizer's rules or the picture policy's shape, or null. Reads the copy alone, through pdf-lib. `links`: what the engine was given and kept (rule 4). */
export async function copyRulesBreak(copy: Uint8Array, image: ImageAction, links: LinkRequest = {}): Promise<string | null> {
  return (await readRules(copy, image, links)).broken;
}

const samplesKey = (pixels: Pixels): string => `${pixels.width}x${pixels.height}x${pixels.channels}:${sha256Hex(pixels.data.subarray(0, pixels.width * pixels.height * pixels.channels))}`;

/** The samples of each picture XObject in `pdf` that blurring would change (none when it cannot be read). */
async function changedByBlur(pdf: Uint8Array): Promise<Set<string>> {
  const keys = new Set<string>();
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdf, { updateMetadata: false });
  } catch {
    return keys;
  }
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream) || nameIn(object.dict, 'Subtype') !== 'Image') continue;
    const pixels = decodePicture(object);
    if (pixels === null) continue;
    const key = samplesKey(pixels);
    if (samplesKey(blurred(pixels)) !== key) keys.add(key);
  }
  return keys;
}

/** Whether a picture XObject of the copy has exactly the samples of one of `originals`. */
async function keepsSamples(copy: Uint8Array, originals: Set<string>): Promise<boolean> {
  if (originals.size === 0) return false;
  const doc = await PDFDocument.load(copy, { updateMetadata: false });
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream) || nameIn(object.dict, 'Subtype') !== 'Image') continue;
    const pixels = decodePicture(object);
    if (pixels !== null && originals.has(samplesKey(pixels))) return true;
  }
  return false;
}

/**
 * Why a copy nests past the cap (nestingBreak), read before pdf.js reads it at all (fix round 6, S3-6: pdf.js's text
 * reading overflows its stack on forms 1,500 deep, and leaves rejections no one handles); null too when pdf-lib cannot
 * read the copy, which the checks after refuse.
 */
async function nestedPast(copy: Uint8Array): Promise<string | null> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(copy, { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: true });
  } catch {
    return null;
  }
  return nestingBreak(doc);
}

/**
 * The gate's verdict on one copy: nesting past the cap first, before pdf.js reads it, then withheld text (gate.ts),
 * then the rules above, then what pdf.js draws (drawn.ts; under "show" only its glyphs, and only with quotes), then
 * under "blur" and "hide" the original's pictures.
 * Never throws.
 */
export async function gateVerdict(job: GateJob): Promise<GateVerdict> {
  try {
    if ((await nestedPast(job.copy)) !== null) return { pass: false, code: 'rules' };
    if ((await checkCopy(job.copy, job.quotes)) !== null) return { pass: false, code: 'withheld' };
    const { broken, pages } = await readRules(job.copy, job.image, job);
    if (broken !== null) return { pass: false, code: 'rules' };
    // Under "show" only for the quotes (fix round 6b, REDACT-LOOK L10/N8), with no picture judged.
    const drawn = job.image === 'show' && job.quotes.length === 0 ? null : await drawnBreak(job.copy, job.image, job.quotes, pages);
    if (drawn !== null) return { pass: false, code: drawn.code };
    if ((await linkTextBreak(job.copy, job.original, job)) !== null) return { pass: false, code: 'rules' };
    if (job.image !== 'show' && (await keepsPicture(job.copy, await pictureWindows(job.original)))) return { pass: false, code: 'rules' };
    if (job.image !== 'show' && (await keepsSamples(job.copy, await changedByBlur(job.original)))) return { pass: false, code: 'rules' };
    return { pass: true };
  } catch {
    return { pass: false, code: 'unfinished' };
  }
}

/**
 * The copy as pdf-lib read it, written again by pdf-lib's writer as the sanitizer writes (sanitize.ts): no object
 * streams, no incremental update, and no /Linearized key anywhere (fix round 5, M1), so pdf.js never reads the
 * gate's writing as linearized, whatever the copy held.
 */
export async function rewrite(copy: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(copy, { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: true });
  for (const [, object] of doc.context.enumerateIndirectObjects()) for (const dict of dictsIn(object)) dict.delete(LINEARIZED);
  return doc.save({ rewrite: true, useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}

/** Whether pdf-lib reads a /Linearized key anywhere in the copy (fix round 5, M1). */
async function holdsLinearized(copy: Uint8Array): Promise<boolean> {
  const doc = await PDFDocument.load(copy, { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: true });
  for (const [, object] of doc.context.enumerateIndirectObjects()) for (const dict of dictsIn(object)) if (dict.has(LINEARIZED)) return true;
  return false;
}

/**
 * The gate child's answer (M1): the copy's sha256 and the verdict on the gate's own writing of the copy, read
 * afresh; on a pass, those bytes, the only ones that may be stored, with their sha256. A copy whose structure
 * could read two ways is refused as it comes (withheld when there are quotes it cannot read it for, else rules),
 * as is one holding /Linearized (rules: fix round 5, M1); one whose writing is over `maxBytes` is unfinished. `write` is the writing (rewrite; another, for tests).
 * Never throws.
 */
export async function gateReply(job: GateJob, maxBytes = MAX_OUTPUT_BYTES, write: (copy: Uint8Array) => Promise<Uint8Array> = rewrite): Promise<GateReply> {
  const sha256 = sha256Hex(job.copy);
  const refused = (code: GateCode): GateReply => ({ verdict: { pass: false, code }, sha256 });
  let pdf: Uint8Array;
  try {
    // Refused as it comes, by the verdict on it as handed over (its structure breaks copyRulesBreak).
    if ((await structureBreak(job.copy)) !== null) return { verdict: await gateVerdict(job), sha256 };
    if (await holdsLinearized(job.copy)) return refused('rules');
    pdf = await write(job.copy);
  } catch {
    return refused('unfinished');
  }
  if (pdf.byteLength > maxBytes) return refused('unfinished');
  const verdict = await gateVerdict({ ...job, copy: pdf });
  return verdict.pass ? { verdict, sha256, checked: { pdf, sha256: sha256Hex(pdf) } } : { verdict, sha256 };
}
