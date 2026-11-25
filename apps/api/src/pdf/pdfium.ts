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
/** A path that is not filled (fpdf_edit.h FPDF_FILLMODE_NONE). */
const FPDF_FILLMODE_NONE = 0;
/** Text render mode 2: the glyphs filled, then stroked. */
const FPDF_TEXTRENDERMODE_FILL_STROKE = 2;
/** Lines joined round or bevelled (fpdf_edit.h FPDF_LINEJOIN_*); any other join is taken as mitred, whose corner may reach as far as its angle lets (PDFium gives no miter limit). */
const FPDF_LINEJOIN_ROUND = 1;
const FPDF_LINEJOIN_BEVEL = 2;

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
  /**
   * The milliseconds its pages have taken PDFium to draw so far for Page.shows and Page.inked (GATE-LAYOUT fix round 3:
   * the label check bounds the time, not only the count, as a page's drawing costs as much as the page holds).
   */
  drawingMs = 0;
  /**
   * Whether a page has had a drawing for Page.shows refused as costing too much (GATE-LAYOUT fix round 4: one drawing
   * runs to its end, so the time it takes is bounded by weighing it before, not after).
   */
  overdrawn = false;

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
  /** Each text object in a form XObject, as labelReading found it: the matrix from its space to the page's. */
  private readonly formMatrix = new Map<number, Matrix>();
  /** The last INK_CACHE text objects drawn alone (Page.inked), by object: each pixel's alpha, a row at a time, and where it lies. */
  private readonly alone = new Map<number, { alpha: Uint8Array; width: number; height: number; scale: number; bounds: Box }>();
  /** The pixels drawn so far for Page.inked (at most MAX_INK_PIXELS a page). */
  private inkPixels = 0;
  /** The last SHOW_CACHE areas drawn for Page.shows, by the objects left out and the area. */
  private readonly drawn = new Map<string, { whole: Float32Array; without: Float32Array; width: number; height: number }>();
  /** What a viewer shows of the page (Page.visible), once read. */
  private shown: Box | null | undefined;
  /** Each path the page draws, at any depth of forms (Page.drawCost), once read. */
  private paths: Array<{ bounds: Box; weight: number }> | undefined;

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
        const error = m.FPDFText_HasUnicodeMapError(text, i) === 1;
        if (error) unmapped += 1;
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
          ...(error ? { unmapped: true } : {}),
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
   * The bounds of a path in the boxes' style, else null: one rectangle (drawn round and closed, as "re" draws it),
   * filled even-odd, not stroked, opaque black, drawn at the identity. `at`: 136 bytes or more of scratch memory.
   */
  private boxOf(object: number, at: number): Box | null {
    const m = this.m;
    const u32 = (offset: number, n: number): number[] => [...new Uint32Array(rt(m).HEAPU8.buffer, at + offset, n)];
    const same = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
    if (!m.FPDFPageObj_GetFillColor(object, at, at + 4, at + 8, at + 12) || !same(u32(0, 4), [0, 0, 0, 255]) || m.FPDFPageObj_HasTransparency(object)) return null;
    if (!m.FPDFPageObj_GetMatrix(object, at + 16) || !same([...new Float32Array(rt(m).HEAPU8.buffer, at + 16, 6)], IDENTITY)) return null;
    if (!m.FPDFPath_GetDrawMode(object, at + 60, at + 64) || !same([...new Int32Array(rt(m).HEAPU8.buffer, at + 60, 2)], [FPDF_FILLMODE_ALTERNATE, 0])) return null;
    m.FPDFPageObj_GetBounds(object, at + 40, at + 44, at + 48, at + 52);
    const [left = 0, bottom = 0, right = 0, top = 0] = new Float32Array(rt(m).HEAPU8.buffer, at + 40, 4);
    const box = { left, bottom, right, top };
    return m.FPDFPath_CountSegments(object) === 5 && rectangle(m, object, box, at + 128) ? box : null;
  }

  /**
   * The rectangles drawn directly on the page in the boxes' style (labelReading's boxes), in drawing order
   * (GATE-LAYOUT): read of an original, they are the layout's own, which the label check does not take for boxes.
   */
  boxes(): Box[] {
    const m = this.m;
    const out: Box[] = [];
    const at = rt(m).wasmExports.malloc(256);
    try {
      for (let i = 0; i < this.objectCount; i++) {
        const object = m.FPDFPage_GetObject(this.handle, i);
        const box = m.FPDFPageObj_GetType(object) === FPDF_PAGEOBJ_PATH ? this.boxOf(object, at) : null;
        if (box !== null) out.push(box);
      }
      return out;
    } finally {
      rt(m).wasmExports.free(at);
    }
  }

  /**
   * The page's object at place `index` in its drawing order as what it paints over what is under it (GATE-LAYOUT):
   * null when it paints nothing there (a text object, whose glyphs the check reads apart, or a path neither filled
   * nor stroked); a shape when it is a path drawn directly on the page at the identity, opaque, of at most
   * MAX_SHAPE_SEGMENTS segments, with every clip on it of at most as many (its outline and its clips' in page points,
   * each curve as CURVE_STEPS chords); else, for anything else (a picture, a form, a shading, a path drawn
   * see-through or through a matrix, or one too long to read), its bounds, as unread.
   */
  shape(index: number): Shape | Unread | null {
    const m = this.m;
    const object = m.FPDFPage_GetObject(this.handle, index);
    if (object === 0) return null;
    const type = m.FPDFPageObj_GetType(object);
    if (type === FPDF_PAGEOBJ_TEXT) return null;
    const at = rt(m).wasmExports.malloc(64);
    try {
      const f32 = (offset: number, n: number): number[] => [...new Float32Array(rt(m).HEAPU8.buffer, at + offset, n)];
      const u32 = (offset: number, n: number): number[] => [...new Uint32Array(rt(m).HEAPU8.buffer, at + offset, n)];
      // Bounds PDFium cannot give: anywhere on the page.
      const [left = -Infinity, bottom = -Infinity, right = Infinity, top = Infinity] = m.FPDFPageObj_GetBounds(object, at, at + 4, at + 8, at + 12) ? f32(0, 4) : [];
      const unread: Unread = { unread: { left, bottom, right, top } };
      if (type !== FPDF_PAGEOBJ_PATH || !m.FPDFPath_GetDrawMode(object, at + 16, at + 20)) return unread;
      const [fill = FPDF_FILLMODE_NONE, stroked = 0] = new Int32Array(rt(m).HEAPU8.buffer, at + 16, 2);
      if (fill === FPDF_FILLMODE_NONE && stroked === 0) return null;
      if (m.FPDFPageObj_HasTransparency(object)) return unread;
      if (!m.FPDFPageObj_GetMatrix(object, at + 24) || IDENTITY.some((v, i) => f32(24, 6)[i] !== v)) return unread;
      let fillLuminance: number | null = null;
      if (fill !== FPDF_FILLMODE_NONE) {
        if (!m.FPDFPageObj_GetFillColor(object, at, at + 4, at + 8, at + 12)) return unread;
        const [r = 0, g = 0, b = 0, alpha = 0] = u32(0, 4);
        if (alpha !== 255) return unread;
        fillLuminance = luminance(r, g, b);
      }
      let stroke: Shape['stroke'];
      if (stroked !== 0) {
        if (!m.FPDFPageObj_GetStrokeColor(object, at, at + 4, at + 8, at + 12) || !m.FPDFPageObj_GetStrokeWidth(object, at + 16)) return unread;
        const [r = 0, g = 0, b = 0, alpha = 0] = u32(0, 4);
        const [width = Infinity] = f32(16, 1);
        if (alpha !== 255 || !Number.isFinite(width)) return unread;
        stroke = { luminance: luminance(r, g, b), width: Math.max(width, 0), mitred: ![FPDF_LINEJOIN_ROUND, FPDF_LINEJOIN_BEVEL].includes(m.FPDFPageObj_GetLineJoin(object)) };
      }
      const closed: boolean[] = [];
      const outline = outlineOf(m, m.FPDFPath_CountSegments(object), (i) => m.FPDFPath_GetPathSegment(object, i), at + 48, closed);
      if (outline === null) return unread;
      const clips = clipsOf(m, m.FPDFPageObj_GetClipPath(object), at + 48);
      if (clips === null) return unread;
      return { luminance: fillLuminance, evenOdd: fill === FPDF_FILLMODE_ALTERNATE, outline, closed, clips, ...(stroke === undefined ? {} : { stroke }) };
    } finally {
      rt(m).wasmExports.free(at);
    }
  }

  /**
   * How much of a box an object draws, as PDFium renders the page (GATE-LAYOUT fix round 1): the page is drawn at
   * SHOW_SCALE with every object, then without `object` (a text object drawn directly on the page or in a form) and
   * the objects `also` names (fix round 2: the same text drawn again there, so a copy of it over it does not hide it),
   * and the share of the box's pixels, inside it by SHOW_INSET of its size on each side, whose luminance they change
   * by 3:1 or more (WCAG contrast). The area drawn is the object's bounds on the page and SHOW_MARGIN round them, kept
   * for the next glyph of it (the last SHOW_CACHE), or, past MAX_SHOW_PIXELS, the box and the margin alone. Null when
   * that too is bigger, or PDFium cannot make the bitmap.
   *
   * Fix round 3: a pixel counts as changed only where a viewer shows the page (Page.visible: PDFium draws page space
   * past the crop box and the media box too) and outside every box of `mask` (in page points: the ink of the other
   * glyphs the drawing takes away, whose pixels are theirs, not the glyph's).
   */
  shows(object: number, box: Box, also: readonly number[] = [], mask: readonly Box[] = []): number | null {
    const near = { left: box.left - SHOW_MARGIN, right: box.right + SHOW_MARGIN, bottom: box.bottom - SHOW_MARGIN, top: box.top + SHOW_MARGIN };
    const pixels = (b: Box): number => Math.ceil((b.right - b.left) * SHOW_SCALE) * Math.ceil((b.top - b.bottom) * SHOW_SCALE);
    if (!(pixels(near) > 0 && pixels(near) <= MAX_SHOW_PIXELS)) return null;
    const own = this.placed(object);
    const round = own === null ? near : { left: Math.min(near.left, own.left - SHOW_MARGIN), right: Math.max(near.right, own.right + SHOW_MARGIN), bottom: Math.min(near.bottom, own.bottom - SHOW_MARGIN), top: Math.max(near.top, own.top + SHOW_MARGIN) };
    const area = pixels(round) <= MAX_SHOW_PIXELS ? round : near;
    const key = `${[object, ...also].join(',')}@${area.left},${area.right},${area.bottom},${area.top}`;
    let drawn = this.drawn.get(key) ?? null;
    if (drawn === null) {
      drawn = this.drawWithout([object, ...also], area);
      if (drawn === null) return null;
      if (this.drawn.size >= SHOW_CACHE) this.drawn.delete(this.drawn.keys().next().value as string);
      this.drawn.set(key, drawn);
    }
    const { whole, without, width, height } = drawn;
    const visible = this.visible();
    const [insetX, insetY] = [(box.right - box.left) * SHOW_INSET, (box.top - box.bottom) * SHOW_INSET];
    const x0 = Math.max(0, Math.floor((box.left + insetX - area.left) * SHOW_SCALE));
    const x1 = Math.min(width - 1, Math.ceil((box.right - insetX - area.left) * SHOW_SCALE) - 1);
    const y0 = Math.max(0, Math.floor((area.top - (box.top - insetY)) * SHOW_SCALE));
    const y1 = Math.min(height - 1, Math.ceil((area.top - (box.bottom + insetY)) * SHOW_SCALE) - 1);
    let changed = 0;
    let all = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const [p = 0, q = 0] = [whole[y * width + x], without[y * width + x]];
        all += 1;
        // The pixel's centre in page points.
        const [px, py] = [area.left + (x + 0.5) / SHOW_SCALE, area.top - (y + 0.5) / SHOW_SCALE];
        if (visible === null || !holdsPoint(visible, px, py) || mask.some((other) => holdsPoint(other, px, py))) continue;
        if ((Math.max(p, q) + 0.05) / (Math.min(p, q) + 0.05) >= 3) changed += 1;
      }
    }
    return all === 0 ? 0 : changed / all;
  }

  /**
   * What a viewer shows of the page, in page points: its crop box cut by its media box (FPDF_GetPageBoundingBox); null
   * when PDFium cannot give it (then nothing of the page is taken as shown).
   */
  visible(): Box | null {
    if (this.shown === undefined) {
      const m = this.m;
      const at = rt(m).wasmExports.malloc(16);
      try {
        // FS_RECTF: left, top, right, bottom.
        const [left = NaN, top = NaN, right = NaN, bottom = NaN] = m.FPDF_GetPageBoundingBox(this.handle, at) ? new Float32Array(rt(m).HEAPU8.buffer, at, 4) : [];
        this.shown = [left, top, right, bottom].every(Number.isFinite) ? { left: Math.min(left, right), right: Math.max(left, right), bottom: Math.min(bottom, top), top: Math.max(bottom, top) } : null;
      } finally {
        rt(m).wasmExports.free(at);
      }
    }
    return this.shown;
  }

  /** A text object's bounds on the page (through its form's matrix when it is in one), or null when PDFium gives none. */
  private placed(object: number): Box | null {
    const m = this.m;
    const at = rt(m).wasmExports.malloc(16);
    try {
      if (!m.FPDFPageObj_GetBounds(object, at, at + 4, at + 8, at + 12)) return null;
      const [left = 0, bottom = 0, right = 0, top = 0] = new Float32Array(rt(m).HEAPU8.buffer, at, 4);
      return transformed({ left, bottom, right, top }, this.formMatrix.get(object) ?? IDENTITY);
    } finally {
      rt(m).wasmExports.free(at);
    }
  }

  /**
   * What drawing an area of the page at SHOW_SCALE costs PDFium (GATE-LAYOUT fix round 4): for each path that meets
   * it, at any depth of forms, its segments times the rows of pixels it meets, a stroked path STROKE_WEIGHT times a
   * filled one. PDFium skips an object whose bounds miss the area, and a fill or stroke costs about each segment for
   * each row it crosses (a page of 400 draws of a 20,000-point zigzag takes minutes over a 100 pt glyph).
   */
  drawCost(area: Box): number {
    if (this.paths === undefined) {
      const m = this.m;
      const paths: Array<{ bounds: Box; weight: number }> = [];
      // FS_RECTF's four floats (FPDFPageObj_GetBounds), FS_MATRIX's six, then the draw mode's two ints.
      const at = rt(m).wasmExports.malloc(48);
      try {
        const pending: Array<[number, Matrix]> = [];
        for (let i = 0; i < this.objectCount; i++) pending.push([m.FPDFPage_GetObject(this.handle, i), IDENTITY]);
        for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
          const [object, matrix] = next;
          const type = m.FPDFPageObj_GetType(object);
          if (type === FPDF_PAGEOBJ_PATH && m.FPDFPath_GetDrawMode(object, at + 40, at + 44) && m.FPDFPageObj_GetBounds(object, at, at + 4, at + 8, at + 12)) {
            const [fill = 0, stroke = 0] = new Int32Array(rt(m).HEAPU8.buffer, at + 40, 2);
            const [left = 0, bottom = 0, right = 0, top = 0] = new Float32Array(rt(m).HEAPU8.buffer, at, 4);
            const weight = m.FPDFPath_CountSegments(object) * ((fill === 0 ? 0 : 1) + (stroke === 0 ? 0 : STROKE_WEIGHT));
            if (weight > 0) paths.push({ bounds: transformed({ left, bottom, right, top }, matrix), weight });
          } else if (type === FPDF_PAGEOBJ_FORM) {
            m.FPDFPageObj_GetMatrix(object, at + 16);
            const inner = [...new Float32Array(rt(m).HEAPU8.buffer, at + 16, 6)] as Matrix;
            for (let i = 0; i < m.FPDFFormObj_CountObjects(object); i++) pending.push([m.FPDFFormObj_GetObject(object, i), times(inner, matrix)]);
          }
        }
      } finally {
        rt(m).wasmExports.free(at);
      }
      this.paths = paths;
    }
    let cost = 0;
    for (const { bounds, weight } of this.paths) {
      const meets = bounds.left <= area.right && area.left <= bounds.right && bounds.bottom <= area.top && area.bottom <= bounds.top;
      if (meets) cost += weight * (1 + Math.ceil((Math.min(area.top, bounds.top) - Math.max(area.bottom, bounds.bottom)) * SHOW_SCALE));
    }
    return cost;
  }

  /**
   * The page's area drawn at SHOW_SCALE (each pixel's luminance, a row at a time, y down) with every object, and without
   * these; null when PDFium cannot, or (fix round 4) when drawing it would cost more than MAX_DRAW_COST (Page.drawCost),
   * which marks the document overdrawn.
   */
  private drawWithout(objects: readonly number[], area: Box): { whole: Float32Array; without: Float32Array; width: number; height: number } | null {
    if (this.drawCost(area) > MAX_DRAW_COST) {
      this.doc.overdrawn = true;
      return null;
    }
    const m = this.m;
    const width = Math.ceil((area.right - area.left) * SHOW_SCALE);
    const height = Math.ceil((area.top - area.bottom) * SHOW_SCALE);
    const at = rt(m).wasmExports.malloc(64);
    try {
      // PDFium draws page points through the page's display matrix (to a device of the page's size in points), then
      // through ours. Ours undoes the display matrix (read from three points, to a thousandth of a point) and carries
      // the area's top left to the bitmap's, at SHOW_SCALE, y down.
      const fine = 1024;
      const device = (x: number, y: number): [number, number] => {
        m.FPDF_PageToDevice(this.handle, 0, 0, Math.round(this.width * fine), Math.round(this.height * fine), 0, x, y, at, at + 4);
        const [dx = 0, dy = 0] = new Int32Array(rt(m).HEAPU8.buffer, at, 2);
        return [dx / fine, dy / fine];
      };
      const [e, f] = device(0, 0);
      const [ax, ay] = device(1, 0);
      const [cx, cy] = device(0, 1);
      // The display matrix [a b c d e f] and its inverse; then the inverse, then (x - left, top - y) times the scale.
      const [a, b, c, d] = [ax - e, ay - f, cx - e, cy - f];
      const det = a * d - b * c;
      if (det === 0) return null;
      const inverse: Matrix = [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
      const ours = times(inverse, [SHOW_SCALE, 0, 0, -SHOW_SCALE, -area.left * SHOW_SCALE, area.top * SHOW_SCALE]);
      new Float32Array(rt(m).HEAPU8.buffer, at + 16, 6).set(ours);
      new Float32Array(rt(m).HEAPU8.buffer, at + 40, 4).set([0, 0, width, height]);
      const render = (): Float32Array | null => {
        const bitmap = m.FPDFBitmap_Create(width, height, 0);
        if (bitmap === 0) return null;
        try {
          m.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
          m.FPDF_RenderPageBitmapWithMatrix(bitmap, this.handle, at + 16, at + 40, 0);
          const stride = m.FPDFBitmap_GetStride(bitmap);
          const start = m.FPDFBitmap_GetBuffer(bitmap);
          const pixels = rt(m).HEAPU8;
          const out = new Float32Array(width * height);
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              // Blue, green, red, unused.
              const o = start + y * stride + x * 4;
              out[y * width + x] = luminance(pixels[o + 2] as number, pixels[o + 1] as number, pixels[o] as number);
            }
          }
          return out;
        } finally {
          m.FPDFBitmap_Destroy(bitmap);
        }
      };
      const started = performance.now();
      const whole = render();
      for (const object of objects) m.FPDFPageObj_SetIsActive(object, false);
      let without: Float32Array | null;
      try {
        without = render();
      } finally {
        for (const object of objects) m.FPDFPageObj_SetIsActive(object, true);
        this.doc.drawingMs += performance.now() - started;
      }
      return whole === null || without === null ? null : { whole, without, width, height };
    } finally {
      rt(m).wasmExports.free(at);
    }
  }

  /**
   * A text object drawn alone at up to INK_SCALE (Page.inked): its pixels' alpha and where they lie; null when PDFium
   * cannot draw it, or drawing it would take the page past MAX_INK_PIXELS.
   */
  private drawnAlone(object: number): { alpha: Uint8Array; width: number; height: number; scale: number; bounds: Box } | null {
    const m = this.m;
    const at = rt(m).wasmExports.malloc(16);
    try {
      if (!m.FPDFPageObj_GetBounds(object, at, at + 4, at + 8, at + 12)) return null;
      const [left = 0, bottom = 0, right = 0, top = 0] = new Float32Array(rt(m).HEAPU8.buffer, at, 4);
      const scale = Math.min(INK_SCALE, Math.sqrt(MAX_RENDER_PIXELS / Math.max(1, (right - left) * (top - bottom))));
      this.inkPixels += (right - left) * (top - bottom) * scale * scale;
      if (this.inkPixels > MAX_INK_PIXELS) return null;
      const started = performance.now();
      const bitmap = m.FPDFTextObj_GetRenderedBitmap(this.doc.handle, this.handle, object, scale);
      this.doc.drawingMs += performance.now() - started;
      if (bitmap === 0) return null;
      try {
        const width = m.FPDFBitmap_GetWidth(bitmap);
        const height = m.FPDFBitmap_GetHeight(bitmap);
        const stride = m.FPDFBitmap_GetStride(bitmap);
        const start = m.FPDFBitmap_GetBuffer(bitmap);
        const alpha = new Uint8Array(width * height);
        // Blue, green, red, alpha.
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) alpha[y * width + x] = rt(m).HEAPU8[start + y * stride + x * 4 + 3] as number;
        return { alpha, width, height, scale, bounds: { left, bottom, right, top } };
      } finally {
        m.FPDFBitmap_Destroy(bitmap);
      }
    } finally {
      rt(m).wasmExports.free(at);
    }
  }

  /**
   * How much of a glyph's ink box PDFium paints when it draws the glyph's text object alone
   * (FPDFTextObj_GetRenderedBitmap, GATE-LAYOUT fix round 1b): the share of the box's pixels, inside it by SHOW_INSET
   * of its size on each side (else the one at its centre), with any paint at all. A glyph a font draws nothing for
   * (a glyph name PDFium finds no glyph by, a space a /ToUnicode reads as a letter) paints none. The box is in page
   * points; a text object in a form is drawn in the form's space, so the box is carried there (labelReading has read
   * the form's matrix). `least`: the alpha (1 to 255) a pixel needs to count as painted (fix round 2: 128, for half of
   * it or more). Null when PDFium cannot draw it, the page's text objects have taken MAX_INK_PIXELS, or its
   * matrix cannot be undone. Fix round 3: a pixel whose centre lies in a box of `mask` (page points: the ink of the
   * object's other glyphs) is not counted as painted.
   */
  inked(object: number, ink: Box, least = 1, mask: readonly Box[] = []): number | null {
    let alone = this.alone.get(object) ?? null;
    if (alone === null) {
      alone = this.drawnAlone(object);
      if (alone === null) return null;
      if (this.alone.size >= INK_CACHE) this.alone.delete(this.alone.keys().next().value as number);
      this.alone.set(object, alone);
    }
    const { alpha, width, height, scale, bounds } = alone;
    // The box in the object's own space: through the inverse of its form's matrix, the box round its four corners.
    const [a, b, c, d, e, f] = this.formMatrix.get(object) ?? IDENTITY;
    const det = a * d - b * c;
    if (det === 0) return null;
    const back = ([x, y]: [number, number]): [number, number] => [(d * (x - e) - c * (y - f)) / det, (a * (y - f) - b * (x - e)) / det];
    const corners = ([[ink.left, ink.bottom], [ink.right, ink.bottom], [ink.left, ink.top], [ink.right, ink.top]] as Array<[number, number]>).map(back);
    const box = { left: Math.min(...corners.map(([x]) => x)), right: Math.max(...corners.map(([x]) => x)), bottom: Math.min(...corners.map(([, y]) => y)), top: Math.max(...corners.map(([, y]) => y)) };
    // Pixels as PDFium draws the object: x from its bounds' left, y down from their top, at the scale.
    const [insetX, insetY] = [(box.right - box.left) * SHOW_INSET, (box.top - box.bottom) * SHOW_INSET];
    const [px0, px1] = [(box.left + insetX - bounds.left) * scale, (box.right - insetX - bounds.left) * scale];
    const [py0, py1] = [(bounds.top - box.top + insetY) * scale, (bounds.top - box.bottom - insetY) * scale];
    // Each pixel whose centre lies inside; none: the one at the centre.
    let [x0, x1, y0, y1] = [Math.ceil(px0 - 0.5), Math.floor(px1 - 0.5), Math.ceil(py0 - 0.5), Math.floor(py1 - 0.5)];
    if (x0 > x1) [x0, x1] = [Math.floor((px0 + px1) / 2), Math.floor((px0 + px1) / 2)];
    if (y0 > y1) [y0, y1] = [Math.floor((py0 + py1) / 2), Math.floor((py0 + py1) / 2)];
    let painted = 0;
    let all = 0;
    // A pixel's centre, from the object's space to the page's.
    const masked = (x: number, y: number): boolean => {
      const [ox, oy] = [bounds.left + (x + 0.5) / scale, bounds.top - (y + 0.5) / scale];
      const [px, py] = [a * ox + c * oy + e, b * ox + d * oy + f];
      return mask.some((other) => holdsPoint(other, px, py));
    };
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        all += 1;
        if (x >= 0 && x < width && y >= 0 && y < height && (alpha[y * width + x] as number) >= least && !masked(x, y)) painted += 1;
      }
    }
    return painted / all;
  }

  /**
   * What the label check reads of the page (gate-labels.ts): each object drawn directly on the page, in drawing
   * order, as a box, a lettering or anything else; how many text objects in a form XObject, at any depth, read as a
   * label in the labels' font and colour; and, for each character of the page's reading (chars(), in its order), the
   * text object it was read from, the place in the drawing order of the page's object that draws it, and how that
   * text object is painted (GATE-LAYOUT: its fill's luminance, and whether its glyphs are filled opaque).
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
      // Each text object PDFium reads a glyph of.
      const read = new Set<number>();
      for (let i = 0; i < m.FPDFText_CountChars(text); i++) {
        const owner = m.FPDFText_GetTextObject(text, i);
        owners.push(owner);
        if (m.FPDFText_IsGenerated(text, i) === 1) continue;
        read.add(owner);
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
      // The place in the drawing order of the page's object that draws each text object, in a form at any depth too.
      const placeOf = new Map<number, number>();
      /** An object in a form: where its form is drawn on the page, whether a form round it is not opaque, the matrix from its space to the page's, and the clips round it. */
      type Nested = { object: number; place: number; veil: boolean; matrix: Matrix; clips: Outline[] | null };
      const pending: Nested[] = [];
      /** The clips on an object, in its space carried by `matrix` to the page's; null when one cannot be read. */
      const clipped = (object: number, matrix: Matrix): Outline[] | null => clipsOf(m, m.FPDFPageObj_GetClipPath(object), at + 136, matrix);
      const inside = (form: number, place: number, veil: boolean, outer: Matrix, clips: Outline[] | null): void => {
        // The form's own matrix carries its content into the space the form is drawn in. One PDFium cannot give
        // leaves the clips round its content unread.
        const own = matrix(form);
        const matrix_ = own.length === 6 ? times(own as Matrix, outer) : outer;
        const around = clips === null || own.length !== 6 ? null : clipped(form, outer);
        const all = clips === null || around === null ? null : [...clips, ...around];
        for (let k = 0; k < m.FPDFFormObj_CountObjects(form); k++) pending.push({ object: m.FPDFFormObj_GetObject(form, k), place, veil: veil || Boolean(m.FPDFPageObj_HasTransparency(form)), matrix: matrix_, clips: all });
      };
      for (let i = 0; i < this.objectCount; i++) {
        const object = m.FPDFPage_GetObject(this.handle, i);
        const type = m.FPDFPageObj_GetType(object);
        placeOf.set(object, i);
        if (type === FPDF_PAGEOBJ_TEXT && lettered(object)) {
          const [a, b, c, d, e = 0, f = 0] = matrix(object);
          const styled = a === 1 && b === 0 && c === 0 && d === 1 && m.FPDFTextObj_GetTextRenderMode(object) === FPDF_TEXTRENDERMODE_FILL && !m.FPDFPageObj_HasTransparency(object) && fontSize(object) >= MIN_LABEL_FLOOR;
          top.push({ kind: 'lettering', object, text: written.get(object) ?? '', styled, x: e, y: f, bounds: bounds(object) });
        } else {
          const box = type === FPDF_PAGEOBJ_PATH ? this.boxOf(object, at) : null;
          top.push(box === null ? { kind: 'other', object } : { kind: 'box', object, bounds: box });
        }
        if (type === FPDF_PAGEOBJ_FORM) inside(object, i, false, IDENTITY, []);
      }
      // Each object drawn through a form that is not opaque, at any depth: whatever its own paint, it is not drawn opaque.
      const veiled = new Set<number>();
      // Each text object in a form: the clips round it in page points (null: one cannot be read).
      const clipsIn = new Map<number, Outline[] | null>();
      // Each place a form is drawn at: the page bounds of everything but text in it, at any depth.
      const besideAt = new Map<number, Box[]>();
      for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        const { object, place, veil, matrix: carried, clips } = next;
        const type = m.FPDFPageObj_GetType(object);
        placeOf.set(object, place);
        if (veil) veiled.add(object);
        if (type === FPDF_PAGEOBJ_TEXT) {
          this.formMatrix.set(object, carried);
          const own = clips === null ? null : clipped(object, carried);
          clipsIn.set(object, clips === null || own === null ? null : [...clips, ...own]);
          if (lettered(object) && isLabel(written.get(object) ?? '')) nested += 1;
        } else {
          const list = besideAt.get(place) ?? [];
          list.push(transformed(bounds(object), carried));
          besideAt.set(place, list);
        }
        if (type === FPDF_PAGEOBJ_FORM) inside(object, place, veil, carried, clips);
      }
      /** The one colour PDFium paints a text object's glyphs in, alone, as [r, g, b], or null when not one, opaque. */
      const painted = (owner: number): [number, number, number] | null => {
        const box = bounds(owner);
        const scale = Math.min(RENDER_SCALE, Math.sqrt(MAX_RENDER_PIXELS / Math.max(1, (box.right - box.left) * (box.top - box.bottom))));
        const bitmap = m.FPDFTextObj_GetRenderedBitmap(this.doc.handle, this.handle, owner, scale);
        if (bitmap === 0) return null;
        try {
          const width = m.FPDFBitmap_GetWidth(bitmap);
          const height = m.FPDFBitmap_GetHeight(bitmap);
          const stride = m.FPDFBitmap_GetStride(bitmap);
          const pixels = rt(m).HEAPU8;
          const start = m.FPDFBitmap_GetBuffer(bitmap);
          let found: [number, number, number] | null = null;
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              // Blue, green, red, alpha.
              const o = start + y * stride + x * 4;
              // An edge pixel, drawn in part: its colour is the glyph's, partly over nothing.
              if ((pixels[o + 3] as number) < 255) continue;
              const pixel: [number, number, number] = [pixels[o + 2] as number, pixels[o + 1] as number, pixels[o] as number];
              if (found === null) found = pixel;
              else if (found.some((v, k) => Math.abs(v - (pixel[k] as number)) > COLOUR_SLACK)) return null;
            }
          }
          return found;
        } finally {
          m.FPDFBitmap_Destroy(bitmap);
        }
      };
      /** Whether a text object's font is a Type 3 font: PDFium holds no font program for one. */
      const type3 = (owner: number): boolean => {
        const font = m.FPDFTextObj_GetFont(owner);
        return font === 0 || (m.FPDFFont_GetFontData(font, 0, 0, at + 144) && new Uint32Array(rt(m).HEAPU8.buffer, at + 144, 1)[0] === 0);
      };
      /** Exactly a Type 3 font (fix round 3): PDFium takes it for embedded, yet holds no font program for it. */
      const inType3 = (object: number): boolean => {
        const font = m.FPDFTextObj_GetFont(object);
        return font === 0 || (m.FPDFFont_GetIsEmbedded(font) === 1 && type3(object));
      };
      // How each glyph's text object is painted (GATE-LAYOUT): read once an object.
      const paintOf = new Map<number, Paint>();
      const paint = (owner: number): Paint => {
        let found = paintOf.get(owner);
        if (found === undefined) {
          const fill = owner === 0 ? [] : filled(owner);
          let [r = 0, g = 0, b = 0] = fill;
          const alpha = fill[3] ?? 0;
          const mode = owner === 0 ? -1 : m.FPDFTextObj_GetTextRenderMode(owner);
          let opaque = alpha === 255 && (mode === FPDF_TEXTRENDERMODE_FILL || mode === FPDF_TEXTRENDERMODE_FILL_STROKE) && !m.FPDFPageObj_HasTransparency(owner) && !veiled.has(owner);
          if (opaque && type3(owner)) {
            const real = painted(owner);
            if (real === null) opaque = false;
            else [r, g, b] = real;
          }
          const place = placeOf.get(owner) ?? -1;
          const clips = owner === 0 ? null : clipsIn.has(owner) ? (clipsIn.get(owner) ?? null) : clipped(owner, IDENTITY);
          found = { luminance: luminance(r, g, b), opaque: opaque && clips !== null, clips: clips ?? [], beside: besideAt.get(place) ?? [] };
          paintOf.set(owner, found);
        }
        return found;
      };
      // Each text object drawn directly on the page drawn again later as it is (GATE-LAYOUT fix round 1): PDFium reads no
      // glyph of such a twin (its glyphs are the first's, at the same places), so its text in the reading is empty, and it
      // is drawn with the same bounds, font, size, matrix, mode and fill. Its own paint (its clips among it) is its own.
      const signature = (object: number): string =>
        JSON.stringify([bounds(object), m.FPDFTextObj_GetFont(object), fontSize(object), matrix(object), m.FPDFTextObj_GetTextRenderMode(object), filled(object)]);
      /** Whether PDFium reads no glyph of a text object of its own (from the page's reading: FPDFTextObj_GetText reads the page's every glyph for each object). */
      const bare = (object: number): boolean => !read.has(object);
      // Each list holds the MAX_TWINS nearest after it (lists are shared, so a page of many costs no more than that).
      const twinsOf = new Map<number, Twin[]>();
      const later = new Map<string, Twin[]>();
      for (let i = this.objectCount - 1; i >= 0; i--) {
        const object = m.FPDFPage_GetObject(this.handle, i);
        if (m.FPDFPageObj_GetType(object) !== FPDF_PAGEOBJ_TEXT) continue;
        const key = signature(object);
        twinsOf.set(object, later.get(key) ?? []);
        if (bare(object)) later.set(key, [{ at: i, object, paint: paint(object) }, ...(later.get(key) ?? []).slice(0, MAX_TWINS - 1)]);
      }
      const twins = owners.map((owner) => twinsOf.get(owner) ?? []);
      const drawers = new Set<number>([...owners.filter((owner) => owner !== 0), ...twins.flatMap((list) => list.map((twin) => twin.object))]);
      return { top, nested, owners, places: owners.map((owner) => placeOf.get(owner) ?? -1), paints: owners.map(paint), twins, clipText: this.hasClipText(), type3: [...drawers].filter(inType3) };
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

