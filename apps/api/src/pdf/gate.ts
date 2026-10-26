// ============================================================================
// REDACT R3a fix 1: the output gate. Every redacted copy passes it before it
// is given, and it does not trust PDFium, which made the copy.
//
//   1. Another reader. pdf.js extracts each page's text twice: in the order
//      it is drawn, and by position (lines by baseline, words left to right,
//      so pieces drawn out of order read as they show).
//   2. Every object. Each string and name, in PDFDocEncoding or Latin-1,
//      UTF-16BE and UTF-16LE, and each stream decoded in full (Flate, LZW,
//      ASCIIHex, ASCII85, RunLength, any chain of them, PNG predictors).
//      The decoded bytes are read as Latin-1 (and as its printable ASCII
//      alone), Windows-1252 and UTF-16 either
//      way at either alignment, and as content: hex strings and escapes
//      decoded, kerning-split pieces joined, every string on its own line.
//      A JPEG is searched as it is. A filter it cannot decode means no copy.
//   3. The file as written, for anything outside the objects.
//
// A short quote (fewer than SHORT_QUOTE folded letters and digits, "Bo") is
// found by chance in picture samples and font programs, so those, and their
// bytes in the file as written, are searched only for the longer quotes.
// Their dictionaries, and everything else, are searched for every quote.
//
// Each text is matched as a page is (match.ts: folded, look-alikes, line
// breaks, hyphens, letter spacing). Any hit means no copy, with the reason.
// ============================================================================
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, type PDFObject, PDFRawStream, PDFString, decodePDFRawStream } from '@cantoo/pdf-lib';
import { probeFolded } from '../redaction/render.js';
import { textMatches } from './match.js';

// pdf.js is loaded on the first check, and on load it prints three lines in the image (HARDEN-1):
//   Warning: Cannot load "@napi-rs/canvas" package: ...
//   Warning: Cannot polyfill `DOMMatrix`, rendering may be broken.
//   Warning: Cannot polyfill `Path2D`, rendering may be broken.
// They are expected and harmless. The image leaves out the optional canvas (Dockerfile:
// --omit=optional, about 71 MB) because the gate never renders a page: it only reads text
// (getTextContent), which needs neither. pdf.js prints them while the module loads, before any
// option (verbosity) can reach it, so no setting silences them; installing the canvas would.
type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjs: Promise<PdfJs> | undefined;

const UNREADABLE = 'the copy could not be read';

/** The fewest folded letters and digits a quote needs before picture samples and font programs are searched for it. */
export const SHORT_QUOTE = 5;
/** A quote's folded letters and digits, counted. */
export const normalizedLength = (quote: string): number => (probeFolded(quote).match(/[\p{L}\p{N}]/gu) ?? []).length;
const FONT_FILES = ['FontFile', 'FontFile2', 'FontFile3'].map((key) => PDFName.of(key));
const IMAGE = PDFName.of('Image');
const DECODABLE = new Set(['/FlateDecode', '/LZWDecode', '/ASCIIHexDecode', '/ASCII85Decode', '/RunLengthDecode']);

interface Item {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  eol: boolean;
}

/** A page's text by position: lines top to bottom, words left to right, a space where there is a gap. */
function byPosition(items: readonly Item[]): string {
  const lines: Item[][] = [];
  for (const item of [...items].filter((i) => i.str.trim() !== '').sort((a, b) => b.y - a.y)) {
    const line = lines.at(-1);
    if (line !== undefined && Math.abs((line[0] as Item).y - item.y) < Math.max(1, 0.3 * item.height)) line.push(item);
    else lines.push([item]);
  }
  return lines
    .map((line) => {
      let out = '';
      let end = -Infinity;
      for (const item of line.sort((a, b) => a.x - b.x)) {
        out += (item.x - end > 0.2 * Math.max(1, item.height) ? ' ' : '') + item.str;
        end = item.x + item.width;
      }
      return out;
    })
    .join('\n');
}

/** Why pdf.js can read a quote on a page, or null. Throws when pdf.js cannot open the copy. */
async function readerFinds(pdf: Uint8Array, quotes: readonly string[]): Promise<string | null> {
  const { getDocument } = await (pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs'));
  const task = getDocument({ data: new Uint8Array(pdf), verbosity: 0, disableFontFace: true });
  try {
    const doc = await task.promise;
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      const items = content.items.flatMap((item): Item[] =>
        'str' in item ? [{ str: item.str, x: item.transform[4] as number, y: item.transform[5] as number, width: item.width, height: item.height, eol: item.hasEOL }] : [],
      );
      const drawn = items.map((item) => item.str + (item.eol ? '\n' : ' ')).join('');
      if (textMatches(drawn, quotes) || textMatches(byPosition(items), quotes)) return `page ${n}: withheld text can still be read by another reader`;
    }
    return null;
  } finally {
    await task.destroy();
  }
}

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');
const CP1252 = new TextDecoder('windows-1252');
const UTF16BE = new TextDecoder('utf-16be');
const UTF16LE = new TextDecoder('utf-16le');

