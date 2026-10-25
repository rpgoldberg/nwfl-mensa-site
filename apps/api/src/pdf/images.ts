// ============================================================================
// REDACT R3b fix 1: a copy applies the audience's image policy (0012's
// "image" cell) to every picture XObject in it.
//
//   show   the picture as it is;
//   hide   a 1 x 1 opaque neutral grey picture in its place, which the page
//          draws at the picture's size (its matrix is unchanged);
//   blur   the picture decoded, scaled down to at most BLUR_MAX pixels on its
//          long side, box-blurred, and written as a new Flate picture with
//          nothing else (no metadata, mask or name), drawn at the same size.
//          A picture that cannot be decoded (JPEG 2000, CCITT, JBIG2, a
//          colour space or depth other than 8-bit grey or RGB, a predictor,
//          a Decode array, a stencil mask) is hidden instead.
//
// Inline pictures: PDFium writes each one on a page as a picture XObject when
// it regenerates the page (redact.ts makes it), so one left in any content
// stream (a form's, which PDFium does not rewrite) means no copy.
//
// Last, before a copy is given: a 64-byte window from the middle of each
// original picture's stored bytes must not be found in the copy.
// ============================================================================
import { PDFArray, PDFDocument, type PDFContext, PDFName, PDFNumber, PDFRawStream, PDFBool, decodePDFRawStream } from '@cantoo/pdf-lib';
import jpeg from 'jpeg-js';

export type ImageAction = 'show' | 'blur' | 'hide';

/** The longest side, in pixels, of a blurred picture. */
export const BLUR_MAX = 24;
/** The grey of a hidden picture's fill. */
export const FILL_GRAY = 160;

const IMAGE = PDFName.of('Image');
const DCT = PDFName.of('DCTDecode');
const DECODABLE = new Set(['/FlateDecode', '/LZWDecode', '/ASCIIHexDecode', '/ASCII85Decode', '/RunLengthDecode']);
const WINDOW = 64;

interface Pixels {
  width: number;
  height: number;
  channels: 1 | 3;
  data: Uint8Array;
}

const isPicture = (object: unknown): object is PDFRawStream => object instanceof PDFRawStream && object.dict.lookup(PDFName.of('Subtype')) === IMAGE;

/** The channels of an 8-bit grey or RGB colour space, or null. */
function channelsOf(context: PDFContext, space: unknown): 1 | 3 | null {
  if (space === PDFName.of('DeviceGray')) return 1;
  if (space === PDFName.of('DeviceRGB')) return 3;
  if (space instanceof PDFArray && space.size() === 2 && space.lookup(0) === PDFName.of('ICCBased')) {
    const profile = context.lookup(space.get(1));
    const n = profile instanceof PDFRawStream ? profile.dict.lookup(PDFName.of('N')) : undefined;
    if (n instanceof PDFNumber && (n.asNumber() === 1 || n.asNumber() === 3)) return n.asNumber() as 1 | 3;
  }
  return null;
}

/** A picture's pixels, or null when it cannot be decoded. */
function decodePicture(picture: PDFRawStream): Pixels | null {
  const { dict } = picture;
  const number = (key: string): number | undefined => {
    const value = dict.lookup(PDFName.of(key));
    return value instanceof PDFNumber ? value.asNumber() : undefined;
  };
  const width = number('Width');
  const height = number('Height');
  if (width === undefined || height === undefined || width < 1 || height < 1) return null;
  if (dict.lookup(PDFName.of('ImageMask')) === PDFBool.True || dict.has(PDFName.of('Decode')) || dict.has(PDFName.of('DecodeParms'))) return null;
  const filter = dict.lookup(PDFName.of('Filter'));
  const filters = filter instanceof PDFArray ? filter.asArray().map((f) => dict.context.lookup(f)) : filter === undefined ? [] : [filter];
  try {
    if (filters.length === 1 && filters[0] === DCT) {
      const image = jpeg.decode(picture.contents, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 256 });
      const data = new Uint8Array(image.width * image.height * 3);
      for (let p = 0; p < image.width * image.height; p++) data.set(image.data.subarray(p * 4, p * 4 + 3), p * 3);
      return { width: image.width, height: image.height, channels: 3, data };
    }
    if (!filters.every((f) => DECODABLE.has(String(f))) || number('BitsPerComponent') !== 8) return null;
    const channels = channelsOf(dict.context, dict.lookup(PDFName.of('ColorSpace')));
    if (channels === null) return null;
    const data = filters.length === 0 ? picture.contents : decodePDFRawStream(picture).decode();
    if (data.length < width * height * channels) return null;
    return { width, height, channels, data };
  } catch {
    return null;
  }
}

