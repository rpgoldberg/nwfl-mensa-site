// ============================================================================
// REDACT R3a: the redacted copy, rebuilt with only what draws the pages.
//
// The pages are copied into a new document, so nothing hangs off the old
// catalog: no Info or XMP metadata, outline, form, named destinations,
// embedded files, document JavaScript or open action. Each page keeps only
// the keys that draw it (annotations, page actions, thumbnails and the rest
// are dropped before the copy, so nothing they point at is copied), and
// every object left loses the keys that carry text or files beside the
// drawing: Metadata, PieceInfo, associated files, optional-content names,
// marked-content properties. Content streams lose their BDC properties
// (content.ts). Each page, form, tiling pattern and Type 3 font keeps only the
// resources its own content names: a form that another page's shared
// resources list, or that a page lists but never draws, is not copied on.
// A JPEG keeps only what draws it (jpeg.ts). Objects nothing points at any
// more are deleted before saving.
// Pictures follow the audience's image policy (images.ts); under "blur" or
// "hide", an inline picture left in any content stream means no copy.
// No date or id is written, so the same input gives the same bytes.
// ============================================================================
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
} from '@cantoo/pdf-lib';
import { stripMarkedContentProperties } from './content.js';
import { type ImageAction, applyImagePolicy, hasInlinePicture } from './images.js';
import { stripJpeg } from './jpeg.js';

const PAGE_KEYS = new Set(['/Type', '/Parent', '/Resources', '/Contents', '/MediaBox', '/CropBox', '/BleedBox', '/TrimBox', '/ArtBox', '/Rotate', '/UserUnit', '/Group']);
const DROP = ['Metadata', 'PieceInfo', 'AF', 'OPI', 'StructParent', 'StructParents', 'Properties', 'OC', 'Thumb', 'LastModified', 'Annots', 'AA'].map((key) => PDFName.of(key));
const STREAM_KEYS = new Set(['/Filter', '/DecodeParms', '/Length', '/DL']);
const RESOURCE_KINDS = new Set(['/XObject', '/Font', '/Pattern', '/ExtGState', '/ColorSpace', '/Shading', '/Properties']);

const name = (dict: PDFDict, key: string): string | undefined => dict.get(PDFName.of(key))?.toString();

function contentStreams(doc: PDFDocument): Set<PDFRef> {
  const { context } = doc;
  const out = new Set<PDFRef>();
  const seen = new Set<PDFDict>();
  // A content entry is a stream, or an array of them, either one possibly behind a reference.
  const refsOf = (value: PDFObject | undefined): PDFRef[] => {
    if (value instanceof PDFArray) return value.asArray().flatMap(refsOf);
    if (!(value instanceof PDFRef)) return [];
    const target = context.lookup(value);
    return target instanceof PDFArray ? refsOf(target) : [value];
  };
  const resources = (value: PDFObject | undefined): void => {
    const dict = context.lookupMaybe(value, PDFDict);
    if (dict === undefined || seen.has(dict)) return;
    seen.add(dict);
    for (const kind of ['XObject', 'Pattern', 'Font']) {
      const entries = context.lookupMaybe(dict.get(PDFName.of(kind)), PDFDict);
      for (const [, ref] of entries?.entries() ?? []) {
        const target = context.lookup(ref);
        const head = target instanceof PDFStream ? target.dict : target instanceof PDFDict ? target : undefined;
        if (head === undefined) continue;
        if (ref instanceof PDFRef && target instanceof PDFStream && (name(head, 'Subtype') === '/Form' || name(head, 'PatternType') === '1')) out.add(ref);
        if (name(head, 'Subtype') === '/Type3') {
          const procs = context.lookupMaybe(head.get(PDFName.of('CharProcs')), PDFDict);
          for (const [, proc] of procs?.entries() ?? []) for (const r of refsOf(proc)) out.add(r);
        }
        resources(head.get(PDFName.of('Resources')));
      }
    }
  };
  for (const page of doc.getPages()) {
    for (const ref of refsOf(page.node.get(PDFName.of('Contents')))) out.add(ref);
    resources(page.node.get(PDFName.of('Resources')));
  }
  return out;
}

const decoded = (value: PDFObject | undefined): Uint8Array => (value instanceof PDFRawStream ? decodePDFRawStream(value).decode() : new Uint8Array());

/** Every name a content stream writes (operands included, so this keeps more than it must, never less). */
const namesIn = (content: Uint8Array): Set<PDFName> =>
  new Set([...Buffer.from(content).toString('latin1').matchAll(/\/([^\s/<>[\]()%{}]*)/g)].map((m) => PDFName.of(m[1] as string)));