const FPDF_SEGMENT_BEZIERTO = 1;
/** The most segments a shape's path, or a clip on it, may have to be read (Page.shape). */
const MAX_SHAPE_SEGMENTS = 512;
/** The chords a curve is read as: a quarter circle of 100 pt radius is within 0.04 pt of sixteen. */
const CURVE_STEPS = 16;
/** The scale a box is drawn at to tell what a text object shows there (Page.shows): 4 pixels a point. */
const SHOW_SCALE = 4;
/** How far round the box it is drawn, in points. */
const SHOW_MARGIN = 1;
/** The most pixels that drawing may take: a bigger box is not drawn. */
const MAX_SHOW_PIXELS = 1_000_000;
/**
 * The most a drawing for Page.shows may cost (Page.drawCost: path segments times the pixel rows they meet), about 5 s
 * of PDFium's drawing on the gate's box (0.05 microseconds each, both drawings; fix round 4): past it, it is not drawn.
 */
const MAX_DRAW_COST = 100_000_000;
/** What a stroked path's segment costs to draw, by a filled one's: its outline is made first (about 2 to 3 times). */
const STROKE_WEIGHT = 3;
/** The most areas drawn for Page.shows kept at once, the oldest let go first. */
const SHOW_CACHE = 4;
/** The most places a text object drawn again as it is is looked for after it (LabelReading.twins). */
const MAX_TWINS = 8;
/** How far inside a glyph's ink box, by its size on each side, its pixels are looked at: off the next glyph's ink. */
const SHOW_INSET = 0.15;
/** The scale a Type 3 font's text object is drawn at alone to read the colour its glyphs paint in (Page.labelReading). */
const RENDER_SCALE = 2;
/** The most pixels that drawing may take: a bigger text object is drawn smaller. */
const MAX_RENDER_PIXELS = 4_000_000;
/** How far, in any channel, a pixel's colour may be from the first one's and still be the same colour. */
const COLOUR_SLACK = 8;
/** The scale a text object is drawn at alone to tell whether a glyph of it paints (Page.inked): 4 pixels a point. */
const INK_SCALE = 4;
/** The most text objects drawn alone kept at once (Page.inked), the oldest let go first. */
const INK_CACHE = 8;
/** The most pixels a page's text objects may be drawn alone at between them (Page.inked): past it, none is drawn. */
const MAX_INK_PIXELS = 64_000_000;

