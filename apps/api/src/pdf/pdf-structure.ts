// ============================================================================
// UNTRUSTED-PDF-GATE M1 (fix round 3): one reading of a copy's objects.
//
// pdf-lib, which the gate reads a copy's objects with, takes the objects in
// the order they are written, keeps the last definition of each number and
// ignores the xref; it takes /Root from the last trailer it meets. A viewer
// (pdf.js, pdfium) follows startxref, the xref and that trailer. So a copy
// that defines an object twice, or whose xref names another definition, can
// show a viewer what the gate never read.
//
// The load-bearing fix is in gate-rules.ts gateReply: the gate re-writes the
// copy from what pdf-lib read, checks those bytes, and only they are stored.
// This check is defence in depth, on the copy as handed over and again on the
// gate's own bytes. The sanitizer (sanitize.ts) writes with pdf-lib's writer,
// without object streams: one xref table, a trailer of /Size and /Root, one
// definition per object, each at the offset the xref gives. Anything else is
// refused before any rule is read:
//   - no single startxref naming an xref table that can be read; a trailer
//     with anything beside /Size and /Root (/Prev, /XRefStm, /Encrypt, /Info,
//     /ID...), or a /Root other than the one pdf-lib took;
//   - an object number written twice, anywhere in the bytes (stream data
//     included: a chance match there only refuses), or out of range;
//   - an xref entry that does not land on its object's definition, a
//     definition the xref does not list, an object pdf-lib holds that has no
//     definition at the top level, and any object or xref stream.
//
// BOXLABEL fix round 3 (R3-1): one reading of each name too (nameBreak).
// pdf-lib's parser decodes a name's #XX escapes twice (in either case, then
// PDFName.of again in upper case); pdf.js and PDFium decode once. So raw
// "/FXF#2332" is FXF2 to pdf-lib and FXF#32 to a viewer, and a key pdf-lib
// reads as FXF#32 comes out of its own writing as "/FXF#2332". A name that
// still holds '#' once decoded is the only way to either, and PDFium writes
// none of its own (its names are FXF<n> and the like; one an original holds,
// it carries through, so the engine refuses that original). So such a name is
// refused, as is a key written twice in one dictionary, wherever it is: key
// or value. A copy whose
// names cannot all be read is refused too (round 4, B1): one pdf-lib's parser
// cannot read to the end, or whose dictionaries and arrays nest past
// MAX_NAME_NESTING, a cap set well short of the stack.
// ============================================================================
import { type PDFArray, type PDFDict, PDFDocument, PDFName, type PDFObject, PDFParser, PDFRawStream, type PDFRef } from '@cantoo/pdf-lib';
import { decodedOnce } from './content.js';

/** The highest object number a PDF reader must take (ISO 32000, implementation limits). */
const MAX_OBJECT = 8_388_607;
const WS = '[\\0\\t\\n\\f\\r ]';
const HEADER = new RegExp(`(?<![0-9])([0-9]+)${WS}+([0-9]+)${WS}*obj`, 'g');
const STARTXREF = /startxref/g;
const TAIL = new RegExp(`startxref${WS}+([0-9]+)${WS}+%%EOF${WS}*$`);
const SUBSECTION = new RegExp(`${WS}+([0-9]+) +([0-9]+)`, 'y');
const ENTRY = new RegExp(`${WS}+([0-9]{10}) ([0-9]{5}) ([nf])`, 'y');
const TRAILER_KEYWORD = new RegExp(`${WS}*trailer`, 'y');
const TRAILER = new RegExp(`${WS}*trailer${WS}*<<((?:${WS}|/Size${WS}+[0-9]+|/Root${WS}+[0-9]+${WS}+[0-9]+${WS}+R)*)>>${WS}*`, 'y');
const ROOT = new RegExp(`/Root${WS}+([0-9]+)${WS}+([0-9]+)${WS}+R`, 'g');

interface Place {
  gen: number;
  at: number;
}

