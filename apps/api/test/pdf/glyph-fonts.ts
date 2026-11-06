// GLYPHMAP: simple fonts whose glyphs are chosen by name, of each kind PDFium and pdf.js draw, for the glyph-name
// tests. A run's codes spell one word ("Private") while its glyph names, written in one of the name classes below,
// spell another ("Quillon"); a /ToUnicode can make every text layer read the codes. Every word here is made up.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { type PDFContext, PDFDict, PDFDocument, PDFName, type PDFRawStream, type PDFRef, PDFString, PDFWriter, decodePDFRawStream } from '@cantoo/pdf-lib';

export const CODES = 'Private';
export const MEANT = 'Quillon';

/** The kinds of simple font measured (red/a-kinds.txt): where the glyph for a code is chosen by its name. */
export const KINDS = ['non-embedded Type1', 'non-embedded TrueType', 'embedded Type1', 'embedded CFF', 'embedded TrueType'] as const;
/** Also a TrueType font shaped as LibreOffice embeds one (red/lo-glyphnames.txt): symbolic, no /Encoding, glyphs by code. */
export type Kind = (typeof KINDS)[number] | 'LibreOffice TrueType';

const hex4 = (c: string): string => c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');

/** Glyph-name classes PDFium reads a character from, as it draws: the Adobe glyph list, uniXXXX, uXXXX[XX], and any of these with a suffix. */
export const READ_CLASSES: Record<string, (c: string) => string> = {
  plain: (c) => c,
  'suffix .alt': (c) => `${c}.alt`,
  'suffix .sc': (c) => `${c}.sc`,
  'suffix .001': (c) => `${c}.001`,
  uniXXXX: (c) => `uni${hex4(c)}`,
  'uniXXXX.alt': (c) => `uni${hex4(c)}.alt`,
  uXXXX: (c) => `u${hex4(c)}`,
  uXXXXXX: (c) => `u00${hex4(c)}`,
};

/** Classes PDFium reads no character from: it draws nothing for them, or the glyph of the code itself. */
export const UNREAD_CLASSES: Record<string, (c: string) => string> = {
  gNNN: (c) => `g${c.charCodeAt(0) + 3}`,
  cidNNN: (c) => `cid${c.charCodeAt(0)}`,
  glyphNNNNN: (c) => `glyph${String(c.charCodeAt(0)).padStart(5, '0')}`,
  'X_X ligature': (c) => `${c}_${c}`,
  unknown: (c) => `zz${c}`,
};

const fontsDir = join(dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'standard_fonts');

/**
 * A Type1 font of made-up shapes (glyphs .notdef, space and a e i l n o P Q r t u v by those names), as the three
 * parts a /FontFile holds: written for these tests with fontTools' Type 1 charstring and eexec encoders.
 */
const TYPE1 = {
  lengths: [381, 914, 532] as const,
  bytes:
    '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',
};

/** pdf.js's FoxitSerif: a bare CFF (Type1C) despite its .pfb name, a real font's outlines. */
const cff = (): Buffer => readFileSync(join(fontsDir, 'FoxitSerif.pfb'));

/**
 * A TrueType font of made-up shapes shaped as LibreOffice 26.8 embeds its subsets: a (1,0) cmap from the codes of
 * "Renée" in Mac Roman (52 65 6E 8E) to glyphs glyph00001 to glyph00004, and a post table of format 3 (no glyph
 * names). Written with fontTools.
 */
