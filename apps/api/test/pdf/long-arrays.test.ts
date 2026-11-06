// LINKS L3 fix round 3 (N5): no array of a page's objects, glyphs, boxes or regions is spread into a
// call (Math.min, Math.max, push) where a test can reach it. A spread passes each item as an argument,
// and V8 throws RangeError past about 125,000 of them: a page of a million text shows (a 1 MB file) made
// the engine throw in isScan instead of answering. Each function here is given more items than that
// (200,000). At a million the engine now runs out of a 2 GB container's memory instead. Five
// pushes are left as main has them (redact.ts: a page's pictures, drawn boxes and withheld areas;
// match.ts regionsFor: a pulled glyph's word and the unread objects reached): no page reaches 125,000
// there in a bounded run (130,000 withheld words took 149 s; 200,000 pictures ran past 10 minutes; a
// word that long is pushed again for each glyph pulled from it), and the RangeError fails the engine safe.
// Synthetic data only; made-up content.
import { PDFDocument, PDFName, StandardFonts } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { copyRulesBreak } from '../../src/pdf/gate-rules.js';
import { linkGuardAreas } from '../../src/pdf/link-guard.js';
import { type Box, type PageChar, type Region, copiesOf, regionsFor, unread } from '../../src/pdf/match.js';
import { redactPdf } from '../../src/pdf/redact.js';
import { manyShows } from './hostile.js';

/** More arguments than V8 takes in one call (about 125,000 on Node 24). */
const MANY = 200_000;
const SIZE = 12;

/** `count` glyphs on one line, 6 pt apart; `inked(i)` says which have ink (the others have only a loose box). */
function line(count: number, text: (i: number) => string = () => 'a', inked: (i: number) => boolean = () => true): PageChar[] {
  return Array.from({ length: count }, (_, i) => {
    const left = 72 + i * 6;
    const box: Box = { left, right: left + 6, bottom: 700, top: 700 + SIZE };
    return { text: text(i), generated: false, hyphen: false, box, ink: inked(i) ? { left: left + 0.5, right: left + 5.5, bottom: 701, top: 710 } : null, fontSize: SIZE };
  });
}
const right = (count: number): number => 72 + count * 6;

/** One page drawing one 1 x 1 picture `count` times, each half a point a side, in rows of 600, and a caption. */
async function manyPictures(count: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const picture = ctx.register(ctx.flateStream(new Uint8Array([200, 30, 90]), { Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
  const page = doc.addPage([612, 792]);
  page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { Im1: picture }, Font: { F1: font.ref } }));
  const draws = Array.from({ length: count }, (_, i) => `q 0.5 0 0 0.5 ${(i % 600) + 1} ${Math.floor(i / 600) + 1} cm /Im1 Do Q`);
  page.node.addContentStream(ctx.register(ctx.flateStream(`${draws.join('\n')}\nBT /F1 12 Tf 72 760 Td (Picnic photos) Tj ET`)));
  return doc.save({ useObjectStreams: false });
}

/** One page whose Type 3 font has `count` glyphs (all one procedure), drawing one of them. */
async function manyGlyphs(count: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const proc = ctx.register(ctx.stream('1000 0 0 0 750 750 d1 0 0 750 750 re f'));
  const procs = Object.fromEntries(Array.from({ length: count }, (_, i) => [`g${i}`, proc]));
  const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 750, 750], FontMatrix: [0.001, 0, 0, 0.001, 0, 0], CharProcs: procs, Encoding: { Type: 'Encoding', Differences: [65, 'g0'] }, FirstChar: 65, LastChar: 65, Widths: [1000] }));
  const page = doc.addPage([612, 792]);
  page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { T3: font } }));
  page.node.addContentStream(ctx.register(ctx.stream('BT /T3 12 Tf 72 700 Td (A) Tj ET')));
  return doc.save({ useObjectStreams: false });
}

