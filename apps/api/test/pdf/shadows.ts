// The round-3 challenge's parser differentials (UNTRUSTED-PDF-GATE M1), as fixtures: copies a
// subverted engine could hand back, which pdf-lib (the gate's object reader) and a viewer (pdf.js,
// which follows the xref) read differently. Two tricks:
//   - a shadow: an object number written twice; the xref names the first, active definition, and
//     pdf-lib keeps the last, clean one;
//   - an indirect structural name: /S, /Subtype or /PatternType given as a reference, which a
//     lookup-free reader of the dictionary does not see as a name.
// Each case has a control: the same copy written plainly, which the gate refused all along. Small,
// bounded PDFs, written byte by byte here; nothing in them runs. Every name is made up.
import { deflateSync } from 'node:zlib';
import { PDFDocument } from '@cantoo/pdf-lib';

const latin1 = (text: string): Buffer => Buffer.from(text, 'latin1');
type Body = string | Buffer;
export type RawObject = [number, Body];

export interface RawOptions {
  /** Moves the xref entry of this object number by `by` bytes, so it lands somewhere else. */
  shift?: { object: number; by: number };
  /** Appends a second xref section (an incremental update) redefining this object, with /Prev. */
  update?: RawObject;
  /** Adds /Prev to the one trailer, pointing at the xref itself. */
  prev?: boolean;
  /** Leaves this object number out of the xref (marked free), though its definition is in the file. */
  omit?: number;
  /** The catalog's object number, for the trailer's /Root (1 when not given). */
  root?: number;
}