const LIBREOFFICE_TTF =
  'AAEAAAAKAIAAAwAgT1MvMkD2QZwAAAEoAAAAYGNtYXAIAQEVAAABlAAAARJnbHlmdM3ieAAAArQAAABwaGVhZC+TD0oAAACsAAAANmhoZWEFFgH2AAAA5AAAACRobXR4AlgAAAAAAYgAAAAMbG9jYQA4AFQAAAKoAAAADG1heHAABwAGAAABCAAAACBuYW1lBikg7gAAAyQAAABpcG9zdAADAAAAAAOQAAAAIAABAAAAAQAArzXn4F8PPPUAAQPoAAAAAOcTZdcAAAAA5xNl1wAyAAACJgK8AAAAAwACAAAAAAAAAAEAAAMg/zgAAAJYAAAAZAH0AAEAAAAAAAAAAAAAAAAAAAABAAEAAAAFAAQAAQAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAwJYAZAABQAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPz8/PwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAACWAAAAAAAAAAAAAAAAAABAAEAAAAAAAwAAAEGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AHAAqADgAAQAyAAACJgK8AAMAADMREwEyggFyAVQBaP1EAAEAMgAAAiYCvAADAAAzERMBMqABVAF8AUD9RAABADIAAAImArwAAwAAMxETATK+ATYBpAEY/UQAAQAyAAACJgK8AAMAADMRNwEy3AEYAczw/UQAAAAABAA2AAEAAAAAAAEACgAAAAEAAAAAAAIABwAKAAMAAQQJAAEAFAARAAMAAQQJAAIADgAlR2x5cGhtYXBMT1JlZ3VsYXIARwBsAHkAcABoAG0AYQBwAEwATwBSAGUAZwB1AGwAYQByAAAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const byte = (c: number): string => c.toString(16).toUpperCase().padStart(2, '0');

/** A /ToUnicode mapping each code of `codes` to the letter of `reads` at the same place. */
export function toUnicode(ctx: PDFContext, codes: string, reads: string): PDFRef {
  const pairs = [...new Map([...codes].map((ch, i) => [ch.charCodeAt(0), (reads[i] ?? ' ').charCodeAt(0)]))].map(([c, t]) => `<${byte(c)}> <${t.toString(16).toUpperCase().padStart(4, '0')}>`);
  return ctx.register(
    ctx.flateStream(
      `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Made def /CIDSystemInfo << /Registry (M) /Ordering (M) /Supplement 0 >> def 1 begincodespacerange <00> <FF> endcodespacerange ${pairs.length} beginbfchar ${pairs.join(' ')} endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`,
    ),
  );
}

export interface FontSpec {
  kind: Kind;
  /** The codes the run shows and the glyph names they are given, letter for letter (no /Differences when null). */
  codes: string;
  names: readonly string[] | null;
  /** What the /ToUnicode reads for the codes, letter for letter; none when undefined. */
  reads?: string;
  /** The font descriptor's /Flags: 32 nonsymbolic, 4 symbolic. */
  flags?: number;
  /** A /Subtype in place of the kind's, or none at all when null. */
  subtype?: string | null;
}

/** A simple font of `spec.kind` whose /Differences give each code its name. */
export function font(ctx: PDFContext, spec: FontSpec): PDFRef {
  const ref = kindFont(ctx, spec);
  const dict = ctx.lookup(ref) as PDFDict;
  if (spec.subtype === null) dict.delete(PDFName.of('Subtype'));
  else if (spec.subtype !== undefined) dict.set(PDFName.of('Subtype'), PDFName.of(spec.subtype));
  return ref;
}

