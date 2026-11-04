// What pdf.js draws, read from its operator lists (UNTRUSTED-PDF-GATE M1, fix round 4): under "blur" and
// "hide", the gate refuses any picture a viewer would draw that is not the policy's shape, wherever it is
// drawn from. Small PDFs written byte by byte; nothing in them runs. Every name is made up.
import { describe, expect, it } from 'vitest';
import { M1_LINEARIZED_CASES, M1_QUOTES, type RawObject, linearizedCopy, nestedForms, plainCopy, rawPdf, rawStream } from '../../test/pdf/shadows.js';
import { PageWalk, drawnBreak } from './drawn.js';
import { loadPdfJs } from './gate.js';

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
/** pdf-lib's page tree for onPage's copies: object 3. */
const PAGE = [{ num: 3, gen: 0 }];
/** A side larger than any picture a group or repeat could name. */
const BLUR_SIDE = 1_000;
const AXIAL = '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 100 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> >>';

describe('drawnBreak: the pictures pdf.js draws, under "blur" and "hide"', () => {
  it('passes a plain copy, the "hide" fill, a "blur" picture of BLUR_MAX a side, an axial shading and a one-pixel stencil', async () => {
    expect(await drawnBreak(plainCopy(), 'hide', [], PAGE)).toBeNull();
    const fill = onPage(DRAW, '/XObject << /Im1 6 0 R >>', [[6, rawStream('/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8', Buffer.from([160]))]]);
    for (const image of ['blur', 'hide'] as const) expect(await drawnBreak(fill, image, [], PAGE), image).toBeNull();
    expect(await drawnBreak(onPage(DRAW, '/XObject << /Im1 6 0 R >>', [picture(24)]), 'blur', [], PAGE)).toBeNull();
    expect(await drawnBreak(onPage('q /Sh1 sh Q', `/Shading << /Sh1 ${AXIAL} >>`), 'hide', [], PAGE)).toBeNull();
    // pdf.js draws an opaque one-pixel stencil as a filled rectangle.
    expect(await drawnBreak(onPage('q 10 0 0 10 0 0 cm BI /W 1 /H 1 /IM true ID \x00 EI Q'), 'hide', [], PAGE)).toBeNull();
  });

  it('refuses a picture larger than the policy draws: over 1 x 1 under "hide", over BLUR_MAX a side under "blur"; an inline picture past 200 pixels of width and height drawn as one too', async () => {
    const big = onPage(DRAW, '/XObject << /Im1 6 0 R >>', [picture(25)]);
    expect(await drawnBreak(big, 'blur', [], PAGE)).toEqual({ code: 'rules', reason: 'page 1: pdf.js draws a picture of 25 x 25' });
    expect(await drawnBreak(onPage(DRAW, '/XObject << /Im1 6 0 R >>', [picture(2)]), 'hide', [], PAGE)).toEqual({ code: 'rules', reason: 'page 1: pdf.js draws a picture of 2 x 2' });
    expect(await drawnBreak(onPage(inline(128)), 'blur', [], PAGE)).toEqual({ code: 'rules', reason: 'page 1: pdf.js draws a picture of 128 x 128' });
    const stencil = onPage(`q 100 0 0 100 0 0 cm BI /W 64 /H 64 /IM true /F /AHx ID ${varied(64 * 8)}> EI Q`);
    expect(await drawnBreak(stencil, 'hide', [], PAGE)).toEqual({ code: 'rules', reason: 'page 1: pdf.js draws a stencil of 64 x 64' });
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
      for (const image of ['blur', 'hide'] as const) expect(await drawnBreak(pdf, image, [], PAGE), `${name}, ${image}`).toEqual({ code: 'rules', reason: 'page 1: pdf.js draws an inline picture' });
    }
  });

  it('refuses a shading drawn as a lattice or a mesh of colours (function-based, and types 4 to 7), filled with sh or through a shading pattern', async () => {
    const mesh: RawObject = [6, rawStream(MESH, TRIANGLE)];
    expect(await drawnBreak(onPage('q /Sh1 sh Q', '/Shading << /Sh1 6 0 R >>', [mesh]), 'hide', [], PAGE)).toEqual({ code: 'rules', reason: 'page 1: pdf.js draws a shading of type 4' });
    const pattern: RawObject = [7, '<< /Type /Pattern /PatternType 2 /Shading 6 0 R >>'];
    expect(await drawnBreak(onPage('/Pattern cs /P1 scn 72 400 200 200 re f', '/Pattern << /P1 7 0 R >>', [mesh, pattern]), 'blur', [], PAGE)).toEqual({ code: 'rules', reason: 'page 1: pdf.js draws a shading of type 4' });
  });

  it('refuses a copy whose pages pdf.js counts otherwise than pdf-lib', async () => {
    expect(await drawnBreak(plainCopy(), 'hide', [], [...PAGE, { num: 13, gen: 0 }])).toEqual({ code: 'rules', reason: 'pdf.js reads 1 pages where pdf-lib reads 2' });
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
    expect(await drawnBreak(lying, 'blur', [quote], PAGE)).toEqual({ code: 'withheld', reason: 'page 1: withheld text is in the glyphs pdf.js draws' });
    expect(await drawnBreak(lying, 'blur', [], PAGE)).toBeNull();
  });
});

