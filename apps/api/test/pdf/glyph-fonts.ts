// GLYPHMAP: simple fonts whose glyphs are chosen by name, of each kind PDFium and pdf.js draw, for the glyph-name
// tests. A run's codes spell one word ("Private") while its glyph names, written in one of the name classes below,
// spell another ("Quillon"); a /ToUnicode can make every text layer read the codes. Every word here is made up.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { type PDFContext, PDFDict, PDFDocument, PDFName, type PDFRawStream, type PDFRef, decodePDFRawStream } from '@cantoo/pdf-lib';

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
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const page = doc.getPage(0);
  const ref = page.node.get(PDFName.of('Contents')) as PDFRef;
  const content = Buffer.from(decodePDFRawStream(doc.context.lookup(ref) as PDFRawStream).decode()).toString('latin1');
  const fonts = page.node.Resources()?.lookup(PDFName.of('Font'), PDFDict) as PDFDict;
  fonts.set(PDFName.of('FXA1'), font(doc.context, spec));
  doc.context.assign(ref, doc.context.flateStream(`${content}\nq 0 0 0 rg ${draw} Q`));
  return doc.save({ useObjectStreams: false });
}

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
