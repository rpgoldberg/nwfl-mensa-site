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
//   2. Pictures, where the policy changes them ("blur" or "hide"):
//      - every picture XObject is what the policy draws: under "hide" the
//        1 x 1 grey fill; under "blur" that fill, or a Flate 8-bit grey or
//        RGB picture of at most BLUR_MAX pixels a side with no other keys and
//        exactly its samples. A re-encoded original (a JPEG, a larger Flate
//        picture, one with a mask) has another shape;
//      - no inline picture in any content (a page's, a form's, a tiling
//        pattern's, a Type 3 glyph's);
//      - no run of an original picture's samples is in the copy (the
//        engine's own check, keepsPicture, on the original the worker sends),
//        and no picture of the copy has exactly the samples of an original
//        picture that blurring changes: an original small enough to have the
//        blur's shape, kept, is caught by one or the other. A picture of one
//        grey is its own blur, so it may come through unchanged.
//
// Out of scope, as for any text gate: withheld text written so a reader does
// not see it as text (reversed, encoded, drawn as curves or as a picture), a
// picture rebuilt from many small tiles or from vector shapes. README, "The
// gate sidecar", lists these limits.
// ============================================================================
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, type PDFObject, PDFRawStream, PDFRef, decodePDFRawStream } from '@cantoo/pdf-lib';
import { type GateVerdict, sha256Hex } from './engine-protocol.js';
import { checkCopy } from './gate.js';
import type { GateJob } from './gate-isolated.js';
import { BLUR_MAX, FILL_GRAY, type ImageAction, type Pixels, blurred, decodePicture, hasInlinePicture, keepsPicture, pictureWindows } from './images.js';

const FORBIDDEN_KEYS = new Set(['JS', 'JavaScript', 'OpenAction', 'AA', 'URI', 'EmbeddedFile', 'EmbeddedFiles', 'EF', 'XFA', 'AcroForm', 'Annots']);
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
const UNREADABLE = 'the copy could not be read';

const nameIn = (dict: PDFDict, key: string): string | undefined => {
  const value = dict.get(PDFName.of(key));
  return value instanceof PDFName ? value.decodeText() : undefined;
};
const numberIn = (dict: PDFDict, key: string): number | undefined => {
  const value = dict.get(PDFName.of(key));
  return value instanceof PDFNumber ? value.asNumber() : undefined;
};

const isEmptyList = (value: unknown): boolean => value instanceof PDFArray && value.size() === 0;

/** Why an object (with what it holds directly) breaks rule 1, or null. Collects the Type 3 glyphs it names. */
function activeIn(object: PDFObject | undefined, glyphs: PDFObject[]): string | null {
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
    // An empty annotation list (pdf-lib writes one on a new page) annotates nothing.
    if (key.decodeText() === 'Annots' && isEmptyList(object.lookup(key))) continue;
    if (FORBIDDEN_KEYS.has(key.decodeText())) return `it holds /${key.decodeText()}`;
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

/** Every content stream of the copy: its pages', its forms', its tiling patterns' and these Type 3 glyphs'. */
function contentStreams(doc: PDFDocument, glyphs: readonly PDFObject[]): PDFObject[] {
  const { context } = doc;
  const out: PDFObject[] = [];
  for (const page of doc.getPages()) {
    const contents = page.node.get(PDFName.of('Contents'));
    const listed = context.lookup(contents);
    if (listed instanceof PDFArray) out.push(...listed.asArray().map((ref) => context.lookup(ref) as PDFObject));
    else if (listed !== undefined) out.push(listed);
  }
  for (const [, object] of context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream && (nameIn(object.dict, 'Subtype') === 'Form' || numberIn(object.dict, 'PatternType') === 1)) out.push(object);
  }
  out.push(...glyphs.map((glyph) => (glyph instanceof PDFRef ? (context.lookup(glyph) as PDFObject) : glyph)));
  return out;
}

/** Why the copy breaks the sanitizer's rules or the picture policy's shape, or null. Reads the copy alone. */
export async function copyRulesBreak(copy: Uint8Array, image: ImageAction): Promise<string | null> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(copy, { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: true });
  } catch {
    return UNREADABLE;
  }
  const { context } = doc;
  if (context.trailerInfo.Encrypt !== undefined) return 'the trailer: the copy is encrypted';
  const glyphs: PDFObject[] = [];
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    const found = activeIn(object, glyphs);
    if (found !== null) return `object ${ref.objectNumber}: ${found}`;
  }
  if (image === 'show') return null;
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream && nameIn(object.dict, 'Subtype') === 'Image' && !drawnByPolicy(object, image)) {
      return `object ${ref.objectNumber}: a picture is not what the "${image}" policy draws`;
    }
  }
  for (const stream of contentStreams(doc, glyphs)) {
    if (!(stream instanceof PDFRawStream)) return 'a page has content that is not a stream';
    let bytes: Uint8Array;
    try {
      bytes = decodePDFRawStream(stream).decode();
    } catch {
      return 'a content stream cannot be read';
    }
    if (hasInlinePicture(bytes)) return `an inline picture is in a content stream under the "${image}" policy`;
  }
  return null;
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

/** The gate's verdict on one copy: withheld text first (gate.ts), then the rules above, then the original's pictures. Never throws. */
export async function gateVerdict(job: GateJob): Promise<GateVerdict> {
  try {
    if ((await checkCopy(job.copy, job.quotes)) !== null) return { pass: false, code: 'withheld' };
    if ((await copyRulesBreak(job.copy, job.image)) !== null) return { pass: false, code: 'rules' };
    if (job.image !== 'show' && (await keepsPicture(job.copy, await pictureWindows(job.original)))) return { pass: false, code: 'rules' };
    if (job.image !== 'show' && (await keepsSamples(job.copy, await changedByBlur(job.original)))) return { pass: false, code: 'rules' };
    return { pass: true };
  } catch {
    return { pass: false, code: 'unfinished' };
  }
}

/** The gate child's answer: the verdict and the sha256 of the very bytes it read. */
export async function gateReply(job: GateJob): Promise<{ verdict: GateVerdict; sha256: string }> {
  return { verdict: await gateVerdict(job), sha256: sha256Hex(job.copy) };
}