/**
 * The share of a box's inner pixels (inside it by SHOW_INSET on each side, at SHOW_SCALE: Page.shows, Page.inked) that
 * one row or one column of them makes, the larger: how finely those shares are read (one, when under a pixel).
 */
export function showPixel(box: Box): number {
  const side = Math.min(box.right - box.left, box.top - box.bottom) * (1 - 2 * SHOW_INSET) * SHOW_SCALE;
  return side > 1 ? 1 / side : 1;
}

/** Whether the point lies in the box, its edge included. */
const holdsPoint = (box: Box, x: number, y: number): boolean => x >= box.left && x <= box.right && y >= box.bottom && y <= box.top;

/** The WCAG relative luminance (0 black to 1 white) of an sRGB colour, each channel 0 to 255. */
export function luminance(r: number, g: number, b: number): number {
  const linear = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** A path's subpaths, each the points round it (closed back to its first), in page points. */
export type Outline = Array<Array<[number, number]>>;

/**
 * A path of `count` segments as an outline, each curve as CURVE_STEPS chords, or null when it has more than
 * MAX_SHAPE_SEGMENTS, a segment cannot be read, a point is not finite, or a line or a curve has no point before it
 * or a curve is not three points. `at`: 8 bytes of scratch memory; `closed`: filled with whether each subpath is
 * closed (a join at its first point, not caps).
 */
function outlineOf(m: Module, count: number, segmentAt: (i: number) => number, at: number, closed: boolean[] = []): Outline | null {
  if (count < 0 || count > MAX_SHAPE_SEGMENTS) return null;
  const out: Outline = [];
  let ring: Array<[number, number]> | null = null;
  let controls: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    const segment = segmentAt(i);
    if (segment === 0 || !m.FPDFPathSegment_GetPoint(segment, at, at + 4)) return null;
    const [x = NaN, y = NaN] = new Float32Array(rt(m).HEAPU8.buffer, at, 2);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const type = m.FPDFPathSegment_GetType(segment);
    if (type === FPDF_SEGMENT_MOVETO) {
      if (controls.length > 0) return null;
      ring = [[x, y]];
      out.push(ring);
      closed.push(false);
    } else if (ring === null) return null;
    else if (type === FPDF_SEGMENT_LINETO) {
      if (controls.length > 0) return null;
      ring.push([x, y]);
    } else if (type === FPDF_SEGMENT_BEZIERTO) {
      controls.push([x, y]);
      if (controls.length < 3) continue;
      const [x0, y0] = ring[ring.length - 1] as [number, number];
      const [[x1, y1], [x2, y2], [x3, y3]] = controls as [[number, number], [number, number], [number, number]];
      for (let step = 1; step <= CURVE_STEPS; step++) {
        const t = step / CURVE_STEPS;
        const u = 1 - t;
        ring.push([u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3]);
      }
      controls = [];
    } else return null;
    if (m.FPDFPathSegment_GetClose(segment)) closed[out.length - 1] = true;
  }
  return controls.length > 0 ? null : out;
}

