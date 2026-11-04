// REDACT-LOOK: the pixel test's eyes. A page rendered by PDFium (the repo's
// own build) at 4x (288 dpi) into a white RGB raster, so a test can count the
// pixels of a colour, find the ones a redaction lost, and save a PNG for a
// person to look at. The fit fixtures draw marked text red and the rest blue.
import { crc32, deflateSync } from 'node:zlib';
import type { Box } from '../../src/pdf/match.js';
import { pdfium } from '../../src/pdf/pdfium.js';

export const SCALE = 4;
/** FPDF_ANNOT: annotations are drawn too, so one left in a copy would show. */
const FPDF_ANNOT = 0x01;

export interface Raster {
  width: number;
  height: number;
  /** The page's height in points: page y = pageHeight - pixel y / SCALE. */
  pageHeight: number;
  /** RGB, three bytes a pixel, rows top first. */
  rgb: Uint8Array;
}

export type Pixel = (r: number, g: number, b: number) => boolean;

/** A pixel of the marked text's red, anti-aliased edges included. */
export const red: Pixel = (r, g, b) => r - Math.max(g, b) > 40;
/** A pixel of the unmarked text's blue, anti-aliased edges included. */
export const blue: Pixel = (r, g, b) => b - Math.max(r, g) > 40;
/** A pixel of a redaction box: pure black. */
export const black: Pixel = (r, g, b) => r === 0 && g === 0 && b === 0;

/** Renders one page (0-based) of a PDF at SCALE. */
export async function render(pdf: Uint8Array, index = 0): Promise<Raster> {
  const m = await pdfium();
  const heap = (): Uint8Array => (m.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8;
  const exports = (m.pdfium as unknown as { wasmExports: { malloc(n: number): number; free(p: number): void } }).wasmExports;
  const buffer = exports.malloc(pdf.length);
  heap().set(pdf, buffer);
  const doc = m.FPDF_LoadMemDocument(buffer, pdf.length, '');
  if (doc === 0) throw new Error('render: the PDF could not be opened');
  try {
    const page = m.FPDF_LoadPage(doc, index);
    try {
      const pageHeight = m.FPDF_GetPageHeightF(page);
      const width = Math.round(m.FPDF_GetPageWidthF(page) * SCALE);
      const height = Math.round(pageHeight * SCALE);
      const bitmap = m.FPDFBitmap_Create(width, height, 0);
      try {
        m.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
        m.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, FPDF_ANNOT);
        const at = m.FPDFBitmap_GetBuffer(bitmap);
        const stride = m.FPDFBitmap_GetStride(bitmap);
        const rgb = new Uint8Array(width * height * 3);
        const bytes = heap();
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const from = at + y * stride + x * 4; // BGRx
            const to = (y * width + x) * 3;
            rgb[to] = bytes[from + 2] as number;
            rgb[to + 1] = bytes[from + 1] as number;
            rgb[to + 2] = bytes[from] as number;
          }
        }
        return { width, height, pageHeight, rgb };
      } finally {
        m.FPDFBitmap_Destroy(bitmap);
      }
    } finally {
      m.FPDF_ClosePage(page);
    }
  } finally {
    m.FPDF_CloseDocument(doc);
    exports.free(buffer);
  }
}

const at = (raster: Raster, x: number, y: number): [number, number, number] => {
  const i = (y * raster.width + x) * 3;
  return [raster.rgb[i] as number, raster.rgb[i + 1] as number, raster.rgb[i + 2] as number];
};

/** The centre of pixel (x, y) in page space. */
export const toPage = (raster: Raster, x: number, y: number): { x: number; y: number } => ({ x: (x + 0.5) / SCALE, y: raster.pageHeight - (y + 0.5) / SCALE });

/** The pixels (as page points) that `pixel` holds for. */
export function where(raster: Raster, pixel: Pixel): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) if (pixel(...at(raster, x, y))) out.push(toPage(raster, x, y));
  return out;
}

/** The pixels (as page points) `pixel` held for before and no longer holds for after. */
export function lost(before: Raster, after: Raster, pixel: Pixel): Array<{ x: number; y: number }> {
  if (before.width !== after.width || before.height !== after.height) throw new Error('lost: rasters differ in size');
  const out: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < before.height; y++) {
    for (let x = 0; x < before.width; x++) if (pixel(...at(before, x, y)) && !pixel(...at(after, x, y))) out.push(toPage(before, x, y));
  }
  return out;
}

/** Whether a page point lies in any box, give or take `slack` points (a pixel's anti-aliased edge). */
export const inAny = (point: { x: number; y: number }, boxes: readonly Box[], slack = 1 / SCALE): boolean =>
  boxes.some((b) => point.x >= b.left - slack && point.x <= b.right + slack && point.y >= b.bottom - slack && point.y <= b.top + slack);

/** The pixels inside a box (inset by `inset` points), as RGB triples. */
export function inside(raster: Raster, box: Box, inset = 0.5): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  const x0 = Math.ceil((box.left + inset) * SCALE);
  const x1 = Math.floor((box.right - inset) * SCALE);
  const y0 = Math.ceil((raster.pageHeight - box.top + inset) * SCALE);
  const y1 = Math.floor((raster.pageHeight - box.bottom - inset) * SCALE);
  for (let y = Math.max(0, y0); y < Math.min(raster.height, y1); y++) for (let x = Math.max(0, x0); x < Math.min(raster.width, x1); x++) out.push(at(raster, x, y));
  return out;
}

/** WCAG relative luminance of an sRGB pixel. */
export function luminance([r, g, b]: readonly [number, number, number]): number {
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between the lightest and the darkest of these pixels. */
export function contrast(pixels: ReadonlyArray<readonly [number, number, number]>): number {
  const lums = pixels.map(luminance);
  return (Math.max(...lums) + 0.05) / (Math.min(...lums) + 0.05);
}

/** The raster as a PNG (8-bit RGB, no filter). */
export function png(raster: Raster): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(raster.width, 0);
  header.writeUInt32BE(raster.height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc(raster.height * (raster.width * 3 + 1));
  for (let y = 0; y < raster.height; y++) {
    const row = y * (raster.width * 3 + 1);
    rows[row] = 0;
    rows.set(raster.rgb.subarray(y * raster.width * 3, (y + 1) * raster.width * 3), row + 1);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
