// REDACT R3a fix 1: a JPEG in a redacted copy keeps only what draws it.
import { describe, expect, it } from 'vitest';
import { stripJpeg } from './jpeg.js';

const seg = (marker: number, body: string | number[]): Buffer => {
  const data = typeof body === 'string' ? Buffer.from(body, 'latin1') : Buffer.from(body);
  return Buffer.concat([Buffer.from([0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 0xff]), data]);
};
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const JFIF = seg(0xe0, 'JFIF\0\x01\x01\0\0\x01\0\x01\0\0');
const ICC = seg(0xe2, 'ICC_PROFILE\0\x01\x01profile');
const ADOBE = seg(0xee, 'Adobe\0\x64\0\0\0\0\x01');
const DQT = seg(0xdb, [0, ...new Array<number>(64).fill(1)]);
const SOF = seg(0xc0, [8, 0, 8, 0, 8, 1, 1, 0x11, 0]);
const SOS = seg(0xda, [1, 1, 0, 0, 63, 0]);
// Entropy data with a stuffed 0xFF00, a restart marker and a fill byte before the next marker.
const SCAN = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff]);

describe('stripJpeg', () => {
  it('keeps JFIF, ICC, Adobe, the tables, frame and scan, and drops comments, EXIF, XMP and other APPn', () => {
    const input = Buffer.concat([
      SOI, JFIF, seg(0xfe, 'Photo by Xavia Penhallow'), seg(0xe1, 'Exif\0\0Xavia Penhallow'), seg(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x>Xavia Penhallow</x>'),
      ICC, seg(0xed, 'Photoshop 3.0\0Xavia'), ADOBE, seg(0xe0, 'JFXX\0thumb'), DQT, SOF, SOS, SCAN, EOI,
    ]);
    const out = Buffer.from(stripJpeg(input));
    expect(out.toString('latin1')).not.toContain('Xavia');
    expect(out.toString('latin1')).not.toContain('JFXX');
    expect(out.equals(Buffer.concat([SOI, JFIF, ICC, ADOBE, DQT, SOF, SOS, SCAN, EOI]))).toBe(true);
  });

  it('keeps every scan of a progressive JPEG, with the tables between them', () => {
    const DHT = seg(0xc4, [0, ...new Array<number>(16).fill(0)]);
    const input = Buffer.concat([SOI, SOF, SOS, SCAN, DHT, SOS, Buffer.from([0x99]), EOI]);
    expect(Buffer.from(stripJpeg(input)).equals(input)).toBe(true);
  });

  it('drops anything after the end of the image', () => {
    const input = Buffer.concat([SOI, SOF, SOS, SCAN, EOI, Buffer.from('Xavia Penhallow', 'latin1')]);
    expect(Buffer.from(stripJpeg(input)).equals(Buffer.concat([SOI, SOF, SOS, SCAN, EOI]))).toBe(true);
  });

  it('skips fill bytes before a marker', () => {
    const input = Buffer.concat([SOI, Buffer.from([0xff]), SOF, SOS, SCAN, EOI]);
    expect(Buffer.from(stripJpeg(input)).equals(Buffer.concat([SOI, SOF, SOS, SCAN, EOI]))).toBe(true);
  });

  it('throws on a file that is not a JPEG, a cut-off segment, bytes between segments, or no end', () => {
    expect(() => stripJpeg(Buffer.from('not a jpeg'))).toThrow('a picture cannot be read');
    expect(() => stripJpeg(Buffer.concat([SOI, SOF.subarray(0, 6)]))).toThrow('a picture cannot be read');
    expect(() => stripJpeg(Buffer.concat([SOI, Buffer.from([0x00]), SOF]))).toThrow('a picture cannot be read');
    expect(() => stripJpeg(Buffer.concat([SOI, SOF, SOS, SCAN]))).toThrow('a picture cannot be read');
    expect(() => stripJpeg(Buffer.concat([SOI, SOF]))).toThrow('a picture cannot be read');
  });
});