function kindFont(ctx: PDFContext, spec: FontSpec): PDFRef {
  const { kind, codes, names, reads, flags = 32 } = spec;
  const differences = names === null ? [] : [...new Map([...codes].map((ch, i) => [ch.charCodeAt(0), names[i] as string]))].sort((a, b) => a[0] - b[0]).flat();
  const base: Record<string, unknown> = { Type: 'Font', Encoding: names === null ? 'WinAnsiEncoding' : { Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: differences } };
  if (kind === 'LibreOffice TrueType') delete base.Encoding;
  if (reads !== undefined) base.ToUnicode = toUnicode(ctx, codes, reads);
  const descriptor = (name: string, file: Record<string, unknown>): PDFRef =>
    ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: name, Flags: flags, FontBBox: [-200, -300, 1200, 1000], ItalicAngle: 0, Ascent: 900, Descent: -210, CapHeight: 720, StemV: 80, ...file }));
  switch (kind) {
    case 'non-embedded Type1':
      return ctx.register(ctx.obj({ ...base, Subtype: 'Type1', BaseFont: 'Helvetica' }));
    case 'non-embedded TrueType':
      return ctx.register(ctx.obj({ ...base, Subtype: 'TrueType', BaseFont: 'Arial', FontDescriptor: descriptor('Arial', {}) }));
    case 'embedded Type1': {
      const [Length1, Length2, Length3] = TYPE1.lengths;
      const file = ctx.register(ctx.flateStream(Buffer.from(TYPE1.bytes, 'base64'), { Length1, Length2, Length3 }));
      return ctx.register(ctx.obj({ ...base, Subtype: 'Type1', BaseFont: 'AAAAAA+GlyphmapT1', FontDescriptor: descriptor('AAAAAA+GlyphmapT1', { FontFile: file }) }));
    }
    case 'embedded CFF': {
      const file = ctx.register(ctx.flateStream(cff(), { Subtype: 'Type1C' }));
      return ctx.register(ctx.obj({ ...base, Subtype: 'Type1', BaseFont: 'AAAAAB+FoxitSerif', FontDescriptor: descriptor('AAAAAB+FoxitSerif', { FontFile3: file }) }));
    }
    case 'LibreOffice TrueType': {
      const ttf = Buffer.from(LIBREOFFICE_TTF, 'base64');
      const file = ctx.register(ctx.flateStream(ttf, { Length1: ttf.length }));
      return ctx.register(ctx.obj({ ...base, Subtype: 'TrueType', BaseFont: 'BAAAAA+GlyphmapLO', FontDescriptor: descriptor('BAAAAA+GlyphmapLO', { FontFile2: file }) }));
    }
    case 'embedded TrueType': {
      const ttf = readFileSync(join(fontsDir, 'LiberationSans-Regular.ttf'));
      const file = ctx.register(ctx.flateStream(ttf, { Length1: ttf.length }));
      return ctx.register(ctx.obj({ ...base, Subtype: 'TrueType', BaseFont: 'AAAAAC+LiberationSans', FontDescriptor: descriptor('AAAAAC+LiberationSans', { FontFile2: file }) }));
    }
  }
}

export const hex = (text: string): string => Buffer.from(text, 'latin1').toString('hex').toUpperCase();

/** `pdf` with `font` added to page 1 as /FXA1 and drawn in black at 72 500 by `draw` (a content fragment), after the page's content. */
export async function withRun(pdf: Uint8Array, spec: FontSpec, draw = `BT /FXA1 24 Tf 72 500 Td <${hex(spec.codes)}> Tj ET`): Promise<Uint8Array> {
  return withFontRun(pdf, (ctx) => font(ctx, spec), draw);
}

/**
 * Where a run's font is held: as its own object (indirect), as a direct dict in page 1's /Resources /Font, or, also
 * direct, in a page held directly in the page tree's /Kids array, so that only a walk through arrays reaches it.
 */
export type Held = 'indirect' | 'direct' | 'in an array';

/** `pdf` with the font `make` gives added to page 1 as /FXA1, held as `held` says, and drawn in black by `draw`. */
export async function withFontRun(pdf: Uint8Array, make: (ctx: PDFContext) => PDFRef, draw: string, held: Held = 'indirect'): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const { context } = doc;
  const page = doc.getPage(0);
  const ref = page.node.get(PDFName.of('Contents')) as PDFRef;
  const content = Buffer.from(decodePDFRawStream(context.lookup(ref) as PDFRawStream).decode()).toString('latin1');
  const resources = page.node.Resources() as PDFDict;
  const fonts = resources.lookup(PDFName.of('Font'), PDFDict);
  const made = make(context);
  if (held === 'indirect') {
    fonts.set(PDFName.of('FXA1'), made);
  } else {
    // The font, its /Font dict and the page's /Resources all direct objects: none of them is an object of its own.
    const dict = context.lookup(made, PDFDict);
    context.delete(made);
    const direct = fonts.clone();
    direct.set(PDFName.of('FXA1'), dict);
    const own = resources.clone();
    own.set(PDFName.of('Font'), direct);
    page.node.set(PDFName.of('Resources'), own);
  }
  context.assign(ref, context.flateStream(`${content}\nq 0 0 0 rg ${draw} Q`));
  if (held === 'in an array') {
    // The page itself a direct dict in /Kids. pdf-lib's save walks the page tree by reference, so its writer is used.
    const kids = doc.catalog.Pages().Kids();
    const pageRef = kids.get(0) as PDFRef;
    kids.set(0, page.node.clone());
    context.delete(pageRef);
    return PDFWriter.forContext(context, 50).serializeToBuffer();
  }
  return doc.save({ useObjectStreams: false });
}

