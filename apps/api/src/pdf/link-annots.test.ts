// LINKS L3: the one link annotation a copy may carry, as the engine writes it and the gate reads it
// back (link-annots.ts). The engine writes fresh annotations from the approved list only, drops any
// whose rect meets a drawn box or removed ink, and the gate accepts exactly that shape and nothing
// else. Every host is a reserved example name and every person is made up.
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFString, StandardFonts } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  type EngineLink,
  LABEL_PREFIX,
  MAX_LABEL_CHARS,
  MAX_LINKS,
  RECT_TOLERANCE,
  acceptedLinks,
  isLabel,
  isOrigin,
  linkLabel,
  linkUri,
  linksBreak,
  meets,
  placeLinks,
  roundRect,
} from './link-annots.js';

const ORIGIN = 'https://nwflorida.us';
const id = (n: number): string => `${'b'.repeat(24)}${'abcdefghijklmnopqrstuvwxyz234567'[Math.floor(n / 32)]}${'abcdefghijklmnopqrstuvwxyz234567'[n % 32]}`;
const link = (n: number, extra: Partial<EngineLink> = {}): EngineLink => ({ id: id(n), page: 1, rect: [72, 700, 200, 714], label: 'Link to site.example', ...extra });

type Doc = Awaited<ReturnType<typeof PDFDocument.create>>;
/** A plain copy of `pages` pages, each reading a line, changed by `edit` before it is saved. */
async function copy(pages = 1, edit: (doc: Doc) => void = () => {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 0; n < pages; n++) doc.addPage([612, 792]).drawText(`Page ${n + 1} reads www.site.example here.`, { x: 72, y: 704, size: 12, font });
  edit(doc);
  return doc.save({ useObjectStreams: false });
}
const load = (pdf: Uint8Array): Promise<Doc> => PDFDocument.load(pdf, { updateMetadata: false });
const annotsOf = (doc: Doc, page = 0): PDFDict[] => {
  const list = doc.getPage(page).node.lookup(PDFName.of('Annots'));
  return list instanceof PDFArray ? list.asArray().map((ref) => doc.context.lookup(ref) as PDFDict) : [];
};
const text = (value: unknown): string => (value instanceof PDFString ? Buffer.from(value.asBytes()).toString('latin1') : `not a string: ${String(value)}`);

describe('the fixed shape and its parts', () => {
  it('points only to the leaving page by id, and labels the link by its host', () => {
    expect(linkUri(ORIGIN, id(1))).toBe(`https://nwflorida.us/out/${id(1)}`);
    expect(linkLabel('site.example')).toBe('Link to site.example');
    expect(LABEL_PREFIX).toBe('Link to ');
    expect(MAX_LINKS).toBe(500);
    expect(MAX_LABEL_CHARS).toBe(8 + 253);
    expect(RECT_TOLERANCE).toBe(0.01);
  });

  it('takes an origin only as https and a DNS name (or localhost with a port, for local runs), with no path, port, credentials or case', () => {
    for (const good of ['https://nwflorida.us', 'https://canary.nwflmensa.us', 'https://localhost', 'https://localhost:8443']) expect(isOrigin(good), good).toBe(true);
    for (const bad of ['http://nwflorida.us', 'https://nwflorida.us/', 'https://NWFLORIDA.us', 'https://nwflorida.us:443', 'https://a@nwflorida.us', 'https://nwflorida.us.', 'https://127.0.0.1', 'https://intranet', 'https://localhost:0', 'https://localhost:99999', 'nwflorida.us', '', 7, null]) {
      expect(isOrigin(bad), String(bad)).toBe(false);
    }
  });

  it('takes a label only as "Link to " and a DNS name', () => {
    expect(isLabel('Link to site.example')).toBe(true);
    for (const bad of ['Link to ', 'Link to SITE.example', 'link to site.example', 'Link to site.example ', 'Link to quillon brask', `Link to ${'a'.repeat(250)}.example`, 7]) expect(isLabel(bad), String(bad)).toBe(false);
  });

  it('rounds a rect to hundredths of a point', () => {
    expect(roundRect([72.004, 700.005, 200.123456, 714])).toEqual([72, 700.01, 200.12, 714]);
  });

  it('counts a rect that touches a box as meeting it, and one a hair away as not', () => {
    const box = { left: 100, right: 150, bottom: 700, top: 712 };
    expect(meets({ left: 150, right: 160, bottom: 700, top: 712 }, box)).toBe(true);
    expect(meets({ left: 90, right: 101, bottom: 690, top: 700 }, box)).toBe(true);
    expect(meets({ left: 150.001, right: 160, bottom: 700, top: 712 }, box)).toBe(false);
    expect(meets({ left: 100, right: 150, bottom: 712.001, top: 720 }, box)).toBe(false);
  });
});