/** Scaled down (box average) to at most BLUR_MAX on the long side, then a 3 x 3 box blur. */
export function blurred(source: Pixels): Pixels {
  const scale = Math.min(1, BLUR_MAX / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const c = source.channels;
  const small = new Float64Array(width * height * c);
  const counts = new Float64Array(width * height);
  for (let y = 0; y < source.height; y++) {
    const ty = Math.min(height - 1, Math.floor((y * height) / source.height));
    for (let x = 0; x < source.width; x++) {
      const t = ty * width + Math.min(width - 1, Math.floor((x * width) / source.width));
      counts[t] = (counts[t] as number) + 1;
      for (let k = 0; k < c; k++) small[t * c + k] = (small[t * c + k] as number) + (source.data[(y * source.width + x) * c + k] as number);
    }
  }
  const out = new Uint8Array(width * height * c);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let k = 0; k < c; k++) {
        let sum = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy;
            const xx = x + dx;
            if (yy < 0 || yy >= height || xx < 0 || xx >= width) continue;
            const t = yy * width + xx;
            sum += (small[t * c + k] as number) / (counts[t] as number);
            n++;
          }
        }
        out[(y * width + x) * c + k] = Math.round(sum / n);
      }
    }
  }
  return { width, height, channels: c, data: out };
}

const pictureDict = (context: PDFContext, pixels: Pixels) =>
  context.obj({ Type: 'XObject', Subtype: 'Image', Width: pixels.width, Height: pixels.height, ColorSpace: pixels.channels === 1 ? 'DeviceGray' : 'DeviceRGB', BitsPerComponent: 8 });

/** Every picture XObject replaced as `action` says (nothing for "show"). */
export function applyImagePolicy(doc: PDFDocument, action: ImageAction): void {
  if (action === 'show') return;
  const { context } = doc;
  for (const [ref, object] of [...context.enumerateIndirectObjects()]) {
    if (!isPicture(object)) continue;
    const pixels = action === 'blur' ? decodePicture(object) : null;
    if (pixels === null) {
      const fill: Pixels = { width: 1, height: 1, channels: 1, data: new Uint8Array([FILL_GRAY]) };
      context.assign(ref, PDFRawStream.of(pictureDict(context, fill), fill.data));
    } else {
      const small = blurred(pixels);
      const stream = context.flateStream(small.data);
      for (const [key, value] of pictureDict(context, small).entries()) stream.dict.set(key, value);
      context.assign(ref, stream);
    }
  }
}

/** Whether decoded content draws an inline picture. */
export const hasInlinePicture = (content: Uint8Array): boolean => /(?:^|[\s\]>)}])BI[\s/]/.test(Buffer.from(content).toString('latin1'));

/** A window from the middle of each picture's stored bytes in the original (pictures under 2 windows are too small to tell). */
export async function pictureWindows(original: Uint8Array): Promise<Buffer[]> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(original, { updateMetadata: false });
  } catch {
    return [];
  }
  const out: Buffer[] = [];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!isPicture(object) || object.contents.length < 2 * WINDOW) continue;
    const at = Math.floor(object.contents.length / 2) - WINDOW / 2;
    out.push(Buffer.from(object.contents.subarray(at, at + WINDOW)));
  }
  return out;
}

/** Whether the copy still holds any of these windows. */
export const keepsPicture = (copy: Uint8Array, windows: readonly Buffer[]): boolean => {
  const bytes = Buffer.from(copy);
  return windows.some((window) => bytes.includes(window));
};
