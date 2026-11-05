// LINKS L3: working links in a redacted copy, end to end through the real engine (redact.ts) and the
// gate (gate-rules.ts, gate-links.ts). The engine writes fresh annotations from the approved list only,
// drops a link whose rect meets a box or removed ink, and checks the copy again with them in place; the
// gate accepts exactly the engine's shape for the ids it kept, and refuses the whole copy when the text
// under a link differs from the original's. A file with no links gives the copy it gave before links.
// Every host is a reserved example name and every person is made up.
import { PDFArray, type PDFDict, PDFDocument, PDFName, PDFString, StandardFonts } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { gateReply, gateVerdict } from '../../src/pdf/gate-rules.js';
import { linkTextBreak } from '../../src/pdf/gate-links.js';
import { type EngineLink, linkUri, writeLinks } from '../../src/pdf/link-annots.js';
import { redactPdf } from '../../src/pdf/redact.js';
import { extractAll, rawText } from './extract.js';
import { leakFixture, linesPdf, pictureUnderTextFixture, twoMarksFixture } from './fixtures.js';

const ORIGIN = 'https://nwflorida.us';
const id = (c: string): string => c.repeat(26);
const link = (c: string, rect: EngineLink['rect'], extra: Partial<EngineLink> = {}): EngineLink => ({ id: id(c), page: 1, rect, label: 'Link to site.example', ...extra });

/**
 * A newsletter-like page (Helvetica 12 at x 72): line 1 names a withheld person, line 2 links an address on the
 * same line as a withheld phone, line 3 is plain. Its own link annotations carry names in /Contents, /T, /Alt and
 * /NM, as Publisher writes them; none of it may reach a copy.
 */
async function newsletter(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Please write to Quillon Brask about the picnic.', { x: 72, y: 720, size: 12, font });
  page.drawText('Call 850-555-0142 or see www.site.example today.', { x: 72, y: 700, size: 12, font });
  page.drawText('This closing line stays readable.', { x: 72, y: 680, size: 12, font });
  const { context } = doc;
  const own = (rect: number[], uri: string) =>
    context.register(
      context.obj({ Type: 'Annot', Subtype: 'Link', Rect: rect, Contents: PDFString.of('Ottoline Varga'), T: PDFString.of('Ysolde Pemberton'), Alt: PDFString.of('Feodora Lusk'), NM: PDFString.of('Zebulon Thrace'), A: { S: 'URI', URI: PDFString.of(uri) } }),
    );
  page.node.set(PDFName.of('Annots'), context.obj([own([230, 697, 340, 712], 'https://www.site.example/'), own([160, 717, 250, 732], 'mailto:quillon~@site.example')]));
  return doc.save({ useObjectStreams: false });
}
// Where the words of the page above are drawn (Helvetica 12 from x 72), measured for these tests.
const OVER_URL: EngineLink['rect'] = [232, 697, 330, 712];
const OVER_NAME: EngineLink['rect'] = [160, 717, 240, 732];
const OVER_PHONE_EDGE: EngineLink['rect'] = [120, 697, 150, 712];
const PLAIN_LINE: EngineLink['rect'] = [72, 677, 250, 692];
const QUOTES = ['Quillon Brask', '850-555-0142'];

const copyOf = async (original: Uint8Array, links: readonly EngineLink[], quotes = QUOTES, image?: 'show' | 'blur' | 'hide') => {
  const result = await redactPdf(original, { quotes, redactsAny: true, origin: ORIGIN, links, ...(image === undefined ? {} : { image }) });
  if (result.kind !== 'redacted') throw new Error(`expected a copy, got ${JSON.stringify(result)}`);
  return result;
};
const job = (copy: Uint8Array, original: Uint8Array, links: readonly EngineLink[], kept: readonly string[], quotes = QUOTES) => ({ copy, original, quotes, image: 'show' as const, origin: ORIGIN, links, kept });

