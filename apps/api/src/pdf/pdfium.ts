// ============================================================================
// REDACT R3a: PDFium (EmbedPDF's WebAssembly build: MIT wrapper, PDFium
// BSD-3-Clause/Apache-2.0) behind the few calls the redaction needs.
//
// One module per process, loaded on first use from the package's own wasm
// file (no network, nothing written to disk). PDFium is not re-entrant, and
// every call here is synchronous, so one document is worked at a time.
// ============================================================================
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { type WrappedPdfiumModule, init } from '@embedpdf/pdfium';
import { type BoxKind, LABEL_EMS, MIN_LABEL_PT, isLabel, labelFor } from './labels.js';
import type { Box, PageChar, Region, TextObject } from './match.js';

type Module = WrappedPdfiumModule;

/** The Emscripten runtime the wrapper exposes (its own typings leave it unresolved). */
interface Runtime {
  readonly HEAPU8: Uint8Array;
  wasmExports: { malloc(size: number): number; free(pointer: number): void };
  stringToUTF16(value: string, pointer: number, maxBytes: number): number;
}

/** Read afresh on every use: the heap is replaced when wasm memory grows. */
const rt = (m: Module): Runtime => m.pdfium as unknown as Runtime;

let loading: Promise<Module> | undefined;

export function pdfium(): Promise<Module> {
  loading ??= (async () => {
    const entry = createRequire(import.meta.url).resolve('@embedpdf/pdfium');
    const wasmBinary = await readFile(join(dirname(entry), 'pdfium.wasm'));
    const module = await init({ wasmBinary: wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength) });
    module.PDFiumExt_Init();
    return module;
  })();
  return loading;
}

const FLAT_NORMALDISPLAY = 0;
const FPDF_PAGEOBJ_TEXT = 1;
const FPDF_PAGEOBJ_IMAGE = 3;
const FPDF_PAGEOBJ_FORM = 5;
const FPDF_FILLMODE_ALTERNATE = 1;
/** Text render modes 4 to 7 add the glyphs to the clipping path (PDF 32000-1, 9.3.6). */
const FPDF_TEXTRENDERMODE_FILL_CLIP = 4;
/** Text render mode 0: the glyphs filled, as the labels are drawn. */
const FPDF_TEXTRENDERMODE_FILL = 0;
const FPDF_PAGEOBJ_PATH = 2;

/** A PDF matrix [a b c d e f]: (x, y) goes to (a x + c y + e, b x + d y + f). */
type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `first`, then `then`. */
const times = ([a, b, c, d, e, f]: Matrix, [A, B, C, D, E, F]: Matrix): Matrix => [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F];

/** The box around a box's corners carried by a matrix. */
function transformed(box: Box, [a, b, c, d, e, f]: Matrix): Box {
  const corners = [
    [box.left, box.bottom],
    [box.left, box.top],
    [box.right, box.bottom],
    [box.right, box.top],
  ].map(([x = 0, y = 0]) => [a * x + c * y + e, b * x + d * y + f] as const);
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  return { left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys), top: Math.max(...ys) };
}

/** An open document: the bytes stay in wasm memory until it is closed. */
export class Document {
  private constructor(
    private readonly m: Module,
    readonly handle: number,
    private readonly buffer: number,
  ) {}

  static open(m: Module, bytes: Uint8Array): Document | null {
    const buffer = rt(m).wasmExports.malloc(Math.max(1, bytes.length));
    rt(m).HEAPU8.set(bytes, buffer);
    const handle = m.FPDF_LoadMemDocument(buffer, bytes.length, '');
    if (handle === 0) {
      rt(m).wasmExports.free(buffer);
      return null;
    }
    return new Document(m, handle, buffer);
  }

  get pageCount(): number {
    return this.m.FPDF_GetPageCount(this.handle);
  }

  /** Runs `work` on page `index` (0-based), then closes the page. */
  page<T>(index: number, work: (page: Page) => T): T {
    const handle = this.m.FPDF_LoadPage(this.handle, index);
    try {
      return work(new Page(this.m, this, handle));
    } finally {
      this.m.FPDF_ClosePage(handle);
    }
  }

  /** Annotations and form fields drawn into the page, as a viewer shows them on screen. */
  flatten(index: number): void {
    this.page(index, (page) => this.m.FPDFPage_Flatten(page.handle, FLAT_NORMALDISPLAY));
  }