/**
 * The paths of a clip as outlines (in the space PDFium gives them), carried by `matrix`; none for no clip; null when
 * it has more than MAX_SHAPE_SEGMENTS paths or one cannot be read (outlineOf). `at`: 8 bytes of scratch memory.
 */
function clipsOf(m: Module, clip: number, at: number, matrix: Matrix = IDENTITY): Outline[] | null {
  const count = clip === 0 ? 0 : m.FPDFClipPath_CountPaths(clip);
  if (count > MAX_SHAPE_SEGMENTS) return null;
  const out: Outline[] = [];
  for (let k = 0; k < count; k++) {
    const path = outlineOf(m, m.FPDFClipPath_CountPathSegments(clip, k), (i) => m.FPDFClipPath_GetPathSegment(clip, k, i), at);
    if (path === null) return null;
    const [a, b, c, d, e, f] = matrix;
    out.push(path.map((ring) => ring.map(([x, y]) => [a * x + c * y + e, b * x + d * y + f] as [number, number])));
  }
  return out;
}

/** How a text object's glyphs are painted, as the label check reads it (Page.labelReading). */
export interface Paint {
  /**
   * The luminance (WCAG) its glyphs are painted in: its fill colour's (0 when PDFium gives none), or, in a Type 3
   * font, whose glyphs may paint in colours of their own, the one colour PDFium paints them in alone.
   */
  luminance: number;
  /**
   * Its glyphs are filled (alone, or filled and stroked) in a colour with no transparency, no form that draws it has
   * any, and, in a Type 3 font, PDFium paints them in one colour, opaque.
   */
  opaque: boolean;
  /** Every clip on it, and on each form that draws it, in page points: it paints only inside every one. */
  clips?: Outline[];
  /** The bounds, in page points, of everything but text drawn in the form on the page that draws it, at any depth. */
  beside?: Box[];
}