/**
 * A Type 3 font for `codes`: each code's glyph is named `names[i]`, as its /Differences say, and is a CharProcs
 * entry by that name. Each glyph draws `shown(name)` in Helvetica, from the font's own /Resources, or a filled box
 * when `shown` gives null. The /ToUnicode reads `reads`, letter for letter, when given.
 */
export function type3Font(ctx: PDFContext, codes: string, names: readonly string[], shown: (name: string) => string | null, reads?: string): PDFRef {
  const differences = [...new Map([...codes].map((ch, i) => [ch.charCodeAt(0), names[i] as string]))].sort((a, b) => a[0] - b[0]).flat();
  const procs = Object.fromEntries(
    [...new Set(names)].map((name) => {
      const text = shown(name);
      const proc = text === null ? '600 0 0 0 500 700 d1 0 0 500 700 re f' : `600 0 d0 BT /H 1000 Tf 0 0 Td <${hex(text)}> Tj ET`;
      return [name, ctx.register(ctx.flateStream(proc))];
    }),
  );
  return ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'Type3',
      FontBBox: [0, -250, 1000, 1000],
      FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      FirstChar: 32,
      LastChar: 126,
      Widths: Array.from({ length: 95 }, () => 600),
      Resources: { Font: { H: ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }) } },
      CharProcs: procs,
      Encoding: { Type: 'Encoding', Differences: differences },
      ...(reads === undefined ? {} : { ToUnicode: toUnicode(ctx, codes, reads) }),
    }),
  );
}

const liberation = (): Buffer => readFileSync(join(fontsDir, 'LiberationSans-Regular.ttf'));

/** The tables of a TrueType font program, by tag. */
function tables(ttf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (let i = 0; i < ttf.readUInt16BE(4); i++) {
    const at = 12 + i * 16;
    out.set(ttf.toString('latin1', at, at + 4), ttf.subarray(ttf.readUInt32BE(at + 8), ttf.readUInt32BE(at + 8) + ttf.readUInt32BE(at + 12)));
  }
  return out;
}

