// REDACT R3b carry-in: short quotes. A quote of fewer than SHORT_QUOTE
// normalized letters or digits ("Bo") turns up by chance in picture samples
// and font programs, so those are searched only for longer quotes. A short
// quote is still searched everywhere else: page text, content streams,
// strings, names, metadata and the rest of the file. Every name is made up.
import { deflateSync } from 'node:zlib';
import { PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { SHORT_QUOTE, checkCopy, normalizedLength } from '../../src/pdf/gate.js';
import { redactPdf } from '../../src/pdf/redact.js';
import { extractAll } from './extract.js';

const B = (s: string | Buffer): Buffer => (typeof s === 'string' ? Buffer.from(s, 'latin1') : s);
const stream = (dict: string, data: string | Buffer): Buffer => Buffer.concat([B(`<< ${dict} /Length ${B(data).length} >>\nstream\n`), B(data), B('\nendstream')]);

/** A one-page PDF (objects 1 to 5) whose page resources may name more objects from 6 on. */
function pdf(content: string, extra: Array<string | Buffer> = [], resources = ''): Uint8Array {
  const objects: Array<string | Buffer> = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> ${resources} >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    stream('', content),
    ...extra,
  ];
  const parts: Buffer[] = [B('%PDF-1.7\n')];
  let at = parts[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(at);
    const chunk = Buffer.concat([B(`${i + 1} 0 obj\n`), B(body), B('\nendobj\n')]);
    parts.push(chunk);
    at += chunk.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  parts.push(B(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}

const PAGE = 'BT /F1 12 Tf 72 700 Td (Hello from the editor.) Tj ET';
const LONG = 'Quillon Brask';
/** A picture XObject whose samples are these bytes, drawn nowhere. */
const image = (samples: string, dict = '', flate = false): Uint8Array =>
  pdf(PAGE, [stream(`/Type /XObject /Subtype /Image /Width 4 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 ${flate ? '/Filter /FlateDecode ' : ''}${dict}`, flate ? deflateSync(B(samples)) : samples)], '/XObject << /Im1 6 0 R >>');
/** An embedded TrueType font program holding these bytes. */
const fontProgram = (bytes: string, key = 'FontFile2'): Uint8Array =>
  pdf(PAGE, [`<< /Type /FontDescriptor /FontName /Embedded /Flags 32 /${key} 7 0 R >>`, stream(key === 'FontFile3' ? '/Subtype /Type1C' : `/Length1 ${bytes.length}`, bytes)]);

describe('normalizedLength', () => {
  it('counts the folded letters and digits only', () => {
    expect(normalizedLength('Bo')).toBe(2);
    expect(normalizedLength(' -- ')).toBe(0);
    expect(normalizedLength('  B-o. ')).toBe(2);
    expect(normalizedLength('Bo Ek')).toBe(4);
    expect(normalizedLength('Ébo 12')).toBe(5);
    expect(SHORT_QUOTE).toBe(5);
  });
});

describe('the gate with a short quote', () => {
  it('ignores it in picture samples, raw or compressed', async () => {
    expect(await checkCopy(image(' Bo \x00'), ['Bo'])).toBeNull();
    expect(await checkCopy(image(' Bo \x00', '', true), ['Bo'])).toBeNull();
    expect(await checkCopy(image(' bo ek '), ['Bo Ek'])).toBeNull();
  });

  it('ignores it in font programs of every kind', async () => {
    expect(await checkCopy(fontProgram('\x00 Bo \x01'), ['Bo'])).toBeNull();
    expect(await checkCopy(fontProgram('\x00 Bo \x01', 'FontFile'), ['Bo'])).toBeNull();
    expect(await checkCopy(fontProgram('\x00 Bo \x01', 'FontFile3'), ['Bo'])).toBeNull();
  });

  it('still finds it in the page text, a content stream, a string, a picture dictionary and the file', async () => {
    expect(await checkCopy(pdf('BT /F1 12 Tf 72 700 Td (Ask Bo today.) Tj ET'), ['Bo'])).toMatch(/withheld text/);
    expect(await checkCopy(pdf(PAGE, [stream('', '(Bo) Tj')]), ['Bo'])).toMatch(/object 6/);
    expect(await checkCopy(pdf(PAGE, ['<< /Author (Bo) >>']), ['Bo'])).toMatch(/object 6/);
    expect(await checkCopy(image('\x00\x00\x00\x00', '/Name (Bo)'), ['Bo'])).toMatch(/object 6/);
    const trailing = Buffer.concat([Buffer.from(pdf(PAGE)), B('% Bo\n')]);
    expect(await checkCopy(new Uint8Array(trailing), ['Bo'])).toBe('withheld text is still in the file');
  });
});

describe('the gate with a quote of SHORT_QUOTE letters or more', () => {
  it('still searches picture samples and font programs', async () => {
    expect(await checkCopy(image(` ${LONG} `), [LONG])).toMatch(/object 6/);
    expect(await checkCopy(image(` ${LONG} `, '', true), [LONG])).toMatch(/object 6/);
    expect(await checkCopy(image(' bobby '), ['Bobby'])).toMatch(/object 6/);
    expect(await checkCopy(fontProgram(` ${LONG} `), [LONG])).toMatch(/object 7/);
  });

  it('searches samples for the long quote while ignoring the short one beside it', async () => {
    expect(await checkCopy(image(' Bo \x00'), ['Bo', LONG])).toBeNull();
    expect(await checkCopy(image(` Bo ${LONG} `), ['Bo', LONG])).toMatch(/object 6/);
  });
});

/** Deterministic noise: a photo's worth of samples. */
function noise(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = 0x2545f491;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/** A page naming "Bo", with a photo of noise beside the text (not under it). */
async function photoFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([612, 792]);
  const { context } = doc;
  const side = 320;
  page.node.setFontDictionary(PDFName.of('F1'), context.register(context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' })));
  page.node.setXObject(
    PDFName.of('Photo'),
    context.register(context.flateStream(noise(side * side * 3), { Type: 'XObject', Subtype: 'Image', Width: side, Height: side, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 })),
  );
  const content = [
    'BT /F1 12 Tf 72 700 Td (Please ask Bo about the picnic.) Tj ET',
    'BT /F1 12 Tf 72 680 Td (This closing line stays readable.) Tj ET',
    'q 200 0 0 200 72 300 cm /Photo Do Q',
  ].join('\n');
  page.node.set(PDFName.of('Contents'), context.register(context.flateStream(content)));
  return doc.save({ useObjectStreams: false });
}

describe('"Bo" on a page with a photo (the carry-in case)', () => {
  it('gives a copy with "Bo" removed and the rest readable', async () => {
    const original = await photoFixture();
    expect(await extractAll(original)).toMatch(/\bBo\b/);
    const result = await redactPdf(original, { quotes: ['Bo'], redactsAny: true });
    expect(result.kind, JSON.stringify(result).slice(0, 200)).toBe('redacted');
    const copy = (result as { pdf: Uint8Array }).pdf;
    const text = await extractAll(copy);
    expect(text).not.toMatch(/\bBo\b/);
    expect(text).toContain('picnic');
    expect(text).toContain('This closing line stays readable.');
  }, 60_000);

  it('refuses the copy when "Bo" is still in its text', async () => {
    expect(await checkCopy(await photoFixture(), ['Bo'])).toMatch(/withheld text/);
  }, 60_000);
});
