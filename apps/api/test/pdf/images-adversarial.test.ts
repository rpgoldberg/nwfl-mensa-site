// REDACT R3b fix 2: the challenger's fixtures (challenge-evidence/images.adv.test.ts),
// kept as they were written: a 16 x 16 RGB inline picture hidden from the
// public by "hide" or "blur", in a form behind NUL separators (PDF whitespace
// that \s does not match), in an ExtGState soft-mask group, on the page, and
// in a plain form. No copy may hold a 64-byte run of its pixels in any stream.
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { redactPdf } from '../../src/pdf/redact.js';

const NAME = 'Quillon Brask';
// 16x16 RGB, distinctive and non-repeating
const PIX = Buffer.alloc(16 * 16 * 3);
for (let i = 0; i < PIX.length; i++) PIX[i] = (i * 131 + 17 * (i >> 5) + 7) & 0xff;
const WIN = PIX.subarray(300, 364);

function inline(sep: string): Buffer {
  return Buffer.concat([
    Buffer.from(`q 100 0 0 100 300 300 cm${sep}BI${sep}/W 16 /H 16 /CS /RGB /BPC 8${sep}ID${sep === '\x00' ? ' ' : ' '}`, 'latin1'),
    PIX,
    Buffer.from(`${sep}EI${sep}Q\n`, 'latin1'),
  ]);
}

async function build(kind: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([612, 792]);
  const { context } = doc;
  page.node.setFontDictionary(PDFName.of('F1'), context.register(context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' })));
  let extra = Buffer.alloc(0);
  if (kind === 'smask-form') {
    const form = context.register(PDFRawStream.of(context.obj({ Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 612, 792], Group: { S: 'Transparency', CS: 'DeviceGray' } }), inline(' ')));
    const gs = context.obj({ Type: 'ExtGState', SMask: { Type: 'Mask', S: 'Luminosity', G: form } });
    const res = page.node.Resources()!;
    res.set(PDFName.of('ExtGState'), context.obj({ GS0: context.register(gs) }));
    extra = Buffer.from('q /GS0 gs 0 0 1 rg 300 300 100 100 re f Q\n');
  } else if (kind === 'nul-form') {
    const form = context.register(PDFRawStream.of(context.obj({ Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 612, 792] }), inline('\x00')));
    page.node.setXObject(PDFName.of('Fm1'), form);
    extra = Buffer.from('/Fm1 Do\n');
  } else if (kind === 'nul-page') {
    extra = inline('\x00');
  } else if (kind === 'space-form') {
    const form = context.register(PDFRawStream.of(context.obj({ Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 612, 792] }), inline(' ')));
    page.node.setXObject(PDFName.of('Fm1'), form);
    extra = Buffer.from('/Fm1 Do\n');
  }
  const content = Buffer.concat([Buffer.from(`BT /F1 14 Tf 72 700 Td (Minutes: ${NAME} spoke.) Tj ET\nBT /F1 14 Tf 72 650 Td (The picnic is on Saturday at the park.) Tj ET\n`), extra]);
  const cs = context.register(PDFRawStream.of(context.obj({}), content));
  page.node.set(PDFName.of('Contents'), cs);
  return doc.save({ useObjectStreams: false });
}

async function leaks(pdf: Uint8Array): Promise<string[]> {
  const where: string[] = [];
  if (Buffer.from(pdf).includes(WIN)) where.push('raw');
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  for (const [ref, o] of doc.context.enumerateIndirectObjects()) {
    if (!(o instanceof PDFRawStream)) continue;
    try { if (Buffer.from(decodePDFRawStream(o).decode()).includes(WIN)) where.push(`obj ${ref.objectNumber}`); } catch { /* */ }
  }
  return where;
}

describe('adversarial images', () => {
  for (const kind of ['space-form', 'nul-form', 'nul-page', 'smask-form']) {
    for (const image of ['hide', 'blur'] as const) {
      it(`${kind} ${image}`, async () => {
        const original = await build(kind);
        expect(await leaks(original)).not.toEqual([]); // positive control
        const r = await redactPdf(original, { quotes: [NAME], redactsAny: true, image });
        const l = r.kind === 'redacted' ? await leaks(r.pdf) : [];
        expect(l, `${kind} ${image}: ${r.kind} ${r.kind === 'refused' ? r.reason : ''}`).toEqual([]);
      });
    }
  }
});

describe('the last check before a copy is given', () => {
  // With sanitize skipped, nothing but the last check stands between the original pixels (now in
  // a picture XObject PDFium made of the inline picture) and the public: remove it and this fails.
  it('refuses a copy whose decoded streams hold a run of an original inline picture\'s samples', async () => {
    const original = await build('nul-page');
    const keep = (bytes: Uint8Array): Promise<Uint8Array> => Promise.resolve(bytes);
    for (const image of ['hide', 'blur'] as const) {
      expect(await redactPdf(original, { quotes: [NAME], redactsAny: true, image }, { sanitize: keep })).toEqual({
        kind: 'refused',
        reason: 'an original picture is still in the copy',
      });
    }
  }, 60_000);

  it('refuses the two challenger forms with a reason for officers', async () => {
    for (const kind of ['nul-form', 'smask-form']) {
      for (const image of ['hide', 'blur'] as const) {
        expect(await redactPdf(await build(kind), { quotes: [NAME], redactsAny: true, image })).toEqual({ kind: 'refused', reason: 'an inline picture cannot be replaced' });
      }
    }
  }, 60_000);
});