describe('drawnBreak, fix round 5: the page pdf.js reads is pdf-lib\'s, and pdf.js reads it to the end', () => {
  /** l1, l3 and l4 with /L their own length: pdf.js reads them as linearized, and takes page 1 from /O (object 9). */
  const linearized = (c: (typeof M1_LINEARIZED_CASES)[number]): Promise<Uint8Array> => linearizedCopy(c.build, (copy) => Promise.resolve(copy));

  it('refuses a page pdf.js takes from another object than pdf-lib\'s page tree: l1, l3 and l4, linearized, where pdf.js reads page 1 from /O (M1)', async () => {
    expect(M1_LINEARIZED_CASES.map((c) => c.id)).toEqual(['l1', 'l3', 'l4']);
    for (const c of M1_LINEARIZED_CASES) {
      expect(await drawnBreak(await linearized(c), c.image, M1_QUOTES, [{ num: 4, gen: 0 }]), c.id).toEqual({ code: 'rules', reason: 'page 1: pdf.js reads object 9 where pdf-lib reads object 4' });
    }
    // The generation counts too, and a page written into /Kids itself is no object at all to pdf.js.
    expect(await drawnBreak(plainCopy(), 'hide', [], [{ num: 3, gen: 1 }])).toEqual({ code: 'rules', reason: 'page 1: pdf.js reads object 3 where pdf-lib reads object 3 generation 1' });
    const direct = rawPdf([CATALOG, [2, '<< /Type /Pages /Kids [<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>] /Count 1 >>']]);
    expect(await drawnBreak(direct, 'hide', [], [{ num: 3, gen: 0 }])).toEqual({ code: 'rules', reason: 'page 1: pdf.js reads no object where pdf-lib reads object 3' });
  });

  it('judges the tree\'s page once pdf.js reads it: each of l1, l3 and l4 with /L one byte off is refused for what the page draws (M1)', async () => {
    const found: Record<string, unknown> = {};
    for (const c of M1_LINEARIZED_CASES) found[c.id] = await drawnBreak(c.build((await linearized(c)).byteLength + 1), c.image, M1_QUOTES, [{ num: 4, gen: 0 }]);
    expect(found).toEqual({
      l1: { code: 'rules', reason: 'page 1: pdf.js draws a shading of type 1' },
      l3: { code: 'withheld', reason: 'page 1: withheld text is in the glyphs pdf.js draws' },
      l4: { code: 'rules', reason: 'page 1: pdf.js draws an inline picture' },
    });
  });

  it('refuses a page pdf.js stops reading before its end: forms nested 2,000 deep (its stack gives out), a form it cannot find; forms 33 deep it reads through (S3)', async () => {
    const stopped = { code: 'rules', reason: 'page 1: pdf.js stopped before the end of it' };
    for (const image of ['blur', 'hide'] as const) expect(await drawnBreak(nestedForms(2_000), image, [], PAGE), image).toEqual(stopped);
    expect(await drawnBreak(onPage('q /X Do Q 0 0 1 1 re f', '/XObject << /X 9 0 R >>'), 'hide', [], PAGE)).toEqual(stopped);
    expect(await drawnBreak(nestedForms(33), 'hide', [], PAGE)).toBeNull();
  });

  it('refuses a page drawn with a font pdf.js could not load, or with a Type 3 glyph it could not read, where a viewer that recovers would draw them (fix round 5b, S3)', async () => {
    const font = (file: string): Uint8Array =>
      onPage('BT /F2 12 Tf 72 700 Td (Picnic) Tj ET', '/Font << /F1 5 0 R /F2 6 0 R >>', [
        [6, '<< /Type /Font /Subtype /TrueType /BaseFont /Picnic /FirstChar 32 /LastChar 126 /Widths [] /FontDescriptor 7 0 R >>'],
        [7, `<< /Type /FontDescriptor /FontName /Picnic /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 ${file} >>`],
        [8, rawStream('', '')],
      ]);
    const unread = { code: 'rules', reason: 'page 1: pdf.js draws with a font it could not read' };
    // An empty font file, which pdf.js would otherwise replace by a standard font; a font the page does not have.
    for (const image of ['blur', 'hide'] as const) expect(await drawnBreak(font('/FontFile2 8 0 R'), image, [], PAGE), image).toEqual(unread);
    expect(await drawnBreak(onPage('BT /F9 12 Tf 72 700 Td (Picnic) Tj ET'), 'hide', [], PAGE)).toEqual(unread);
    expect(await drawnBreak(font(''), 'hide', [], PAGE)).toBeNull();
    const type3 = (proc: string): Uint8Array =>
      onPage('BT /T3 12 Tf 72 400 Td (A) Tj ET', '/Font << /F1 5 0 R /T3 6 0 R >>', [
        [6, '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /g 7 0 R >> /Encoding << /Type /Encoding /Differences [65 /g] >> /FirstChar 65 /LastChar 65 /Widths [1000] /Resources << >> >>'],
        [7, rawStream('', proc)],
      ]);
    // A glyph that draws a form there is none of (pdf.js keeps an empty glyph in its place), and one with no d1.
    for (const proc of ['1000 0 0 0 1000 1000 d1 /X Do', '']) expect(await drawnBreak(type3(proc), 'hide', [], PAGE), proc).toEqual({ code: 'rules', reason: 'page 1: pdf.js could not read a Type 3 glyph' });
    expect(await drawnBreak(type3('1000 0 0 0 1000 1000 d1 0 0 1000 1000 re f'), 'hide', [], PAGE)).toBeNull();
  });
});