/** A string's bytes as text: as written (Latin-1), PDFDocEncoding or UTF-16BE with a BOM, and UTF-16 without one. */
function stringForms(value: PDFString | PDFHexString): string[] {
  const bytes = value.asBytes();
  return [latin1(bytes), value.decodeText(), UTF16BE.decode(bytes), UTF16LE.decode(bytes)];
}

/** Every string and name in an object (a stream's dictionary included), one per line. */
function stringsIn(object: PDFObject | undefined, out: string[] = []): string[] {
  if (object instanceof PDFString || object instanceof PDFHexString) out.push(...stringForms(object));
  else if (object instanceof PDFName) out.push(object.decodeText());
  else if (object instanceof PDFRawStream) stringsIn(object.dict, out);
  else if (object instanceof PDFDict) {
    for (const [key, value] of object.entries()) {
      out.push(key.decodeText());
      stringsIn(value, out);
    }
  } else if (object instanceof PDFArray) for (const value of object.asArray()) stringsIn(value, out);
  return out;
}

/** PNG predictor rows undone (a filter byte, then the row). Throws on a row filter it does not know. */
function unpredict(bytes: Uint8Array, parms: PDFDict): Uint8Array {
  const num = (key: string, fallback: number): number => {
    const value = parms.lookup(PDFName.of(key));
    return value instanceof PDFNumber ? value.asNumber() : fallback;
  };
  const bits = num('Colors', 1) * num('BitsPerComponent', 8);
  const bpp = Math.max(1, Math.ceil(bits / 8));
  const width = Math.ceil((bits * num('Columns', 1)) / 8);
  const out = new Uint8Array(Math.floor(bytes.length / (width + 1)) * width);
  for (let row = 0; (row + 1) * (width + 1) <= bytes.length; row++) {
    const filter = bytes[row * (width + 1)] as number;
    for (let k = 0; k < width; k++) {
      const raw = bytes[row * (width + 1) + 1 + k] as number;
      const at = row * width + k;
      const left = k >= bpp ? (out[at - bpp] as number) : 0;
      const up = row > 0 ? (out[at - width] as number) : 0;
      const upLeft = row > 0 && k >= bpp ? (out[at - width - bpp] as number) : 0;
      const p = left + up - upLeft;
      const paeth = Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - upLeft) ? left : Math.abs(p - up) <= Math.abs(p - upLeft) ? up : upLeft;
      const predicted = [0, left, up, (left + up) >> 1, paeth][filter];
      if (predicted === undefined) throw new Error('unknown PNG row filter');
      out[at] = (raw + predicted) & 0xff;
    }
  }
  return out;
}

/** A stream's bytes, decoded but for a JPEG (searched as it is), or why it cannot be checked. */
function decoded(stream: PDFRawStream): Uint8Array | string {
  const { dict } = stream;
  const filter = dict.lookup(PDFName.of('Filter'));
  const parms = dict.lookup(PDFName.of('DecodeParms'));
  const filters = filter instanceof PDFArray ? filter.asArray().map((f) => dict.context.lookup(f)) : filter === undefined ? [] : [filter];
  const parmsList = parms instanceof PDFArray ? parms.asArray().map((p) => dict.context.lookup(p)) : [parms];
  const names = filters.map((f) => (f instanceof PDFName ? f.toString() : String(f)));
  if (names.at(-1) === '/DCTDecode') names.pop();
  const unknown = names.find((name) => !DECODABLE.has(name));
  if (unknown !== undefined) return `a stream uses a filter that cannot be checked (${unknown})`;
  if (names.length === 0) return stream.contents;
  try {
    const chain = dict.clone();
    chain.set(PDFName.of('Filter'), dict.context.obj(names.map((name) => PDFName.of(name.slice(1)))));
    chain.delete(PDFName.of('DecodeParms'));
    let bytes = decodePDFRawStream(PDFRawStream.of(chain, stream.contents)).decode();
    // A predictor is only undone on the last filter; on any other, or a TIFF one, the bytes cannot be read.
    for (const [index, p] of parmsList.entries()) {
      const predictor = p instanceof PDFDict ? p.lookup(PDFName.of('Predictor')) : undefined;
      const value = predictor instanceof PDFNumber ? predictor.asNumber() : 1;
      if (value <= 1) continue;
      if (value < 10 || index !== names.length - 1) throw new Error('predictor');
      bytes = unpredict(bytes, p as PDFDict);
    }
    return bytes;
  } catch {
    return 'a stream cannot be decoded';
  }
}