describe('the engine: fresh annotations from the approved list only', () => {
  it('keeps a link beside withheld text on its line, and drops one over a box or a removed glyph\'s ink', async () => {
    const original = await newsletter();
    const links = [link('a', OVER_URL), link('b', OVER_NAME), link('c', OVER_PHONE_EDGE), link('d', PLAIN_LINE)];
    const result = await copyOf(original, links);
    expect(result.kept).toEqual([id('a'), id('d')]);
    const doc = await PDFDocument.load(result.pdf, { updateMetadata: false });
    const list = doc.getPage(0).node.lookup(PDFName.of('Annots')) as PDFArray;
    const uris = list.asArray().map((ref) => Buffer.from(((doc.context.lookup(ref) as PDFDict).lookup(PDFName.of('A')) as PDFDict).lookup(PDFName.of('URI'), PDFString).asBytes()).toString('latin1'));
    expect(uris).toEqual([linkUri(ORIGIN, id('a')), linkUri(ORIGIN, id('d'))]);
  });

  it('drops a link partly over a box, one touching its edge, and one over a neighbour removed with a passage', async () => {
    const original = await linesPdf(['Phone Bo now about the picnic.', 'Ask the hosts at the door.']);
    // "Bo" (x 110 to 124.7) is removed alone; a rect from inside it on meets it.
    const partly = await copyOf(original, [link('a', [100, 717, 140, 731])], ['Bo']);
    expect(partly.kept).toEqual([]);
    const clear = await copyOf(original, [link('c', [150, 717, 230, 731]), link('e', [72, 697, 200, 711])], ['Bo']);
    expect(clear.kept).toEqual([id('c'), id('e')]);
    // "Wrenhallow" hyphenated over two lines: the hyphen (x 140 to 144), no letter of the passage, is removed with it.
    const split = await linesPdf(['Tobias Wren-', 'hallow hosted it.']);
    const neighbour = await copyOf(split, [link('b', [141, 717, 150, 731]), link('f', [112, 697, 140, 711])], ['Wrenhallow']);
    expect(neighbour.kept).toEqual([id('f')]);
  });

  it('drops a link on a page the copy does not have, or off the page', async () => {
    const result = await copyOf(await newsletter(), [link('a', OVER_URL, { page: 2 }), link('b', [700, 100, 800, 120]), link('c', PLAIN_LINE)]);
    expect(result.kept).toEqual([id('c')]);
  });

  it('copies nothing of the original\'s annotations: no /Contents, /T, /Alt, /NM, URI or mail address of theirs is anywhere in the copy', async () => {
    const result = await copyOf(await newsletter(), [link('a', OVER_URL), link('d', PLAIN_LINE)]);
    const seen = `${await extractAll(result.pdf)}\n${rawText(result.pdf)}`;
    for (const needle of ['Ottoline', 'Ysolde', 'Pemberton', 'Feodora', 'Zebulon', 'www.site.example/', 'quillon~', 'mailto:', 'Quillon', '555-0142']) expect(seen, needle).not.toContain(needle);
    expect(seen).toContain(linkUri(ORIGIN, id('a')));
    expect(seen).toContain('Link to site.example');
  });

  it('checks the copy again with the annotations in place: a label that holds a withheld passage means no copy', async () => {
    const result = await redactPdf(await linesPdf(['See the picnic page.']), { quotes: ['Kestrelambry'], redactsAny: true, origin: ORIGIN, links: [link('a', [72, 717, 200, 731], { label: 'Link to kestrelambry.example' })] });
    expect(result).toEqual({ kind: 'refused', reason: expect.stringMatching(/^object \d+: withheld text is still in the file$/) as unknown });
  });

  it('refuses links with no origin to point to, rather than write them', async () => {
    const result = await redactPdf(await newsletter(), { quotes: QUOTES, redactsAny: true, links: [link('a', OVER_URL)] });
    expect(result.kind).toBe('refused');
  });

  it('gives a file with no links exactly the copy it gave before links: the same bytes with an empty list, under each policy', async () => {
    for (const [original, quotes, image] of [
      [await leakFixture(), ['Quillon Brask', 'Marvel Ostrander'], 'show'],
      [await twoMarksFixture(), ['Bo', 'Quillon'], 'show'],
      [await pictureUnderTextFixture(), ['Pellingham'], 'blur'],
      [await newsletter(), QUOTES, 'hide'],
    ] as const) {
      const before = await redactPdf(original, { quotes, redactsAny: true, image });
      const after = await redactPdf(original, { quotes, redactsAny: true, image, origin: ORIGIN, links: [] });
      if (before.kind !== 'redacted' || after.kind !== 'redacted') throw new Error('expected copies');
      expect(Buffer.from(after.pdf).equals(Buffer.from(before.pdf))).toBe(true);
      expect(after.kept).toEqual([]);
      // Every link dropped is no link written: the same bytes again.
      const dropped = await redactPdf(original, { quotes, redactsAny: true, image, origin: ORIGIN, links: [link('z', [72, 100, 80, 110], { page: 9 })] });
      expect(dropped.kind === 'redacted' && Buffer.from(dropped.pdf).equals(Buffer.from(before.pdf))).toBe(true);
    }
  });
});