/** Each page, and each form, tiling pattern and Type 3 font it reaches, given resources holding only what its content names. */
function pruneResources(doc: PDFDocument): void {
  const { context } = doc;
  const done = new Set<PDFObject>();
  const visit = (owner: PDFDict, content: Uint8Array): void => {
    const resources = context.lookupMaybe(owner.get(PDFName.of('Resources')), PDFDict);
    if (resources === undefined) return;
    const used = namesIn(content);
    const fresh = context.obj({});
    for (const [kind, value] of resources.entries()) {
      if (!RESOURCE_KINDS.has(kind.toString())) {
        fresh.set(kind, value);
        continue;
      }
      const kept = context.obj({});
      for (const [key, ref] of context.lookupMaybe(value, PDFDict)?.entries() ?? []) {
        if (!used.has(key)) continue;
        kept.set(key, ref);
        const target = context.lookup(ref);
        if (target === undefined || done.has(target)) continue;
        done.add(target);
        if (target instanceof PDFRawStream && (name(target.dict, 'Subtype') === '/Form' || name(target.dict, 'PatternType') === '1')) visit(target.dict, decoded(target));
        else if (target instanceof PDFDict && name(target, 'Subtype') === '/Type3') {
          const procs = context.lookupMaybe(target.get(PDFName.of('CharProcs')), PDFDict);
          visit(target, Buffer.concat([...(procs?.entries() ?? [])].map(([, proc]) => decoded(context.lookup(proc)))));
        }
      }
      if (kept.keys().length > 0) fresh.set(kind, kept);
    }
    owner.set(PDFName.of('Resources'), fresh);
  };
  for (const page of doc.getPages()) {
    const contents = context.lookup(page.node.get(PDFName.of('Contents')));
    const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => context.lookup(ref)) : [contents];
    visit(page.node, Buffer.concat(streams.map((stream) => decoded(stream))));
  }
}

/** Every JPEG with only what draws it. Throws when one cannot be read. */
function stripJpegs(doc: PDFDocument): void {
  const { context } = doc;
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const filter = object.dict.lookup(PDFName.of('Filter'));
    const only = filter instanceof PDFArray && filter.size() === 1 ? filter.lookup(0) : filter;
    if (only === PDFName.of('DCTDecode')) context.assign(ref, PDFRawStream.of(object.dict, stripJpeg(object.contents)));
  }
}

function scrub(value: PDFObject): void {
  const dict = value instanceof PDFStream ? value.dict : value instanceof PDFDict ? value : undefined;
  if (dict !== undefined) {
    for (const key of DROP) dict.delete(key);
    for (const [, child] of dict.entries()) scrub(child);
  } else if (value instanceof PDFArray) value.asArray().forEach(scrub);
}

function reachable(doc: PDFDocument): Set<string> {
  const { context } = doc;
  const seen = new Set<string>();
  const walk = (value: PDFObject | undefined): void => {
    if (value instanceof PDFRef) {
      if (seen.has(value.toString())) return;
      seen.add(value.toString());
      walk(context.lookup(value));
    } else if (value instanceof PDFStream) walk(value.dict);
    else if (value instanceof PDFDict) for (const [, child] of value.entries()) walk(child);
    else if (value instanceof PDFArray) value.asArray().forEach(walk);
  };
  walk(context.trailerInfo.Root);
  return seen;
}

/** The pages of `bytes`, alone in a new document, with nothing beside the drawing. Throws when a content stream or a JPEG cannot be read. */
export async function sanitize(bytes: Uint8Array, image: ImageAction = 'show'): Promise<Uint8Array> {
  const source = await PDFDocument.load(bytes, { updateMetadata: false });
  for (const page of source.getPages()) {
    for (const key of page.node.keys()) if (!PAGE_KEYS.has(key.toString())) page.node.delete(key);
  }
  const out = await PDFDocument.create({ updateMetadata: false });
  for (const page of await out.copyPages(source, source.getPageIndices())) out.addPage(page);
  const { context } = out;
  for (const [, object] of context.enumerateIndirectObjects()) scrub(object);
  pruneResources(out);
  for (const ref of contentStreams(out)) {
    const stream = context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) throw new Error('a page has content that is not a stream');
    const content = stripMarkedContentProperties(decodePDFRawStream(stream).decode());
    if (image !== 'show' && hasInlinePicture(content)) throw new Error('an inline picture cannot be replaced');
    const stripped = context.flateStream(content);
    for (const [key, value] of stream.dict.entries()) if (!STREAM_KEYS.has(key.toString())) stripped.dict.set(key, value);
    context.assign(ref, stripped);
  }
  applyImagePolicy(out, image);
  const keep = reachable(out);
  for (const [ref] of context.enumerateIndirectObjects()) if (!keep.has(ref.toString())) context.delete(ref);
  stripJpegs(out);
  return out.save({ useObjectStreams: false });
}