/** A PDF written as given: objects in order (a number may repeat), the xref naming each number's FIRST definition. */
export function rawPdf(objects: readonly RawObject[], options: RawOptions = {}): Uint8Array {
  const parts = [latin1('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')];
  let at = (parts[0] as Buffer).length;
  const first = new Map<number, number>();
  for (const [num, body] of objects) {
    const chunk = Buffer.concat([latin1(`${num} 0 obj\n`), typeof body === 'string' ? latin1(body) : body, latin1('\nendobj\n')]);
    if (!first.has(num)) first.set(num, at);
    parts.push(chunk);
    at += chunk.length;
  }
  if (options.shift !== undefined) first.set(options.shift.object, (first.get(options.shift.object) as number) + options.shift.by);
  const max = Math.max(...first.keys());
  if (options.omit !== undefined) first.delete(options.omit);
  const xrefAt = at;
  let xref = `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= max; n++) xref += first.has(n) ? `${String(first.get(n)).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
  const prev = options.prev === true ? ` /Prev ${xrefAt}` : '';
  const root = options.root ?? 1;
  const tail = latin1(`${xref}trailer\n<< /Size ${max + 1} /Root ${root} 0 R${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  parts.push(tail);
  at += tail.length;
  if (options.update !== undefined) {
    const [num, body] = options.update;
    const objectAt = at;
    const chunk = Buffer.concat([latin1(`${num} 0 obj\n`), typeof body === 'string' ? latin1(body) : body, latin1('\nendobj\n')]);
    parts.push(chunk);
    at += chunk.length;
    parts.push(latin1(`xref\n${num} 1\n${String(objectAt).padStart(10, '0')} 00000 n \ntrailer\n<< /Size ${max + 1} /Root ${root} 0 R /Prev ${xrefAt} >>\nstartxref\n${at}\n%%EOF\n`));
  }
  return new Uint8Array(Buffer.concat(parts));
}

export const rawStream = (dict: string, data: Body): Buffer =>
  Buffer.concat([latin1(`<< ${dict} /Length ${data.length} >>\nstream\n`), typeof data === 'string' ? latin1(data) : data, latin1('\nendstream')]);

const FONT: RawObject = [5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
const TEXT = 'BT /F1 12 Tf 72 720 Td (Picnic flyer) Tj ET\n';
const PAGES: RawObject = [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'];
const CATALOG = '<< /Type /Catalog /Pages 2 0 R >>';
const page = (resources = '', extra = ''): RawObject => [3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> ${resources} >> ${extra}>>`];
const contents = (more = ''): RawObject => [4, rawStream('', TEXT + more)];

/** A plain one-page copy: the flyer's text, nothing else. */
export const plainCopy = (): Uint8Array => rawPdf([[1, CATALOG], PAGES, page(), contents(), FONT]);

// The original's 64 x 64 photo (seeded noise, so no blur keeps it) and the copy's "kept" photo: the same
// samples, each +1, so neither its bytes nor its exact samples match the original's.
const SIDE = 64;
const SAMPLES = (() => {
  const out = Buffer.alloc(SIDE * SIDE * 3);
  let x = 7;
  for (let i = 0; i < out.length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    out[i] = (x >>> 16) & 0xfe;
  }
  return out;
})();
const KEPT = Buffer.from(SAMPLES.map((sample) => sample + 1));
const picture = (subtype: string, samples: Buffer): Buffer =>
  rawStream(`/Type /XObject /Subtype ${subtype} /Width ${SIDE} /Height ${SIDE} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`, deflateSync(samples));
const DRAW = 'q 200 0 0 200 72 400 cm /Im1 Do Q\n';

/** The original the M1 copies were made from: the flyer and the photo. */
export const M1_ORIGINAL = rawPdf([[1, CATALOG], PAGES, page('/XObject << /Im1 6 0 R >>'), contents(DRAW), FONT, [6, picture('/Image', SAMPLES)]]);

export interface M1Case {
  id: string;
  name: string;
  image: 'show' | 'blur' | 'hide';
  attack: Uint8Array;
  control: Uint8Array;
}

const cases: M1Case[] = [];
const add = (id: string, name: string, image: M1Case['image'], attack: Uint8Array, control: Uint8Array): void => void cases.push({ id, name, image, attack, control });
/** The attack: the active definitions, then clean duplicates; the control: the active definitions alone. */
const shadowed = (active: readonly RawObject[], clean: readonly RawObject[]): [Uint8Array, Uint8Array] => [rawPdf([...active, ...clean]), rawPdf(active)];

add(
  'a',
  'a JavaScript OpenAction, the catalog and the action shadowed',
  'blur',
  ...shadowed([[1, '<< /Type /Catalog /Pages 2 0 R /OpenAction 6 0 R >>'], PAGES, page(), contents(), FONT, [6, "<< /S /JavaScript /JS (app.alert\\('gate bypass'\\);) >>"]], [[1, CATALOG], [6, '<< >>']]),
);
add('a2', 'a Named Print OpenAction, the catalog shadowed', 'blur', ...shadowed([[1, '<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /Named /N /Print >> >>'], PAGES, page(), contents(), FONT], [[1, CATALOG]]));
const outlined = (s: string, title: string): Uint8Array =>
  rawPdf([
    [1, '<< /Type /Catalog /Pages 2 0 R /Outlines 7 0 R /PageMode /UseOutlines >>'],
    PAGES,
    page(),
    contents(),
    FONT,
    [7, '<< /Type /Outlines /First 8 0 R /Last 8 0 R /Count 1 >>'],
    [8, `<< /Title (${title}) /Parent 7 0 R /A << /S ${s} /F (https://example.invalid/roster.pdf) /D [0 /Fit] >> >>`],
    [9, s === '9 0 R' && title === 'Open' ? '/Launch' : '/GoToR'],
  ]);
add('b', 'an outline GoToR to a remote file, its /S indirect', 'blur', outlined('9 0 R', 'Members roster'), outlined('/GoToR', 'Members roster'));
add('b2', 'an outline Launch, its /S indirect', 'blur', outlined('9 0 R', 'Open'), outlined('/Launch', 'Open'));
const kept = (subtype: string, extra: readonly RawObject[] = []): Uint8Array =>
  rawPdf([[1, CATALOG], PAGES, page('/XObject << /Im1 6 0 R >>'), contents(DRAW), FONT, [6, picture(subtype, KEPT)], ...extra]);
add('c', 'the original photo kept, its /Subtype indirect (blur)', 'blur', kept('10 0 R', [[10, '/Image']]), kept('/Image'));
add('c2', 'the original photo kept, its /Subtype indirect (hide)', 'hide', kept('10 0 R', [[10, '/Image']]), kept('/Image'));
add(
  'd',
  'the original photo kept, shadowed by a grey fill (hide)',
  'hide',
  rawPdf([
    [1, CATALOG],
    PAGES,
    page('/XObject << /Im1 6 0 R >>'),
    contents(DRAW),
    FONT,
    [6, picture('/Image', KEPT)],
    [6, rawStream('/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8', Buffer.from([160]))],
  ]),
  kept('/Image'),
);
const inline = (scale: string): Buffer => latin1(`q ${scale} cm BI /W ${SIDE} /H ${SIDE} /CS /RGB /BPC 8 /F /AHx ID ${KEPT.toString('hex')}>\nEI Q\n`);
const inForm = (subtype: string, extra: readonly RawObject[] = []): Uint8Array =>
  rawPdf([[1, CATALOG], PAGES, page('/XObject << /Fm1 6 0 R >>'), contents('q /Fm1 Do Q\n'), FONT, [6, rawStream(`/Type /XObject /Subtype ${subtype} /BBox [0 0 612 792]`, inline('200 0 0 200 72 400'))], ...extra]);
add('e', 'an inline photo in a form, the form\'s /Subtype indirect (hide)', 'hide', inForm('11 0 R', [[11, '/Form']]), inForm('/Form'));
const inPattern = (type: string, extra: readonly RawObject[] = []): Uint8Array =>
  rawPdf([
    [1, CATALOG],
    PAGES,
    page('/Pattern << /P1 6 0 R >>'),
    contents('/Pattern cs /P1 scn 72 400 200 200 re f\n'),
    FONT,
    [6, rawStream(`/Type /Pattern /PatternType ${type} /PaintType 1 /TilingType 1 /BBox [0 0 64 64] /XStep 64 /YStep 64 /Resources << >>`, inline('64 0 0 64 0 0'))],
    ...extra,
  ]);
add('f', 'an inline photo in a tiling pattern, its /PatternType indirect (hide)', 'hide', inPattern('12 0 R', [[12, '1']]), inPattern('1'));
add(
  'g1',
  'an outline URI action, the item shadowed',
  'blur',
  ...shadowed(
    [
      [1, '<< /Type /Catalog /Pages 2 0 R /Outlines 7 0 R >>'],
      PAGES,
      page(),
      contents(),
      FONT,
      [7, '<< /Type /Outlines /First 8 0 R /Last 8 0 R /Count 1 >>'],
      [8, '<< /Title (Roster) /Parent 7 0 R /A << /S /URI /URI (https://example.invalid/u) >> >>'],
    ],
    [[8, '<< /Title (Roster) /Parent 7 0 R >>']],
  ),
);
add('g2', 'a page /AA JavaScript, the page shadowed', 'blur', ...shadowed([[1, CATALOG], PAGES, page('', "/AA << /O << /S /JavaScript /JS (app.alert\\('aa'\\)) >> >> "), contents(), FONT], [page()]));
add(
  'g3',
  'an embedded file, the catalog, file specification and file shadowed',
  'blur',
  ...shadowed(
    [
      [1, '<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(roster.txt) 7 0 R] >> >> >>'],
      PAGES,
      page(),
      contents(),
      FONT,
      [7, '<< /Type /Filespec /F (roster.txt) /EF << /F 8 0 R >> >>'],
      [8, rawStream('/Type /EmbeddedFile', 'MEMBERS ONLY roster')],
    ],
    [[1, CATALOG], [7, '<< >>'], [8, '<< >>']],
  ),
);
const ANNOTATED = '/Annots [7 0 R] ';
add(
  'g4',
  'a Stamp annotation drawing the photo, shadowed (hide)',
  'hide',
  ...shadowed(
    [
      [1, CATALOG],
      PAGES,
      page('', ANNOTATED),
      contents(),
      FONT,
      [7, '<< /Type /Annot /Subtype /Stamp /Rect [72 400 272 600] /AP << /N 8 0 R >> >>'],
      [8, rawStream('/Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources << /XObject << /Im1 6 0 R >> >>', 'q 200 0 0 200 0 0 cm /Im1 Do Q')],
      [6, picture('/Image', KEPT)],
    ],
    [page(), [7, '<< >>'], [8, '<< >>'], [6, '<< >>']],
  ),
);
add('g5', 'a RichMedia annotation, the page shadowed', 'blur', ...shadowed([[1, CATALOG], PAGES, page('', ANNOTATED), contents(), FONT, [7, '<< /Type /Annot /Subtype /RichMedia /Rect [72 400 272 600] >>']], [page(), [7, '<< >>']]));
add(
  'g6',
  'an XFA form, the catalog shadowed',
  'blur',
  ...shadowed([[1, '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [] /XFA 7 0 R >> >>'], PAGES, page(), contents(), FONT, [7, rawStream('', '<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"></xdp:xdp>')]], [[1, CATALOG], [7, '<< >>']]),
);
const stamped = (appearance: Buffer, filter: string): [Uint8Array, Uint8Array] =>
  shadowed(
    [
      [1, CATALOG],
      PAGES,
      page('', ANNOTATED),
      contents(),
      FONT,
      [7, '<< /Type /Annot /Subtype /Stamp /Rect [72 600 472 630] /F 4 /AP << /N 8 0 R >> >>'],
      [8, rawStream(`/Type /XObject /Subtype /Form /BBox [0 0 400 30] /Resources << /Font << /F1 5 0 R >> >>${filter}`, appearance)],
    ],
    [page(), [7, '<< >>'], [8, '<< >>']],
  );
const WITHHELD = 'BT /F1 14 Tf 4 8 Td (Rides: call Kestrel Ambry, 850-555-0142) Tj ET';
add('h', 'the withheld quote drawn in a shadowed annotation\'s appearance', 'show', ...stamped(latin1(WITHHELD), ''));
add('h2', 'the withheld quote in a shadowed annotation\'s appearance, Flate', 'show', ...stamped(deflateSync(latin1(WITHHELD)), ' /Filter /FlateDecode'));

/** The challenge's cases a to h2, each with its control. */
export const M1_CASES: readonly M1Case[] = cases;
export const M1_QUOTES = ['Kestrel Ambry', '850-555-0142'];

// Round 4 (fix round 4, M1, from test/chal-r4/gate/cases.mjs): copies whose structure is one reading, and
// whose pages draw the kept photo all the same, where pdf-lib (the rules' reader) and pdf.js (the viewer)
// disagree on what is DRAWN. Every control is the same inline photo written plainly on the page.
const drawn: M1Case[] = [];
const addDrawn = (id: string, name: string, attack: Uint8Array, control: Uint8Array = PLAIN_INLINE): void => void drawn.push({ id, name, image: 'hide', attack, control });
const PLAIN = '200 0 0 200 72 400';
const PLAIN_INLINE = rawPdf([[1, CATALOG], PAGES, page(), contents(inline(PLAIN).toString('latin1')), FONT]);
// The photo as a function-based shading over a 64 x 64 sampled function (n5, l1), objects 16 and 17.
const FLIPPED = Buffer.alloc(KEPT.length);
for (let row = 0; row < SIDE; row++) KEPT.copy(FLIPPED, row * SIDE * 3, (SIDE - 1 - row) * SIDE * 3, (SIDE - row) * SIDE * 3);
const LATTICE: RawObject[] = [
  [16, `<< /ShadingType 1 /ColorSpace /DeviceRGB /Domain [0 ${SIDE} 0 ${SIDE}] /Function 17 0 R >>`],
  [17, rawStream(`/FunctionType 0 /Domain [0 ${SIDE} 0 ${SIDE}] /Range [0 1 0 1 0 1] /Size [${SIDE} ${SIDE}] /BitsPerSample 8 /Filter /FlateDecode`, deflateSync(FLIPPED))],
];
const SHADED = 'q 3.125 0 0 3.125 72 400 cm /Sh1 sh Q\n';
// n1. pdf-lib's decoder has no predictor; pdf.js undoes /Predictor 12 (PNG rows of one byte, filter None).
{
  const content = Buffer.concat([latin1(TEXT), inline(PLAIN)]);
  const rows = Buffer.alloc(content.length * 2);
  for (let i = 0; i < content.length; i++) rows[2 * i + 1] = content[i] as number;
  addDrawn('n1', 'the inline photo behind a PNG predictor on the page\'s content', rawPdf([[1, CATALOG], PAGES, page(), [4, rawStream('/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 1 >>', deflateSync(rows))], FONT]));
}
// n2, n2b, n2c. pdf.js's lexer: "qBI" is q then BI; "BI%" is BI then a comment; "{BI" is { then BI.
const lexed = (before: string, begin: string): Uint8Array =>
  rawPdf([[1, CATALOG], PAGES, page(), contents(`${before}${begin} /W ${SIDE} /H ${SIDE} /CS /RGB /BPC 8 /F /AHx ID ${KEPT.toString('hex')}>\nEI Q\n`), FONT]);
addDrawn('n2', 'the inline photo as "qBI"', lexed(`${PLAIN} cm q`, 'BI'));
addDrawn('n2b', 'the inline photo as "BI%c"', lexed(`q ${PLAIN} cm `, 'BI%c\n'));
addDrawn('n2c', 'the inline photo as "{BI"', lexed(`q ${PLAIN} cm {`, 'BI'));
// n3, n3b. pdf-lib counts only typed pages under typed nodes; pdf.js takes any kid without /Kids as a page.
{
  const two: RawObject = [2, '<< /Type /Pages /Kids [3 0 R 13 0 R] /Count 2 >>'];
  const second = (type: string): Uint8Array =>
    rawPdf([[1, CATALOG], two, page(), contents(), FONT, [13, `<< ${type}/Parent 2 0 R /MediaBox [0 0 612 792] /Contents 14 0 R /Resources << >> >>`], [14, rawStream('', inline(PLAIN))]]);
  addDrawn('n3', 'the inline photo on a second page with no /Type', second(''), second('/Type /Page '));
  const under = (type: string): Uint8Array =>
    rawPdf([
      [1, CATALOG],
      two,
      page(),
      contents(),
      FONT,
      [13, `<< ${type}/Parent 2 0 R /Kids [15 0 R] /Count 1 >>`],
      [14, rawStream('', inline(PLAIN))],
      [15, '<< /Type /Page /Parent 13 0 R /MediaBox [0 0 612 792] /Contents 14 0 R /Resources << >> >>'],
    ]);
  addDrawn('n3b', 'the inline photo on a page under a node with no /Type', under(''), under('/Type /Pages '));
}
// n4. pdf.js joins a /Contents array's streams byte to byte: "B" ending one and "I" starting the next is BI.
{
  // "q <scale> cm B" | "I /W 64 ...".
  const split = `q ${PLAIN} cm B`.length;
  const [head, tail] = [inline(PLAIN).subarray(0, split), inline(PLAIN).subarray(split)];
  const joined: RawObject = [3, (page()[1] as string).replace('/Contents 4 0 R', '/Contents [4 0 R 14 0 R]')];
  addDrawn('n4', 'the inline photo with its BI split across two streams of /Contents', rawPdf([[1, CATALOG], PAGES, joined, [4, rawStream('', Buffer.concat([latin1(TEXT), head]))], FONT, [14, rawStream('', tail)]]));
}
// n5. The photo as a function-based shading over a 64 x 64 sampled function: no picture at all to pdf-lib.
{
  addDrawn('n5', 'the photo as a function-based shading (ShadingType 1)', rawPdf([[1, CATALOG], PAGES, page('/Shading << /Sh1 16 0 R >>'), contents(SHADED), FONT, ...LATTICE]), kept('/Image'));
}
/** Round 4's n1 to n5 (all under "hide"), each with its control. */
export const M1_DRAWN_CASES: readonly M1Case[] = drawn;

/**
 * Round 4's q1 (r4 N1): the quote only in a comment between objects. The copy as handed over holds it (the
 * gate's search of the file as written finds it); the gate's own writing does not (pdf-lib writes no
 * comments). The verdict is on that writing, so q1 passes, and its stored bytes hold no quote.
 */
export const Q1 = ((): Uint8Array => {
  const good = Buffer.from(plainCopy()).toString('latin1');
  const comment = '%Rides: call Kestrel Ambry, 850-555-0142\n';
  const at = good.indexOf('2 0 obj');
  const moved = (offset: number): number => (offset >= at ? offset + comment.length : offset);
  return latin1(
    (good.slice(0, at) + comment + good.slice(at))
      .replace(/^(\d{10}) 00000 n $/gm, (_line, offset: string) => `${String(moved(Number(offset))).padStart(10, '0')} 00000 n `)
      .replace(/startxref\n(\d+)/, (_line, offset: string) => `startxref\n${moved(Number(offset))}`),
  );
})();

// Round 5 (fix round 5, M1, from test/chal-r5/cases5.mjs): a linearized copy. Object 1 is a /Linearized
// dictionary whose /O names object 9, a page outside the page tree; the tree's one page is object 4. When /L
// is the file's length, pdf.js takes page 1 from /O, while pdf-lib (and PDFium, poppler, MuPDF) take the
// tree's page. The gate checks its own writing of the copy, so /L must be that writing's length: build(L)
// writes the copy with a given /L, and linearizedCopy finds the L at which the writing is L bytes long.
const LINEARIZED_QUOTE = 'Kestrel Ambry';
const LIN_LETTERS = [...new Set(LINEARIZED_QUOTE.replace(/ /g, ''))].sort();
const linCode = (c: string): number => (c === ' ' ? 0x20 : 0x41 + LIN_LETTERS.indexOf(c));
/** A /ToUnicode that maps every glyph of the quote to "x" (r4 N3): the text layer reads no quote. */
const LYING_CMAP = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /X def 1 begincodespacerange <00> <FF> endcodespacerange ${LIN_LETTERS.length + 1} beginbfchar <20> <0020> ${LIN_LETTERS.map((c) => `<${linCode(c).toString(16)}> <0078>`).join(' ')} endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
const LYING_FONT = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [65 ${LIN_LETTERS.map((c) => `/${c}`).join(' ')}] >> /ToUnicode 19 0 R >>`;

interface TreePage {
  content: Body;
  resources: string;
  objects: readonly RawObject[];
}
const linearizedPdf = (L: number, tree: TreePage): Uint8Array =>
  rawPdf(
    [
      [1, `<< /Linearized 1 /L ${L} /H [1000 100] /O 9 /E 1000 /N 1 /T 1000 >>`],
      [2, '<< /Type /Catalog /Pages 3 0 R >>'],
      [3, '<< /Type /Pages /Kids [4 0 R] /Count 1 >>'],
      [4, `<< /Type /Page /Parent 3 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << ${tree.resources} >> >>`],
      [5, rawStream('', tree.content)],
      [6, FONT[1]],
      [9, '<< /Type /Page /MediaBox [0 0 612 792] /Contents 10 0 R /Resources << /Font << /F1 6 0 R >> >> >>'],
      [10, rawStream('', TEXT)],
      ...tree.objects,
    ],
    { root: 2 },
  );

export interface LinearizedCase {
  id: string;
  name: string;
  image: 'hide';
  build: (L: number) => Uint8Array;
}
const LIN_FONT = '/Font << /F1 6 0 R >>';
/** l1, l3 and l4: each tree page draws what "hide" forbids, or a withheld quote, and pdf.js would judge object 9 instead. */
export const M1_LINEARIZED_CASES: readonly LinearizedCase[] = [
  { id: 'l1', name: 'the tree page draws the photo as a function-based shading (n5)', image: 'hide', build: (L) => linearizedPdf(L, { content: TEXT + SHADED, resources: `${LIN_FONT} /Shading << /Sh1 16 0 R >>`, objects: LATTICE }) },
  {
    id: 'l3',
    name: 'the tree page shows a withheld quote through a /ToUnicode that lies',
    image: 'hide',
    build: (L) =>
      linearizedPdf(L, {
        content: `${TEXT}BT /F2 14 Tf 72 690 Td <${[...LINEARIZED_QUOTE].map((c) => linCode(c).toString(16).padStart(2, '0')).join('')}> Tj ET\n`,
        resources: '/Font << /F1 6 0 R /F2 18 0 R >>',
        objects: [
          [18, LYING_FONT],
          [19, rawStream('', LYING_CMAP)],
        ],
      }),
  },
  {
    id: 'l4',
    name: 'the tree page draws the photo inline, in a soft mask\'s group with no /Subtype',
    image: 'hide',
    build: (L) =>
      linearizedPdf(L, {
        content: `${TEXT}q /GS1 gs 0 0 0 rg 72 400 200 200 re f Q\n`,
        resources: `${LIN_FONT} /ExtGState << /GS1 << /SMask << /S /Luminosity /G 16 0 R >> >> >>`,
        objects: [[16, rawStream('/BBox [0 0 612 792] /Group << /S /Transparency /CS /DeviceRGB >>', inline(PLAIN))]],
      }),
  },
];

/**
 * The gate's writing of a copy up to fix round 5 (pdf-lib's, every object kept, /Linearized too): the round-5
 * challenge set /L to its length, so pdf.js read the gate's own writing as linearized. Since fix round 5b the
 * gate refuses such a copy as it comes, and its writing holds no /Linearized.
 */
export const roundFiveWriting = async (copy: Uint8Array): Promise<Uint8Array> =>
  (await PDFDocument.load(copy, { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: true })).save({ rewrite: true, useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });

/** The copy `build` writes with /L equal to the length of `write`'s writing of it (pdf.js then reads it as linearized). */
export async function linearizedCopy(build: (L: number) => Uint8Array, write: (copy: Uint8Array) => Promise<Uint8Array>): Promise<Uint8Array> {
  let L = 10_000;
  for (let i = 0; i < 4; i++) {
    const written = (await write(build(L))).byteLength;
    if (written === L) return build(L);
    L = written;
  }
  throw new Error('no length at which the writing is as long as its /L');
}

// Round 5, S1 (from test/chal-r5/cases5.mjs r1): the photo as 64 axial shadings, one per row of pixels, each
// over its row of one sampled function (the photo row by row), so a gradient carries 64 colours.
const rows = (functionRef: string): { resources: string; content: string } => {
  const step = 200 / SIDE;
  const [x0, x1] = [72 + step / 2, 72 + 200 - step / 2];
  let resources = '/Shading <<';
  let content = '';
  for (let r = 0; r < SIDE; r++) {
    resources += ` /S${r} << /ShadingType 2 /ColorSpace /DeviceRGB /Coords [${x0} 0 ${x1} 0] /Domain [${SIDE * r} ${SIDE * r + SIDE - 1}] /Extend [true true] /Function ${functionRef} >>`;
    content += `q 72 ${(600 - (r + 1) * step).toFixed(4)} 200 ${step} re W n /S${r} sh Q\n`;
  }
  return { resources: `${resources} >>`, content };
};
const ROW_SAMPLES = SIDE * SIDE - 1;
/** The photo as 64 axial shadings over one sampled (Type 0) function. */
export const S1_ROWS = ((): Uint8Array => {
  const { resources, content } = rows('6 0 R');
  return rawPdf([[1, CATALOG], PAGES, page(resources), contents(content), FONT, [6, rawStream(`/FunctionType 0 /Domain [0 ${ROW_SAMPLES}] /Range [0 1 0 1 0 1] /Size [${SIDE * SIDE}] /BitsPerSample 8 /Encode [0 ${ROW_SAMPLES}] /Filter /FlateDecode`, deflateSync(KEPT))]]);
})();
/** The same photo with no sampled function: one stitching (Type 3) function of 4095 linear (Type 2) pieces, sample to sample. */
export const S1_STITCHED_ROWS = ((): Uint8Array => {
  const { resources, content } = rows('6 0 R');
  const colour = (p: number): string => [0, 1, 2].map((c) => ((KEPT[p * 3 + c] as number) / 255).toFixed(3)).join(' ');
  const pieces = Array.from({ length: ROW_SAMPLES }, (_, p) => `<< /FunctionType 2 /Domain [0 1] /C0 [${colour(p)}] /C1 [${colour(p + 1)}] /N 1 >>`);
  const bounds = Array.from({ length: ROW_SAMPLES - 1 }, (_, p) => p + 1).join(' ');
  const encode = Array.from({ length: ROW_SAMPLES }, () => '0 1').join(' ');
  return rawPdf([[1, CATALOG], PAGES, page(resources), contents(content), FONT, [6, `<< /FunctionType 3 /Domain [0 ${ROW_SAMPLES}] /Functions [${pieces.join(' ')}] /Bounds [${bounds}] /Encode [${encode}] >>`]]);
})();

// Round 5, S3: forms nested `depth` deep, the last filling a square (d3, e1500); pdf.js's stack gives out
// near 1,500 and pdf.js carries on as if the page ended there.
export const nestedForms = (depth: number, last = '0 0 1 1 re f'): Uint8Array => {
  const forms: RawObject[] = [];
  for (let k = 0; k < depth; k++) {
    const next = k + 1 < depth;
    forms.push([k + 10, rawStream(`/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << ${next ? `/XObject << /X ${k + 11} 0 R >>` : ''} >>`, next ? 'q /X Do Q' : last)]);
  }
  return rawPdf([[1, CATALOG], PAGES, page('/XObject << /X 10 0 R >>'), contents('q /X Do Q\n'), FONT, ...forms]);
};

// Round 6 (M-6, S1-6, S3-6). A one-page copy drawing `parts` as its /Contents (an array when there are
// several, as a page split across streams is), with these resources and objects; and a mesh shading of the
// given type (4 to 7), three vertices or one patch, enough for a reader to take it for one.
export const R6_CATALOG: RawObject = [1, CATALOG];
export const R6_PAGES: RawObject = PAGES;
// Its resources hold one /Font list: `resources`' own when it has one (BOXLABEL fix round 3: a key twice is refused).
export const onSplitPage = (parts: readonly (string | Buffer)[], resources = '', extra: RawObject[] = []): Uint8Array => {
  const refs = parts.map((_, k) => `${k === 0 ? 4 : 100 + k} 0 R`);
  const streams: RawObject[] = parts.map((part, k) => [k === 0 ? 4 : 100 + k, rawStream('', part)]);
  const contents = parts.length === 1 ? (refs[0] as string) : `[${refs.join(' ')}]`;
  const fonts = resources.includes('/Font') ? '' : '/Font << /F1 5 0 R >> ';
  return rawPdf([[1, CATALOG], PAGES, [3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contents} /Resources << ${fonts}${resources} >> >>`], ...streams, FONT, ...extra]);
};
export const meshShading = (type: 4 | 5 | 6 | 7): Buffer => {
  const decode = '/Decode [0 612 0 792 0 1 0 1 0 1]';
  if (type === 4) return rawStream(`/ShadingType 4 /ColorSpace /DeviceRGB /BitsPerCoordinate 8 /BitsPerComponent 8 /BitsPerFlag 8 ${decode}`, Buffer.from([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 255, 0]));
  if (type === 5) return rawStream(`/ShadingType 5 /ColorSpace /DeviceRGB /BitsPerCoordinate 8 /BitsPerComponent 8 /VerticesPerRow 2 ${decode}`, Buffer.from([0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0]));
  return rawStream(`/ShadingType ${type} /ColorSpace /DeviceRGB /BitsPerCoordinate 8 /BitsPerComponent 8 /BitsPerFlag 8 ${decode}`, Buffer.alloc(type === 6 ? 1 + 24 + 12 : 1 + 32 + 12, 0x40));
};
/**
 * Forms `depth` deep from object `first`, each drawing the next under the resource name `name`, written `written` in
 * its content (an #xx spelling, say), the last running `last` with `resources`.
 */
