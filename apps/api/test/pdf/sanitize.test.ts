// REDACT R3a: the rebuild of a redacted copy reaches every content stream a
// page draws with (form XObjects, tiling patterns, Type 3 glyphs), and refuses
// a page whose content is not a stream. Every name here is made up.
import { PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { sanitize } from '../../src/pdf/sanitize.js';
import { rawText } from './extract.js';
import { M1_DRAWN_CASES } from './shadows.js';

const drawnCase = (id: string): Uint8Array => (M1_DRAWN_CASES.find((c) => c.id === id) as { attack: Uint8Array }).attack;

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
    page.node.set(PDFName.of('Contents'), context.register(context.flateStream('/X1 Do /Pattern cs /P1 scn 0 0 9 9 re f BT /F3 12 Tf (A) Tj ET')));
    const before = await doc.save({ useObjectStreams: false });
    expect(rawText(before)).toContain('Quillon Brask');

    const after = rawText(await sanitize(before));
    expect(after).not.toContain('Quillon');
    expect(after.match(/\/Span BMC/g)).toHaveLength(3);
  });

  it('refuses an original\'s inline picture as pdf.js reads it, under "blur" or "hide": "qBI" (n2), and BI split across a /Contents array (n4) (fix round 4, M1)', async () => {
    for (const id of ['n2', 'n4']) {
      for (const image of ['blur', 'hide'] as const) await expect(sanitize(drawnCase(id), image), `${id}, ${image}`).rejects.toThrow('an inline picture cannot be replaced');
      expect((await sanitize(drawnCase(id), 'show')).byteLength, id).toBeGreaterThan(0);
    }
  });

  it('refuses a content stream with /DecodeParms, which it cannot decode (pdf-lib has no predictor), under every policy (n1, fix round 4, M1)', async () => {
    for (const image of ['show', 'blur', 'hide'] as const) await expect(sanitize(drawnCase('n1'), image), image).rejects.toThrow('a content stream has /DecodeParms, which it cannot read');
  });

  it('refuses a page whose content is not a stream', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.obj({ Not: 'a stream' })));
    await expect(sanitize(await doc.save({ useObjectStreams: false }))).rejects.toThrow('a page has content that is not a stream');
  });
});
