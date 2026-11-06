// BOXLABEL fix round 2: layer (b) on its own. The gate takes a label's text out of its checks in two layers:
// (a) gate-labels.ts unlabelled, which masks a label only in PDFium's own font, and (b) the glyph check
// (drawn.ts), which reads the copy itself and skips a run only where pdf.js's glyphs and their text both spell a
// label. Round 2's challenger bypassed (a) with a name escape (R2-1) and showed that no test pinned (b): reading
// the masked bytes (mutant Nb5) or exempting on text alone (Nb1) let a lying label pass. Here (a) is replaced by
// one that masks every label whatever its font, as if bypassed, and (b) alone must refuse. Every name is made up.
// These PDFs are adversarial in shape: run this file only in the capped container.
import { PDFDict, PDFDocument, PDFName, type PDFContext, type PDFRef, PDFRawStream, decodePDFRawStream } from '@cantoo/pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { drawnBreak, type PageRef } from '../../src/pdf/drawn.js';
import * as labels from '../../src/pdf/gate-labels.js';
import { gateReply, gateVerdict } from '../../src/pdf/gate-rules.js';
import { redactPdf } from '../../src/pdf/redact.js';
import { twoMarksFixture } from './fixtures.js';

const LABEL_OP = /q 1 1 1 rg 0 G 1 0 0 1 \S+ \S+ cm BT 1 0 0 1 0 0 Tm \/(\S+) \S+ Tf 0 Tr <([0-9A-F]+)> Tj ET Q/g;

/** The copy with every label's string turned to spaces, in whatever font: layer (a) as if bypassed. */
async function maskedAnyFont(pdf: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  for (const page of doc.getPages()) {
    const ref = page.node.get(PDFName.of('Contents')) as PDFRef;
    const text = Buffer.from(decodePDFRawStream(doc.context.lookup(ref) as PDFRawStream).decode()).toString('latin1');
    const masked = text.replace(LABEL_OP, (op, _name, hex: string) => op.replace(`<${hex}>`, `<${'20'.repeat(hex.length / 2)}>`));
    doc.context.assign(ref, doc.context.flateStream(Buffer.from(masked, 'latin1')));
  }
  return doc.save({ useObjectStreams: false });
}

vi.mock('../../src/pdf/gate-labels.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/pdf/gate-labels.js')>();
  // leakBreak as it is, but with maskedAnyFont in unlabelled's place.
  const leakBreak: typeof real.leakBreak = async (pdf, marks, check) => {
    const found = await check(pdf);
    if (found === null || typeof marks === 'string') return found;
    return check(await maskedAnyFont(pdf), marks);
  };
  return { ...real, leakBreak };
});

const WITHHELD_GLYPHS = { code: 'withheld', reason: 'page 1: withheld text is in the glyphs pdf.js draws' };
const byte = (code: number): string => code.toString(16).toUpperCase().padStart(2, '0');

/** The F1 font: PDFium's Helvetica whose /Differences draw `glyphs` for the label's codes, read through ToUnicode as the label. */
function drawsOther(context: PDFContext, label: string, glyphs: string): PDFRef {
  const byCode = new Map([...label].map((ch, i) => [ch.charCodeAt(0), glyphs[i] ?? ' ']));
  const differences = [...byCode].sort((a, b) => a[0] - b[0]).flatMap(([code, glyph]) => [code, glyph === ' ' ? 'space' : glyph]);
  const pairs = [...byCode.keys()].map((code) => `<${byte(code)}> <00${byte(code)}>`);
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Id def /CIDSystemInfo << /Registry (L) /Ordering (L) /Supplement 0 >> def 1 begincodespacerange <00> <FF> endcodespacerange ${pairs.length} beginbfchar ${pairs.join(' ')} endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
  return context.register(
    context.obj({
      Type: 'Font',
      Subtype: 'Type1',
      BaseFont: 'Helvetica',
      Encoding: { Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: differences },
      ToUnicode: context.register(context.flateStream(cmap)),
    }),
  );
}

describe('layer (b) refuses a lying label when layer (a) is bypassed', () => {
  it('"Private" over the quote, in a font whose /Differences draw it: the glyph check reads the copy, glyphs and text both', async () => {
    const original = await twoMarksFixture();
    const result = await redactPdf(original, { quotes: ['Quillon'], membersWithhold: [true], redactsAny: true });
    if (result.kind !== 'redacted') throw new Error(JSON.stringify(result));
    const job = { copy: result.pdf, original, quotes: ['Quillon'], image: 'show' } as const;
    // Control: the honest copy passes with (a) bypassed too, so the bypass alone refuses nothing.
    expect(await gateVerdict(job)).toEqual({ pass: true });

    const doc = await PDFDocument.load(result.pdf, { updateMetadata: false });
    const content = Buffer.from(decodePDFRawStream(doc.context.lookup(doc.getPage(0).node.get(PDFName.of('Contents')) as PDFRef) as PDFRawStream).decode()).toString('latin1');
    const name = (new RegExp(LABEL_OP.source).exec(content) as RegExpExecArray)[1] as string;
    (doc.getPage(0).node.Resources()?.lookup(PDFName.of('Font'), PDFDict) as PDFDict).set(PDFName.of(name), drawsOther(doc.context, 'Private', 'Quillon'));
    const lying = await doc.save({ useObjectStreams: false });
    const marks = await labels.labelMarks(lying);
    expect(marks).toEqual([[{ text: 'Private', x: expect.any(Number) as unknown, y: expect.any(Number) as unknown }]]);

    // The bypassed (a) hands over masked bytes in which nothing is left to find: reading them would pass (Nb5).
    const pages: PageRef[] = doc.getPages().map((page) => ({ num: page.ref.objectNumber, gen: page.ref.generationNumber }));
    expect(await drawnBreak(await maskedAnyFont(lying), 'show', ['Quillon'], pages, [['Private']])).toBeNull();
    // The copy's own glyphs draw the quote under text that reads "Private": exempting on text alone would pass (Nb1).
    expect(await drawnBreak(lying, 'show', ['Quillon'], pages, [['Private']])).toEqual(WITHHELD_GLYPHS);

    expect(await gateVerdict({ ...job, copy: lying })).toEqual({ pass: false, code: 'withheld' });
    expect((await gateReply({ ...job, copy: lying })).verdict).toEqual({ pass: false, code: 'withheld' });
  });
});