export const formChain = (depth: number, first: number, options: { name?: string; written?: string; last?: string; resources?: string } = {}): RawObject[] => {
  const { name = 'X', last = '0 0 1 1 re f', resources = '' } = options;
  const written = options.written ?? name;
  return Array.from({ length: depth }, (_, k): RawObject => {
    const next = k + 1 < depth;
    return [first + k, rawStream(`/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << ${next ? `/XObject << /${name} ${first + k + 1} 0 R >>` : resources} >>`, next ? `/${written} Do` : last)];
  });
};

// Round 6: ordinary newsletter-like originals, after the round-6 challenge's honest set (h1 to h4, h6 to h9):
// text, a photo, vector rules and an axial gradient (h1), with a multi-stop gradient (h2), a spot-colour band with
// a type 2 tint (h3), a linearized layout (h4), a sampled tint on a flat fill (h6), a broken embedded TrueType
// program (h7), an unknown operator and one short of operands (h8), a Do of a name its resources lack (h9). The
// real engine's copy of each must pass the gate under every policy.
const HONEST_BODY = [
  'BT /F1 22 Tf 72 740 Td (Northwest Florida Mensa: The Flyer) Tj ET',
  '0.2 0.2 0.5 RG 2 w 72 728 m 540 728 l S',
  'BT /F2 11 Tf 72 700 Td 14 TL (Picnic at the bayou park on the third Saturday.) Tj T* (Call Kestrel Ambry at 850-555-0142 to bring a dish.) Tj ET',
  'q 200 0 0 200 72 400 cm /Im1 Do Q',
  'BT /F2 9 Tf 72 388 Td (Photo: last year at the park.) Tj ET',
  '0.6 g 300 400 240 0.75 re f',
  'q 300 600 240 60 re W n /Band sh Q',
].join('\n');
const HONEST_AXIAL = '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [300 0 540 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [0.85 0.9 1] /C1 [0.2 0.3 0.7] /N 1 >> /Extend [true true] >>';
const HONEST_STITCH = '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [300 0 540 0] /Function << /FunctionType 3 /Domain [0 1] /Functions [<< /FunctionType 2 /Domain [0 1] /C0 [1 1 1] /C1 [0.9 0.6 0.2] /N 1 >> << /FunctionType 2 /Domain [0 1] /C0 [0.9 0.6 0.2] /C1 [0.2 0.3 0.7] /N 1.5 >>] /Bounds [0.4] /Encode [0 1 0 1] >> /Extend [true true] >>';
const honest = (band: string, { extra = [] as RawObject[], resources = '', content = HONEST_BODY, body = '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>', first = [] as RawObject[] } = {}): Uint8Array =>
  rawPdf([
    ...first,
    [1, CATALOG],
    PAGES,
    [3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 7 0 R >> /XObject << /Im1 6 0 R >> /Shading << /Band 8 0 R >> ${resources} >> >>`],
    [4, rawStream('/Filter /FlateDecode', deflateSync(Buffer.from(`${content}\n`, 'latin1')))],
    [5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'],
    [6, picture('/Image', SAMPLES)],
    [7, body],
    [8, band],
    ...extra,
  ], { root: 1 });
const SPOT = (tint: string): RawObject => [9, `[/Separation /PMS286 /DeviceCMYK ${tint}]`];
export const HONEST_ORIGINALS: ReadonlyArray<[string, () => Uint8Array]> = [
  ['h1', () => honest(HONEST_AXIAL)],
  ['h2', () => honest(HONEST_STITCH)],
  ['h3', () => honest(HONEST_AXIAL, { extra: [SPOT('<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [1 0.66 0 0.02] /N 1 >>')], resources: '/ColorSpace << /Spot 9 0 R >>', content: `${HONEST_BODY}\n/Spot cs 1 scn 72 300 468 20 re f` })],
  ['h4', () => {
    const build = (length: number): Uint8Array => honest(HONEST_AXIAL, { first: [[10, `<< /Linearized 1 /L ${String(length).padStart(7, '0')} /H [0 0] /O 3 /E 0 /N 1 /T 0 >>`]] });
    return build(build(0).byteLength);
  }],
  ['h6', () => honest(HONEST_AXIAL, { extra: [[9, '[/Separation /PMS286 /DeviceRGB 11 0 R]'], [11, rawStream('/FunctionType 0 /Domain [0 1] /Range [0 1 0 1 0 1] /Size [2] /BitsPerSample 8', Buffer.from([255, 255, 255, 0, 56, 168]))]], resources: '/ColorSpace << /Spot 9 0 R >>', content: `${HONEST_BODY}\n/Spot cs 1 scn 72 300 468 20 re f` })],
  ['h7', () => honest(HONEST_AXIAL, {
    body: `<< /Type /Font /Subtype /TrueType /BaseFont /Junk /FirstChar 32 /LastChar 126 /Widths [${Array(95).fill(500).join(' ')}] /FontDescriptor 13 0 R /Encoding /WinAnsiEncoding >>`,
    extra: [[12, rawStream('', Buffer.alloc(3000, 0x5a))], [13, '<< /Type /FontDescriptor /FontName /Junk /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 12 0 R >>']],
  })],
  ['h8', () => honest(HONEST_AXIAL, { content: `${HONEST_BODY}\nfoo 1 0 0 cm 5 w` })],
  ['h9', () => honest(HONEST_AXIAL, { content: `${HONEST_BODY}\nq 10 0 0 10 500 100 cm /ImX Do Q` })],
];
export const HONEST_QUOTES = ['850-555-0142'];

// Round 6 (S3-6, n1t): the withheld name in a font of its own (a custom encoding, an honest /ToUnicode, so no
// string in the file spells it) at the bottom of `depth` nested forms, the page's edge split across two streams
// when `split`. Past about 1,000 forms pdf.js's getTextContent runs out of stack.
export const DEEP_QUOTE = 'Kestrel Ambry';
export const deepText = (depth: number, split: boolean): Uint8Array => {
  const glyphs = [...new Set(DEEP_QUOTE.replace(/ /g, ''))].sort();
  const code = (c: string): number => (c === ' ' ? 0x20 : 0x41 + glyphs.indexOf(c));
  const hex = [...DEEP_QUOTE].map((c) => code(c).toString(16).padStart(2, '0')).join('');
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Y def 1 begincodespacerange <00> <FF> endcodespacerange ${glyphs.length + 1} beginbfchar <20> <0020> ${glyphs.map((c) => `<${code(c).toString(16)}> <${c.charCodeAt(0).toString(16).padStart(4, '0')}>`).join(' ')} endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
  const font: RawObject = [9, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [${0x41} ${glyphs.map((c) => `/${c}`).join(' ')}] >> /ToUnicode 10 0 R >>`];
  const forms = formChain(depth, 20, { last: `BT /W 14 Tf 72 500 Td <${hex}> Tj ET`, resources: '/Font << /W 9 0 R >>' });
  const parts = split ? [`${TEXT}q /F`, 'm0 Do Q\n'] : [`${TEXT}q /Fm0 Do Q\n`];
  const streams: RawObject[] = parts.map((part, k) => [k === 0 ? 4 : 6, rawStream('', part)]);
  return rawPdf([[1, CATALOG], PAGES, [3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${split ? '[4 0 R 6 0 R]' : '4 0 R'} /Resources << /Font << /F1 5 0 R >> /XObject << /Fm0 20 0 R >> >> >>`], ...streams, FONT, font, [10, rawStream('', cmap)], ...forms]);
};

/**
 * Fix round 6b (REDACT-LOOK L10/N8): `quote` drawn in Helvetica on page 3 0 R, its /ToUnicode mapping every letter
 * to "x", so the text layer reads no quote and only the glyphs drawn spell it (r4 N3; the challenger's
 * ship-order-0022 copy).
 */
export function lyingToUnicode(quote: string): Uint8Array {
  const letters = [...new Set(quote.replace(/ /g, ''))].sort();
  const code = (c: string): number => (c === ' ' ? 0x20 : 0x41 + letters.indexOf(c));
  const hex = [...quote].map((c) => code(c).toString(16).padStart(2, '0')).join('');
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /X def 1 begincodespacerange <00> <FF> endcodespacerange ${letters.length + 1} beginbfchar <20> <0020> ${letters.map((c) => `<${code(c).toString(16)}> <0078>`).join(' ')} endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
  return rawPdf([
    [1, CATALOG],
    PAGES,
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 7 0 R >> >> >>'],
    [4, rawStream('', `BT /F2 12 Tf 72 720 Td (Picnic flyer) Tj ET BT /F1 14 Tf 72 690 Td <${hex}> Tj ET`)],
    [5, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [65 ${letters.map((c) => `/${c}`).join(' ')}] >> /ToUnicode 6 0 R >>`],
    [6, rawStream('', cmap)],
    [7, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
  ]);
}
