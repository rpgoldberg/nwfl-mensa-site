// ARCHIVE-SEARCH S2: what the gate's child answers a "text" job (gate-text.ts): the text of a stored
// copy's pages, read with pdf.js as the gate reads it, through the index's one line-end rule
// (search/text.ts). The PDFs are synthetic, made here with pdf-lib; every name is made up.
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { blankPdf, pagesPdf } from '../../test/search/synthetic.js';
import { sha256Hex } from './engine-protocol.js';
import { isTextJob, pageOf, textReply } from './gate-text.js';
import { textMatches } from './match.js';
import { TEXT_MAX_PAGES } from './text-protocol.js';

const job = (copy: Uint8Array, quotes: readonly string[] = []) => ({ kind: 'text' as const, copy, quotes });

describe('textReply', () => {
  it('answers the text of each page, in order, with the sha256 of the copy it was sent', async () => {
    const copy = await pagesPdf([['Picnic at Ferry Park', 'Bring a chair.'], [], ['Game night moves to Tuesday']]);
    expect(await textReply(job(copy))).toEqual({
      sha256: sha256Hex(copy),
      pages: [
        { text: 'Picnic at Ferry Park Bring a chair.', extra: '' },
        { text: '', extra: '' },
        { text: 'Game night moves to Tuesday', extra: '' },
      ],
    });
  });

  it('reads a word split at a line end as one word, and keeps the hyphenated form as extra (SEARCH-HYPH)', async () => {
    const copy = await pagesPdf([['All mem-', 'bers are welcome; a well-', 'known speaker follows.']]);
    expect(await textReply(job(copy))).toEqual({ sha256: sha256Hex(copy), pages: [{ text: 'All members are welcome; a wellknown speaker follows.', extra: 'mem-bers well-known' }] });
  });

  it('gives no text at all for a copy that still holds a passage its audience withholds, whole or split at a line end', async () => {
    const plain = await pagesPdf([['Notes from the board'], ['Rides: call Kestrel Ambry today.']]);
    expect(await textReply(job(plain, ['Kestrel Ambry']))).toEqual({ sha256: sha256Hex(plain), code: 'withheld' });
    const split = await pagesPdf([['Rides: call Kestrel Am-', 'bry today.']]);
    expect(await textReply(job(split, ['Kestrel Ambry']))).toEqual({ sha256: sha256Hex(split), code: 'withheld' });
    // The same copies for an audience that withholds something else are read.
    expect(await textReply(job(plain, ['Ottoline Varga']))).toMatchObject({ pages: [{ text: 'Notes from the board' }, { text: 'Rides: call Kestrel Ambry today.' }] });
  });

  it('gives no text for a withheld name split at a line end in another font, which the gate\'s own readings do not join (S2 challenge M1)', async () => {
    // pdf.js gives "Call Av-" (no end of line), an empty item that ends the line, then "ery Quill today": the index's
    // join reads "Avery Quill", the gate's readings do not. The check is on the text that would be indexed.
    const doc = await PDFDocument.create({ updateMetadata: false });
    const [times, bold] = [await doc.embedFont(StandardFonts.TimesRoman), await doc.embedFont(StandardFonts.HelveticaBold)];
    const page = doc.addPage([612, 792]);
    page.drawText('Call Av-', { x: 320, y: 700, size: 12, font: times });
    page.drawText('ery Quill today', { x: 320, y: 684, size: 12, font: bold });
    const copy = await doc.save({ useObjectStreams: false });
    expect(await textReply(job(copy, ['Avery Quill']))).toEqual({ sha256: sha256Hex(copy), code: 'withheld' });
    expect(await textReply(job(copy, ['Ottoline Varga']))).toMatchObject({ pages: [{ text: 'Call Avery Quill today', extra: 'Av-ery' }] });
  });

  it('still puts the gate\'s own readings first: a name drawn out of order, which the index\'s join does not read, is withheld on any page', async () => {
    // "Quill today" is drawn before "Call Avery" on the same line: the items, in drawn order, read "Quill today Call
    // Avery" (S1's join puts a space between items on a line); the gate's placed reading reads the line left to right.
    // Only the gate's test finds the name here.
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([612, 792]).drawText('Notes from the board', { x: 72, y: 700, size: 12, font });
    const second = doc.addPage([612, 792]);
    second.drawText('Quill today', { x: 72 + font.widthOfTextAtSize('Call Avery ', 12), y: 700, size: 12, font });
    second.drawText('Call Avery', { x: 72, y: 700, size: 12, font });
    const copy = await doc.save({ useObjectStreams: false });
    const read = await textReply(job(copy, ['Ottoline Varga']));
    expect(read).toMatchObject({ pages: [{ text: 'Notes from the board' }, { text: 'Quill today Call Avery' }] });
    expect(await textReply(job(copy, ['Avery Quill']))).toEqual({ sha256: sha256Hex(copy), code: 'withheld' });
  });

  it('never gives text that holds a withheld name, over random layouts that split it (seeded property, S2 challenge M1)', async () => {
    const quotes = ['Avery Quill'];
    const seen: Record<string, { leaked: number; withheld: number }> = {};
    for (const start of [7, 11]) {
      let [leaked, withheld] = [0, 0];
      for (const copy of await splitLayouts(start, 300)) {
        const reply = await textReply(job(copy, quotes));
        if ('pages' in reply && reply.pages.some((page) => textMatches(page.text, quotes) || textMatches(page.extra, quotes))) leaked++;
        if ('code' in reply && reply.code === 'withheld') withheld++;
      }
      seen[`seed ${start}`] = { leaked, withheld };
    }
    // Of 300 layouts a seed, none gives text that holds the name; the control: most are refused, as the name shows.
    expect(Object.values(seen).map((counts) => counts.leaked), JSON.stringify(seen)).toEqual([0, 0]);
    for (const counts of Object.values(seen)) expect(counts.withheld, JSON.stringify(seen)).toBeGreaterThan(100);
  }, 120_000);

  it('says "over-cap" for more than 300 pages, a page over its cap, or a file over the cap in all, and reads up to them', async () => {
    const most = await blankPdf(TEXT_MAX_PAGES);
    expect(await textReply(job(most))).toMatchObject({ pages: { length: TEXT_MAX_PAGES } });
    const over = await blankPdf(TEXT_MAX_PAGES + 1);
    expect(await textReply(job(over))).toEqual({ sha256: sha256Hex(over), code: 'over-cap' });
    const copy = await pagesPdf([['twelve chars'], ['twelve chars']]);
    expect(await textReply(job(copy), { pageBytes: 12, bytes: 24 })).toMatchObject({ pages: { length: 2 } });
    expect(await textReply(job(copy), { pageBytes: 11, bytes: 24 })).toEqual({ sha256: sha256Hex(copy), code: 'over-cap' });
    expect(await textReply(job(copy), { pageBytes: 12, bytes: 23 })).toEqual({ sha256: sha256Hex(copy), code: 'over-cap' });
    const joined = await pagesPdf([['a well-', 'known one']]);
    // The extra counts too: "a wellknown one" is 15 bytes, "well-known" 10.
    expect(await textReply(job(joined), { pageBytes: 15, bytes: 25 })).toMatchObject({ pages: [{ extra: 'well-known' }] });
    expect(await textReply(job(joined), { pageBytes: 15, bytes: 24 })).toMatchObject({ code: 'over-cap' });
    expect(await textReply(job(joined), { pageBytes: 9, bytes: 99 })).toMatchObject({ code: 'over-cap' });
  });

  it('says "unfinished" for bytes that are no PDF', async () => {
    const copy = new TextEncoder().encode('not a pdf at all');
    expect(await textReply(job(copy))).toEqual({ sha256: sha256Hex(copy), code: 'unfinished' });
  });
});

