// REDACT R3a: the rebuild of a redacted copy reaches every content stream a
// page draws with (form XObjects, tiling patterns, Type 3 glyphs), and refuses
// a page whose content is not a stream. Every name here is made up.
import { PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { sanitize } from '../../src/pdf/sanitize.js';
import { rawText } from './extract.js';

const MARKED = '/Span <</ActualText (Quillon Brask)>> BDC 0 0 1 1 re f EMC';

describe('sanitize', () => {
  it('drops marked-content properties from form XObjects, tiling patterns and Type 3 glyphs', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const page = doc.addPage([612, 792]);
    const { context } = doc;
    const form = context.register(context.flateStream(MARKED, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] }));
    const pattern = context.register(context.flateStream(MARKED, { PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 10, 10], XStep: 10, YStep: 10, Resources: {} }));
    const glyph = context.register(context.flateStream(`500 0 0 0 500 700 d1 ${MARKED}`));
    const type3 = context.register(
      context.obj({ Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 500, 700], FontMatrix: [0.001, 0, 0, 0.001, 0, 0], CharProcs: { g1: glyph }, Encoding: { Type: 'Encoding', Differences: [65, 'g1'] }, FirstChar: 65, LastChar: 65, Widths: [500], Resources: {} }),
    );
    page.node.set(PDFName.of('Resources'), context.obj({ XObject: { X1: form }, Pattern: { P1: pattern }, Font: { F3: type3 } }));
    page.node.set(PDFName.of('Contents'), context.register(context.flateStream('/X1 Do BT /F3 12 Tf (A) Tj ET')));
    const before = await doc.save({ useObjectStreams: false });
    expect(rawText(before)).toContain('Quillon Brask');

    const after = rawText(await sanitize(before));
    expect(after).not.toContain('Quillon');
    expect(after.match(/\/Span BMC/g)).toHaveLength(3);
  });

  it('refuses a page whose content is not a stream', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.obj({ Not: 'a stream' })));
    await expect(sanitize(await doc.save({ useObjectStreams: false }))).rejects.toThrow('a page has content that is not a stream');
  });
});
