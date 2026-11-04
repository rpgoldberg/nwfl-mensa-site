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
/** Helvetica's advance for "withheld", in ems (its AFM widths: w i t h h e l d). */
const LABEL = 'withheld';
export const LABEL_EMS = (722 + 222 + 278 + 556 + 556 + 556 + 222 + 556) / 1000;
/** The smallest label drawn, in points: below it a box has no label (REDACT-LOOK: legible to older readers at 100 %). */
export const MIN_LABEL_PT = 7;
/** The space kept clear between the label and each side of its box, in points. */
const LABEL_PAD = 1;

/**
 * The size of the "withheld" label for a box, or null when it has none: 0.8 of the passage's type
 * size, smaller to fit the box's height and width (a point clear each side), but never below
 * MIN_LABEL_PT or 0.6 of the type size. A box too narrow for a readable label is left without one,
 * as an opaque box alone; the label is never shrunk to fit.
 */
export function labelSize(region: Region): number | null {
  const size = Math.min(0.8 * region.fontSize, 0.8 * (region.top - region.bottom), (region.right - region.left - 2 * LABEL_PAD) / LABEL_EMS);
  return size < Math.max(MIN_LABEL_PT, 0.6 * region.fontSize) ? null : size;
}

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
   * An opaque box over each region, labelled "withheld" in white, centred, where the label fits
   * (labelSize). The labels go on after every box, so no box is drawn over another's label.
   */
  drawBoxes(regions: readonly Region[]): void {
    const m = this.m;
    for (const { left, right, bottom, top } of regions) {
      const box = m.FPDFPageObj_CreateNewRect(left, bottom, right - left, top - bottom);
      m.FPDFPageObj_SetFillColor(box, 0, 0, 0, 255);
      m.FPDFPath_SetDrawMode(box, FPDF_FILLMODE_ALTERNATE, false);
      m.FPDFPage_InsertObject(this.handle, box);
    }
    for (const region of regions) {
      const { left, right, bottom, top } = region;
      const width = right - left;
      const height = top - bottom;
      const size = labelSize(region);
      if (size === null) continue;
      const label = m.FPDFPageObj_NewTextObj(this.doc.handle, 'Helvetica', size);
      const bytes = (LABEL.length + 1) * 2;
      const text = rt(m).wasmExports.malloc(bytes);
      rt(m).stringToUTF16(LABEL, text, bytes);
      m.FPDFText_SetText(label, text);
      rt(m).wasmExports.free(text);
      m.FPDFPageObj_SetFillColor(label, 255, 255, 255, 255);
      m.FPDFPageObj_Transform(label, 1, 0, 0, 1, left + (width - LABEL_EMS * size) / 2, bottom + (height - 0.7 * size) / 2);
      m.FPDFPage_InsertObject(this.handle, label);
    }
    m.FPDFPage_GenerateContent(this.handle);
  }
}