describe('pageOf', () => {
  it('reads the text items alone, and drops a NUL: Postgres holds none in text', () => {
    expect(pageOf([{ str: 'Pic\u0000nic', hasEOL: false }, { type: 'beginMarkedContent' }, { str: ' at noon', hasEOL: true }, { str: 'co-', hasEOL: true }, { str: 'op\u0000 sale' }])).toEqual({
      text: 'Picnic at noon coop sale',
      extra: 'co-op',
    });
  });
});

describe('isTextJob', () => {
  it('takes a message of kind "text" and nothing else: a check has no kind', () => {
    expect(isTextJob({ kind: 'text', copy: new Uint8Array(1), quotes: [] })).toBe(true);
    for (const not of [{ copy: new Uint8Array(1), original: new Uint8Array(1), quotes: [], image: 'show' }, { kind: 'check' }, null, 'text', undefined]) expect(isTextJob(not)).toBe(false);
  });
});

/**
 * `count` synthetic one-page layouts from a seeded generator (the S2 challenger's): "Call <name part><hyphen>" and
 * "<rest of name> today", in three fonts, on one line or two, with the first part sometimes in two runs and a second
 * column beside it. The made-up name is cut anywhere, with a hyphen, a soft hyphen, nothing or a space.
 */
async function splitLayouts(start: number, count: number): Promise<Uint8Array[]> {
  let seed = start;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = <T>(from: readonly T[]): T => from[Math.floor(rnd() * from.length)] as T;
  const name = 'Avery Quill';
  const out: Uint8Array[] = [];
  for (let t = 0; t < count; t++) {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const fonts = [await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold), await doc.embedFont(StandardFonts.TimesRoman)];
    const font = (n: number) => fonts[n] as (typeof fonts)[number];
    const page = doc.addPage([612, 792]);
    const cut = 1 + Math.floor(rnd() * (name.length - 1));
    const first = `Call ${name.slice(0, cut)}${pick(['-', '\u00ad', '', ' '])}`;
    const second = `${name.slice(cut)} today`;
    const parts: Array<{ s: string; x: number; y: number; f: number }> = [];
    const x0 = pick([72, 320]);
    if (rnd() < 0.5 && first.length > 3) {
      const k = 1 + Math.floor(rnd() * (first.length - 1));
      const [f1, f2] = [Math.floor(rnd() * 3), Math.floor(rnd() * 3)];
      parts.push({ s: first.slice(0, k), x: x0, y: 700, f: f1 });
      parts.push({ s: first.slice(k), x: x0 + font(f1).widthOfTextAtSize(first.slice(0, k), 12) + pick([0, 0, 0.5, 1.5, 3]), y: 700, f: f2 });
    } else parts.push({ s: first, x: x0, y: 700, f: Math.floor(rnd() * 3) });
    const sameLine = rnd() < 0.3;
    const right = parts.reduce((most, part) => Math.max(most, part.x + font(part.f).widthOfTextAtSize(part.s, 12)), 0);
    parts.push({
      s: second,
      x: sameLine ? right + pick([0, 0.5, 1.5, 3, 6]) : x0 + pick([0, 0, 10]),
      y: sameLine ? 700 + pick([0, 0, 2, -2]) : pick([686, 684, 690]),
      f: Math.floor(rnd() * 3),
    });
    if (rnd() < 0.5) {
      const other = x0 === 72 ? 320 : 72;
      parts.push({ s: 'Other column text', x: other, y: 700, f: 0 }, { s: 'ill more column', x: other, y: 686, f: 0 });
    }
    for (const part of rnd() < 0.3 ? [...parts].reverse() : parts) {
      try {
        page.drawText(part.s, { x: part.x, y: part.y, size: 12, font: font(part.f) });
      } catch {
        // A character the standard font cannot encode: the layout goes without that run.
      }
    }
    out.push(await doc.save({ useObjectStreams: false }));
  }
  return out;
}
