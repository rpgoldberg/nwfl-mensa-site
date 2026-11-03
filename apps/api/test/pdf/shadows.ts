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
  const tail = latin1(`${xref}trailer\n<< /Size ${max + 1} /Root 1 0 R${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  parts.push(tail);
  at += tail.length;
  if (options.update !== undefined) {
    const [num, body] = options.update;
    const objectAt = at;
    const chunk = Buffer.concat([latin1(`${num} 0 obj\n`), typeof body === 'string' ? latin1(body) : body, latin1('\nendobj\n')]);
    parts.push(chunk);
    at += chunk.length;
    parts.push(latin1(`xref\n${num} 1\n${String(objectAt).padStart(10, '0')} 00000 n \ntrailer\n<< /Size ${max + 1} /Root 1 0 R /Prev ${xrefAt} >>\nstartxref\n${at}\n%%EOF\n`));
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
  const flipped = Buffer.alloc(KEPT.length);
  for (let row = 0; row < SIDE; row++) KEPT.copy(flipped, row * SIDE * 3, (SIDE - 1 - row) * SIDE * 3, (SIDE - row) * SIDE * 3);
  addDrawn(
    'n5',
    'the photo as a function-based shading (ShadingType 1)',
    rawPdf([
      [1, CATALOG],
      PAGES,
      page('/Shading << /Sh1 16 0 R >>'),
      contents('q 3.125 0 0 3.125 72 400 cm /Sh1 sh Q\n'),
      FONT,
      [16, `<< /ShadingType 1 /ColorSpace /DeviceRGB /Domain [0 ${SIDE} 0 ${SIDE}] /Function 17 0 R >>`],
      [17, rawStream(`/FunctionType 0 /Domain [0 ${SIDE} 0 ${SIDE}] /Range [0 1 0 1 0 1] /Size [${SIDE} ${SIDE}] /BitsPerSample 8 /Filter /FlateDecode`, deflateSync(flipped))],
    ]),
    kept('/Image'),
  );
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
