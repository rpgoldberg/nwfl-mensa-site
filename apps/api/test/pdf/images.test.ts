// REDACT R3b fix 1: a copy applies the audience's image policy. "show" keeps
// each picture as it is; "hide" puts an opaque neutral fill in its place;
// "blur" keeps at most 24 px of it on the long side, blurred, with nothing
// else. A picture that cannot be decoded under "blur" is hidden; one that
// cannot be replaced at all means no copy. Every name here is made up.
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { PDFDocument, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from '@cantoo/pdf-lib';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { BLUR_MAX, FILL_GRAY, keepsPicture, pictureWindows } from '../../src/pdf/images.js';
import { type RedactResult, redactPdf } from '../../src/pdf/redact.js';
import { extractAll } from './extract.js';

const NAME = 'Quillon Brask';
const INLINE = 'ZQXJ'.repeat(12); // a 4 x 4 RGB inline picture

/** Smooth noise: a photo's worth of pixels that a JPEG keeps. */
function pixels(width: number, height: number, channels: number): Buffer {
  const out = Buffer.alloc(width * height * channels);
  for (let i = 0; i < out.length; i++) out[i] = (Math.sin(i * 0.37) * 60 + Math.cos(i * 0.011) * 60 + 128) & 0xff;
  return out;
}

const jpegBytes = (): Buffer => {
  const rgba = Buffer.alloc(96 * 64 * 4);
  const rgb = pixels(96, 64, 3);
  for (let p = 0; p < 96 * 64; p++) rgb.copy(rgba, p * 4, p * 3, p * 3 + 3), (rgba[p * 4 + 3] = 255);
  return jpeg.encode({ width: 96, height: 64, data: rgba }, 90).data;
};

interface Fixture {
  pdf: Uint8Array;
  /** Each picture stream's bytes as stored in the original. */
  pictures: Buffer[];
}

/**
 * A page naming NAME, with a JPEG photo, a Flate RGB picture carrying XMP and a soft mask, an
 * undecodable JPEG 2000 picture, and an inline picture; `form` draws the inline picture inside a
 * form XObject instead (PDFium does not rewrite a form's content).
 */
async function fixture(options: { form?: boolean } = {}): Promise<Fixture> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([612, 792]);
  const { context } = doc;
  page.node.setFontDictionary(PDFName.of('F1'), context.register(context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' })));
  const image = { Type: 'XObject', Subtype: 'Image', BitsPerComponent: 8 };
  const photo = jpegBytes();
  const flate = deflateSync(pixels(40, 30, 3));
  const mask = deflateSync(pixels(40, 30, 1));
  const jpx = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7 + 3) & 0xff));
  const xmp = context.register(context.stream('<x:xmpmeta>Photographer Halvorsine</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' }));
  const smask = context.register(PDFRawStream.of(context.obj({ ...image, Width: 40, Height: 30, ColorSpace: 'DeviceGray', Filter: 'FlateDecode' }), mask));
  page.node.setXObject(PDFName.of('Photo'), context.register(PDFRawStream.of(context.obj({ ...image, Width: 96, Height: 64, ColorSpace: 'DeviceRGB', Filter: 'DCTDecode' }), photo)));
  page.node.setXObject(
    PDFName.of('Pic'),
    context.register(PDFRawStream.of(context.obj({ ...image, Width: 40, Height: 30, ColorSpace: 'DeviceRGB', Filter: 'FlateDecode', Metadata: xmp, SMask: smask }), flate)),
  );
  page.node.setXObject(PDFName.of('Jpx'), context.register(PDFRawStream.of(context.obj({ ...image, Width: 10, Height: 10, ColorSpace: 'DeviceRGB', Filter: 'JPXDecode' }), jpx)));
  const inline = `q 50 0 0 50 400 300 cm BI /W 4 /H 4 /CS /RGB /BPC 8 ID ${INLINE} EI Q`;
  if (options.form === true) {
    page.node.setXObject(PDFName.of('Fm'), context.register(context.stream(inline, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 612, 792] })));
  }
  const content = [
    'BT /F1 12 Tf 72 700 Td (Please call Quillon Brask about the picnic.) Tj ET',
    'BT /F1 12 Tf 72 680 Td (This closing line stays readable.) Tj ET',
    'q 192 0 0 128 72 400 cm /Photo Do Q',
    'q 120 0 0 90 300 400 cm /Pic Do Q',
    'q 30 0 0 30 72 200 cm /Jpx Do Q',
    options.form === true ? '/Fm Do' : inline,
  ].join('\n');
  page.node.set(PDFName.of('Contents'), context.register(context.stream(content)));
  return { pdf: await doc.save({ useObjectStreams: false }), pictures: [photo, flate, mask, jpx] };
}