/** A path drawn directly on a page, opaque, as what it paints over what is under it (Page.shape). */
export interface Shape {
  /** The fill colour's WCAG relative luminance; null when it is not filled. */
  luminance: number | null;
  /** Filled by the even-odd rule; else by the nonzero winding rule. */
  evenOdd: boolean;
  outline: Outline;
  /** Whether each subpath of the outline is closed (a join at its first point, not caps); unknown: taken as closed. */
  closed?: boolean[];
  /** Each clip on it: it paints only inside every one. */
  clips: Outline[];
  /** Its stroke, when it is stroked: the colour's luminance, the line's width, and whether its corners are mitred. */
  stroke?: { luminance: number; width: number; mitred: boolean };
}

/** An object drawn on a page that may paint anything inside its bounds (Page.shape). */
export interface Unread {
  unread: Box;
}

/** A text object drawn again as another is, whose glyphs PDFium does not read again: its place in `top`, and its paint. */
export interface Twin {
  at: number;
  object: number;
  paint: Paint;
}

/** One object drawn directly on a page, as the label check reads it (Page.labelReading). */
export type PageMark =
  | { kind: 'box'; object: number; bounds: Box }
  | { kind: 'lettering'; object: number; text: string; styled: boolean; x: number; y: number; bounds: Box }
  | { kind: 'other'; object: number };

export interface LabelReading {
  top: PageMark[];
  /**
   * The page draws text as a clip (render mode 4 to 7; hasClipText). PDFium gives a clip's paths but not its text,
   * so what such a clip leaves out cannot be read (GATE-LAYOUT fix round 1b).
   */
  clipText?: boolean;
  /** Text objects in a form XObject that read as a label, in the labels' font and colour. */
  nested: number;
  /** For each character of the page's reading (Page.chars, in its order), the text object it was read from. */
  owners: number[];
  /** For each character, the place in `top` of the object that draws it (-1 when PDFium names none). */
  places: number[];
  /** For each character, how its text object is painted. */
  paints: Paint[];
  /**
   * For each character, where its text object is drawn again as it is, after it, directly on the page: the MAX_TWINS
   * nearest (none for one in a form).
   */
  twins?: Twin[][];
  /**
   * The text objects (each character's, and each drawn again as it is) whose font is a Type 3 font, whose glyphs' boxes
   * are only what the font claims: PDFium draws a glyph's paint past its box (fix round 3).
   */
  type3?: number[];
}