  /** The whole document, written anew (not as an incremental update). */
  save(): Uint8Array {
    const m = this.m;
    const writer = m.PDFiumExt_OpenFileWriter();
    try {
      m.PDFiumExt_SaveAsCopy(this.handle, writer);
      const size = m.PDFiumExt_GetFileWriterSize(writer);
      const out = rt(m).wasmExports.malloc(size);
      try {
        m.PDFiumExt_GetFileWriterData(writer, out, size);
        return rt(m).HEAPU8.slice(out, out + size);
      } finally {
        rt(m).wasmExports.free(out);
      }
    } finally {
      m.PDFiumExt_CloseFileWriter(writer);
    }
  }

  close(): void {
    this.m.FPDF_CloseDocument(this.handle);
    rt(this.m).wasmExports.free(this.buffer);
  }
}

export class Page {
  constructor(
    private readonly m: Module,
    private readonly doc: Document,
    readonly handle: number,
  ) {}

  get objectCount(): number {
    return this.m.FPDFPage_CountObjects(this.handle);
  }

  get width(): number {
    return this.m.FPDF_GetPageWidthF(this.handle);
  }

  get height(): number {
    return this.m.FPDF_GetPageHeightF(this.handle);
  }

  /** The bounds of every picture drawn directly on the page. */
  pictures(): Box[] {
    return this.bounds(true);
  }