function copyOf(result: RedactResult): Uint8Array {
  if (result.kind !== 'redacted') throw new Error(`expected a redacted copy, got ${JSON.stringify(result)}`);
  return result.pdf;
}

interface Picture {
  width: number;
  height: number;
  dict: string;
  samples: Buffer;
  sha: string;
}

/** Every picture stream in a PDF, decoded. */
async function picturesIn(bytes: Uint8Array): Promise<Picture[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const out: Picture[] = [];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream) || object.dict.lookup(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    const size = (key: string): number => (object.dict.lookup(PDFName.of(key)) as PDFNumber).asNumber();
    const filtered = object.dict.lookup(PDFName.of('Filter')) !== undefined;
    out.push({
      width: size('Width'),
      height: size('Height'),
      dict: object.dict.toString(),
      samples: Buffer.from(filtered ? decodePDFRawStream(object).decode() : object.contents),
      sha: createHash('sha256').update(object.contents).digest('hex'),
    });
  }
  return out;
}

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
/** A 64-byte window from the middle of a picture's stored bytes, searched for in the copy as written. */
const windowIn = (copy: Uint8Array, picture: Buffer): boolean => {
  const at = Math.max(0, Math.floor(picture.length / 2) - 32);
  return Buffer.from(copy).includes(picture.subarray(at, at + 64));
};

describe('an image policy of "blur"', () => {
  it('keeps no byte of any original picture, and each picture at most 24 px, blurred, with nothing beside it', async () => {
    const { pdf, pictures } = await fixture();
    const copy = copyOf(await redactPdf(pdf, { quotes: [NAME], redactsAny: true, image: 'blur' }));
    const found = await picturesIn(copy);
    expect(found.length).toBeGreaterThanOrEqual(3);
    for (const original of pictures) {
      expect(found.map((p) => p.sha)).not.toContain(sha(original));
      expect(windowIn(copy, original)).toBe(false);
    }
    expect(Buffer.from(copy).includes(Buffer.from(INLINE))).toBe(false);
    expect(Buffer.from(copy).toString('latin1')).not.toMatch(/Halvorsine|\/SMask|\/Metadata/);
    expect(BLUR_MAX).toBe(24);
    for (const picture of found) {
      expect(Math.max(picture.width, picture.height)).toBeLessThanOrEqual(BLUR_MAX);
      expect(picture.samples.length).toBe(picture.width * picture.height * (picture.dict.includes('/DeviceGray') ? 1 : 3));
    }
    // The photo, 96 x 64, keeps its shape: 24 x 16.
    expect(found.some((p) => p.width === 24 && p.height === 16 && p.dict.includes('/DeviceRGB'))).toBe(true);
    // The Flate picture, 40 x 30: 24 x 18.
    expect(found.some((p) => p.width === 24 && p.height === 18)).toBe(true);
    const text = await extractAll(copy);
    expect(text).not.toContain(NAME);
    expect(text).toContain('This closing line stays readable.');
  }, 60_000);

  it('hides a picture it cannot decode (JPEG 2000) behind a fill', async () => {
    const { pdf } = await fixture();
    const found = await picturesIn(copyOf(await redactPdf(pdf, { quotes: [], redactsAny: true, image: 'blur' })));
    expect(found.filter((p) => p.width === 1 && p.height === 1 && p.samples.equals(Buffer.from([FILL_GRAY])))).not.toHaveLength(0);
  }, 60_000);
});

