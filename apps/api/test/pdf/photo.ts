// A synthetic page with a photo (LINKS L3 fix round 1, S1): made-up content only.
import { PDFDocument, PDFName, StandardFonts } from '@cantoo/pdf-lib';

/** A page with a 64 x 64 photo at [100, 400, 300, 600] (drawn on the page, or through a form XObject) and a caption under it. */
export async function photoPage(inForm = false, pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const side = 64;
  const samples = Uint8Array.from({ length: side * side * 3 }, (_, i) => (i * 37 + (i >> 3) * 11) % 251);
  const picture = doc.context.register(doc.context.flateStream(samples, { Type: 'XObject', Subtype: 'Image', Width: side, Height: side, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
  for (let n = 0; n < pages; n++) {
    const page = doc.addPage([612, 792]);
    if (inForm) {
      // The form draws the photo in its own unit square; the page scales and places the form.
      const form = doc.context.register(doc.context.stream('q 1 0 0 1 0 0 cm /Im1 Do Q', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Resources: { XObject: { Im1: picture } } }));
      page.node.setXObject(PDFName.of('Fm1'), form);
      page.node.addContentStream(doc.context.register(doc.context.stream('q 200 0 0 200 100 400 cm /Fm1 Do Q')));
    } else {
      page.node.setXObject(PDFName.of('Im1'), picture);
      page.node.addContentStream(doc.context.register(doc.context.stream('q 200 0 0 200 100 400 cm /Im1 Do Q')));
    }
    page.drawText('Our members at the picnic.', { x: 72, y: 380, size: 12, font });
  }
  return doc.save({ useObjectStreams: false });
}

/** A dictionary as pdf-lib's context takes one. */
type Dict = NonNullable<Parameters<PDFDocument['context']['stream']>[1]>;

/**
 * How a page reaches a tiling pattern (LINKS L3 fix round 2, F1), and what the pattern holds. Each pattern paints
 * the 64 x 64 photo (when it holds one) at [100, 400, 300, 600], with no picture drawn on the page itself:
 *   image      the pattern's own resources name the photo;
 *   flat       the same, with a flat grey picture in place of the photo (its samples read as no content);
 *   inline     the pattern's content holds an inline picture;
 *   form       the pattern draws a form that draws the photo;
 *   nested     the pattern paints with a second pattern that holds the photo;
 *   inherit    the pattern has no resources of its own; the page's name the photo (readers merge them);
 *   pageform   the page draws a form whose resources hold the pattern;
 *   annot      a Stamp annotation's appearance paints with the pattern, in its down appearance's "On" state;
 *   smask      a soft mask's group paints with the pattern;
 *   glyph      a Type 3 glyph paints with the pattern;
 *   unreadable the pattern's content is under a filter no reader knows;
 *   predictor  the pattern's content has /DecodeParms, which pdf-lib does not apply;
 *   vector     the pattern paints a plain square: no picture, so nothing is withheld; beside it the page's resources
 *              hold what draws no picture: a shading pattern, a state with no soft mask, and entries that are
 *              not what their kind names (a number for a picture or a font).
 * Pages after the first hold a line of text only.
 */
export type PatternRoute = 'image' | 'flat' | 'inline' | 'form' | 'nested' | 'inherit' | 'pageform' | 'annot' | 'smask' | 'glyph' | 'unreadable' | 'predictor' | 'vector';
export const PATTERN_ROUTES: readonly PatternRoute[] = ['image', 'flat', 'inline', 'form', 'nested', 'inherit', 'pageform', 'annot', 'smask', 'glyph', 'unreadable', 'predictor', 'vector'];

export async function patternPage(route: PatternRoute, pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;
  const side = 64;
  const samples = Uint8Array.from({ length: side * side * 3 }, (_, i) => (i * 37 + (i >> 3) * 11) % 251);
  const picture = ctx.register(ctx.flateStream(samples, { Type: 'XObject', Subtype: 'Image', Width: side, Height: side, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
  const DRAW = 'q 200 0 0 200 0 0 cm /Im1 Do Q';
  const FILL = 'q /Pattern cs /P1 scn 100 400 200 200 re f Q';
  const tile = (content: string, resources?: Dict, extra: Dict = {}) =>
    ctx.register(ctx.stream(content, { Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 200, 200], XStep: 200, YStep: 200, Matrix: [1, 0, 0, 1, 100, 400], ...(resources === undefined ? {} : { Resources: resources }), ...extra }));
  const form = (content: string, resources: Dict, extra: Dict = {}) =>
    ctx.register(ctx.stream(content, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 612, 792], Resources: resources, ...extra }));
  const holding = tile(DRAW, { XObject: { Im1: picture } });
  const page = doc.addPage([612, 792]);
  let resources: Dict = { Pattern: { P1: holding } };
  let content = FILL;
  if (route === 'flat') {
    const grey = ctx.register(ctx.flateStream(new Uint8Array(side * side).fill(160), { Type: 'XObject', Subtype: 'Image', Width: side, Height: side, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));
    resources = { Pattern: { P1: tile(DRAW, { XObject: { Im1: grey } }) } };
  } else if (route === 'inline') {
    const hex = Buffer.from(samples.subarray(0, 8 * 8 * 3)).toString('hex');
    resources = { Pattern: { P1: tile(`q 200 0 0 200 0 0 cm BI /W 8 /H 8 /CS /RGB /BPC 8 /F /AHx ID ${hex}> EI Q`, {}) } };
  } else if (route === 'form') {
    resources = { Pattern: { P1: tile('/Fm1 Do', { XObject: { Fm1: form(DRAW, { XObject: { Im1: picture } }, { BBox: [0, 0, 200, 200] }) } }) } };
  } else if (route === 'nested') {
    resources = { Pattern: { P1: tile('/Pattern cs /P2 scn 0 0 200 200 re f', { Pattern: { P2: holding } }) } };
  } else if (route === 'inherit') {
    resources = { Pattern: { P1: tile(DRAW) }, XObject: { Im1: picture } };
  } else if (route === 'pageform') {
    resources = { XObject: { Fm2: form(FILL, { Pattern: { P1: holding } }) } };
    content = '/Fm2 Do';
  } else if (route === 'annot') {
    const appearance = form(FILL, { Pattern: { P1: holding } });
    const blank = form('', {});
    page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [0, 0, 612, 792], F: 4, AS: 'On', AP: { N: blank, D: { Off: blank, On: appearance } } }))]));
    resources = {};
    content = '';
  } else if (route === 'smask') {
    const group = form(FILL, { Pattern: { P1: holding } }, { Group: { S: 'Transparency', CS: 'DeviceGray' } });
    resources = { ExtGState: { GS1: ctx.obj({ Type: 'ExtGState', SMask: { Type: 'Mask', S: 'Luminosity', G: group } }) } };
    content = 'q /GS1 gs 0 0 0 rg 100 400 200 200 re f Q';
  } else if (route === 'glyph') {
    const proc = ctx.register(ctx.stream('200 0 d0 /Pattern cs /P1 scn 0 0 200 200 re f'));
    const t3 = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 200, 200], FontMatrix: [0.005, 0, 0, 0.005, 0, 0], CharProcs: { g: proc }, Encoding: { Type: 'Encoding', Differences: [65, 'g'] }, FirstChar: 65, LastChar: 65, Widths: [200], Resources: { Pattern: { P1: holding } } }));
    resources = { Font: { T3: t3 } };
    content = 'BT /T3 200 Tf 100 400 Td (A) Tj ET';
  } else if (route === 'unreadable') {
    resources = { Pattern: { P1: tile(DRAW, {}, { Filter: 'NoSuchDecode' }) } };
  } else if (route === 'predictor') {
    resources = { Pattern: { P1: tile('0 0 100 100 re f', {}, { DecodeParms: { Predictor: 12, Columns: 4 } }) } };
  } else if (route === 'vector') {
    const shading = { ShadingType: 2, ColorSpace: 'DeviceRGB', Coords: [0, 0, 100, 0], Function: { FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0], C1: [1, 1, 1], N: 1 } };
    resources = {
      Pattern: { P1: tile('0.2 0.4 0.6 rg 0 0 100 100 re f', {}), Sh1: ctx.obj({ PatternType: 2, Shading: shading }) },
      ExtGState: { GS1: ctx.obj({ Type: 'ExtGState', CA: 1 }) },
      XObject: { Odd: 7 },
      Font: { Odd: 7 },
    };
  }
  page.node.set(PDFName.of('Resources'), ctx.obj(resources));
  if (content !== '') page.node.addContentStream(ctx.register(ctx.stream(content)));
  page.drawText('Our members at the picnic.', { x: 72, y: 380, size: 12, font });
  for (let n = 1; n < pages; n++) doc.addPage([612, 792]).drawText(`Page ${n + 1}: the picnic schedule.`, { x: 72, y: 700, size: 12, font });
  return doc.save({ useObjectStreams: false });
}