describe('N5: no spread of an unbounded array into a call', () => {
  it('unread: a text object of more glyphs than a call takes arguments', () => {
    const chars = line(MANY);
    const bounds = { left: 60, right: right(MANY), bottom: 700, top: 700 + SIZE };
    // What the reading reaches: from the first glyph's box to the last's; the object's bounds begin 12 pt before it.
    expect(unread(chars, [{ bounds, chars: chars.map((_, i) => i) }])).toEqual({ objects: [], parts: [{ left: 60, right: 72, bottom: 700, top: 712 }] });
  });

  it('copiesOf: a withheld word of more glyphs than a call takes arguments', () => {
    const chars = line(MANY);
    const all = chars.map((_, i) => i);
    expect(copiesOf(chars, new Set(all), [{ object: 0, chars: all }])).toEqual([]);
  });

  it('regionsFor: more regions than a call takes arguments, all met by one unread object, become one', () => {
    // Every other glyph withheld, each its own region; the glyphs between have no ink, so none is pulled in.
    const chars = line(2 * MANY, (i) => (i % 2 === 0 ? 'a' : 'b'), (i) => i % 2 === 0);
    const withheld = new Set(chars.flatMap((_, i) => (i % 2 === 0 ? [i] : [])));
    const unreadObject = { left: 70, right: right(2 * MANY) + 2, bottom: 698, top: 714 };
    const expected: Region = { page: 0, ...unreadObject, fontSize: SIZE };
    expect(regionsFor(chars, withheld, 0, [unreadObject])).toEqual({ ok: true, regions: [expected] });
  });

  it('copiesOf: a word of more glyphs than a call takes arguments that repeats a withheld word is all a copy', () => {
    // A withheld "Brask" (text object 0), and at its place in object 1 the same word after a run of full stops.
    const held = 'Brask';
    const chars = [...line(held.length, (i) => held[i] as string), ...line(MANY, (i) => (i < MANY - held.length ? '.' : (held[i - MANY + held.length] as string)))];
    const first = Array.from({ length: held.length }, (_, i) => i);
    const second = Array.from({ length: MANY }, (_, i) => held.length + i);
    expect(copiesOf(chars, new Set(first), [{ object: 0, chars: first }, { object: 1, chars: second }])).toEqual(second);
  });

  it('linkGuardAreas: a page of more glyphs than a call takes arguments, none of them in the copy', async () => {
    const blank = await PDFDocument.create({ updateMetadata: false });
    blank.addPage([612, 792]);
    const areas = await linkGuardAreas(manyShows(MANY / 2), await blank.save({ useObjectStreams: false }), 'show');
    expect(areas.length).toBeGreaterThan(MANY);
  }, 600_000);

  it('linkGuardAreas: a page of more pictures than a call takes arguments, under "blur"', async () => {
    const pdf = await manyPictures(MANY);
    const areas = await linkGuardAreas(pdf, pdf, 'blur');
    expect(areas.length).toBe(MANY);
    expect(areas.filter((area) => area.page === 0 && area.left === 1 && area.bottom === 1 && area.right === 1.5)).toHaveLength(1);
  }, 600_000);

  it('copyRulesBreak: a Type 3 font of more glyphs than a call takes arguments', async () => {
    expect(await copyRulesBreak(await manyGlyphs(MANY), 'blur')).toBe(null);
  }, 600_000);

  it('isScan: a blank page draws nothing, so it is no scan (as with the spread, whose extent was empty)', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage([612, 792]);
    expect(await redactPdf(await doc.save({ useObjectStreams: false }), { quotes: ['Picnic'], redactsAny: true })).toMatchObject({ kind: 'redacted' });
  });

  it('copyRulesBreak: a Type 3 glyph that is not a stream is refused, as before', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const ctx = doc.context;
    const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 750, 750], FontMatrix: [0.001, 0, 0, 0.001, 0, 0], CharProcs: { g0: 7 }, Encoding: { Type: 'Encoding', Differences: [65, 'g0'] }, FirstChar: 65, LastChar: 65, Widths: [1000] }));
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { T3: font } }));
    page.node.addContentStream(ctx.register(ctx.stream('BT /T3 12 Tf 72 700 Td (A) Tj ET')));
    expect(await copyRulesBreak(await doc.save({ useObjectStreams: false }), 'blur')).toBe('a page has content that is not a stream');
  });

  it('isScan: the engine answers for a page of more text shows than a call takes arguments, with no RangeError', async () => {
    expect(await redactPdf(manyShows(MANY), { quotes: ['Picnic'], redactsAny: true })).toMatchObject({ kind: 'redacted' });
  }, 600_000);
});
