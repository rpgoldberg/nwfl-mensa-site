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
// (content.ts). Objects nothing points at any more are deleted before saving.
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

const PAGE_KEYS = new Set(['/Type', '/Parent', '/Resources', '/Contents', '/MediaBox', '/CropBox', '/BleedBox', '/TrimBox', '/ArtBox', '/Rotate', '/UserUnit', '/Group']);
const DROP = ['Metadata', 'PieceInfo', 'AF', 'OPI', 'StructParent', 'StructParents', 'Properties', 'OC', 'Thumb', 'LastModified', 'Annots', 'AA'].map((key) => PDFName.of(key));
const STREAM_KEYS = new Set(['/Filter', '/DecodeParms', '/Length', '/DL']);

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

/** The pages of `bytes`, alone in a new document, with nothing beside the drawing. Throws when a content stream cannot be read. */
export async function sanitize(bytes: Uint8Array): Promise<Uint8Array> {
  const source = await PDFDocument.load(bytes, { updateMetadata: false });
  for (const page of source.getPages()) {
    for (const key of page.node.keys()) if (!PAGE_KEYS.has(key.toString())) page.node.delete(key);
  }
  const out = await PDFDocument.create({ updateMetadata: false });
  for (const page of await out.copyPages(source, source.getPageIndices())) out.addPage(page);
  const { context } = out;
  for (const [, object] of context.enumerateIndirectObjects()) scrub(object);
  for (const ref of contentStreams(out)) {
    const stream = context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) throw new Error('a page has content that is not a stream');
    const stripped = context.flateStream(stripMarkedContentProperties(decodePDFRawStream(stream).decode()));
    for (const [key, value] of stream.dict.entries()) if (!STREAM_KEYS.has(key.toString())) stripped.dict.set(key, value);
    context.assign(ref, stripped);
  }
  const keep = reachable(out);
  for (const [ref] of context.enumerateIndirectObjects()) if (!keep.has(ref.toString())) context.delete(ref);
  return out.save({ useObjectStreams: false });
}