describe('an image policy of "hide"', () => {
  it('puts a 1 x 1 neutral fill, drawn at the picture\'s size, in place of every picture', async () => {
    const { pdf, pictures } = await fixture();
    const copy = copyOf(await redactPdf(pdf, { quotes: [], redactsAny: true, image: 'hide' }));
    const found = await picturesIn(copy);
    expect(found.length).toBeGreaterThanOrEqual(4);
    for (const picture of found) {
      expect([picture.width, picture.height]).toEqual([1, 1]);
      expect(picture.dict).toContain('/DeviceGray');
      expect(picture.samples.equals(Buffer.from([FILL_GRAY]))).toBe(true);
    }
    for (const original of pictures) expect(windowIn(copy, original)).toBe(false);
    expect(Buffer.from(copy).includes(Buffer.from(INLINE))).toBe(false);
    expect(await extractAll(copy)).toContain('Please call Quillon Brask');
  }, 60_000);

  it('gives no copy when a picture cannot be replaced (inline in a form), with the reason', async () => {
    const { pdf } = await fixture({ form: true });
    expect(await redactPdf(pdf, { quotes: [], redactsAny: true, image: 'hide' })).toEqual({
      kind: 'refused',
      reason: 'an inline picture cannot be replaced',
    });
    expect(await redactPdf(pdf, { quotes: [], redactsAny: true, image: 'blur' })).toMatchObject({ kind: 'refused' });
  }, 60_000);
});

describe('an image policy of "show"', () => {
  it('keeps the original picture bytes (the officers\' and members\' copies)', async () => {
    const { pdf, pictures } = await fixture();
    const copy = copyOf(await redactPdf(pdf, { quotes: [NAME], redactsAny: true, image: 'show' }));
    const found = await picturesIn(copy);
    const [photo, flate] = pictures as [Buffer, Buffer];
    expect(found.map((p) => p.sha)).toContain(sha(flate));
    expect(windowIn(copy, flate)).toBe(true);
    // The JPEG keeps its scan (jpeg.ts strips only what does not draw it).
    expect(windowIn(copy, photo)).toBe(true);
    expect(await redactPdf(pdf, { quotes: [], redactsAny: false, image: 'show' })).toEqual({ kind: 'original' });
    expect(await redactPdf(pdf, { quotes: [], redactsAny: false })).toEqual({ kind: 'original' });
  }, 60_000);

  it('is not the original when the image policy is not "show", even with nothing else redacted', async () => {
    const { pdf } = await fixture();
    expect((await redactPdf(pdf, { quotes: [], redactsAny: false, image: 'hide' })).kind).toBe('redacted');
  }, 60_000);
});

describe('pictureWindows and keepsPicture (the last check before a copy is given)', () => {
  it('finds an original picture left in a copy, and ignores pictures too small to tell', async () => {
    const { pdf, pictures } = await fixture();
    const windows = await pictureWindows(pdf);
    expect(windows).toHaveLength(4);
    expect(keepsPicture(pdf, windows)).toBe(true);
    expect(keepsPicture(new Uint8Array(Buffer.from('%PDF-1.7\n%%EOF\n')), windows)).toBe(false);
    expect(windows.every((w) => pictures.some((p) => p.includes(w)))).toBe(true);
    expect(await pictureWindows(new Uint8Array(Buffer.from('not a pdf')))).toEqual([]);
  }, 60_000);

  it('refuses a copy that still holds an original picture', async () => {
    const { pdf } = await fixture();
    const reason = 'an original picture is still in the copy';
    const sanitizeKeeping = async (bytes: Uint8Array): Promise<Uint8Array> => bytes;
    expect(await redactPdf(pdf, { quotes: [], redactsAny: true, image: 'hide' }, { sanitize: sanitizeKeeping })).toEqual({ kind: 'refused', reason });
  }, 60_000);
});
