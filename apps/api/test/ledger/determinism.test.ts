// REDACT R-LEDGER item 4: the same PDF inputs and the same engine give a
// byte-identical copy, so a ledger hash can be checked by making the copy
// again. The engine already writes no time and no random id: pdf-lib is
// opened with updateMetadata off, and sanitize.ts rebuilds every copy into a
// fresh document, which drops the original's Info dates and trailer /ID. This
// holds it: two runs over a second apart, from originals that carry dates.
// Every name here is made up.
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { redactPdf } from '../../src/pdf/redact.js';
import { leakFixture, pictureUnderTextFixture } from '../pdf/fixtures.js';

/** An original WITH a creation and a modification date (pdf-lib's default), and a producer. */
async function datedOriginal(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('Minutes');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText('Minutes taken by Quillon Brask.', { x: 72, y: 700, size: 12, font });
  return doc.save({ useObjectStreams: false });
}

const make = async (original: Uint8Array, quotes: string[], image: 'show' | 'blur' | 'hide'): Promise<Buffer> => {
  const result = await redactPdf(original, { quotes, redactsAny: true, image });
  if (result.kind !== 'redacted') throw new Error(`expected a copy, got ${result.kind}`);
  return Buffer.from(result.pdf);
};

describe('the PDF engine is deterministic', () => {
  it.each([
    ['a dated original', datedOriginal, ['Quillon Brask'], 'show'],
    ['text over a picture, blurred', pictureUnderTextFixture, ['Pellingham'], 'blur'],
    ['the leak fixture, pictures hidden', leakFixture, ['Quillon Brask', 'Marvel Ostrander'], 'hide'],
  ] as const)('gives byte-identical copies of %s', async (_label, build, quotes, image) => {
    const original = await build();
    expect(Buffer.from(original).toString('latin1')).toMatch(_label === 'a dated original' ? /CreationDate/ : /%PDF/);
    const first = await make(original, [...quotes], image);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await make(original, [...quotes], image);
    expect(second.equals(first)).toBe(true);
    expect(first.toString('latin1')).not.toMatch(/\/(CreationDate|ModDate|ID)\b/);
  });
});
