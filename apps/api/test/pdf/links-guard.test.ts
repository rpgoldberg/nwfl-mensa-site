// LINKS L3 fix round 1 (S1, N1): no kept link meets anything withheld, by the engine's drop and by the
// gate's own refusal, both reading the same thing with PDFium (link-guard.ts):
//   - a picture the audience's policy does not show ("blur" or "hide"), on any page, with no quote on it
//     too, drawn on the page or in a form XObject;
//   - the box of any glyph of the original that is missing from the copy, and its ink: a rect that meets
//     a withheld glyph only by a sliver, its centre outside, is refused too.
// The engine drops such a link; a subverted engine that keeps one has its whole copy refused by the gate.
// Synthetic PDFs only; every person is made up and every host is a reserved example name.
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { gateVerdict } from '../../src/pdf/gate-rules.js';
import { linkTextBreak } from '../../src/pdf/gate-links.js';
import type { ImageAction } from '../../src/pdf/images.js';
import { type EngineLink, writeLinks } from '../../src/pdf/link-annots.js';
import { redactPdf } from '../../src/pdf/redact.js';
import { linesPdf } from './fixtures.js';
import { photoPage } from './photo.js';

const ORIGIN = 'https://nwflorida.us';
const id = (c: string): string => c.repeat(26);
const link = (c: string, rect: EngineLink['rect'], extra: Partial<EngineLink> = {}): EngineLink => ({ id: id(c), page: 1, rect, label: 'Link to site.example', ...extra });
const job = (copy: Uint8Array, original: Uint8Array, links: readonly EngineLink[], kept: readonly string[], quotes: readonly string[], image: ImageAction) => ({ copy, original, quotes, image, origin: ORIGIN, links, kept });

const OVER_PHOTO: EngineLink['rect'] = [100, 400, 300, 600];
const BESIDE_PHOTO: EngineLink['rect'] = [320, 450, 400, 470];
const CAPTION: EngineLink['rect'] = [72, 377, 220, 392];

/** The engine's copy with no links, then the links written over it anyway: a subverted engine's. */
async function subverted(original: Uint8Array, links: readonly EngineLink[], quotes: readonly string[], image: ImageAction): Promise<Uint8Array> {
  const plain = await redactPdf(original, { quotes, redactsAny: true, image });
  if (plain.kind !== 'redacted') throw new Error(`expected a copy, got ${JSON.stringify(plain)}`);
  const doc = await PDFDocument.load(plain.pdf, { updateMetadata: false });
  writeLinks(doc, ORIGIN, links);
  return doc.save({ useObjectStreams: false });
}

describe('S1: a link over a picture the policy does not show', () => {
  for (const image of ['blur', 'hide'] as const) {
    it(`under "${image}", the engine drops a link over a photo, on a page with no quote, drawn on the page or in a form; one beside it or over the caption stays`, async () => {
      for (const inForm of [false, true]) {
        const original = await photoPage(inForm);
        const links = [link('p', OVER_PHOTO, { label: 'Link to photos.example' }), link('q', [250, 550, 350, 650]), link('b', BESIDE_PHOTO), link('c', CAPTION)];
        const result = await redactPdf(original, { quotes: [], redactsAny: true, origin: ORIGIN, links, image });
        expect(result.kind, `form ${inForm}`).toBe('redacted');
        const kept = (result as { kept: string[] }).kept;
        expect(kept, `form ${inForm}`).toEqual([id('b'), id('c')]);
        expect(await gateVerdict(job((result as { pdf: Uint8Array }).pdf, original, links, kept, [], image)), `form ${inForm}`).toEqual({ pass: true });
      }
    });

    it(`under "${image}", the gate refuses a subverted engine's copy that keeps a link over the photo, or touching its edge, on any page`, async () => {
      for (const [inForm, pages, page, rect] of [
        [false, 1, 1, OVER_PHOTO],
        [true, 1, 1, OVER_PHOTO],
        [false, 1, 1, [300, 600, 340, 640]],
        [false, 2, 2, [150, 450, 160, 460]],
      ] as const) {
        const original = await photoPage(inForm, pages);
        const links = [link('p', rect, { page }), link('c', CAPTION)];
        const copy = await subverted(original, links, [], image);
        const label = `form ${inForm}, page ${page}, ${rect.join(' ')}`;
        expect(await linkTextBreak(copy, original, { origin: ORIGIN, links, kept: [id('p'), id('c')], image }), label).not.toBeNull();
        expect(await gateVerdict(job(copy, original, links, [id('p'), id('c')], [], image)), label).toEqual({ pass: false, code: 'rules' });
      }
    });
  }

  it('under "show", the photo is the original\'s and a link over it is kept, and passes the gate', async () => {
    const original = await photoPage();
    const links = [link('p', OVER_PHOTO)];
    const result = await redactPdf(original, { quotes: ['Kestrel Ambry'], redactsAny: true, origin: ORIGIN, links, image: 'show' });
    expect(result).toMatchObject({ kind: 'redacted', kept: [id('p')] });
    expect(await gateVerdict(job((result as { pdf: Uint8Array }).pdf, original, links, [id('p')], ['Kestrel Ambry'], 'show'))).toEqual({ pass: true });
  });
});

describe('N1: a link that meets the box of a withheld glyph, though no glyph centre is under it', () => {
  async function namePage(): Promise<{ original: Uint8Array; nameEnd: number }> {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    page.drawText('Please write to Quillon Brask about the picnic.', { x: 72, y: 720, size: 12, font });
    page.drawText('This closing line stays readable.', { x: 72, y: 680, size: 12, font });
    const nameEnd = 72 + font.widthOfTextAtSize('Please write to Quillon Brask', 12);
    return { original: await doc.save({ useObjectStreams: false }), nameEnd };
  }

  it('the gate refuses a subverted engine\'s link that overlaps the name\'s last glyph by 1.5 pt', async () => {
    const { original, nameEnd } = await namePage();
    const sliver = link('s', [nameEnd - 1.5, 717, nameEnd + 60, 732]);
    // The honest engine drops it.
    expect(await redactPdf(original, { quotes: ['Quillon Brask'], redactsAny: true, origin: ORIGIN, links: [sliver] })).toMatchObject({ kind: 'redacted', kept: [] });
    const copy = await subverted(original, [sliver], ['Quillon Brask'], 'show');
    expect(await linkTextBreak(copy, original, { origin: ORIGIN, links: [sliver], kept: [id('s')] })).not.toBeNull();
    expect(await gateVerdict(job(copy, original, [sliver], [id('s')], ['Quillon Brask'], 'show'))).toEqual({ pass: false, code: 'rules' });
  });

  it('keeps, and the gate passes, a link 25 pt past a removed word on its line and one on the line below it, which meet none of it', async () => {
    const original = await linesPdf(['Phone Bo now about the picnic.', 'Ask the hosts at the door.']);
    // "Bo" (x 110 to 124.7) is removed alone.
    const links = [link('c', [150, 717, 230, 731]), link('e', [72, 697, 200, 711])];
    const result = await redactPdf(original, { quotes: ['Bo'], redactsAny: true, origin: ORIGIN, links });
    expect(result).toMatchObject({ kind: 'redacted', kept: [id('c'), id('e')] });
    expect(await gateVerdict(job((result as { pdf: Uint8Array }).pdf, original, links, [id('c'), id('e')], ['Bo'], 'show'))).toEqual({ pass: true });
  });
});
