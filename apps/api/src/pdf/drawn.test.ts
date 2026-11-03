// What pdf.js draws, read from its operator lists (UNTRUSTED-PDF-GATE M1, fix round 4): under "blur" and
// "hide", the gate refuses any picture a viewer would draw that is not the policy's shape, wherever it is
// drawn from. Small PDFs written byte by byte; nothing in them runs. Every name is made up.
import { describe, expect, it } from 'vitest';
import { type RawObject, plainCopy, rawPdf, rawStream } from '../../test/pdf/shadows.js';
import { drawnBreak } from './drawn.js';

const CATALOG: RawObject = [1, '<< /Type /Catalog /Pages 2 0 R >>'];
const PAGES: RawObject = [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'];
const FONT: RawObject = [5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
/** One page drawing `content`, with these resources beside its font, and these objects. */
const onPage = (content: string | Buffer, resources = '', extra: RawObject[] = []): Uint8Array =>
  rawPdf([CATALOG, PAGES, [3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> ${resources} >> >>`], [4, rawStream('', content)], FONT, ...extra]);
const varied = (bytes: number): string => Buffer.from(Array.from({ length: bytes }, (_, i) => (Math.imul(i + 1, 2654435761) >>> 13) & 0xff)).toString('hex');
/** An inline picture, its samples in hex. */
const inline = (side: number, more = ''): string => `q 100 0 0 100 72 400 cm BI /W ${side} /H ${side} /CS /RGB /BPC 8 /F /AHx ${more}ID ${varied(side * side * 3)}>\nEI Q\n`;
/** A picture XObject of this size, its samples in hex. */
const picture = (side: number): RawObject => [6, rawStream(`/Type /XObject /Subtype /Image /Width ${side} /Height ${side} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode`, `${varied(side * side)}>`)];
const DRAW = 'q 100 0 0 100 72 400 cm /Im1 Do Q';
const MESH = '/ShadingType 4 /ColorSpace /DeviceRGB /BitsPerCoordinate 8 /BitsPerComponent 8 /BitsPerFlag 8 /Decode [0 100 0 100 0 1 0 1 0 1]';
const TRIANGLE = Buffer.from([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255]);
const AXIAL = '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 100 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> >>';

describe('drawnBreak: the pictures pdf.js draws, under "blur" and "hide"', () => {
  it('passes a plain copy, the "hide" fill, a "blur" picture of BLUR_MAX a side, an axial shading and a one-pixel stencil', async () => {
    expect(await drawnBreak(plainCopy(), 'hide', [], 1)).toBeNull();
    const fill = onPage(DRAW, '/XObject << /Im1 6 0 R >>', [[6, rawStream('/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8', Buffer.from([160]))]]);
    for (const image of ['blur', 'hide'] as const) expect(await drawnBreak(fill, image, [], 1), image).toBeNull();
    expect(await drawnBreak(onPage(DRAW, '/XObject << /Im1 6 0 R >>', [picture(24)]), 'blur', [], 1)).toBeNull();
    expect(await drawnBreak(onPage('q /Sh1 sh Q', `/Shading << /Sh1 ${AXIAL} >>`), 'hide', [], 1)).toBeNull();
    // pdf.js draws an opaque one-pixel stencil as a filled rectangle.
    expect(await drawnBreak(onPage('q 10 0 0 10 0 0 cm BI /W 1 /H 1 /IM true ID \x00 EI Q'), 'hide', [], 1)).toBeNull();
  });

  it('refuses a picture larger than the policy draws: over 1 x 1 under "hide", over BLUR_MAX a side under "blur"; an inline picture past 200 pixels of width and height drawn as one too', async () => {
    const big = onPage(DRAW, '/XObject << /Im1 6 0 R >>', [picture(25)]);
    expect(await drawnBreak(big, 'blur', [], 1)).toEqual({ code: 'rules', reason: 'page 1: pdf.js draws a picture of 25 x 25' });
    expect(await drawnBreak(onPage(DRAW, '/XObject << /Im1 6 0 R >>', [picture(2)]), 'hide', [], 1)).toEqual({ code: 'rules', reason: 'page 1: pdf.js draws a picture of 2 x 2' });
    expect(await drawnBreak(onPage(inline(128)), 'blur', [], 1)).toEqual({ code: 'rules', reason: 'page 1: pdf.js draws a picture of 128 x 128' });
    const stencil = onPage(`q 100 0 0 100 0 0 cm BI /W 64 /H 64 /IM true /F /AHx ID ${varied(64 * 8)}> EI Q`);
    expect(await drawnBreak(stencil, 'hide', [], 1)).toEqual({ code: 'rules', reason: 'page 1: pdf.js draws a stencil of 64 x 64' });
  });

  it('refuses an inline picture wherever pdf.js draws it from: a page, a form, a tiling pattern, a Type 3 glyph', async () => {
    const form: RawObject = [6, rawStream('/Type /XObject /Subtype /Form /BBox [0 0 612 792]', inline(4))];
    const tiling: RawObject = [6, rawStream('/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 100 100] /XStep 100 /YStep 100 /Resources << >>', inline(4))];
    const glyph: RawObject = [7, rawStream('', `1000 0 0 0 1000 1000 d1 ${inline(4)}`)];
    const type3: RawObject = [6, '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /g 7 0 R >> /Encoding << /Differences [65 /g] >> /FirstChar 65 /LastChar 65 /Widths [1000] /Resources << >> >>'];
    const cases: Array<[string, Uint8Array]> = [
      ['a page', onPage(inline(4))],
      ['a form', onPage('q /Fm1 Do Q', '/XObject << /Fm1 6 0 R >>', [form])],
      ['a tiling pattern', onPage('/Pattern cs /P1 scn 72 400 200 200 re f', '/Pattern << /P1 6 0 R >>', [tiling])],
      ['a Type 3 glyph', onPage('BT /T3 12 Tf 72 400 Td (A) Tj ET', '/Font << /F1 5 0 R /T3 6 0 R >>', [type3, glyph])],
    ];
    for (const [name, pdf] of cases) {
      for (const image of ['blur', 'hide'] as const) expect(await drawnBreak(pdf, image, [], 1), `${name}, ${image}`).toEqual({ code: 'rules', reason: 'page 1: pdf.js draws an inline picture' });
    }
  });

  it('refuses a shading drawn as a lattice or a mesh of colours (function-based, and types 4 to 7), filled with sh or through a shading pattern', async () => {
    const mesh: RawObject = [6, rawStream(MESH, TRIANGLE)];
    expect(await drawnBreak(onPage('q /Sh1 sh Q', '/Shading << /Sh1 6 0 R >>', [mesh]), 'hide', [], 1)).toEqual({ code: 'rules', reason: 'page 1: pdf.js draws a shading of type 4' });
    const pattern: RawObject = [7, '<< /Type /Pattern /PatternType 2 /Shading 6 0 R >>'];
    expect(await drawnBreak(onPage('/Pattern cs /P1 scn 72 400 200 200 re f', '/Pattern << /P1 7 0 R >>', [mesh, pattern]), 'blur', [], 1)).toEqual({ code: 'rules', reason: 'page 1: pdf.js draws a shading of type 4' });
  });

  it('refuses a copy whose pages pdf.js counts otherwise than pdf-lib', async () => {
    expect(await drawnBreak(plainCopy(), 'hide', [], 2)).toEqual({ code: 'rules', reason: 'pdf.js reads 1 pages where pdf-lib reads 2' });
  });

  it('finds a withheld quote in the glyphs pdf.js draws, where a /ToUnicode lies to the text layer (r4 N3)', async () => {
    const quote = 'Kestrel Ambry';
    const letters = [...new Set(quote.replace(/ /g, ''))].sort();
    const code = (c: string): number => (c === ' ' ? 0x20 : 0x41 + letters.indexOf(c));
    const hex = [...quote].map((c) => code(c).toString(16).padStart(2, '0')).join('');
    const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /X def 1 begincodespacerange <00> <FF> endcodespacerange ${letters.length + 1} beginbfchar <20> <0020> ${letters.map((c) => `<${code(c).toString(16)}> <0078>`).join(' ')} endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
    const lying = rawPdf([
      CATALOG,
      PAGES,
      [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 7 0 R >> >> >>'],
      [4, rawStream('', `BT /F2 12 Tf 72 720 Td (Picnic flyer) Tj ET BT /F1 14 Tf 72 690 Td <${hex}> Tj ET`)],
      [5, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [65 ${letters.map((c) => `/${c}`).join(' ')}] >> /ToUnicode 6 0 R >>`],
      [6, rawStream('', cmap)],
      [7, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
    ]);
    expect(await drawnBreak(lying, 'blur', [quote], 1)).toEqual({ code: 'withheld', reason: 'page 1: withheld text is in the glyphs pdf.js draws' });
    expect(await drawnBreak(lying, 'blur', [], 1)).toBeNull();
  });
});