  /** The bounds, in page space, of every picture the page draws, on the page or in a form XObject at any depth (LINKS L3 fix 1, S1). */
  allPictures(): Box[] {
    const m = this.m;
    const out: Box[] = [];
    // FS_RECTF's four floats (FPDFPageObj_GetBounds), then FS_MATRIX's six.
    const at = rt(m).wasmExports.malloc(40);
    try {
      const pending: Array<[number, Matrix]> = [];
      for (let i = 0; i < this.objectCount; i++) pending.push([m.FPDFPage_GetObject(this.handle, i), IDENTITY]);
      for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        const [object, matrix] = next;
        const type = m.FPDFPageObj_GetType(object);
        if (type === FPDF_PAGEOBJ_IMAGE) {
          m.FPDFPageObj_GetBounds(object, at, at + 4, at + 8, at + 12);
          const [left = 0, bottom = 0, right = 0, top = 0] = new Float32Array(rt(m).HEAPU8.buffer, at, 4);
          out.push(transformed({ left, bottom, right, top }, matrix));
        } else if (type === FPDF_PAGEOBJ_FORM) {
          m.FPDFPageObj_GetMatrix(object, at + 16);
          const inner = [...new Float32Array(rt(m).HEAPU8.buffer, at + 16, 6)] as Matrix;
          for (let i = 0; i < m.FPDFFormObj_CountObjects(object); i++) pending.push([m.FPDFFormObj_GetObject(object, i), times(inner, matrix)]);
        }
      }
    } finally {
      rt(m).wasmExports.free(at);
    }
    return out;
  }

  /** The bounds of every object drawn directly on the page, or of its pictures only. */
  bounds(picturesOnly = false): Box[] {
    const m = this.m;
    const out: Box[] = [];
    const at = rt(m).wasmExports.malloc(16);
    try {
      for (let i = 0; i < this.objectCount; i++) {
        const object = m.FPDFPage_GetObject(this.handle, i);
        if (picturesOnly && m.FPDFPageObj_GetType(object) !== FPDF_PAGEOBJ_IMAGE) continue;
        m.FPDFPageObj_GetBounds(object, at, at + 4, at + 8, at + 12);
        const [left = 0, bottom = 0, right = 0, top = 0] = new Float32Array(rt(m).HEAPU8.buffer, at, 4);
        out.push({ left, bottom, right, top });
      }
    } finally {
      rt(m).wasmExports.free(at);
    }
    return out;
  }

  /**
   * The page's characters, as PDFium extracts them; `unmapped` counts characters with no Unicode
   * value. A character's type size is the font's size scaled by its matrix's vertical axis, so text
   * set at 1 pt and scaled to 12 pt reads as 12 pt.
   */
  chars(): { chars: PageChar[]; unmapped: number } {
    const m = this.m;
    const text = m.FPDFText_LoadPage(this.handle);
    // FS_RECTF (16 bytes), four doubles (32) and FS_MATRIX (24).
    const at = rt(m).wasmExports.malloc(72);
    const chars: PageChar[] = [];
    let unmapped = 0;
    try {
      const count = m.FPDFText_CountChars(text);
      for (let i = 0; i < count; i++) {
        const code = m.FPDFText_GetUnicode(text, i);
        if (m.FPDFText_HasUnicodeMapError(text, i) === 1) unmapped += 1;
        const placed = m.FPDFText_GetLooseCharBox(text, i, at);
        // FS_RECTF: left, top, right, bottom.
        const [left = NaN, top = NaN, right = NaN, bottom = NaN] = new Float32Array(rt(m).HEAPU8.buffer, at, 4);
        const box = placed && [left, top, right, bottom].every(Number.isFinite) && right > left && top > bottom ? { left, right, bottom, top } : null;
        chars.push({
          text: code > 0x10ffff ? '�' : String.fromCodePoint(code),
          generated: m.FPDFText_IsGenerated(text, i) === 1,
          hyphen: m.FPDFText_IsHyphen(text, i) === 1,
          box,
          ink: this.ink(text, i, at + 16),
          fontSize: m.FPDFText_GetFontSize(text, i) * this.scale(text, i, at + 48),
        });
      }
    } finally {
      rt(m).wasmExports.free(at);
      m.FPDFText_ClosePage(text);
    }
    return { chars, unmapped };
  }

  /**
   * Whether any text on the page, form XObjects included, is drawn as a clip (render mode 4 to 7).
   * PDFium's rewrite of a page (removeText, drawBoxes) wraps each text object in q ... Q, so such a
   * clip would end with its text object, and what it clipped would be drawn unclipped.
   */
  hasClipText(): boolean {
    const m = this.m;
    const pending: number[] = [];
    for (let i = 0; i < this.objectCount; i++) pending.push(m.FPDFPage_GetObject(this.handle, i));
    for (let object = pending.pop(); object !== undefined; object = pending.pop()) {
      const type = m.FPDFPageObj_GetType(object);
      if (type === FPDF_PAGEOBJ_TEXT && m.FPDFTextObj_GetTextRenderMode(object) >= FPDF_TEXTRENDERMODE_FILL_CLIP) return true;
      if (type === FPDF_PAGEOBJ_FORM) for (let i = 0; i < m.FPDFFormObj_CountObjects(object); i++) pending.push(m.FPDFFormObj_GetObject(object, i));
    }
    return false;
  }

  /**
   * Every text object the page draws, on the page or in a form XObject at any depth, with its bounds in
   * page space and the characters of the page's reading (chars(), in its order) that PDFium took from it.
   */
  textObjects(): TextObject[] {
    const m = this.m;
    const objects: Array<{ bounds: Box; chars: number[] }> = [];
    const index = new Map<number, number>();
    // FS_RECTF's four floats (FPDFPageObj_GetBounds), then FS_MATRIX's six.
    const at = rt(m).wasmExports.malloc(40);
    try {
      const pending: Array<[number, Matrix]> = [];
      for (let i = 0; i < this.objectCount; i++) pending.push([m.FPDFPage_GetObject(this.handle, i), IDENTITY]);
      for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        const [object, matrix] = next;
        const type = m.FPDFPageObj_GetType(object);
        if (type === FPDF_PAGEOBJ_TEXT) {
          m.FPDFPageObj_GetBounds(object, at, at + 4, at + 8, at + 12);
          const [left = 0, bottom = 0, right = 0, top = 0] = new Float32Array(rt(m).HEAPU8.buffer, at, 4);
          index.set(object, objects.length);
          objects.push({ bounds: transformed({ left, bottom, right, top }, matrix), chars: [] });
        } else if (type === FPDF_PAGEOBJ_FORM) {
          m.FPDFPageObj_GetMatrix(object, at + 16);
          const inner = [...new Float32Array(rt(m).HEAPU8.buffer, at + 16, 6)] as Matrix;
          for (let i = 0; i < m.FPDFFormObj_CountObjects(object); i++) pending.push([m.FPDFFormObj_GetObject(object, i), times(inner, matrix)]);
        }
      }
    } finally {
      rt(m).wasmExports.free(at);
    }
    const text = m.FPDFText_LoadPage(this.handle);
    try {
      for (let i = 0; i < m.FPDFText_CountChars(text); i++) objects[index.get(m.FPDFText_GetTextObject(text, i)) ?? -1]?.chars.push(i);
    } finally {
      m.FPDFText_ClosePage(text);
    }
    return objects;
  }

  /** A character's tight box (FPDFText_GetCharBox, the box PDFium's removal tests), or null. */
  private ink(text: number, i: number, at: number): Box | null {
    const placed = this.m.FPDFText_GetCharBox(text, i, at, at + 8, at + 16, at + 24);
    const [left = NaN, right = NaN, bottom = NaN, top = NaN] = new Float64Array(rt(this.m).HEAPU8.buffer, at, 4);
    return placed && [left, right, bottom, top].every(Number.isFinite) && right >= left && top >= bottom ? { left, right, bottom, top } : null;
  }

  /** How much a character's matrix scales its type vertically (1 when it cannot be read). */
  private scale(text: number, i: number, at: number): number {
    if (!this.m.FPDFText_GetMatrix(text, i, at)) return 1;
    const [, , c = 0, d = 1] = new Float32Array(rt(this.m).HEAPU8.buffer, at, 4);
    const scale = Math.hypot(c, d);
    return Number.isFinite(scale) && scale > 0 ? scale : 1;
  }

  /** Removes every glyph the regions touch from the page's content, form XObjects included. */
  removeText(regions: readonly Region[]): boolean {
    const m = this.m;
    const at = rt(m).wasmExports.malloc(32 * regions.length);
    try {
      // FS_QUADPOINTSF, in the order EmbedPDF's engine writes it: top-left, top-right, bottom-left, bottom-right.
      const quads = regions.flatMap(({ left, right, bottom, top }) => [left, top, right, top, left, bottom, right, bottom]);
      new Float32Array(rt(m).HEAPU8.buffer, at, quads.length).set(quads);
      const removed = m.EPDFText_RedactInQuads(this.handle, at, regions.length, true, false);
      return m.FPDFPage_GenerateContent(this.handle) && removed;
    } finally {
      rt(m).wasmExports.free(at);
    }
  }

  /**
   * Rewrites the page's content from its objects: PDFium writes each inline picture as a picture
   * XObject. It rewrites only a stream with a changed object, so each picture is first moved by
   * the identity, which changes nothing it draws.
   */
  regenerate(): boolean {
    const m = this.m;
    for (let i = 0; i < this.objectCount; i++) {
      const object = m.FPDFPage_GetObject(this.handle, i);
      if (m.FPDFPageObj_GetType(object) === FPDF_PAGEOBJ_IMAGE) m.FPDFPageObj_Transform(object, 1, 0, 0, 1, 0, 0);
    }
    return m.FPDFPage_GenerateContent(this.handle);
  }

  /**
   * An opaque box over each region, labelled by its kind (labels.ts labelFor: "Members Only", "Mbrs Only" or
   * "Private") in white Helvetica, centred, where a label fits. `kinds[i]` is region i's; "private" when absent.
   * The labels go on after every box, so no box is drawn over another's label.
   */
  drawBoxes(regions: readonly Region[], kinds: readonly BoxKind[] = []): void {
    const m = this.m;
    for (const { left, right, bottom, top } of regions) {
      const box = m.FPDFPageObj_CreateNewRect(left, bottom, right - left, top - bottom);
      m.FPDFPageObj_SetFillColor(box, 0, 0, 0, 255);
      m.FPDFPath_SetDrawMode(box, FPDF_FILLMODE_ALTERNATE, false);
      m.FPDFPage_InsertObject(this.handle, box);
    }
    regions.forEach((region, i) => {
      const { left, right, bottom, top } = region;
      const found = labelFor(region, kinds[i] ?? 'private');
      if (found === null) return;
      const { text: string, size } = found;
      const label = m.FPDFPageObj_NewTextObj(this.doc.handle, 'Helvetica', size);
      const bytes = (string.length + 1) * 2;
      const text = rt(m).wasmExports.malloc(bytes);
      rt(m).stringToUTF16(string, text, bytes);
      m.FPDFText_SetText(label, text);
      rt(m).wasmExports.free(text);
      m.FPDFPageObj_SetFillColor(label, 255, 255, 255, 255);
      m.FPDFPageObj_Transform(label, 1, 0, 0, 1, left + (right - left - LABEL_EMS[string] * size) / 2, bottom + (top - bottom - 0.7 * size) / 2);
      m.FPDFPage_InsertObject(this.handle, label);
    });
    m.FPDFPage_GenerateContent(this.handle);
  }

  /**
   * What the label check reads of the page (gate-labels.ts): each object drawn directly on the page, in drawing
   * order, as a box, a lettering or anything else; how many text objects in a form XObject, at any depth, read as a
   * label in the labels' font and colour; and, for each character of the page's reading (chars(), in its order), the
   * text object it was read from and the place in the drawing order of the page's object that draws it.
   *
   * A box is a path in the boxes' style: one rectangle (drawn round and closed, as "re" draws it), filled even-odd,
   * not stroked, opaque black, drawn at the identity. A lettering is a text object in the labels' font and colour (white, non-embedded Helvetica), with the
   * text the page's reading gives it (no character PDFium makes up), and `styled` when it is in the labels' style
   * besides (glyphs filled, opaque, moved but not scaled or turned, at least MIN_LABEL_PT).
   */
  labelReading(): LabelReading {
    const m = this.m;
    const top: PageMark[] = [];
    let nested = 0;
    const text = m.FPDFText_LoadPage(this.handle);
    // Fill colour (4 u32), FS_MATRIX (6 floats), FS_RECTF (4 floats), a float, two ints, a name, and a point.
    const at = rt(m).wasmExports.malloc(256);
    try {
      const u32 = (offset: number, n: number): number[] => [...new Uint32Array(rt(m).HEAPU8.buffer, at + offset, n)];
      const f32 = (offset: number, n: number): number[] => [...new Float32Array(rt(m).HEAPU8.buffer, at + offset, n)];
      const filled = (object: number): number[] => (m.FPDFPageObj_GetFillColor(object, at, at + 4, at + 8, at + 12) ? u32(0, 4) : []);
      const matrix = (object: number): number[] => (m.FPDFPageObj_GetMatrix(object, at + 16) ? f32(16, 6) : []);
      const same = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
      const bounds = (object: number): Box => {
        m.FPDFPageObj_GetBounds(object, at + 40, at + 44, at + 48, at + 52);
        const [left = 0, bottom = 0, right = 0, top = 0] = f32(40, 4);
        return { left, bottom, right, top };
      };
      // Each text object's glyphs as the page's reading gives them (none PDFium makes up, such as the space it reads
      // after a text object), and each glyph's object.
      const owners: number[] = [];
      const written = new Map<number, string>();
      for (let i = 0; i < m.FPDFText_CountChars(text); i++) {
        const owner = m.FPDFText_GetTextObject(text, i);
        owners.push(owner);
        if (m.FPDFText_IsGenerated(text, i) === 1) continue;
        const code = m.FPDFText_GetUnicode(text, i);
        const sofar = written.get(owner) ?? '';
        if (sofar.length <= 16) written.set(owner, sofar + (code > 0x10ffff ? '\ufffd' : String.fromCodePoint(code)));
      }
      /** Whether a text object is in the labels' font and colour: white, non-embedded Helvetica. */
      const lettered = (object: number): boolean => {
        if (!same(filled(object), [255, 255, 255, 255])) return false;
        const font = m.FPDFTextObj_GetFont(object);
        if (font === 0 || m.FPDFFont_GetIsEmbedded(font) !== 0) return false;
        const length = m.FPDFFont_GetBaseFontName(font, at + 64, 64);
        return length === 10 && Buffer.from(rt(m).HEAPU8.subarray(at + 64, at + 73)).toString('latin1') === 'Helvetica';
      };
      const fontSize = (object: number): number => (m.FPDFTextObj_GetFontSize(object, at + 56) ? (f32(56, 1)[0] as number) : 0);
      const isBox = (object: number): boolean => {
        if (!same(filled(object), [0, 0, 0, 255]) || m.FPDFPageObj_HasTransparency(object) || !same(matrix(object), [1, 0, 0, 1, 0, 0])) return false;
        if (!m.FPDFPath_GetDrawMode(object, at + 60, at + 64) || !same([...new Int32Array(rt(m).HEAPU8.buffer, at + 60, 2)], [FPDF_FILLMODE_ALTERNATE, 0])) return false;
        return m.FPDFPath_CountSegments(object) === 5 && rectangle(m, object, bounds(object), at + 128);
      };
      // The place in the drawing order of the page's object that draws each text object, in a form at any depth too.
      const placeOf = new Map<number, number>();
      const pending: Array<[number, number]> = [];
      for (let i = 0; i < this.objectCount; i++) {
        const object = m.FPDFPage_GetObject(this.handle, i);
        const type = m.FPDFPageObj_GetType(object);
        placeOf.set(object, i);
        if (type === FPDF_PAGEOBJ_TEXT && lettered(object)) {
          const [a, b, c, d, e = 0, f = 0] = matrix(object);
          const styled = a === 1 && b === 0 && c === 0 && d === 1 && m.FPDFTextObj_GetTextRenderMode(object) === FPDF_TEXTRENDERMODE_FILL && !m.FPDFPageObj_HasTransparency(object) && fontSize(object) >= MIN_LABEL_FLOOR;
          top.push({ kind: 'lettering', object, text: written.get(object) ?? '', styled, x: e, y: f, bounds: bounds(object) });
        } else if (type === FPDF_PAGEOBJ_PATH && isBox(object)) top.push({ kind: 'box', object, bounds: bounds(object) });
        else top.push({ kind: 'other', object });
        if (type === FPDF_PAGEOBJ_FORM) for (let k = 0; k < m.FPDFFormObj_CountObjects(object); k++) pending.push([m.FPDFFormObj_GetObject(object, k), i]);
      }
      for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        const [object, place] = next;
        const type = m.FPDFPageObj_GetType(object);
        placeOf.set(object, place);
        if (type === FPDF_PAGEOBJ_TEXT && lettered(object) && isLabel(written.get(object) ?? '')) nested += 1;
        if (type === FPDF_PAGEOBJ_FORM) for (let k = 0; k < m.FPDFFormObj_CountObjects(object); k++) pending.push([m.FPDFFormObj_GetObject(object, k), place]);
      }
      return { top, nested, owners, places: owners.map((owner) => placeOf.get(owner) ?? -1) };
    } finally {
      rt(m).wasmExports.free(at);
      m.FPDFText_ClosePage(text);
    }
  }
}

