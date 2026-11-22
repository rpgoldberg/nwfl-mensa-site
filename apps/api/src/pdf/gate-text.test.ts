// ARCHIVE-SEARCH S2: what the gate's child answers a "text" job (gate-text.ts): the text of a stored
// copy's pages, read with pdf.js as the gate reads it, through the index's one line-end rule
// (search/text.ts). The PDFs are synthetic, made here with pdf-lib; every name is made up.
import { describe, expect, it } from 'vitest';
import { blankPdf, pagesPdf } from '../../test/search/synthetic.js';
import { sha256Hex } from './engine-protocol.js';
import { isTextJob, pageOf, textReply } from './gate-text.js';
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