const unescape = (value: string, dropParens: boolean): string =>
  value.replace(/\\([0-7]{1,3}|\r\n|[\s\S])|[()]/g, (whole, escaped: string | undefined) => {
    if (escaped === undefined) return dropParens ? '' : whole;
    if (/^[0-7]/.test(escaped)) return String.fromCharCode(parseInt(escaped, 8) & 0xff);
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\n': '', '\r': '', '\r\n': '' } as Record<string, string>)[escaped] ?? escaped;
  });

/** Decoded bytes as content: hex strings made literal, kerning-split pieces joined; then every string a line, and the whole unescaped. */
function contentForms(text: string): string[] {
  const literal = text
    .replace(/(?<!<)<([0-9A-Fa-f\s]*)>/g, (_whole, hex: string) => {
      const digits = hex.replace(/\s/g, '');
      return `(${Buffer.from(digits.length % 2 ? `${digits}0` : digits, 'hex').toString('latin1').replace(/[\\()]/g, '\\$&')})`;
    })
    .replace(/\)(?:\s*[-+]?[\d.]+)*\s*\(/g, '');
  const strings = [...literal.matchAll(/\((?:[^()\\]|\\[\s\S])*\)/g)].map((m) => {
    const value = unescape(m[0].slice(1, -1), false);
    return value.startsWith('\xfe\xff') ? UTF16BE.decode(Buffer.from(value.slice(2), 'latin1')) : value;
  });
  return [strings.join('\n'), unescape(literal, true)];
}

/** Every reading of decoded stream bytes. */
function streamForms(bytes: Uint8Array): string[] {
  const text = latin1(bytes);
  // Binary beside a name (a JPEG marker's 0xFF reads as a letter) must not hide it: everything else is a break.
  return [text, text.replace(/[^\x20-\x7e\t]/g, '\n'), CP1252.decode(bytes), UTF16BE.decode(bytes), UTF16BE.decode(bytes.subarray(1)), UTF16LE.decode(bytes), UTF16LE.decode(bytes.subarray(1)), ...contentForms(text)];
}

/** The picture XObjects and embedded font programs in the copy: bytes a short quote turns up in by chance. */
function binaryStreams(doc: PDFDocument): Set<PDFRawStream> {
  const out = new Set<PDFRawStream>();
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    const dict = object instanceof PDFRawStream ? object.dict : object instanceof PDFDict ? object : undefined;
    if (dict === undefined) continue;
    if (object instanceof PDFRawStream && dict.lookup(PDFName.of('Subtype')) === IMAGE) out.add(object);
    for (const key of FONT_FILES) {
      const program = dict.lookup(key);
      if (program instanceof PDFRawStream) out.add(program);
    }
  }
  return out;
}

/** The file as written with these streams' bytes blanked out. */
function without(pdf: Uint8Array, streams: Iterable<PDFRawStream>): Uint8Array {
  const out = Buffer.from(pdf);
  for (const stream of streams) {
    if (stream.contents.length === 0) continue;
    const at = out.indexOf(stream.contents);
    if (at >= 0) out.fill(0x0a, at, at + stream.contents.length);
  }
  return out;
}

/** Why a quote can be found in an object of the copy, or in its bytes; null when in none. */
function objectFinds(pdf: Uint8Array, doc: PDFDocument, quotes: readonly string[]): string | null {
  const long = quotes.filter((quote) => normalizedLength(quote) >= SHORT_QUOTE);
  const short = quotes.filter((quote) => !long.includes(quote));
  const binary = binaryStreams(doc);
  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    const where = `object ${ref.objectNumber}`;
    if (textMatches(stringsIn(object).join('\n'), quotes)) return `${where}: withheld text is still in the file`;
    if (!(object instanceof PDFRawStream)) continue;
    const bytes = decoded(object);
    if (typeof bytes === 'string') return `${where}: ${bytes}`;
    const searched = binary.has(object) ? long : quotes;
    if (streamForms(bytes).some((form) => textMatches(form, searched))) return `${where}: withheld text is still in the file`;
  }
  const found = streamForms(pdf).some((form) => textMatches(form, long)) || streamForms(without(pdf, binary)).some((form) => textMatches(form, short));
  return found ? 'withheld text is still in the file' : null;
}

/** Null when no quote can be found anywhere in the copy, else why it must not be given. */
export async function checkCopy(pdf: Uint8Array, quotes: readonly string[]): Promise<string | null> {
  if (quotes.length === 0) return null;
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdf, { updateMetadata: false, throwOnInvalidObject: true });
    const read = await readerFinds(pdf, quotes);
    if (read !== null) return read;
  } catch {
    return UNREADABLE;
  }
  return objectFinds(pdf, doc, quotes);
}
