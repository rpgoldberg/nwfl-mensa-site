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
import type { Box, PageChar, Region } from './match.js';

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
const FPDF_PAGEOBJ_IMAGE = 3;
const FPDF_FILLMODE_ALTERNATE = 1;
/** Helvetica's advance for "withheld", in ems (its AFM widths: w i t h h e l d). */
const LABEL = 'withheld';
const LABEL_EMS = (722 + 222 + 278 + 556 + 556 + 556 + 222 + 556) / 1000;

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

  /** The page's characters, as PDFium extracts them; `unmapped` counts characters with no Unicode value. */
  chars(): { chars: PageChar[]; unmapped: number } {
    const m = this.m;
    const text = m.FPDFText_LoadPage(this.handle);
    const at = rt(m).wasmExports.malloc(16);
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
          fontSize: m.FPDFText_GetFontSize(text, i),
        });
      }
    } finally {
      rt(m).wasmExports.free(at);
      m.FPDFText_ClosePage(text);
    }
    return { chars, unmapped };
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

  /** An opaque box over each region, labelled "withheld" in white where the label fits. */
  drawBoxes(regions: readonly Region[]): void {
    const m = this.m;
    for (const { left, right, bottom, top, fontSize } of regions) {
      const width = right - left;
      const height = top - bottom;
      const box = m.FPDFPageObj_CreateNewRect(left, bottom, width, height);
      m.FPDFPageObj_SetFillColor(box, 0, 0, 0, 255);
      m.FPDFPath_SetDrawMode(box, FPDF_FILLMODE_ALTERNATE, false);
      m.FPDFPage_InsertObject(this.handle, box);
      const size = Math.min(fontSize * 0.8, (width - 2) / LABEL_EMS, height * 0.8);
      if (size < 4) continue;
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
