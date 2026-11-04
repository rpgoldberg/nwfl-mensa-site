// REDACT-LOOK: synthetic PDFs for the exact-fit boxes, one per way a marked
// glyph's ink can reach past where its box would be (SPEC section 3, L1 to
// L9). Marked text is drawn red and the rest blue, so a rendered copy shows
// at once whether any marked pixel is left and whether an unmarked one went
// missing outside a box. Every name here is made up.
import { crc32, deflateSync } from 'node:zlib';
import { PDFDocument, PDFName, type PDFRef, PDFString, StandardFonts } from '@cantoo/pdf-lib';

export const RED = '1 0 0 rg';
export const RED_STROKE = '1 0 0 RG';
export const BLUE = '0 0 1 rg';

const HELVETICA = { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' };
const TIMES_ITALIC = { Type: 'Font', Subtype: 'Type1', BaseFont: 'Times-Italic', Encoding: 'WinAnsiEncoding' };
// No /Encoding: the built-in StandardEncoding, where \256 is the "fi" ligature.
const TIMES = { Type: 'Font', Subtype: 'Type1', BaseFont: 'Times-Roman' };

/**
 * A Type 3 font (F3) whose glyphs are rectangles, each code read as one letter through its ToUnicode
 * map. Units are thousandths of the type size.
 */
const TYPE3: ReadonlyArray<{ code: number; unicode: number; width: number; proc: string }> = [
  { code: 0x20, unicode: 0x20, width: 250, proc: '250 0 0 0 0 0 d1' },
  // K: ink far past its 500 advance, to 1400.
  { code: 0x41, unicode: 0x4b, width: 500, proc: '500 0 0 0 1400 700 d1 0 0 1400 700 re f' },
  { code: 0x42, unicode: 0x61, width: 500, proc: '500 0 50 0 450 500 d1 50 0 400 500 re f' },
  // y: a descender.
  { code: 0x43, unicode: 0x79, width: 500, proc: '500 0 50 -250 450 500 d1 50 -250 400 750 re f' },
  // A zero-width combining acute, drawn over the glyph before it.
  { code: 0x44, unicode: 0x301, width: 0, proc: '0 0 -450 750 -50 1150 d1 -450 750 400 400 re f' },
  // z: its whole ink 1.5 em to the right of its advance.
  { code: 0x45, unicode: 0x7a, width: 500, proc: '500 0 2000 0 2500 700 d1 2000 0 500 700 re f' },
  // x: ink to 900, past a following space into the next word.
  { code: 0x46, unicode: 0x78, width: 500, proc: '500 0 0 0 900 600 d1 0 0 900 600 re f' },
  { code: 0x47, unicode: 0x52, width: 500, proc: '500 0 50 0 450 700 d1 50 0 400 700 re f' },
  { code: 0x48, unicode: 0x65, width: 500, proc: '500 0 50 0 450 500 d1 50 0 400 500 re f' },
  { code: 0x49, unicode: 0x6e, width: 500, proc: '500 0 50 0 450 500 d1 50 0 400 500 re f' },
];

const toUnicode = (): string => {
  const hex = (n: number, digits: number): string => n.toString(16).toUpperCase().padStart(digits, '0');
  const pairs = TYPE3.map((g) => `<${hex(g.code, 2)}> <${hex(g.unicode, 4)}>`).join(' ');
  return `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /FitT3 def /CIDSystemInfo <</Registry (Fit) /Ordering (T3) /Supplement 0>> def 1 begincodespacerange <00> <FF> endcodespacerange ${TYPE3.length} beginbfchar ${pairs} endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
};

export interface PageOptions {
  width?: number;
  height?: number;
  /** A grey picture drawn at this box, over the text. */
  picture?: { left: number; bottom: number; width: number; height: number };
  /** A form XObject /Fm1 with this content, drawn by the page as "/Fm1 Do". */
  form?: string;
  /** A form XObject /Fm2 with this content, which /Fm1 draws ("/Fm2 Do"): a form two deep. */
  innerForm?: string;
  /** F5: Helvetica whose ToUnicode reads every letter, digit and mark but the space as "x" (a font that lies about its text). */
  lyingFont?: boolean;
  /** An ExtGState /GS0 with these entries. */
  extGState?: Record<string, unknown>;
}

/** A one-page PDF with this content stream and the fixture fonts F1 (Helvetica), F2 (Times-Italic), F3 (Type 3) and F4 (Times). */
export async function fitPdf(content: string, options: PageOptions = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([options.width ?? 400, options.height ?? 140]);
  const { context } = doc;
  const helvetica = context.register(context.obj(HELVETICA));
  page.node.setFontDictionary(PDFName.of('F1'), helvetica);
  page.node.setFontDictionary(PDFName.of('F2'), context.register(context.obj(TIMES_ITALIC)));
  page.node.setFontDictionary(PDFName.of('F4'), context.register(context.obj(TIMES)));
  const procs: Record<string, PDFRef> = {};
  for (const glyph of TYPE3) procs[`g${glyph.code.toString(16)}`] = context.register(context.flateStream(glyph.proc));
  const first = Math.min(...TYPE3.map((g) => g.code));
  const last = Math.max(...TYPE3.map((g) => g.code));
  const widths = Array.from({ length: last - first + 1 }, (_, i) => TYPE3.find((g) => g.code === first + i)?.width ?? 0);
  const differences: Array<number | string> = [];
  for (const glyph of TYPE3) differences.push(glyph.code, `g${glyph.code.toString(16)}`);
  page.node.setFontDictionary(
    PDFName.of('F3'),
    context.register(
      context.obj({
        Type: 'Font',
        Subtype: 'Type3',
        FontBBox: [-500, -300, 2600, 1200],
        FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
        CharProcs: procs,
        Encoding: { Type: 'Encoding', Differences: differences.map((d) => (typeof d === 'number' ? d : PDFName.of(d))) },
        FirstChar: first,
        LastChar: last,
        Widths: widths,
        Resources: {},
        ToUnicode: context.register(context.flateStream(toUnicode())),
      }),
    ),
  );
  const bbox = [0, 0, options.width ?? 400, options.height ?? 140];
  if (options.form !== undefined) {
    const inner = options.innerForm === undefined ? {} : { XObject: { Fm2: context.register(context.flateStream(options.innerForm, { Type: 'XObject', Subtype: 'Form', BBox: bbox, Resources: { Font: { F1: helvetica } } })) } };
    const form = context.flateStream(options.form, { Type: 'XObject', Subtype: 'Form', BBox: bbox, Resources: { Font: { F1: helvetica }, ...inner } });
    page.node.setXObject(PDFName.of('Fm1'), context.register(form));
  }
  if (options.lyingFont === true) {
    const codes = Array.from({ length: 0x7f - 0x21 }, (_, i) => `<${(0x21 + i).toString(16).toUpperCase()}> <0078>`);
    const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /FitLie def /CIDSystemInfo <</Registry (Fit) /Ordering (Lie) /Supplement 0>> def 1 begincodespacerange <00> <FF> endcodespacerange ${codes.length + 1} beginbfchar <20> <0020> ${codes.join(' ')} endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
    page.node.setFontDictionary(PDFName.of('F5'), context.register(context.obj({ ...HELVETICA, ToUnicode: context.register(context.flateStream(cmap)) })));
  }
  if (options.extGState !== undefined) page.node.setExtGState(PDFName.of('GS0'), context.register(context.obj(options.extGState as never)));
  page.node.set(PDFName.of('Contents'), context.obj([context.register(context.flateStream(content))]));
  // pdf-lib appends the picture's own content stream after the fixture's.
  if (options.picture !== undefined) {
    const { left, bottom, width, height } = options.picture;
    page.drawImage(await doc.embedPng(greyPng()), { x: left, y: bottom, width, height });
  }
  return doc.save({ useObjectStreams: false });
}

/** An 8 by 8 grey PNG. */
function greyPng(): Uint8Array {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(8, 0);
  header.writeUInt32BE(8, 4);
  header.set([8, 0, 0, 0, 0], 8);
  const rows = Buffer.concat(Array.from({ length: 8 }, () => Buffer.from([0, ...new Array<number>(8).fill(128)])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

export interface FitFixture {
  /** The SPEC section 3 surface. */
  surface: string;
  name: string;
  pdf: () => Promise<Uint8Array>;
  quotes: string[];
  /** What must not be readable in a copy. */
  needles: string[];
  /** A copy may be refused instead, for a reason like this: the surface is one no check can box exactly. */
  mayRefuse?: RegExp;
}

/** "Ask <marked> now." on one line, Helvetica 14 pt, the marked part red. */
export const askLine = (marked: string, opts: { font?: string; size?: number; x?: number; y?: number; before?: string; after?: string } = {}): string =>
  `BT /${opts.font ?? 'F1'} ${opts.size ?? 14} Tf ${opts.x ?? 20} ${opts.y ?? 60} Td ${BLUE} (${opts.before ?? 'Ask '}) Tj ${RED} ${marked} ${BLUE} (${opts.after ?? ' now.'}) Tj ET`;

const QUILLON = { quotes: ['Quillon Brask'], needles: ['Quillon Brask', 'Quillon', 'Brask'] };

/** The same marked words drawn a second time, at (dx, dy) from the first, in its own text object. */
const twice = (dx: number, dy: number, extra = ''): string =>
  `${askLine('(Quillon Brask) Tj')}\nBT /F1 14 Tf ${extra} ${20 + 27.23 + dx} ${60 + dy} Td ${RED} (Quillon Brask) Tj ET`;

/**
 * "Ask <name> now." with the name drawn a second time at (dx, dy) from the first, in its own text object,
 * at an offset PDFium's text page takes for a duplicate (a drop shadow, a fake bold): it reads the name
 * once, so the second copy is in no reading taken before the removal (REDACT-LOOK fix round, F1 and F2).
 */
export const shadowed = (name: string, dx: number, dy: number): string =>
  `${askLine(`(${name}) Tj`)}\nBT /F1 14 Tf ${(20 + 27.23 + dx).toFixed(4)} ${(60 + dy).toFixed(4)} Td ${RED} (${name}) Tj ET`;

/** The offsets of the challenger's sweep (14 pt) where the shadow's first, last or x-height glyphs were left. */
const SHADOWS: ReadonlyArray<[string, number, number]> = [
  ['Quillon Brell', 2.2, 0],
  ['Quillon Brell', 2.5, 0],
  ['Quillon Brell', 2.75, 0],
  ['Quillon Brell', 2.5, -2.5],
  ['Quillon Brask', 6.1, 0],
  ['Quillon Brask', 6.2, 0],
  ['Quillon Brask', 6.3, 0],
  ['Ivo Brumm', -2.7, 0],
  ['Ivo Brumm', -5, 0],
  ['Ivo Brumm', -10.4, 0],
  ['Quillon Braskett', 0, -10.5],
  ['Quillon Braskett', 0, -11],
];

/** Helvetica's advance widths (its AFM, thousandths of an em) of the letters the decoys are set in. */
const HELVETICA_WIDTHS: Readonly<Record<string, number>> = { ' ': 278, B: 667, I: 278, Q: 778, a: 556, e: 556, i: 222, k: 500, l: 222, m: 833, n: 556, o: 556, r: 333, s: 500, t: 278, u: 556, v: 500 };

/**
 * An invisible text object (render mode `mode`, 3 unless given) of the name's glyphs at `keep` alone, each
 * where it is in the name set from (x, y) at 14 pt, the others skipped by TJ spacing.
 */
const remnantOf = (name: string, keep: readonly number[], x: number, y: number, mode: number): string => {
  const glyphs = [...name];
  const at = (k: number): number => (glyphs.slice(0, k).reduce((sum, ch) => sum + (HELVETICA_WIDTHS[ch] as number), 0) * 14) / 1000;
  const parts: string[] = [];
  keep.forEach((k, n) => {
    if (n > 0) {
      const gap = glyphs.slice((keep[n - 1] as number) + 1, k).reduce((sum, ch) => sum + (HELVETICA_WIDTHS[ch] as number), 0);
      if (gap > 0) parts.push(String(-gap));
    }
    parts.push(`(${glyphs[k]})`);
  });
  return `BT /F1 14 Tf ${mode} Tr ${(x + at(keep[0] as number)).toFixed(4)} ${y.toFixed(4)} Td ${BLUE} [${parts.join(' ')}] TJ 0 Tr ET`;
};

/**
 * A shadow (`shadowed`) with a decoy (challenger r2, F-A): an invisible copy of exactly the glyphs a removal of
 * the marked name leaves of its shadow (`keep`, by index in the name), at their places, drawn between the two.
 * After the removal PDFium takes what is left of the shadow for a copy of the decoy and reads it no more, so a
 * check of the reading after the removal alone cannot see it: the shadow is in no reading before the removal
 * either, so the page's text objects are counted against the reading (redact.ts). `form`: all of it in a form
 * XObject the page draws moved down 20 pt, which the count walks into.
 */
const decoyed = (name: string, dx: number, dy: number, keep: readonly number[], opts: { mode?: number; form?: boolean } = {}): (() => Promise<Uint8Array>) => {
  const x = 20 + 27.23 + dx;
  const decoy = remnantOf(name, keep, x, 60 + dy, opts.mode ?? 3);
  const content = `${askLine(`(${name}) Tj`)}\n${decoy}\nBT /F1 14 Tf ${x.toFixed(4)} ${(60 + dy).toFixed(4)} Td ${RED} (${name}) Tj ET`;
  return () => (opts.form === true ? fitPdf('q 1 0 0 1 0 -20 cm /Fm1 Do Q', { form: content }) : fitPdf(content));
};

/**
 * The challenger's F-A, and a decoy for each shadow of the sweep (SHADOWS), of exactly the glyphs its removal
 * left before the count: the last glyph, the first, an x-height one, or a run of them.
 */
const DECOYS: ReadonlyArray<[string, number, number, readonly number[]]> = [
  ['Quillon Brask', 6.3, 4, [12]],
  ['Quillon Brell', 2.2, 0, [12]],
  ['Quillon Brell', 2.5, -2.5, [12]],
  ['Quillon Brask', 6.1, 0, [12]],
  ['Ivo Brumm', -2.7, 0, [0]],
  ['Ivo Brumm', -10.4, 0, [0]],
  ['Quillon Braskett', 0, -10.5, [1]],
  ['Quillon Braskett', 0, -11, [1, 5, 6, 7, 9, 10, 11, 13]],
];

/**
 * "Ask <name> now." drawn a word at a time (one Tj per word, as producers that write a text object per word do),
 * and the name drawn again so at (dx, dy) from it, after the line or before it, with no decoy (challenger r3, F1
 * and F2). PDFium reads both copies, interleaved word by word ("Quillon Quillon Brask Brask"), so the quote
 * matches once, across the two, and each word the match leaves is a copy of a withheld one by the box.
 */
const wordByWord = (name: string): string => name.split(' ').map((word, i, list) => `(${word}${i < list.length - 1 ? ' ' : ''}) Tj`).join(' ');
const perWord = (name: string, dx: number, dy: number, order: 'after' | 'before'): string => {
  const line = `BT /F1 14 Tf 20 60 Td ${BLUE} (Ask ) Tj ${RED} ${wordByWord(name)} ${BLUE} ( now.) Tj ET`;
  const again = `BT /F1 14 Tf ${(20 + 27.23 + dx).toFixed(4)} ${(60 + dy).toFixed(4)} Td ${RED} ${wordByWord(name)} ET`;
  return order === 'after' ? `${line}\n${again}` : `${again}\n${line}`;
};

/**
 * Per-word shadows past the challenger's range (REDACT-LOOK fix round 3): the reading pairs a twin's word with
 * the name's, and the word it leaves lies near the passage (within an em) but meets no box, so only the copy rule
 * (match.ts copiesOf) withholds it.
 */
const FAR_WORD_SHADOWS: ReadonlyArray<[string, number, number, 'after' | 'before']> = [
  ['Ivo Brumm', 19, 0, 'after'],
  ['Quillon Brask', -40, 0, 'before'],
  ['Ada Marsh', -30, 0, 'after'],
];

/**
 * "Ask <name> now." (the name a word at a time, or in one Tj) with the name drawn again at (dx, dy) a glyph at a
 * time, a text object per glyph, after the line or before it (REDACT-LOOK fix round 3, beyond the challenger's
 * sweep): no text object holds more than one glyph of the copy, so only where its glyphs lie joins them into words.
 * `track`: points added after each glyph's advance (a copy letter-spaced unlike the name, challenger r4 F1).
 */
const perGlyph = (name: string, dx: number, dy: number, line: 'word' | 'one', order: 'after' | 'before', track = 0): string => {
  let x = 20 + 27.23 + dx;
  const again = [...name]
    .map((ch) => {
      const glyph = `BT /F1 14 Tf ${x.toFixed(4)} ${(60 + dy).toFixed(4)} Td ${RED} (${ch}) Tj ET`;
      x += ((HELVETICA_WIDTHS[ch] as number) * 14) / 1000 + track;
      return glyph;
    })
    .join('\n');
  const main = line === 'one' ? askLine(`(${name}) Tj`) : `BT /F1 14 Tf 20 60 Td ${BLUE} (Ask ) Tj ${RED} ${wordByWord(name)} ${BLUE} ( now.) Tj ET`;
  return order === 'after' ? `${main}\n${again}` : `${again}\n${main}`;
};

/** Per-glyph copies whose glyphs past the box's edge the exact fit left (the last two leave them on main too). */
const GLYPH_SHADOWS: ReadonlyArray<[string, number, number, 'word' | 'one', 'after' | 'before']> = [
  ['Quillon Brask', 6.4, 0, 'word', 'after'],
  ['Quillon Brask', 16, 4, 'one', 'after'],
  ['Ivo Brumm', 11.2, 0, 'word', 'before'],
  ['Ivo Brumm', -3.2, 4, 'one', 'before'],
];

/**
 * The challenger's r4 F1 layouts: a copy drawn a glyph at a time, letter-spaced `track` pt more than the name, so the
 * glyphs that abut a pulled one are more than a tenth of an em apart and the abut chain stops. A glyph left so beside
 * the box refuses the page (match.ts loneGlyphs); a copy the box logic does not tie to the passage refuses it too.
 */
const TRACKED_GLYPH_SHADOWS: ReadonlyArray<[string, number, number, 'word' | 'one', number]> = [
  ['Quillon Brask', 6, 0, 'one', 1.6],
  ['Ivo Brumm', 1.2, 0, 'word', 1.6],
  ['Ivo Brumm', 0, 2.5, 'one', 2],
];

/**
 * "Ask <name>'s car." with the name a word at a time and drawn again so at (dx, dy) (challenger r4 F2): the
 * passage ends inside its last word ("Marsh's"), and the copy's "Marsh's" repeats the withheld "Marsh" with a
 * possessive. The 's is drawn with the name, so it is red in both, and the line's is left by design.
 */
export const possessiveShadow = (name: string, dx: number, dy: number, order: 'after' | 'before'): string => {
  const line = `BT /F1 14 Tf 20 60 Td ${BLUE} (Ask ) Tj ${RED} ${wordByWord(`${name}'s`)} ${BLUE} ( car.) Tj ET`;
  const again = `BT /F1 14 Tf ${(20 + 27.23 + dx).toFixed(4)} ${(60 + dy).toFixed(4)} Td ${RED} ${wordByWord(`${name}'s`)} ET`;
  return order === 'after' ? `${line}\n${again}` : `${again}\n${line}`;
};

/** An ordinary paragraph at 11 pt on 12 pt leading, a Tj per line, the name on its fourth line (challenger r4 F3). */
export const TIGHT_PARAGRAPH = [
  'Our spring picnic is at the bayou pavilion, with grilled shrimp,',
  'hot dogs, and a quiz: bring a guess at the jar of jellybeans.',
  'Parking is by the gym; carpools from the hall leave at eight.',
  '@ by Friday so we can plan enough supply for you.',
  'Questions go to the program chair, who is happy to help.',
];
export const tightParagraph = (per: 'line' | 'word' = 'line'): Promise<Uint8Array> =>
  fitPdf(
    TIGHT_PARAGRAPH.map((line, n) => {
      const [before = '', after = ''] = line.split('@');
      // A Tj per line, or a Tj per word with its following space (the challenger's para-word layouts).
      const tj = (text: string): string => (per === 'line' ? `(${text}) Tj` : text.split(/(?<= )/u).map((word) => `(${word}) Tj`).join(' '));
      const ops = line.includes('@') ? `${before === '' ? '' : `${BLUE} ${tj(before)} `}${RED} ${tj('Quillon Brask')} ${BLUE} ${tj(after)}` : `${BLUE} ${tj(line)}`;
      return `BT /F1 11 Tf 30 ${(120 - 12 * n).toFixed(2)} Td ${ops} ET`;
    }).join('\n'),
    { width: 420 },
  );

/** The page's and the outer form's matrices for a form two deep: a rotation and a stretch, each way round. */
export const NESTED: ReadonlyArray<[string, string, string]> = [
  ['rotated, then stretched', 'q 0.866 0.5 -0.5 0.866 150 20 cm /Fm1 Do Q', '1.5 0 0 0.7 0 0 cm /Fm2 Do'],
  ['stretched, then rotated', 'q 1.5 0 0 0.7 20 20 cm /Fm1 Do Q', '0.866 0.5 -0.5 0.866 60 0 cm /Fm2 Do'],
];

/** The challenger's r3 layouts (sweep2 and AT8b) whose copies left a glyph of the name beside the box. */
const WORD_SHADOWS: ReadonlyArray<[string, number, number, 'after' | 'before']> = [
  ['Quillon Brask', 6.4, 0, 'after'],
  ['Ada Marsh', -8.8, 0, 'before'],
  ['Quillon Brask', 6.3, 4, 'after'],
  ['Ivo Brumm', 12.8, 1.5, 'after'],
];

export const FIT_FIXTURES: FitFixture[] = [
  // L1: ink outside the loose box.
  { surface: 'L1', name: 'accents above the ascent (Å, Ç, ÿ)', pdf: () => fitPdf(askLine('(\\305sa \\307ald\\377ry) Tj', { size: 18 })), quotes: ['Åsa Çaldÿry'], needles: ['Åsa', 'Çaldÿry', 'aldÿry'] },
  { surface: 'L1', name: 'descenders (g j p q y)', pdf: () => fitPdf(askLine('(Peggy Jaquay) Tj', { size: 18 })), quotes: ['Peggy Jaquay'], needles: ['Peggy', 'Jaquay'] },
  { surface: 'L1', name: 'italic overhang (Times-Italic f)', pdf: () => fitPdf(askLine('(Jeff Fairfax) Tj', { font: 'F2', size: 22 })), quotes: ['Jeff Fairfax'], needles: ['Jeff', 'Fairfax'] },
  { surface: 'L1', name: 'a Type 3 glyph whose ink runs past its advance', pdf: () => fitPdf(`BT /F1 18 Tf 20 60 Td ${BLUE} (Ask ) Tj /F3 18 Tf ${RED} (ABC) Tj /F1 18 Tf ${BLUE} (      now.) Tj ET`), quotes: ['Kay'], needles: ['Kay'] },
  { surface: 'L1', name: 'stroked text (Tr 1, 3 pt line)', pdf: () => fitPdf(`${RED_STROKE} 3 w ${askLine('1 Tr (Quillon Brask) Tj 0 Tr', { size: 20 })}`), ...QUILLON },
  { surface: 'L1', name: 'filled and stroked text (Tr 2, 3 pt line)', pdf: () => fitPdf(`${RED_STROKE} 3 w ${askLine('2 Tr (Quillon Brask) Tj 0 Tr', { size: 20 })}`), ...QUILLON },
  { surface: 'L1', name: 'text rise (Ts 6)', pdf: () => fitPdf(askLine('(Quillon ) Tj 6 Ts (Brask) Tj 0 Ts')), ...QUILLON },
  { surface: 'L1', name: 'horizontal scaling (Tz 50)', pdf: () => fitPdf(askLine('50 Tz (Quillon Brask) Tj 100 Tz')), ...QUILLON },
  { surface: 'L1', name: 'horizontal scaling (Tz 200)', pdf: () => fitPdf(askLine('200 Tz (Quillon Brask) Tj 100 Tz', { size: 12 })), ...QUILLON },
  { surface: 'L1', name: 'rotated 30 degrees', pdf: () => fitPdf(`BT /F1 12 Tf 0.866 0.5 -0.5 0.866 30 15 Tm ${BLUE} (Ask ) Tj ${RED} (Quillon Brask) Tj ${BLUE} ( now.) Tj ET`), ...QUILLON },
  { surface: 'L1', name: 'rotated 90 degrees', pdf: () => fitPdf(`BT /F1 12 Tf 0 1 -1 0 200 8 Tm ${BLUE} (Ask ) Tj ${RED} (Quillon Brask) Tj ${BLUE} ( now.) Tj ET`), ...QUILLON },
  { surface: 'L1', name: 'skewed (Tm with a shear)', pdf: () => fitPdf(`BT /F1 16 Tf 1 0 0.6 1 20 60 Tm ${BLUE} (Ask ) Tj ${RED} (Quillon Brask) Tj ${BLUE} ( now.) Tj ET`), ...QUILLON },
  { surface: 'L1', name: 'a clipped run (W n)', pdf: () => fitPdf(`q 20 0 90 140 re W n ${askLine('(Quillon Brask) Tj', { size: 18 })} Q ${BLUE} BT /F1 14 Tf 20 20 Td (The rest stays.) Tj ET`), ...QUILLON },
  // L2: text drawn twice.
  { surface: 'L2', name: 'drawn twice, 0.3 pt apart', pdf: () => fitPdf(twice(0.3, 0)), ...QUILLON },
  { surface: 'L2', name: 'drawn twice, 1.5 pt apart', pdf: () => fitPdf(twice(1.5, -1.5)), ...QUILLON },
  { surface: 'L2', name: 'drawn twice, half an em apart', pdf: () => fitPdf(twice(7, 0)), ...QUILLON, mayRefuse: /withheld/ },
  { surface: 'L2', name: 'drawn twice, an em apart', pdf: () => fitPdf(twice(14, 0)), ...QUILLON, mayRefuse: /withheld/ },
  { surface: 'L2', name: 'drawn twice, three ems apart', pdf: () => fitPdf(twice(42, 0)), ...QUILLON, mayRefuse: /withheld/ },
  { surface: 'L2', name: 'drawn twice, half a line up', pdf: () => fitPdf(twice(0, 8.4)), ...QUILLON },
  { surface: 'L2', name: 'drawn twice, half a line down', pdf: () => fitPdf(twice(0, -8.4)), ...QUILLON },
  { surface: 'L2', name: 'fake bold (Tr 2 and a 0.4 pt offset)', pdf: () => fitPdf(`${RED_STROKE} 0.5 w ${twice(0.4, 0, '2 Tr')}`), ...QUILLON },
  // L2: drawn twice at an offset PDFium reads once; the copy it left out is read once the first is removed.
  ...SHADOWS.map(([name, dx, dy]): FitFixture => ({
    surface: 'L2',
    name: `"${name}" drawn twice, PDFium reading it once (${dx}, ${dy})`,
    pdf: () => fitPdf(shadowed(name, dx, dy)),
    quotes: [name],
    needles: [name, ...name.split(' ')],
    mayRefuse: /drawn twice/,
  })),
  // L2: the same, with a decoy that hides what removal leaves of the shadow from the reading after it (F-A).
  ...DECOYS.map(([name, dx, dy, keep]): FitFixture => ({
    surface: 'L2',
    name: `"${name}" drawn twice (${dx}, ${dy}), with an invisible decoy of glyphs ${keep.join(' ')}`,
    pdf: decoyed(name, dx, dy, keep),
    quotes: [name],
    needles: [name, ...name.split(' ')],
    // On the name's own baseline the decoy runs on into it ("Brelll"): PDFium's reading then holds no passage,
    // and the output gate, reading as pdf.js does, finds the name and refuses the copy.
    ...(dy === 0 ? { mayRefuse: /can still be read by another reader/ } : {}),
  })),
  { surface: 'L2', name: 'F-A in a form XObject drawn moved', pdf: decoyed('Quillon Brask', 6.3, 4, [12], { form: true }), ...QUILLON },
  { surface: 'L2', name: 'F-A with the decoy drawn as a clip (Tr 7)', pdf: decoyed('Quillon Brask', 6.3, 4, [12], { mode: 7 }), ...QUILLON, mayRefuse: /drawn as a clip/ },
  // L2: drawn a word at a time, and again so beside it (challenger r3, F1 and F2): a copy, never refused.
  ...[...WORD_SHADOWS, ...FAR_WORD_SHADOWS].map(([name, dx, dy, order]): FitFixture => ({
    surface: 'L2',
    name: `"${name}" drawn a word at a time, and again so at (${dx}, ${dy}) ${order} it`,
    pdf: () => fitPdf(perWord(name, dx, dy, order)),
    quotes: [name],
    needles: [name, ...name.split(' ')],
  })),
  // L2: the same, the copy drawn a glyph at a time: a copy, never refused.
  ...GLYPH_SHADOWS.map(([name, dx, dy, line, order]): FitFixture => ({
    surface: 'L2',
    name: `"${name}" (${line === 'one' ? 'in one Tj' : 'a word at a time'}) drawn again a glyph at a time at (${dx}, ${dy}) ${order} it`,
    pdf: () => fitPdf(perGlyph(name, dx, dy, line, order)),
    quotes: [name],
    needles: [name, ...name.split(' ')],
  })),
  // L2: a copy drawn a glyph at a time, letter-spaced unlike the name (challenger r4 F1): no glyph of it is left, or
  // the page is refused.
  ...TRACKED_GLYPH_SHADOWS.map(([name, dx, dy, line, track]): FitFixture => ({
    surface: 'L2',
    name: `"${name}" (${line === 'one' ? 'in one Tj' : 'a word at a time'}) drawn again a glyph at a time, ${track} pt apart, at (${dx}, ${dy}) after it`,
    pdf: () => fitPdf(perGlyph(name, dx, dy, line, 'after', track)),
    quotes: [name],
    needles: [name, ...name.split(' ')],
    mayRefuse: /a glyph drawn on its own is left beside a withheld passage|withheld text is drawn again elsewhere on the page/,
  })),
  // L2: a shadow in a font whose ToUnicode reads every letter as x (challenger r3, F3): no reading holds a copy of
  // the name, so only where its glyphs lie says what it is.
  ...([[7, 4], [30, 0]] as const).map(([dx, dy]): FitFixture => ({
    surface: 'L2',
    name: `a shadow at (${dx}, ${dy}) in a font that reads every letter as x`,
    pdf: () => fitPdf(`${askLine('(Quillon Brask) Tj')}\nBT /F5 14 Tf ${(20 + 27.23 + dx).toFixed(4)} ${(60 + dy).toFixed(4)} Td ${RED} (Quillon Brask) Tj ET`, { lyingFont: true }),
    ...QUILLON,
  })),
  // L2: F-A's shadow, with no decoy, two forms deep, the forms' matrices not commuting (challenger r3, N1): the
  // count places it on the page only when it carries the inner form's matrix first, then the outer's.
  ...NESTED.map(([order, page, form]): FitFixture => ({
    surface: 'L2',
    name: `F-A with no decoy two forms deep, ${order}`,
    pdf: () => fitPdf(page, { width: 500, height: 400, form, innerForm: shadowed('Quillon Brask', 6.3, 4) }),
    ...QUILLON,
  })),
  // L3: one marked glyph left behind, which no whole-quote check sees.
  { surface: 'L3', name: 'a Type 3 glyph drawn 1.5 em from its advance', pdf: () => fitPdf(`BT /F1 18 Tf 20 60 Td ${BLUE} (Ask ) Tj /F3 18 Tf ${RED} (GHIBE) Tj /F1 18 Tf ${BLUE} (          now.) Tj ET`), quotes: ['Renaz'], needles: ['Renaz', 'Rena'], mayRefuse: /withheld/ },
  { surface: 'L3', name: 'a glyph pulled out of its place by a TJ', pdf: () => fitPdf(askLine('[(Quill) 2200 (on)] TJ', { after: '      now.' })), quotes: ['Quillon'], needles: ['Quillon', 'Quill'], mayRefuse: /withheld/ },
  // L4: a zero-width combining mark.
  { surface: 'L4', name: 'a zero-width combining mark (Type 3, U+0301)', pdf: () => fitPdf(`BT /F1 18 Tf 20 60 Td ${BLUE} (Ask ) Tj /F3 18 Tf ${RED} (GHIHD) Tj /F1 18 Tf ${BLUE} ( now.) Tj ET`), // A shorter needle ("Ren") would be found in "/Parent" in the raw bytes.
    quotes: ['René'], needles: ['René'], mayRefuse: /no position|withheld/ },
  // L5: ligature, letter spacing, a hyphen across lines, a split line.
  {
    surface: 'L5',
    name: 'a ligature, letter spacing, a hyphen at a line end and a split line',
    pdf: () =>
      fitPdf(
        [
          `BT /F4 14 Tf 20 120 Td ${BLUE} (Keep the ) Tj ${RED} (Snow\\256eld) Tj ${BLUE} ( farm in mind.) Tj ET`,
          `BT /F1 14 Tf 20 100 Td ${BLUE} (Phone ) Tj ${RED} 3 Tc (Kestrel) Tj 0 Tc ${BLUE} ( now.) Tj ET`,
          `BT /F1 14 Tf 20 80 Td ${BLUE} (Tobias ) Tj ${RED} (Wren-) Tj ET`,
          `BT /F1 14 Tf 20 64 Td ${RED} (hallow) Tj ${BLUE} ( hosted it.) Tj ET`,
          `BT /F1 14 Tf 20 44 Td ${BLUE} (Then ask ) Tj ${RED} (Marvel) Tj ET`,
          `BT /F1 14 Tf 20 28 Td ${RED} (Ostrander) Tj ${BLUE} ( at the door.) Tj ET`,
        ].join('\n'),
      ),
    quotes: ['Snowfield', 'Kestrel', 'Wrenhallow', 'Marvel Ostrander'],
    // pdf.js reads the hyphenated word as "Wren- hallow": its halves are the needles.
    needles: ['Snowfield', 'Snow', 'Kestrel', 'Wren', 'hallow', 'Marvel', 'Ostrander'],
  },
  // L6: hidden duplicates.
  {
    surface: 'L6',
    name: 'an invisible copy (Tr 3), a form XObject and ActualText',
    pdf: () =>
      fitPdf(
        [
          askLine('(Quillon Brask) Tj', { y: 110 }),
          `BT /F1 14 Tf 3 Tr 20 110 Td (Ask Quillon Brask now.) Tj 0 Tr ET`,
          '/Fm1 Do',
          `/Span <</ActualText (Quillon Brask)>> BDC BT /F1 14 Tf 20 30 Td ${BLUE} (Signed, the host.) Tj ET EMC`,
        ].join('\n'),
        { form: askLine('(Quillon Brask) Tj', { y: 70 }) },
      ),
    ...QUILLON,
  },
  // L7: unmarked neighbours whose ink reaches into the marked passage.
  { surface: 'L7', name: 'a kerned neighbour (“ tucked over V)', pdf: () => fitPdf(`BT /F1 24 Tf 20 60 Td ${BLUE} (Ask \\223) Tj ${RED} [250 (Vola)] TJ ${BLUE} (\\224 now.) Tj ET`), quotes: ['Vola'], needles: ['Vola'] },
  { surface: 'L7', name: 'an italic f reaching across a tight space', pdf: () => fitPdf(`BT /F2 24 Tf 20 60 Td ${BLUE} (Ask the staff ) Tj ${RED} [150 (Bolam)] TJ ${BLUE} ( now.) Tj ET`), quotes: ['Bolam'], needles: ['Bolam'] },
  { surface: 'L7', name: 'descenders of the line above reaching into the passage (11 pt on 12 pt leading)', pdf: () => tightParagraph(), ...QUILLON },
  { surface: 'L7', name: 'descenders of the line above reaching into the passage (11 pt on 12 pt leading), a Tj per word', pdf: () => tightParagraph('word'), ...QUILLON },
  { surface: 'L7', name: 'a Type 3 neighbour whose ink overlaps the passage', pdf: () => fitPdf(`BT /F1 18 Tf 20 60 Td ${BLUE} (Ask ) Tj /F3 18 Tf (F ) Tj ${RED} (GHIH) Tj /F1 18 Tf ${BLUE} ( now.) Tj ET`), quotes: ['Rene'], needles: ['Rene'] },
  // L9: a page that leaves its graphics state open, before the box is appended.
  {
    surface: 'L9',
    name: 'an unbalanced /GS0 gs (ca 0.2, Multiply) and q ... cm at the end of the page',
    pdf: () => fitPdf(`${askLine('(Bo) Tj')}\n${askLine('(Quillon Brask) Tj', { y: 100 })}\n/GS0 gs q 2 0 0 2 0 0 cm ${BLUE}`, { extGState: { Type: 'ExtGState', ca: 0.2, CA: 0.2, BM: PDFName.of('Multiply') } }),
    quotes: ['Bo', 'Quillon Brask'],
    needles: ['Quillon', 'Brask'],
  },
];

/**
 * L8: "Ask Åsa now." with a picture over the Å's ring (`over`), or just right of "Åsa", clear of its
 * glyphs but where a widened box would have reached.
 */
export async function pictureNearFixture(place: 'over' | 'beside'): Promise<Uint8Array> {
  const picture = place === 'over' ? { left: 58, bottom: 74, width: 6, height: 6 } : { left: 89, bottom: 58, width: 6, height: 14 };
  return fitPdf(`BT /F1 18 Tf 20 60 Td ${BLUE} (Ask ) Tj ${RED} (\\305sa) Tj ${BLUE} (               now.) Tj ET`, { picture });
}

/** Text set at 1 pt and scaled by its matrix to 12 pt, as some layout programs write it. */
export async function scaledTypeFixture(): Promise<Uint8Array> {
  return fitPdf(`BT /F1 1 Tf 12 0 0 12 20 60 Tm ${BLUE} (Please call ) Tj ${RED} (Quillon Brask) Tj ${BLUE} ( today.) Tj ET`);
}

/** The page the orchestrator shows Ross: a short notice with names, a phone number and an address. */
export async function lookFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([432, 216]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawText('Picnic at the pavilion', { x: 36, y: 176, size: 16, font: bold });
  const lines = [
    'Alex Sample will bring the grill, and Bo Pellingham the lemonade.',
    'Questions? Call Quillon Brask at 850-555-0142 or write to him at',
    '12 Example Lane, Pensacola. Rides from Jo Ostley on request.',
    'Everyone is welcome; bring a chair and a friend.',
  ];
  lines.forEach((line, n) => page.drawText(line, { x: 36, y: 146 - 20 * n, size: 12, font }));
  page.node.set(PDFName.of('Lang'), PDFString.of('en-US'));
  return doc.save({ useObjectStreams: false });
}

/** The look page's marks as the public is given them after 0022: contacts redacted, names shown. */
export const LOOK_PUBLIC_QUOTES = ['850-555-0142', '12 Example Lane, Pensacola'];
/** The look page's marks as the public was given them before 0022: names redacted too. */
export const LOOK_OLD_PUBLIC_QUOTES = [...LOOK_PUBLIC_QUOTES, 'Alex Sample', 'Bo Pellingham', 'Quillon Brask', 'Jo Ostley'];