describe('linksBreak: the links an engine or a gate is given', () => {
  it('passes none, or a list of distinct well-formed links with an origin', () => {
    expect(linksBreak([], undefined)).toBeNull();
    expect(linksBreak([link(1), link(2, { page: 3 })], ORIGIN)).toBeNull();
    expect(linksBreak(Array.from({ length: MAX_LINKS }, (_, n) => link(n)), ORIGIN)).toBeNull();
  });

  it('refuses anything else, by what is wrong and never by what it holds', () => {
    const bad: Array<[unknown, unknown, string]> = [
      ['links', ORIGIN, 'the links are not a list'],
      [[link(1)], undefined, 'links need an origin: https:// and the site\'s host'],
      [[link(1)], 'https://evil.example/', 'links need an origin: https:// and the site\'s host'],
      [[], 'http://nwflorida.us', 'links need an origin: https:// and the site\'s host'],
      [Array.from({ length: MAX_LINKS + 1 }, (_, n) => link(n)), ORIGIN, `at most ${MAX_LINKS} links`],
      [[link(1), link(1)], ORIGIN, 'a link id is given twice'],
      [[{ ...link(1), url: 'https://site.example/' }], ORIGIN, 'a link is exactly id, page, rect and label'],
      [[{ id: id(1), page: 1, rect: [1, 2, 3, 4] }], ORIGIN, 'a link is exactly id, page, rect and label'],
      [[null], ORIGIN, 'a link is exactly id, page, rect and label'],
      [[link(1, { id: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' })], ORIGIN, 'a link id is 26 lower-case base32 characters'],
      [[link(1, { page: 0 })], ORIGIN, 'a link page is 1 to 10000'],
      [[link(1, { page: 1.5 })], ORIGIN, 'a link page is 1 to 10000'],
      [[link(1, { rect: [1, 2, 3] as never })], ORIGIN, 'a link rect is four finite numbers within 14400 of 0, with x1 < x2 and y1 < y2'],
      [[link(1, { rect: [3, 2, 1, 4] })], ORIGIN, 'a link rect is four finite numbers within 14400 of 0, with x1 < x2 and y1 < y2'],
      [[link(1, { rect: [1, 2, 3, Number.NaN] })], ORIGIN, 'a link rect is four finite numbers within 14400 of 0, with x1 < x2 and y1 < y2'],
      [[link(1, { rect: [1, 2, 3, 14401] })], ORIGIN, 'a link rect is four finite numbers within 14400 of 0, with x1 < x2 and y1 < y2'],
      [[link(1, { rect: ['1', 2, 3, 4] as never })], ORIGIN, 'a link rect is four finite numbers within 14400 of 0, with x1 < x2 and y1 < y2'],
      [[link(1, { label: 'Link to Quillon Brask' })], ORIGIN, 'a link label is "Link to " and a host'],
    ];
    for (const [links, origin, reason] of bad) expect(linksBreak(links, origin), reason).toBe(reason);
  });
});

describe('placeLinks: fresh annotations from the approved list only', () => {
  it('returns the copy untouched, byte for byte, when there are no links', async () => {
    const pdf = await copy();
    const placed = await placeLinks(pdf, [], undefined, []);
    expect(placed.kept).toEqual([]);
    expect(placed.pdf).toBe(pdf);
  });

  it('writes the one shape, in a page\'s /Annots by reference, and nothing of the original', async () => {
    const placed = await placeLinks(await copy(2), [link(2, { page: 2, rect: [72.25, 700, 300, 714] }), link(1)], ORIGIN, []);
    expect(placed.kept).toEqual([id(2), id(1)]);
    const doc = await load(placed.pdf);
    for (const [page, n, rect] of [[0, 1, [72, 700, 200, 714]], [1, 2, [72.25, 700, 300, 714]]] as const) {
      const raw = doc.getPage(page).node.get(PDFName.of('Annots'));
      expect(raw).toBeInstanceOf(PDFArray);
      expect((raw as PDFArray).asArray().every((item) => item instanceof PDFRef)).toBe(true);
      const [annot, ...rest] = annotsOf(doc, page);
      expect(rest).toEqual([]);
      expect(annot!.keys().map((key) => key.decodeText())).toEqual(['Type', 'Subtype', 'Rect', 'Border', 'F', 'A', 'Contents']);
      expect(annot!.get(PDFName.of('Type'))).toBe(PDFName.of('Annot'));
      expect(annot!.get(PDFName.of('Subtype'))).toBe(PDFName.of('Link'));
      expect((annot!.get(PDFName.of('Rect')) as PDFArray).asArray().map((v) => (v as PDFNumber).asNumber())).toEqual(rect);
      expect((annot!.get(PDFName.of('Border')) as PDFArray).asArray().map((v) => (v as PDFNumber).asNumber())).toEqual([0, 0, 0]);
      expect((annot!.get(PDFName.of('F')) as PDFNumber).asNumber()).toBe(4);
      const action = annot!.get(PDFName.of('A')) as PDFDict;
      expect(action.keys().map((key) => key.decodeText())).toEqual(['S', 'URI']);
      expect(action.get(PDFName.of('S'))).toBe(PDFName.of('URI'));
      expect(text(action.get(PDFName.of('URI')))).toBe(`https://nwflorida.us/out/${id(n)}`);
      expect(text(annot!.get(PDFName.of('Contents')))).toBe('Link to site.example');
    }
  });

  it('drops a link on a page the copy does not have, or whose rect lies outside the page\'s crop box', async () => {
    const pdf = await copy(1, (doc) => doc.getPage(0).setCropBox(0, 0, 612, 400));
    const placed = await placeLinks(pdf, [link(1, { page: 2 }), link(2), link(3, { rect: [-50, 100, -10, 120] }), link(4, { rect: [72, 300, 200, 314] }), link(5, { rect: [600, 390, 700, 420] })], ORIGIN, []);
    expect(placed.kept).toEqual([id(4), id(5)]);
  });

  it('drops a link whose rect, clamped to the crop box, meets a box or removed ink on its page, and keeps it beside them', async () => {
    const pdf = await copy(2);
    const blocked = [
      { page: 0, left: 150, right: 180, bottom: 702, top: 712 },
      { page: 1, left: 400, right: 410, bottom: 100, top: 110 },
    ];
    const placed = await placeLinks(pdf, [link(1), link(2, { rect: [180, 712, 220, 730] }), link(3, { rect: [181, 712.5, 220, 730] }), link(4, { page: 2 }), link(5, { page: 2, rect: [395, 0, 405, 105] })], ORIGIN, blocked);
    expect(placed.kept).toEqual([id(3), id(4)]);
    // Over the edge of the page only the part on it counts: a box beyond the crop box is not met, one on the page is.
    const cropped = await copy(1, (doc) => doc.getPage(0).setCropBox(0, 0, 160, 792));
    const beyond = await placeLinks(cropped, [link(6, { rect: [150, 702, 900, 712] })], ORIGIN, [{ page: 0, left: 165, right: 170, bottom: 702, top: 712 }]);
    expect(beyond.kept).toEqual([id(6)]);
    const on = await placeLinks(cropped, [link(6, { rect: [150, 702, 900, 712] })], ORIGIN, [{ page: 0, left: 155, right: 170, bottom: 702, top: 712 }]);
    expect(on.kept).toEqual([]);
  });

  it('refuses links without an origin, rather than write a link to nowhere', async () => {
    await expect(placeLinks(await copy(), [link(1)], undefined, [])).rejects.toThrow('links need an origin');
  });
});

describe('acceptedLinks: exactly the shape, at the request\'s place, for the ids the engine kept', () => {
  const REQUEST = { origin: ORIGIN, links: [link(1), link(2, { page: 2, rect: [72, 600, 220, 614] })], kept: [id(1), id(2)] };
  const placedCopy = async (links = REQUEST.links): Promise<Uint8Array> => (await placeLinks(await copy(2), links, ORIGIN, [])).pdf;

  it('accepts the engine\'s own annotations: the pages and the annotation objects', async () => {
    const doc = await load(await placedCopy());
    const accepted = acceptedLinks(doc, REQUEST);
    if (typeof accepted === 'string') throw new Error(accepted);
    expect(accepted.pages.size).toBe(2);
    expect(accepted.annots.size).toBe(2);
    expect(acceptedLinks(doc, { ...REQUEST, links: REQUEST.links.map((l) => ({ ...l, rect: l.rect.map((n) => n + RECT_TOLERANCE) as unknown as EngineLink['rect'] })) })).not.toBeTypeOf('string');
  });

  it('accepts nothing when nothing was kept: the general rules then refuse any annotation', async () => {
    const accepted = acceptedLinks(await load(await placedCopy()), { origin: ORIGIN, links: REQUEST.links, kept: [] });
    expect(accepted).toEqual({ pages: new Set(), annots: new Set() });
    expect(acceptedLinks(await load(await copy()), {})).toEqual({ pages: new Set(), annots: new Set() });
  });

  /** The engine's copy with one annotation dictionary changed by `edit`. */
  const edited = async (edit: (annot: PDFDict, doc: Doc) => void, which = 0): Promise<Doc> => {
    const doc = await load(await placedCopy());
    edit(annotsOf(doc, which)[0]!, doc);
    return load(await doc.save({ useObjectStreams: false }));
  };
  const uri = (value: string) => (annot: PDFDict, doc: Doc): void => {
    annot.set(PDFName.of('A'), doc.context.obj({ S: 'URI', URI: PDFString.of(value) }));
  };

  it('refuses every way a subverted engine could bend the shape (SPEC 7)', async () => {
    const cases: Array<[string, (annot: PDFDict, doc: Doc) => void]> = [
      ['an appearance stream', (annot, doc) => annot.set(PDFName.of('AP'), doc.context.obj({ N: doc.context.register(doc.context.stream('0 0 m')) }))],
      ['additional actions', (annot, doc) => annot.set(PDFName.of('AA'), doc.context.obj({ E: { S: 'URI', URI: PDFString.of('https://evil.example/') } }))],
      ['a JavaScript action', (annot, doc) => annot.set(PDFName.of('A'), doc.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') }))],
      ['a Launch action', (annot, doc) => annot.set(PDFName.of('A'), doc.context.obj({ S: 'Launch', F: PDFString.of('cmd.exe') }))],
      ['a GoToR action', (annot, doc) => annot.set(PDFName.of('A'), doc.context.obj({ S: 'GoToR', F: PDFString.of('x.pdf'), D: [0, 'Fit'] }))],
      ['a URI action with an extra key', (annot, doc) => annot.set(PDFName.of('A'), doc.context.obj({ S: 'URI', URI: PDFString.of(linkUri(ORIGIN, id(1))), Next: { S: 'Launch' } }))],
      ['another origin, as a suffix', uri(`https://nwflorida.us.evil.example/out/${id(1)}`)],
      ['credentials before another host', uri(`https://nwflorida.us@example.net/out/${id(1)}`)],
      ['a dot segment', uri(`https://nwflorida.us/out/../${id(1)}`)],
      ['a dot segment after the id', uri(`https://nwflorida.us/out/${id(1)}/../../x`)],
      ['a query', uri(`https://nwflorida.us/out/${id(1)}?to=https://evil.example/`)],
      ['a fragment', uri(`https://nwflorida.us/out/${id(1)}#x`)],
      ['upper case', uri(`https://NWFLORIDA.US/out/${id(1)}`)],
      ['an upper-case id', uri(`https://nwflorida.us/out/${id(1).toUpperCase()}`)],
      ['a homoglyph host', uri(`https://nwflоrida.us/out/${id(1)}`)],
      ['http', uri(`http://nwflorida.us/out/${id(1)}`)],
      ['a trailing space', uri(`https://nwflorida.us/out/${id(1)} `)],
      ['an id not in the request', uri(linkUri(ORIGIN, id(9)))],
      ['the other kept id (a duplicate)', uri(linkUri(ORIGIN, id(2)))],
      ['a moved rect', (annot, doc) => annot.set(PDFName.of('Rect'), doc.context.obj([72, 700, 200, 714 + 2 * RECT_TOLERANCE]))],
      ['a rect of three numbers', (annot, doc) => annot.set(PDFName.of('Rect'), doc.context.obj([72, 700, 200]))],
      ['a rect by reference', (annot, doc) => annot.set(PDFName.of('Rect'), doc.context.register(doc.context.obj([72, 700, 200, 714])))],
      ['a visible border', (annot, doc) => annot.set(PDFName.of('Border'), doc.context.obj([0, 0, 1]))],
      ['a hidden flag', (annot) => annot.set(PDFName.of('F'), PDFNumber.of(2))],
      ['another label', (annot) => annot.set(PDFName.of('Contents'), PDFString.of('Link to evil.example'))],
      ['a label holding a name', (annot) => annot.set(PDFName.of('Contents'), PDFString.of('Quillon Brask'))],
      ['an extra key: the original\'s /T', (annot) => annot.set(PDFName.of('T'), PDFString.of('Ottoline Varga'))],
      ['an extra key: /Alt', (annot) => annot.set(PDFName.of('Alt'), PDFString.of('Ottoline Varga'))],
      ['an extra key: /QuadPoints', (annot, doc) => annot.set(PDFName.of('QuadPoints'), doc.context.obj([72, 714, 200, 714, 72, 700, 200, 700]))],
      ['a /Subtype other than /Link', (annot) => annot.set(PDFName.of('Subtype'), PDFName.of('Widget'))],
      ['a /Type by reference', (annot, doc) => annot.set(PDFName.of('Type'), doc.context.register(PDFName.of('Annot')))],
      ['an action by reference', (annot, doc) => annot.set(PDFName.of('A'), doc.context.register(doc.context.obj({ S: 'URI', URI: PDFString.of(linkUri(ORIGIN, id(1))) })))],
      ['a URI by reference', (annot, doc) => annot.set(PDFName.of('A'), doc.context.obj({ S: 'URI', URI: doc.context.register(PDFString.of(linkUri(ORIGIN, id(1)))) }))],
      ['a URI that is a name', (annot, doc) => annot.set(PDFName.of('A'), doc.context.obj({ S: 'URI', URI: PDFName.of(linkUri(ORIGIN, id(1))) }))],
    ];
    for (const [name, edit] of cases) expect(acceptedLinks(await edited(edit), REQUEST), name).toBeTypeOf('string');
  });

  it('refuses a link on another page than its own, a second annotation for an id, an extra one, and one kept but missing', async () => {
    const swapped = await placeLinks(await copy(2), [link(1, { page: 2 }), link(2, { page: 1, rect: [72, 600, 220, 614] })], ORIGIN, []);
    expect(acceptedLinks(await load(swapped.pdf), REQUEST)).toBeTypeOf('string');
    const twice = await load(await placedCopy());
    const page = twice.getPage(0).node;
    const list = page.lookup(PDFName.of('Annots')) as PDFArray;
    list.push(list.get(0));
    expect(acceptedLinks(await load(await twice.save({ useObjectStreams: false })), REQUEST)).toBe('a link annotation is listed twice');
    const copied = await load(await placedCopy());
    const first = annotsOf(copied, 0)[0]!;
    (copied.getPage(0).node.lookup(PDFName.of('Annots')) as PDFArray).push(copied.context.register(first.clone()));
    expect(acceptedLinks(await load(await copied.save({ useObjectStreams: false })), REQUEST)).toBe('a link id is in the copy twice');
    const one = await placeLinks(await copy(2), [link(1)], ORIGIN, []);
    expect(acceptedLinks(await load(one.pdf), REQUEST)).toBe('the copy does not hold exactly the links the engine kept');
    expect(acceptedLinks(await load(await placedCopy()), { ...REQUEST, kept: [id(1)] })).toBeTypeOf('string');
  });

  it('refuses kept ids that the request does not hold, or holds twice, and a bad origin', async () => {
    const doc = await load(await placedCopy());
    expect(acceptedLinks(doc, { ...REQUEST, kept: [id(1), id(7)] })).toBe('the engine kept a link it was not given');
    expect(acceptedLinks(doc, { ...REQUEST, kept: [id(1), id(1)] })).toBe('the engine kept a link twice');
    expect(acceptedLinks(doc, { ...REQUEST, origin: 'https://evil.example/' })).toBe('links need an origin: https:// and the site\'s host');
  });

  it('refuses /Annots that is not a list in the page, an entry that is not a reference to a dictionary, and an annotation referenced from anywhere else', async () => {
    const byRef = await load(await placedCopy());
    const list = byRef.getPage(0).node.get(PDFName.of('Annots')) as PDFArray;
    byRef.getPage(0).node.set(PDFName.of('Annots'), byRef.context.register(list));
    expect(acceptedLinks(await load(await byRef.save({ useObjectStreams: false })), REQUEST)).toBe("a page's /Annots is not a list written in the page");
    const direct = await load(await placedCopy());
    const annot = annotsOf(direct, 0)[0]!;
    direct.getPage(0).node.set(PDFName.of('Annots'), direct.context.obj([annot]));
    expect(acceptedLinks(await load(await direct.save({ useObjectStreams: false })), REQUEST)).toBe('a link annotation is not a dictionary by reference');
    const elsewhere = await load(await placedCopy());
    const ref = (elsewhere.getPage(0).node.lookup(PDFName.of('Annots')) as PDFArray).get(0);
    elsewhere.catalog.set(PDFName.of('Junk'), elsewhere.context.obj([ref]));
    expect(acceptedLinks(await load(await elsewhere.save({ useObjectStreams: false })), REQUEST)).toBe('a link annotation is referenced outside its page');
  });
});