/** The glyph id a (3,1) format 4 cmap gives the character `code` (0 when none). */
function glyphOf(cmap: Buffer, code: number): number {
  for (let i = 0; i < cmap.readUInt16BE(2); i++) {
    const at = cmap.readUInt32BE(4 + i * 8 + 4);
    if (cmap.readUInt16BE(4 + i * 8) !== 3 || cmap.readUInt16BE(4 + i * 8 + 2) !== 1 || cmap.readUInt16BE(at) !== 4) continue;
    const segs = cmap.readUInt16BE(at + 6) / 2;
    const ends = at + 14;
    for (let s = 0; s < segs; s++) {
      const start = cmap.readUInt16BE(ends + 2 + segs * 2 + s * 2);
      if (code < start || code > cmap.readUInt16BE(ends + s * 2)) continue;
      const delta = cmap.readUInt16BE(ends + 2 + segs * 4 + s * 2);
      const rangeAt = ends + 2 + segs * 6 + s * 2;
      const range = cmap.readUInt16BE(rangeAt);
      const glyph = range === 0 ? code : cmap.readUInt16BE(rangeAt + range + (code - start) * 2);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
  }
  return 0;
}

/** A cmap of one (3,0) (Microsoft Symbol) format 4 subtable: each character of `map` to its glyph id. */
function symbolCmap(map: ReadonlyMap<number, number>): Buffer {
  const codes = [...map.keys()].sort((a, b) => a - b);
  const segs = codes.length + 1;
  const sub = Buffer.alloc(16 + segs * 8);
  sub.writeUInt16BE(4, 0);
  sub.writeUInt16BE(sub.length, 2);
  sub.writeUInt16BE(segs * 2, 6);
  const ends = 14;
  [...codes, 0xffff].forEach((code, s) => {
    sub.writeUInt16BE(code, ends + s * 2);
    sub.writeUInt16BE(code, ends + 2 + segs * 2 + s * 2);
    sub.writeUInt16BE(code === 0xffff ? 1 : ((map.get(code) as number) - code) & 0xffff, ends + 2 + segs * 4 + s * 2);
  });
  const head = Buffer.alloc(12);
  head.writeUInt16BE(1, 2);
  head.writeUInt16BE(3, 4);
  head.writeUInt32BE(12, 8);
  return Buffer.concat([head, sub]);
}

/** A TrueType font program from `table`s, each 4-byte aligned (checksums left 0: neither FreeType nor pdf.js reads them). */
function sfnt(table: ReadonlyMap<string, Buffer>): Buffer {
  const tags = [...table.keys()].sort();
  const head = Buffer.alloc(12 + tags.length * 16);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt16BE(tags.length, 4);
  const parts: Buffer[] = [head];
  let offset = head.length;
  tags.forEach((tag, i) => {
    const data = table.get(tag) as Buffer;
    head.write(tag, 12 + i * 16, 'latin1');
    head.writeUInt32BE(offset, 12 + i * 16 + 8);
    head.writeUInt32BE(data.length, 12 + i * 16 + 12);
    const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
    parts.push(padded);
    offset += padded.length;
  });
  return Buffer.concat(parts);
}

/**
 * LiberationSans with its cmap replaced by a single (3,0) subtable, as a symbolic font is built: 0xF000 plus each
 * code of `codes` to the glyph of the letter of `draws` at the same place. Its glyph names (post) stay.
 */
export function symbolProgram(codes: string, draws: string): Buffer {
  const table = tables(liberation());
  const cmap = table.get('cmap') as Buffer;
  table.set('cmap', symbolCmap(new Map([...codes].map((ch, i) => [0xf000 + ch.charCodeAt(0), glyphOf(cmap, (draws[i] as string).charCodeAt(0))]))));
  return sfnt(table);
}

/**
 * An embedded symbolic (Flags 4) TrueType font whose program is `program`: with a /Differences giving each code of
 * `codes` the name `names[i]` when `names` is given, and no /Encoding at all when it is null; a /ToUnicode reading `reads`.
 */
export function symbolTrueType(ctx: PDFContext, program: Buffer, codes: string, names: readonly string[] | null, reads: string): PDFRef {
  const file = ctx.register(ctx.flateStream(program, { Length1: program.length }));
  const descriptor = ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: 'AAAAAD+GlyphmapSym', Flags: 4, FontBBox: [-200, -300, 1200, 1000], ItalicAngle: 0, Ascent: 900, Descent: -210, CapHeight: 720, StemV: 80, FontFile2: file }));
  const differences = names === null ? [] : [...new Map([...codes].map((ch, i) => [ch.charCodeAt(0), names[i] as string]))].sort((a, b) => a[0] - b[0]).flat();
  return ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'TrueType',
      BaseFont: 'AAAAAD+GlyphmapSym',
      FontDescriptor: descriptor,
      ...(names === null ? {} : { Encoding: { Type: 'Encoding', Differences: differences } }),
      ToUnicode: toUnicode(ctx, codes, reads),
    }),
  );
}

/** The glyph ids LiberationSans draws the letters of `text` with. */
export function glyphIds(text: string): number[] {
  const cmap = tables(liberation()).get('cmap') as Buffer;
  return [...text].map((ch) => glyphOf(cmap, ch.charCodeAt(0)));
}

/**
 * A Type0 font, Identity-H, over LiberationSans embedded as a CIDFontType2 with an /Identity CIDToGIDMap: a code is
 * a glyph id. Its /ToUnicode maps the glyph ids of `draws` to the letters of `reads`, place for place.
 */