/** The xref table at `at`: its in-use entries by number, and where its trailer ends; a string when it cannot be read. */
function xrefTable(text: string, at: number): { entries: Map<number, Place>; root: string; end: number } | string {
  if (!text.startsWith('xref', at)) return 'it has no xref table where startxref points';
  const entries = new Map<number, Place>();
  let cursor = at + 4;
  for (;;) {
    SUBSECTION.lastIndex = cursor;
    const head = SUBSECTION.exec(text);
    if (head === null) break;
    cursor = SUBSECTION.lastIndex;
    const first = Number(head[1]);
    const count = Number(head[2]);
    for (let n = first; n < first + count; n++) {
      ENTRY.lastIndex = cursor;
      const entry = ENTRY.exec(text);
      if (entry === null) return 'its xref table cannot be read';
      cursor = ENTRY.lastIndex;
      if (entry[3] === 'n') {
        if (entries.has(n)) return `its xref lists object ${n} twice`;
        entries.set(n, { at: Number(entry[1]), gen: Number(entry[2]) });
      }
    }
  }
  TRAILER_KEYWORD.lastIndex = cursor;
  if (!TRAILER_KEYWORD.test(text)) return 'its xref table cannot be read';
  TRAILER.lastIndex = cursor;
  const trailer = TRAILER.exec(text);
  if (trailer === null) return 'its trailer has more than /Size and /Root';
  const roots = [...(trailer[1] as string).matchAll(ROOT)];
  if (roots.length !== 1) return 'its trailer has more than /Size and /Root';
  const [, number, gen] = roots[0] as RegExpMatchArray;
  return { entries, root: `${Number(number)} ${Number(gen)} R`, end: TRAILER.lastIndex };
}

/** Each object definition in the bytes, by number; a string when a number is written twice or is out of range. */
function definitions(text: string): Map<number, Place> | string {
  const found = new Map<number, Place>();
  for (const match of text.matchAll(HEADER)) {
    const [, digits, gen] = match as unknown as [string, string, string];
    const n = digits.length > 7 ? Infinity : Number(digits);
    if (n > MAX_OBJECT || gen.length > 5 || Number(gen) > 65_535) return 'an object number is out of range';
    if (found.has(n)) return `object ${n} is defined more than once`;
    found.set(n, { at: match.index, gen: Number(gen) });
  }
  return found;
}

/** Why the copy's objects could read one way to the gate and another to a viewer, or null. */
export async function structureBreak(bytes: Uint8Array): Promise<string | null> {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  const marks = text.match(STARTXREF)?.length ?? 0;
  if (marks > 1) return 'it has more than one xref section';
  const tail = TAIL.exec(text);
  if (marks === 0 || tail === null) return 'it has no xref table where startxref points';
  const table = xrefTable(text, Number(tail[1]));
  if (typeof table === 'string') return table;
  if (table.end !== tail.index) return 'it has more than one xref section';
  const defined = definitions(text);
  if (typeof defined === 'string') return defined;
  for (const [n, place] of defined) {
    const listed = table.entries.get(n);
    if (listed === undefined) return `object ${n} is not in the xref`;
    if (listed.at !== place.at || listed.gen !== place.gen) return `the xref entry for object ${n} does not land on it`;
  }
  for (const n of table.entries.keys()) if (!defined.has(n)) return `the xref entry for object ${n} does not land on it`;
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: true });
  } catch {
    return 'it cannot be read';
  }
  const { context } = doc;
  const read = context.enumerateIndirectObjects();
  for (const [, object] of read) {
    const type = object instanceof PDFRawStream ? object.dict.lookup(PDFName.of('Type')) : undefined;
    if (type === PDFName.of('ObjStm') || type === PDFName.of('XRef')) return 'it has an object stream or an xref stream';
  }
  for (const [ref] of read) {
    if (defined.get(ref.objectNumber)?.gen !== ref.generationNumber) return `object ${ref.objectNumber} is not defined at the top level`;
  }
  if (read.length !== defined.size) return 'pdf-lib does not read every definition';
  const { Root, Encrypt, Info, ID } = context.trailerInfo;
  if (Root?.toString() !== table.root || Encrypt !== undefined || Info !== undefined || ID !== undefined) return 'pdf-lib takes another trailer';
  return null;
}