describe('PageWalk: an object pdf.js names before it has sent it', () => {
  /** A page whose objects arrive only through the callback, after `ms`, or never. */
  const later = (data: unknown, ms: number | null) => {
    const pool = {
      has: () => false,
      get: (_id: string, callback: (value: unknown) => void) => void (ms === null ? undefined : setTimeout(() => callback(data), ms)),
    };
    return { objs: pool, commonObjs: pool } as unknown as ConstructorParameters<typeof PageWalk>[1];
  };

  it('waits for it, and refuses the page when it never comes', async () => {
    const pdfjs = await loadPdfJs();
    const list = { fnArray: [pdfjs.OPS.shadingFill], argsArray: [['pattern_p1']] };
    expect(await new PageWalk(pdfjs, later(['Mesh', 6], 10), 1, 1_000).read(list)).toBe('pdf.js draws a shading of type 6');
    expect(await new PageWalk(pdfjs, later(['RadialAxial', 'axial'], 10), 1, 1_000).read(list)).toBeNull();
    expect(await new PageWalk(pdfjs, later(null, null), 1, 20).read(list)).toBe('pdf.js draws a shading it could not read');
    // A global id (a Type 3 glyph's) is looked up among the document's objects.
    const glyphList = { fnArray: [pdfjs.OPS.shadingFill], argsArray: [['g_d0_type3_pattern_p2']] };
    expect(await new PageWalk(pdfjs, later(['Mesh', 1], 10), 1, 1_000).read(glyphList)).toBe('pdf.js draws a shading of type 1');
  });

  it('refuses a page whose font never comes, as it refuses a shading that never comes (fix round 5, S3)', async () => {
    const pdfjs = await loadPdfJs();
    const list = { fnArray: [pdfjs.OPS.setFont], argsArray: [['g_d0_f1', 12]] };
    expect(await new PageWalk(pdfjs, later(null, null), 1, 20).read(list)).toBe('pdf.js draws with a font it never sent');
    expect(await new PageWalk(pdfjs, later({ name: 'Helvetica' }, 10), 1, 1_000).read(list)).toBeNull();
    // What pdf.js sends for a font it could not load (fix round 5b): its error, as a string.
    expect(await new PageWalk(pdfjs, later('FontFile is empty', 10), 1, 1_000).read(list)).toBe('pdf.js draws with a font it could not read');
    const glyphs = (...lists: number[][]) => ({ charProcOperatorList: new Map(lists.map((fnArray, i) => [`g${i}`, { fnArray, argsArray: fnArray.map(() => null) }])) });
    expect(await new PageWalk(pdfjs, later(glyphs([pdfjs.OPS.setCharWidth], []), 10), 1, 1_000).read(list)).toBe('pdf.js could not read a Type 3 glyph');
    expect(await new PageWalk(pdfjs, later(glyphs([pdfjs.OPS.setCharWidth]), 10), 1, 1_000).read(list)).toBeNull();
  });

  it('refuses the grouped and repeated pictures pdf.js\'s optimizer makes, handed to the walk as they are (fix round 5, N9)', async () => {
    const pdfjs = await loadPdfJs();
    const { OPS } = pdfjs;
    for (const op of ['paintInlineImageXObject', 'paintInlineImageXObjectGroup', 'paintImageXObjectRepeat', 'paintImageMaskXObjectGroup', 'paintImageMaskXObjectRepeat'] as const) {
      expect(await new PageWalk(pdfjs, later(null, null), BLUR_SIDE, 20).read({ fnArray: [OPS.save, OPS[op], OPS.restore], argsArray: [null, [], null] }), op).toBe('pdf.js draws an inline picture');
    }
    expect(await new PageWalk(pdfjs, later(null, null), BLUR_SIDE, 20).read({ fnArray: [OPS.save, OPS.restore], argsArray: [null, null] })).toBeNull();
  });
});