describe('the gate: exactly the engine\'s links, and the text under each is the original\'s', () => {
  it('passes the engine\'s copy with its links, and hands back bytes that keep them', async () => {
    const original = await newsletter();
    const links = [link('a', OVER_URL), link('b', OVER_NAME), link('d', PLAIN_LINE)];
    const result = await copyOf(original, links);
    expect(await gateVerdict(job(result.pdf, original, links, result.kept ?? []))).toEqual({ pass: true });
    const reply = await gateReply(job(result.pdf, original, links, result.kept ?? []));
    expect(reply.verdict).toEqual({ pass: true });
    const written = await PDFDocument.load(reply.checked!.pdf, { updateMetadata: false });
    expect((written.getPage(0).node.lookup(PDFName.of('Annots')) as PDFArray).size()).toBe(2);
    for (const image of ['blur', 'hide'] as const) {
      const other = await copyOf(original, links, QUOTES, image);
      expect(await gateVerdict({ ...job(other.pdf, original, links, other.kept ?? []), image }), image).toEqual({ pass: true });
    }
  });

  it('refuses a copy with links when it was told of none, or of other kept ids', async () => {
    const original = await newsletter();
    const links = [link('a', OVER_URL), link('d', PLAIN_LINE)];
    const result = await copyOf(original, links);
    expect(await gateVerdict({ copy: result.pdf, original, quotes: QUOTES, image: 'show' })).toEqual({ pass: false, code: 'rules' });
    expect(await gateVerdict(job(result.pdf, original, links, [id('a')]))).toEqual({ pass: false, code: 'rules' });
    expect(await gateVerdict(job(result.pdf, original, [...links, link('e', [300, 300, 320, 320])], [id('a'), id('d'), id('e')]))).toEqual({ pass: false, code: 'rules' });
  });

  /** The redacted copy with no links, then annotations written as a subverted engine would, by `edit`. */
  async function subverted(original: Uint8Array, edit: (doc: PDFDocument) => void): Promise<Uint8Array> {
    const plain = await copyOf(original, []);
    const doc = await PDFDocument.load(plain.pdf, { updateMetadata: false });
    edit(doc);
    return doc.save({ useObjectStreams: false });
  }

  it('refuses a subverted engine\'s link placed over a box, though its shape and place are the request\'s: the text under it is not the original\'s', async () => {
    const original = await newsletter();
    const links = [link('a', OVER_URL), link('b', OVER_NAME)];
    const copy = await subverted(original, (doc) => writeLinks(doc, ORIGIN, links));
    expect(await linkTextBreak(copy, original, { origin: ORIGIN, links, kept: [id('a'), id('b')] })).toBe('page 1: the text under a link is not the original\'s');
    expect(await gateVerdict(job(copy, original, links, [id('a'), id('b')]))).toEqual({ pass: false, code: 'rules' });
    // The same link over text nothing withheld passes.
    const fine = await subverted(original, (doc) => writeLinks(doc, ORIGIN, [links[0]!]));
    expect(await gateVerdict(job(fine, original, links, [id('a')]))).toEqual({ pass: true });
  });

  it('refuses each of SPEC 7\'s subverted-engine copies: an extra annotation, /AP, /AA, JavaScript, Launch, another origin, a duplicated id, an id not asked for, a rect moved over a box', async () => {
    const original = await newsletter();
    const links = [link('a', OVER_URL), link('d', PLAIN_LINE)];
    const kept = [id('a'), id('d')];
    const annot = (doc: PDFDocument, extra: Record<string, unknown>, uri = linkUri(ORIGIN, id('a')), rect: readonly number[] = OVER_URL) =>
      doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [...rect], Border: [0, 0, 0], F: 4, A: { S: 'URI', URI: PDFString.of(uri) }, Contents: PDFString.of('Link to site.example'), ...extra } as never));
    const page = (doc: PDFDocument, refs: unknown[]) => doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj(refs as never));
    const plainD = (doc: PDFDocument) => annot(doc, {}, linkUri(ORIGIN, id('d')), PLAIN_LINE);
    const cases: Array<[string, (doc: PDFDocument) => void]> = [
      ['an extra link to another site', (doc) => page(doc, [annot(doc, {}), plainD(doc), annot(doc, {}, 'https://evil.example/', [72, 600, 100, 620])])],
      ['an appearance stream', (doc) => page(doc, [annot(doc, { AP: { N: doc.context.register(doc.context.stream('BT /F1 9 Tf (Read more) Tj ET')) } }), plainD(doc)])],
      ['additional actions', (doc) => page(doc, [annot(doc, { AA: { E: { S: 'JavaScript', JS: PDFString.of('app.alert(1)') } } }), plainD(doc)])],
      ['a JavaScript action', (doc) => page(doc, [doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [...OVER_URL], Border: [0, 0, 0], F: 4, A: { S: 'JavaScript', JS: PDFString.of('app.launchURL("https://evil.example/")') }, Contents: PDFString.of('Link to site.example') })), plainD(doc)])],
      ['a Launch action', (doc) => page(doc, [doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [...OVER_URL], Border: [0, 0, 0], F: 4, A: { S: 'Launch', F: PDFString.of('cmd.exe') }, Contents: PDFString.of('Link to site.example') })), plainD(doc)])],
      ['<origin>.evil', (doc) => page(doc, [annot(doc, {}, `https://nwflorida.us.evil.example/out/${id('a')}`), plainD(doc)])],
      ['<origin>@evil', (doc) => page(doc, [annot(doc, {}, `https://nwflorida.us@example.net/out/${id('a')}`), plainD(doc)])],
      ['/out/../', (doc) => page(doc, [annot(doc, {}, `https://nwflorida.us/out/../${id('a')}`), plainD(doc)])],
      ['upper case', (doc) => page(doc, [annot(doc, {}, `HTTPS://NWFLORIDA.US/out/${id('a')}`), plainD(doc)])],
      ['a homoglyph origin', (doc) => page(doc, [annot(doc, {}, `https://nwflоrida.us/out/${id('a')}`), plainD(doc)])],
      ['a duplicated id', (doc) => page(doc, [annot(doc, {}), annot(doc, {}), plainD(doc)])],
      ['an id not in the request', (doc) => page(doc, [annot(doc, {}, linkUri(ORIGIN, id('q'))), plainD(doc)])],
      ['a rect moved over a box', (doc) => page(doc, [annot(doc, {}, linkUri(ORIGIN, id('a')), OVER_NAME), plainD(doc)])],
      ['a link outside /Annots, in the catalog', (doc) => {
        page(doc, [annot(doc, {}), plainD(doc)]);
        doc.catalog.set(PDFName.of('OpenAction'), annot(doc, {}));
      }],
      ['an annotation list on the page tree\'s root, which pdf.js inherits', (doc) => {
        page(doc, [annot(doc, {}), plainD(doc)]);
        (doc.catalog.lookup(PDFName.of('Pages')) as PDFDict).set(PDFName.of('Annots'), doc.context.obj([annot(doc, {}, linkUri(ORIGIN, id('d')), PLAIN_LINE)]));
      }],
    ];
    for (const [name, edit] of cases) {
      const copy = await subverted(original, edit);
      expect(await gateVerdict(job(copy, original, links, kept)), name).toEqual({ pass: false, code: 'rules' });
      expect((await gateReply(job(copy, original, links, kept))).verdict, name).toEqual({ pass: false, code: 'rules' });
    }
    // The control: written the engine's way, the same two links pass.
    expect(await gateVerdict(job(await subverted(original, (doc) => writeLinks(doc, ORIGIN, links)), original, links, kept))).toEqual({ pass: true });
  });

  it('reads the original\'s text under each link with the original\'s own annotations out of the way, and refuses a link past the original\'s pages', async () => {
    const original = await newsletter();
    const links = [link('a', OVER_URL)];
    const copy = await subverted(original, (doc) => writeLinks(doc, ORIGIN, links));
    expect(await linkTextBreak(copy, original, { origin: ORIGIN, links, kept: [id('a')] })).toBeNull();
    expect(await linkTextBreak(copy, original, { origin: ORIGIN, links: [link('a', OVER_URL, { page: 2 })], kept: [id('a')] })).toBeTypeOf('string');
    expect(await linkTextBreak(copy, Uint8Array.from([1, 2, 3]), { origin: ORIGIN, links, kept: [id('a')] })).toBe('the text under the links cannot be read');
    expect(await linkTextBreak(copy, original, { origin: ORIGIN, links, kept: [] })).toBeNull();
  });

  it('refuses what pdf.js reads besides the kept links: another annotation, a link twice, a request with no origin or no links; a link over blank paper reads alike', async () => {
    const original = await newsletter();
    const links = [link('a', OVER_URL)];
    const kept = [id('a')];
    const STRAY = 'pdf.js reads other annotations in the copy than the links the engine kept';
    const withNote = await subverted(original, (doc) => {
      writeLinks(doc, ORIGIN, links);
      const note = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [400, 400, 420, 420], Contents: PDFString.of('note') }));
      doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).push(note);
    });
    expect(await linkTextBreak(withNote, original, { origin: ORIGIN, links, kept })).toBe(STRAY);
    const twice = await subverted(original, (doc) => writeLinks(doc, ORIGIN, [links[0]!, links[0]!]));
    expect(await linkTextBreak(twice, original, { origin: ORIGIN, links, kept })).toBe(STRAY);
    const copy = await subverted(original, (doc) => writeLinks(doc, ORIGIN, links));
    expect(await linkTextBreak(copy, original, { links, kept })).toBe(STRAY);
    expect(await linkTextBreak(copy, original, { origin: ORIGIN, kept })).toBe(STRAY);
    expect(await linkTextBreak(copy, original, { origin: ORIGIN, links })).toBeNull();
    const blank = [link('b', [400, 100, 500, 120])];
    expect(await linkTextBreak(await subverted(original, (doc) => writeLinks(doc, ORIGIN, blank)), original, { origin: ORIGIN, links: blank, kept: [id('b')] })).toBeNull();
  });
});