export function identityType0(ctx: PDFContext, draws: string, reads: string): PDFRef {
  const ttf = liberation();
  const file = ctx.register(ctx.flateStream(ttf, { Length1: ttf.length }));
  const descriptor = ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: 'AAAAAE+LiberationSans', Flags: 32, FontBBox: [-200, -300, 1200, 1000], ItalicAngle: 0, Ascent: 900, Descent: -210, CapHeight: 720, StemV: 80, FontFile2: file }));
  const cid = ctx.register(
    ctx.obj({ Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'AAAAAE+LiberationSans', CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 }, FontDescriptor: descriptor, CIDToGIDMap: 'Identity', DW: 600 }),
  );
  const pairs = [...new Map(glyphIds(draws).map((gid, i) => [gid, (reads[i] ?? ' ').charCodeAt(0)]))].map(([gid, t]) => `<${gid.toString(16).toUpperCase().padStart(4, '0')}> <${t.toString(16).toUpperCase().padStart(4, '0')}>`);
  const cmap = ctx.register(
    ctx.flateStream(
      `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Made def /CIDSystemInfo << /Registry (M) /Ordering (M) /Supplement 0 >> def 1 begincodespacerange <0000> <FFFF> endcodespacerange ${pairs.length} beginbfchar ${pairs.join(' ')} endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`,
    ),
  );
  return ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'AAAAAE+LiberationSans', Encoding: 'Identity-H', DescendantFonts: [cid], ToUnicode: cmap }));
}

/** The codes of a Type0 Identity-H run drawing `text` in LiberationSans, as a hex string. */
export const identityCodes = (text: string): string => glyphIds(text).map((gid) => gid.toString(16).toUpperCase().padStart(4, '0')).join('');

/** `pdf` with page 1's font `name` (in its /Resources) replaced by `spec`'s. */
export async function withFont(pdf: Uint8Array, name: string, spec: FontSpec): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const fonts = doc.getPage(0).node.Resources()?.lookup(PDFName.of('Font'), PDFDict) as PDFDict;
  fonts.set(PDFName.of(name), font(doc.context, spec));
  return doc.save({ useObjectStreams: false });
}

/** Page 1's content, decoded. */
export async function contentText(pdf: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const ref = doc.getPage(0).node.get(PDFName.of('Contents')) as PDFRef;
  return Buffer.from(decodePDFRawStream(doc.context.lookup(ref) as PDFRawStream).decode()).toString('latin1');
}

/** The names `cls` gives the letters of `word`. */
export const namesOf = (cls: (c: string) => string, word: string): string[] => [...word].map(cls);

/**
 * `pdf` with `spec`'s run drawn inside a tiling pattern (GLYPHMAP fix round 2, B1: the verifier's adv2 P1): one cell
 * at 72 490 whose content shows the codes at 0 10 in the font (its own /Resources), and page 1 filling 72 490 300 40
 * with it, after the page's content. PDFium draws the run there and reads no text from it.
 */
export async function withPatternRun(pdf: Uint8Array, spec: FontSpec): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const { context } = doc;
  const page = doc.getPage(0);
  const ref = page.node.get(PDFName.of('Contents')) as PDFRef;
  const content = Buffer.from(decodePDFRawStream(context.lookup(ref) as PDFRawStream).decode()).toString('latin1');
  const cell = { Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 1000, 60], XStep: 1000, YStep: 1000, Matrix: [1, 0, 0, 1, 72, 490], Resources: { Font: { FXA1: font(context, spec) } } };
  const pattern = context.register(context.flateStream(`0 0 0 rg BT /FXA1 24 Tf 0 10 Td <${hex(spec.codes)}> Tj ET`, cell));
  (page.node.Resources() as PDFDict).set(PDFName.of('Pattern'), context.obj({ FXP: pattern }));
  context.assign(ref, context.flateStream(`${content}\nq /Pattern cs /FXP scn 72 490 300 40 re f Q`));
  return doc.save({ useObjectStreams: false });
}

/** `pdf` with a second page whose only content is `spec`'s run at 72 500 (GLYPHMAP fix round 2, S1). */
export async function withPageTwoRun(pdf: Uint8Array, spec: FontSpec): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const { context } = doc;
  const page = doc.addPage([612, 792]);
  page.node.set(PDFName.of('Resources'), context.obj({ Font: { FXA1: font(context, spec) } }));
  page.node.set(PDFName.of('Contents'), context.register(context.flateStream(`q 0 0 0 rg BT /FXA1 24 Tf 72 500 Td <${hex(spec.codes)}> Tj ET Q`)));
  return doc.save({ useObjectStreams: false });
}