/** The deepest a copy's dictionaries and arrays may nest, together, for nameBreak to read it (round 4, B1). */
export const MAX_NAME_NESTING = 256;
/** nameBreak's reason for a copy nested past MAX_NAME_NESTING, which pdf-lib's own load may still read. */
export const NAMES_NESTED = 'the names cannot all be read: dictionaries and arrays nest too deep';
/** nameBreak's reason for a copy pdf-lib's parser cannot read to the end, which pdf-lib's own load cannot read either. */
export const NAMES_UNPARSED = 'the names cannot all be read';

/**
 * pdf-lib's own parser, which also notes the first name that still holds '#' once decoded (pdf-lib decodes it again)
 * and the first key written twice in one dictionary. A name parsed while no value of the innermost dictionary is being
 * parsed is one of its keys. It stops (throws) past MAX_NAME_NESTING levels of dictionaries and arrays, well before
 * its own frames could run out of stack: where it stops depends on no stack size.
 */
class NameReading extends PDFParser {
  broken: string | null = null;
  private readonly source: Uint8Array;
  private readonly dicts: Array<{ keys: Set<PDFName>; values: number }> = [];
  private depth = 0;

  constructor(bytes: Uint8Array) {
    super(bytes, Infinity, true);
    this.source = bytes;
  }

  protected override parseName(): PDFName {
    const start = this.bytes.offset() + 1;
    const name = super.parseName();
    const raw = Buffer.from(this.source.buffer, this.source.byteOffset + start, this.bytes.offset() - start).toString('latin1');
    const dict = this.dicts.at(-1);
    // The reasons name no name: an engine's reaches an officer, and a name is the original's bytes.
    if (decodedOnce(raw).includes('#')) this.broken ??= 'a name holds "#" once decoded, so pdf-lib reads it apart from pdf.js and PDFium';
    else if (dict !== undefined && dict.values === 0) {
      if (dict.keys.has(name)) this.broken ??= 'a dictionary has a key twice';
      dict.keys.add(name);
    }
    return name;
  }

  /** `parse` one level deeper; past the cap, a throw (pdf-lib turns it into its own, so the reason is noted first). */
  private nested<T>(parse: () => T): T {
    if (this.depth >= MAX_NAME_NESTING) {
      this.broken ??= NAMES_NESTED;
      throw new Error(NAMES_NESTED);
    }
    this.depth += 1;
    try {
      return parse();
    } finally {
      this.depth -= 1;
    }
  }

  protected override parseArray(ref?: PDFRef): PDFArray {
    return this.nested(() => super.parseArray(ref));
  }

  protected override parseDict(ref?: PDFRef): PDFDict {
    return this.nested(() => {
      this.dicts.push({ keys: new Set(), values: 0 });
      try {
        return super.parseDict(ref);
      } finally {
        this.dicts.pop();
      }
    });
  }

  override parseObject(ref?: PDFRef): PDFObject {
    const dict = this.dicts.at(-1);
    if (dict !== undefined) dict.values += 1;
    try {
      return super.parseObject(ref);
    } finally {
      if (dict !== undefined) dict.values -= 1;
    }
  }
}

/**
 * Why a name in the copy's objects reads one way to pdf-lib and another to pdf.js and PDFium, or could after pdf-lib
 * writes it again (see the header), or null. It fails closed (round 4, B1): a copy whose names cannot all be read is
 * refused, with the first break found before the point it stops if there is one, else NAMES_NESTED (nested past
 * MAX_NAME_NESTING) or NAMES_UNPARSED (pdf-lib's parser cannot read it to the end). Null only for a copy read to the end.
 */
export async function nameBreak(bytes: Uint8Array): Promise<string | null> {
  const reading = new NameReading(bytes);
  try {
    await reading.parseDocument();
  } catch {
    return reading.broken ?? NAMES_UNPARSED;
  }
  return reading.broken;
}
