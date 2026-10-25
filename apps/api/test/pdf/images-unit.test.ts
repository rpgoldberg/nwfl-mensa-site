// REDACT R3b fix 1: which pictures "blur" can decode. Anything it cannot is
// hidden behind the fill instead, never kept.
import { deflateSync } from 'node:zlib';
import { type PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { FILL_GRAY, applyImagePolicy, blurred, hasInlinePicture, keepsPicture, pictureWindows } from '../../src/pdf/images.js';

type Dict = Record<string, unknown>;

/** The picture `applyImagePolicy` leaves for one stream: its size and samples. */
async function after(dict: (doc: PDFDocument) => Dict, contents: Uint8Array, action: 'blur' | 'hide' | 'show' = 'blur') {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ref = doc.context.register(PDFRawStream.of(doc.context.obj({ Type: 'XObject', Subtype: 'Image', ...dict(doc) } as never) as unknown as PDFDict, contents));
  applyImagePolicy(doc, action);
  const out = doc.context.lookup(ref) as PDFRawStream;
  const size = (key: string) => (out.dict.lookup(PDFName.of(key)) as PDFNumber | undefined)?.asNumber();
  const samples = out.dict.has(PDFName.of('Filter')) ? decodePDFRawStream(out).decode() : out.contents;
  return { width: size('Width'), height: size('Height'), fill: size('Width') === 1 && samples.length === 1 && samples[0] === FILL_GRAY, kept: out.contents === contents };
}

const gray = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => i & 0xff));
const base = { Width: 30, Height: 20, BitsPerComponent: 8, ColorSpace: 'DeviceGray' };
const icc = (n: number) => (doc: PDFDocument): Dict => ({ ...base, ColorSpace: [PDFName.of('ICCBased'), doc.context.register(doc.context.stream('', { N: n }))] });

describe('applyImagePolicy under "blur"', () => {
  it('blurs 8-bit grey and RGB, raw or Flate, and ICC profiles of 1 or 3 channels', async () => {
    expect(await after(() => base, gray(600))).toMatchObject({ width: 24, height: 16, fill: false });
    expect(await after(() => ({ ...base, Filter: 'FlateDecode' }), deflateSync(gray(600)))).toMatchObject({ width: 24, fill: false });
    expect(await after(() => ({ ...base, ColorSpace: 'DeviceRGB' }), gray(1800))).toMatchObject({ width: 24, fill: false });
    expect(await after(icc(1), gray(600))).toMatchObject({ width: 24, fill: false });
    expect(await after(icc(3), gray(1800))).toMatchObject({ width: 24, fill: false });
    expect(await after(() => ({ ...base, Width: 5, Height: 4 }), gray(20))).toMatchObject({ width: 5, height: 4, fill: false });
  });

  it('hides what it cannot decode', async () => {
    const cases: Array<[(doc: PDFDocument) => Dict, Uint8Array]> = [
      [icc(4), gray(2400)],
      [(doc) => ({ ...base, ColorSpace: [PDFName.of('ICCBased'), doc.context.register(doc.context.stream('', {}))] }), gray(600)],
      [() => ({ ...base, ColorSpace: [PDFName.of('Indexed'), PDFName.of('DeviceRGB'), 1, '(abcdef)'] }), gray(600)],
      [() => ({ ...base, ColorSpace: 'DeviceCMYK' }), gray(2400)],
      [() => ({ ...base, BitsPerComponent: 1 }), gray(80)],
      [() => ({ ...base, ImageMask: true }), gray(80)],
      [() => ({ ...base, Decode: [1, 0] }), gray(600)],
      [() => ({ ...base, Filter: 'FlateDecode', DecodeParms: { Predictor: 12 } }), deflateSync(gray(600))],
      [() => ({ ...base, Filter: 'CCITTFaxDecode' }), gray(600)],
      [() => ({ ...base, Width: 0 }), gray(600)],
      [() => ({ ...base, Height: undefined }), gray(600)],
      [() => base, gray(10)],
      [() => ({ ...base, Filter: 'FlateDecode' }), gray(600)],
      [() => ({ ...base, Filter: 'DCTDecode' }), gray(600)],
    ];
    for (const [dict, contents] of cases) expect(await after(dict, contents)).toMatchObject({ width: 1, height: 1, fill: true });
  });

  it('hides everything under "hide" and keeps everything under "show"', async () => {
    expect(await after(() => base, gray(600), 'hide')).toMatchObject({ fill: true });
    expect(await after(() => base, gray(600), 'show')).toMatchObject({ kept: true, width: 30 });
  });
});

describe('blurred', () => {
  it('averages: a flat picture stays flat at its new size', () => {
    const out = blurred({ width: 48, height: 2, channels: 1, data: new Uint8Array(96).fill(77) });
    expect([out.width, out.height]).toEqual([24, 1]);
    expect([...out.data].every((v) => v === 77)).toBe(true);
  });
});

describe('hasInlinePicture', () => {
  it('finds BI as an operator only', () => {
    const t = (s: string) => hasInlinePicture(new Uint8Array(Buffer.from(s, 'latin1')));
    expect(t('q BI /W 1 /H 1 ID x EI Q')).toBe(true);
    expect(t('BI\n/W 1')).toBe(true);
    expect(t('<4142> Tj /FBI Do 0 BIG')).toBe(false);
    // PDF whitespace is NUL, tab, LF, FF, CR and space; nothing else (not U+00A0).
    expect(t('q\x00BI\x00/W 1')).toBe(true);
    expect(t('q\fBI\f/W 1')).toBe(true);
    expect(t('q\xa0BI\xa0/W 1')).toBe(false);
  });
});

describe('pictureWindows and keepsPicture', () => {
  it('keeps windows of varied samples at a stride of 32 and finds any of them at any offset', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const varied = new Uint8Array(Array.from({ length: 640 }, (_, i) => (i * 131 + 7) & 0xff));
    doc.context.register(PDFRawStream.of(doc.context.obj({ Type: 'XObject', Subtype: 'Image', ...base, Width: 32, Height: 20 }) as unknown as PDFDict, varied));
    // A flat picture says nothing about anyone: its windows are not kept (they would match any run of one byte).
    doc.context.register(PDFRawStream.of(doc.context.obj({ Type: 'XObject', Subtype: 'Image', ...base, Width: 32, Height: 20 }) as unknown as PDFDict, new Uint8Array(640).fill(255)));
    const windows = await pictureWindows(await doc.save());
    expect(windows.size).toBe(19);
    const copyWith = (run: Uint8Array) => new Uint8Array(Buffer.concat([Buffer.from('%PDF-1.7\n1 0 obj\n<< /Length ' + run.length + ' >>\nstream\n'), run, Buffer.from('\nendstream\nendobj\n%%EOF\n')]));
    expect(await keepsPicture(copyWith(varied.subarray(101, 197)), windows)).toBe(true);
    expect(await keepsPicture(copyWith(varied.subarray(101, 160)), windows)).toBe(false);
    expect(await keepsPicture(copyWith(new Uint8Array(300).fill(255)), windows)).toBe(false);
    expect(await keepsPicture(new Uint8Array(Buffer.from('not a pdf')), windows)).toBe(false);
    expect((await pictureWindows(new Uint8Array(Buffer.from('not a pdf')))).size).toBe(0);
  });
});