/** The smallest label size taken as the labels' style: MIN_LABEL_PT, less what a float written and read again loses. */
const MIN_LABEL_FLOOR = MIN_LABEL_PT - 1e-4;

/** PDFium's path segment types (fpdf_edit.h FPDF_SEGMENT_*). */
const FPDF_SEGMENT_LINETO = 0;
const FPDF_SEGMENT_MOVETO = 2;

/**
 * Whether a path of five segments is the rectangle of its bounds, as "re" draws it (BOXLABEL fix round 1, F3: four
 * corners in any order drew two triangles): a move to a corner, then four lines, each along a side, round the four
 * corners and back to the first, the last closing the path.
 */
function rectangle(m: Module, path: number, box: Box, at: number): boolean {
  const corners: string[] = [];
  let last: readonly [number, number] | null = null;
  for (let i = 0; i < 5; i++) {
    const segment = m.FPDFPath_GetPathSegment(path, i);
    if (segment === 0 || !m.FPDFPathSegment_GetPoint(segment, at, at + 4)) return false;
    // A move, then four lines; only the last closes the path.
    if (m.FPDFPathSegment_GetType(segment) !== (i === 0 ? FPDF_SEGMENT_MOVETO : FPDF_SEGMENT_LINETO)) return false;
    if (Boolean(m.FPDFPathSegment_GetClose(segment)) !== (i === 4)) return false;
    const [x = NaN, y = NaN] = new Float32Array(rt(m).HEAPU8.buffer, at, 2);
    if (!((x === box.left || x === box.right) && (y === box.bottom || y === box.top))) return false;
    // Each line runs along a side: it keeps exactly one of x and y.
    if (last !== null && (x === last[0]) === (y === last[1])) return false;
    last = [x, y];
    corners.push(`${x},${y}`);
  }
  // Round the four corners, and back to the first.
  return new Set(corners).size === 4 && corners[4] === corners[0];
}

/** One object drawn directly on a page, as the label check reads it (Page.labelReading). */
export type PageMark =
  | { kind: 'box'; object: number; bounds: Box }
  | { kind: 'lettering'; object: number; text: string; styled: boolean; x: number; y: number; bounds: Box }
  | { kind: 'other'; object: number };

export interface LabelReading {
  top: PageMark[];
  /** Text objects in a form XObject that read as a label, in the labels' font and colour. */
  nested: number;
  /** For each character of the page's reading (Page.chars, in its order), the text object it was read from. */
  owners: number[];
  /** For each character, the place in `top` of the object that draws it (-1 when PDFium names none). */
  places: number[];
}
