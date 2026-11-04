// REDACT R3a: finding marked passages in a PDF page's text and turning them
// into the regions that are removed and boxed. Pure: a page is a list of
// characters as PDFium reports them (text, generated or not, a line-end
// hyphen or not, a box). Every name here is made up.
import { describe, expect, it } from 'vitest';
import { type Box, type PageChar, type Region, type TextObject, boxesFor, copiesOf, matchedChars, meeting, regionsFor, stillThere, textMatches, unread, wordsOf } from './match.js';
import { LABEL_EMS, MIN_LABEL_PT, labelSize } from './pdfium.js';

const SIZE = 12;
const ADVANCE = 6;

/** A page laid out one line per string, 6 pt per character, 12 pt type; PDFium's generated CR LF between lines. */
function page(lines: readonly string[], options: { x?: number; generatedSpaces?: boolean } = {}): PageChar[] {
  const out: PageChar[] = [];
  lines.forEach((line, row) => {
    if (row > 0) {
      out.push({ text: '\r', generated: true, hyphen: false, box: null, ink: null, fontSize: 0 });
      out.push({ text: '\n', generated: true, hyphen: false, box: null, ink: null, fontSize: 0 });
    }
    const bottom = 700 - row * 20;
    [...line].forEach((ch, col) => {
      const left = (options.x ?? 72) + col * ADVANCE;
      const hyphen = ch === '\u0002';
      out.push({
        text: ch,
        generated: false,
        hyphen,
        box: { left, right: left + ADVANCE, bottom, top: bottom + SIZE },
        // The glyph's own ink sits inside its advance, as most do: half a point in from each side.
        ink: { left: left + 0.5, right: left + ADVANCE - 0.5, bottom: bottom + 1, top: bottom + SIZE - 2 },
        fontSize: SIZE,
      });
    });
  });
  return out;
}

const textOf = (chars: readonly PageChar[], indices: ReadonlySet<number>): string =>
  [...indices]
    .sort((a, b) => a - b)
    .map((i) => (chars[i] as PageChar).text)
    .join('');

describe('matchedChars', () => {
  it('finds a passage as whole words, folded, on one line', () => {
    const chars = page(['Call QUILLON  brask today.']);
    expect(textOf(chars, matchedChars(chars, ['Quillon Brask']))).toBe('QUILLON  brask');
  });

  it('does not match inside a longer word', () => {
    const chars = page(['Annual meeting, Ann.']);
    expect(textOf(chars, matchedChars(chars, ['Ann']))).toBe('Ann');
  });

  it('finds a passage split across two lines', () => {
    const chars = page(['ask Marvel', 'Ostrander at the door']);
    expect(textOf(chars, matchedChars(chars, ['Marvel Ostrander']))).toBe('MarvelOstrander');
  });

  it('finds a word hyphenated at a line end, with PDFium\'s soft-hyphen marker', () => {
    const chars = page(['Tobias Wren\u0002', 'field hosted it']);
    expect(textOf(chars, matchedChars(chars, ['Wrenfield']))).toBe('Wren\u0002field');
  });

  it('finds a word hyphenated at a line end when PDFium reports no line break after the hyphen', () => {
    const chars = page(['Tobias Wren\u0002', 'hallow hosted it']).filter((c) => !c.generated);
    expect(textOf(chars, matchedChars(chars, ['Wrenhallow']))).toBe('Wren\u0002hallow');
  });

  it('finds a word hyphenated at a line end with a plain hyphen', () => {
    const chars = page(['Tobias Wren-', 'field hosted it']);
    expect(textOf(chars, matchedChars(chars, ['Wrenfield']))).toBe('Wren-field');
  });

  it('keeps a real hyphenated compound that breaks at the hyphen', () => {
    const chars = page(['Ada Smith-', 'Jones came']);
    expect(textOf(chars, matchedChars(chars, ['Smith-Jones']))).toBe('Smith-Jones');
  });

  it('finds a ligature that PDFium reports as two characters', () => {
    const chars = page(['the Snowfield farm']);
    expect(textOf(chars, matchedChars(chars, ['Snowfield']))).toBe('Snowfield');
  });

  it('finds a compatibility ligature character', () => {
    const chars = page(['the Snowﬁeld farm']);
    expect(textOf(chars, matchedChars(chars, ['Snowfield']))).toBe('Snowﬁeld');
  });

  it('finds look-alike letters', () => {
    const chars = page(['Call Quiаlon now']);
    expect(textOf(chars, matchedChars(chars, ['Quialon']))).toBe('Quiаlon');
  });

  it('finds letter-spaced text, even run on into the next spaced word', () => {
    const chars = page(['Phone K e s t r e l n o w please']);
    expect(textOf(chars, matchedChars(chars, ['Kestrel']))).toBe('Kestrel');
  });

  it('matches normal text on word edges only, but a letter-spaced run without them (over-redaction is the safe side)', () => {
    const plain = page(['Come before noon']);
    expect(matchedChars(plain, ['befo']).size).toBe(0);
    const alone = page(['Ask B e f o today']);
    expect(textOf(alone, matchedChars(alone, ['befo'])).replaceAll(' ', '')).toBe('Befo');
    // A spaced run gives no word edge: "b e f o r e" loses "b e f o". Accepted.
    const run = page(['Come b e f o r e noon']);
    expect(textOf(run, matchedChars(run, ['befo']))).toBe('befo');
  });

  it('finds letter-spaced text across PDFium generated spaces', () => {
    const chars = page(['Phone K e s t r e l.']).map((c) => (c.text === ' ' ? { ...c, generated: true, box: null, ink: null } : c));
    expect(textOf(chars, matchedChars(chars, ['Kestrel'])).replaceAll(' ', '')).toBe('Kestrel');
  });

  it('leaves ordinary words alone in the letter-spaced pass', () => {
    const chars = page(['Annual plan next']);
    expect(matchedChars(chars, ['Ann', 'plann']).size).toBe(0);
  });

  it('matches nothing without quotes', () => {
    expect(matchedChars(page(['anything']), []).size).toBe(0);
  });

  it('finds a name whose first word alone is letter-spaced', () => {
    const chars = page(['Phone J u n o Blackwood now.']);
    expect(textOf(chars, matchedChars(chars, ['Juno Blackwood']))).toBe('J u n o Blackwood');
  });
});

describe('textMatches (a plain string, as the output gate reads it)', () => {
  it('finds a passage as whole words, folded, across a line break and a line-end hyphen', () => {
    expect(textMatches('call KESTREL\nWren-\nhallow now', ['Kestrel Wrenhallow'])).toBe(true);
    expect(textMatches('Smith-\r\nJones', ['Smith-Jones'])).toBe(true);
  });

  it('finds letter-spaced and mixed-spaced passages', () => {
    expect(textMatches('x K e s t r e l y', ['Kestrel'])).toBe(true);
    expect(textMatches('Phone K e s t r e l n o w please', ['Kestrel'])).toBe(true);
    expect(textMatches('Phone J u n o Blackwood now.', ['Juno Blackwood'])).toBe(true);
  });

  it('does not match inside a longer word, or without quotes', () => {
    expect(textMatches('Ann Leek', ['Ann Lee'])).toBe(false);
    expect(textMatches('come before noon', ['befo'])).toBe(false);
    expect(textMatches('ask B e f o today', ['befo'])).toBe(true);
    // The gate keeps the no-edge check on a rejoined run: over-redaction, never a leak.
    expect(textMatches('come b e f o r e noon', ['befo'])).toBe(true);
    expect(textMatches('anything', [])).toBe(false);
  });

  it('finds a passage across the seam of a long text read in pieces', () => {
    const long = `${'x'.repeat(70_000)} Kestrel ${'y'.repeat(70_000)}`;
    expect(textMatches(long, ['Kestrel'])).toBe(true);
    const seam = `${'x '.repeat(32_766)}Kestrel Wrenhallow`;
    expect(textMatches(seam, ['Kestrel Wrenhallow'])).toBe(true);
  });
});

/** The regions' edges, rounded to a thousandth of a point. */
const edges = (result: ReturnType<typeof regionsFor> | Region[]): number[][] => {
  if (!Array.isArray(result) && !result.ok) throw new Error(result.reason);
  return (Array.isArray(result) ? result : result.regions).map((r) => [r.left, r.right, r.bottom, r.top].map((v) => Number(v.toFixed(3))));
};

/** The page with one character's loose box or ink changed. */
const withChar = (chars: PageChar[], index: number, change: { box?: Partial<Box> | null; ink?: Partial<Box> | null }): PageChar[] =>
  chars.map((c, i) => {
    if (i !== index) return c;
    const box = change.box === null ? null : change.box === undefined ? c.box : { ...(c.box as Box), ...change.box };
    const ink = change.ink === null ? null : change.ink === undefined ? c.ink : { ...(c.ink as Box), ...change.ink };
    return { ...c, box, ink };
  });

describe('regionsFor: exact fit (REDACT-LOOK, Ross 11-02)', () => {
  it('boxes a passage at exactly its marked glyphs\' extent, one line tall', () => {
    const chars = page(['Call Bo today, and the rest of a long line of text']);
    expect(regionsFor(chars, matchedChars(chars, ['Bo']))).toEqual({
      ok: true,
      regions: [{ page: 0, left: 72 + 5 * ADVANCE, right: 72 + 7 * ADVANCE, bottom: 700, top: 712, fontSize: SIZE }],
    });
  });

  it('gives two passages of different lengths boxes of their own widths', () => {
    const chars = page(['x Bo y and some filler words here', 'x Quillon y and some filler words here']);
    const result = regionsFor(chars, matchedChars(chars, ['Bo', 'Quillon']));
    expect(edges(result).map(([left, right]) => (right as number) - (left as number))).toEqual([2 * ADVANCE, 7 * ADVANCE]);
  });

  it('does not widen a long passage', () => {
    const chars = page(['x Bartholomew y then a much longer tail of filler text']);
    expect(edges(regionsFor(chars, matchedChars(chars, ['Bartholomew'])))).toEqual([[84, 84 + 11 * ADVANCE, 700, 712]]);
  });

  it('never runs a box that ends its line on into the margin', () => {
    const chars = page(['a long line that ends with Bo']);
    expect(edges(regionsFor(chars, matchedChars(chars, ['Bo'])))).toEqual([[72 + 27 * ADVANCE, 72 + 29 * ADVANCE, 700, 712]]);
  });

  it('gives "Ann Lee" and "Ann Leek" at a line end their own widths', () => {
    const lee = page(['Please phone our club treasurer, Ann Lee']);
    const leek = page(['Please phone our club treasurer, Ann Leek']);
    expect(edges(regionsFor(lee, matchedChars(lee, ['Ann Lee'])))).toEqual([[270, 312, 700, 712]]);
    expect(edges(regionsFor(leek, matchedChars(leek, ['Ann Leek'])))).toEqual([[270, 318, 700, 712]]);
  });

  it('leaves a second column in the same band untouched', () => {
    const left = page(['some words then Ann Lee']);
    const right = page(['other column']).map((c) => ({
      ...c,
      box: c.box && { ...c.box, left: c.box.left + 300, right: c.box.right + 300 },
      ink: c.ink && { ...c.ink, left: c.ink.left + 300, right: c.ink.right + 300 },
    }));
    const chars = [...left, { text: '\n', generated: true, hyphen: false, box: null, ink: null, fontSize: 0 }, ...right];
    expect(edges(regionsFor(chars, matchedChars(chars, ['Ann Lee'])))).toEqual([[168, 210, 700, 712]]);
  });

  it('gives each line of a split passage its own exact box', () => {
    const chars = page(['then you can ask Marvel', 'Ostrander at the door and more filler text']);
    expect(edges(regionsFor(chars, matchedChars(chars, ['Marvel Ostrander'])))).toEqual([
      [174, 210, 700, 712],
      [72, 126, 680, 692],
    ]);
  });

  it('starts a new line after PDFium\'s line-end hyphen, even with no line break reported', () => {
    const chars = page(['then Tobias Wren\u0002', 'hallow hosted it and more filler text']).filter((c) => !c.generated);
    // The hyphen is the first line's last glyph: its box reaches it.
    expect(edges(regionsFor(chars, matchedChars(chars, ['Wrenhallow'])))).toEqual([
      [144, 174, 700, 712],
      [72, 108, 680, 692],
    ]);
  });

  it('gives two passages on one line two boxes, never one over the unmarked word between them (challenger r2, F3)', () => {
    // "Ask Bo Pell and Quill now": "Bo Pell" [96,138], " and " between, "Quill" [168,198].
    const chars = page(['Ask Bo Pell and Quill now']);
    expect(edges(regionsFor(chars, matchedChars(chars, ['Bo Pell', 'Quill'])))).toEqual([
      [96, 138, 700, 712],
      [168, 198, 700, 712],
    ]);
  });

  it('merges passages whose boxes overlap on a line, without widening the merge', () => {
    // "Bo" and "Al" kerned together over a zero-width space: their boxes overlap by 2 pt.
    let chars = page(['Bo Al']);
    chars = withChar(chars, 2, { box: { left: 84, right: 84 }, ink: null });
    chars = withChar(chars, 3, { box: { left: 82, right: 88 }, ink: { left: 82.5, right: 87.5 } });
    chars = withChar(chars, 4, { box: { left: 88, right: 94 }, ink: { left: 88.5, right: 93.5 } });
    expect(edges(regionsFor(chars, new Set([0, 1, 3, 4])))).toEqual([[72, 94, 700, 712]]);
  });

  it('makes the box taller for a risen glyph, never wider', () => {
    const chars = withChar(page(['x Bo y']), 3, { box: { bottom: 703, top: 715 }, ink: { bottom: 704, top: 713 } });
    expect(edges(regionsFor(chars, matchedChars(chars, ['Bo'])))).toEqual([[84, 96, 700, 715]]);
  });

  it('refuses a matched character that has no box', () => {
    const chars = page(['Call Bo now']).map((c, i) => (i === 5 ? { ...c, box: null } : c));
    expect(regionsFor(chars, new Set([5, 6]))).toEqual({ ok: false, reason: 'a withheld passage on page 1 has no position' });
  });

  it('gives no regions for no matches', () => {
    expect(regionsFor(page(['nothing']), new Set())).toEqual({ ok: true, regions: [] });
  });

  it('numbers the page it is given', () => {
    const chars = page(['Bo and more filler words']);
    const result = regionsFor(chars, matchedChars(chars, ['Bo']), 3);
    if (!result.ok) throw new Error(result.reason);
    expect(result.regions[0]?.page).toBe(3);
  });
});

describe('regionsFor: neighbours PDFium removes with the passage (the collateral fixpoint)', () => {
  // "xAVo y": x [72,78], A [78,84], V [84,90], o [90,96]; "Vo" is marked.
  const kerned = (): PageChar[] => page(['xAVo y']);

  it('extends the box over an unmarked neighbour whose ink reaches into it (a kerned A, an italic f)', () => {
    const chars = withChar(kerned(), 1, { ink: { right: 86 } });
    expect(edges(regionsFor(chars, new Set([2, 3])))).toEqual([[78, 96, 700, 712]]);
  });

  it('does not extend over a neighbour whose ink only touches the box', () => {
    const chars = withChar(kerned(), 1, { ink: { right: 84 } });
    expect(edges(regionsFor(chars, new Set([2, 3])))).toEqual([[84, 96, 700, 712]]);
  });

  it('does not extend over a neighbour whose ink reaches in by less than SLIP (0.0005 pt: a precision slip, not ink)', () => {
    const chars = withChar(kerned(), 1, { ink: { right: 84.0005 } });
    expect(edges(regionsFor(chars, new Set([2, 3])))).toEqual([[84, 96, 700, 712]]);
  });

  it('extends over a neighbour whose ink reaches in by more than SLIP (0.002 pt), each way', () => {
    expect(edges(regionsFor(withChar(kerned(), 1, { ink: { right: 84.002 } }), new Set([2, 3])))).toEqual([[78, 96, 700, 712]]);
    // A descender of the line above reaching 0.0005 pt into the line's top is not ink; 0.002 pt is.
    const above = (bottom: number): PageChar[] => withChar(page(['xg', 'Bo y']), 1, { ink: { bottom } });
    expect(edges(regionsFor(above(691.9995), new Set([4, 5])))).toEqual([[72, 84, 680, 692]]);
    expect(edges(regionsFor(above(691.998), new Set([4, 5])))).toEqual([
      [78, 84, 700, 712],
      [72, 84, 680, 692],
    ]);
  });

  it('follows a chain: a neighbour pulled in can pull in the next', () => {
    const chars = withChar(withChar(kerned(), 1, { ink: { right: 86 } }), 0, { ink: { right: 80 } });
    expect(edges(regionsFor(chars, new Set([2, 3])))).toEqual([[72, 96, 700, 712]]);
  });

  it('gives a neighbour on another line its own region (a descender reaching into the line below)', () => {
    // Line 0 "xg": g [78,84] at 700; line 1 "Bo y": B [72,78], o [78,84] at 680..692.
    const chars = withChar(page(['xg', 'Bo y']), 1, { ink: { bottom: 690 } });
    // In reading order: the line above first.
    expect(edges(regionsFor(chars, new Set([4, 5])))).toEqual([
      [78, 84, 700, 712],
      [72, 84, 680, 692],
    ]);
  });

  it('boxes a pulled-in neighbour that has no loose box at its ink', () => {
    const chars = withChar(kerned(), 1, { box: null, ink: { left: 82, right: 86 } });
    expect(edges(regionsFor(chars, new Set([2, 3])))).toEqual([[82, 96, 700, 712]]);
  });

  it('ignores generated characters and ones with no ink', () => {
    const chars = withChar(page(['xA', 'Vo']), 1, { ink: null });
    expect(edges(regionsFor(chars, new Set([4, 5])))).toEqual([[72, 84, 680, 692]]);
  });
});

describe('unread: what PDFium\'s reading leaves out of each text object (challenger r2, F2)', () => {
  // "Bo now": B [72,78], o [78,84], " " [84,90], n [90,96], o [96,102], w [102,108].
  const chars = page(['Bo now']);

  it('gives the bounds of an object the reading has no character of: text drawn twice, read once', () => {
    const shadow = { left: 73, right: 85, bottom: 699, top: 711 };
    expect(unread(chars, [{ bounds: { left: 72, right: 84, bottom: 700, top: 712 }, chars: [0, 1] }, { bounds: shadow, chars: [] }])).toEqual({ objects: [shadow], parts: [] });
  });

  it('counts an object the reading has only generated characters of as unread', () => {
    const generated = [...chars, { text: ' ', generated: true, hyphen: false, box: { left: 108, right: 114, bottom: 700, top: 712 }, ink: null, fontSize: SIZE }];
    const bounds = { left: 108, right: 114, bottom: 700, top: 712 };
    expect(unread(generated, [{ bounds, chars: [6] }])).toEqual({ objects: [bounds], parts: [] });
  });

  it('gives nothing for an object whose bounds its characters cover, loose boxes and ink together', () => {
    // The ink reaches a point below and past the loose boxes: still the characters' own.
    const reaching = withChar(chars, 1, { ink: { right: 85, bottom: 699 } });
    expect(unread(reaching, [{ bounds: { left: 72, right: 85, bottom: 699, top: 712 }, chars: [0, 1] }])).toEqual({ objects: [], parts: [] });
  });

  it('gives each side of an object\'s bounds that its read characters do not reach, for one read in part', () => {
    // An object drawing "XBo now" whose X the reading left out (a glyph drawn again at its own place), and
    // whose bounds reach 2 pt above and below its characters.
    const bounds = { left: 66, right: 108, bottom: 698, top: 714 };
    expect(unread(chars, [{ bounds, chars: [0, 1, 2, 3, 4, 5] }])).toEqual({
      objects: [],
      parts: [
        { left: 66, right: 72, bottom: 698, top: 714 },
        { left: 66, right: 108, bottom: 698, top: 700 },
        { left: 66, right: 108, bottom: 712, top: 714 },
      ],
    });
    expect(unread(chars, [{ bounds: { left: 72, right: 114, bottom: 700, top: 712 }, chars: [0, 1, 2, 3, 4, 5] }]).parts).toEqual([{ left: 108, right: 114, bottom: 700, top: 712 }]);
  });
});

describe('regionsFor: text PDFium does not read, by a passage (challenger r2, F2)', () => {
  // "Ask Bo now": B [96,102], o [102,108]; "Bo" is marked.
  const chars = (): PageChar[] => page(['Ask Bo now']);

  it('extends the box over the bounds of an unread object that overlaps it, so all of that object is removed and boxed', () => {
    const shadow = { left: 99, right: 111, bottom: 702, top: 714 };
    expect(edges(regionsFor(chars(), new Set([4, 5]), 0, [shadow]))).toEqual([[96, 111, 700, 714]]);
  });

  it('leaves an unread object that only touches the box, or lies apart from it, alone', () => {
    const touching = { left: 108, right: 120, bottom: 700, top: 712 };
    const apart = { left: 200, right: 212, bottom: 700, top: 712 };
    expect(edges(regionsFor(chars(), new Set([4, 5]), 0, [touching, apart]))).toEqual([[96, 108, 700, 712]]);
  });

  it('follows a chain: the extended box pulls in a neighbour\'s ink, and that the next unread object', () => {
    // "now": n [114,120], o [120,126] (ink half a point in). The shadow reaches the n's ink; once the n is
    // boxed, a second unread object reaches past it into the o's ink; the o's loose box ends at 126.
    const shadow = { left: 99, right: 116, bottom: 700, top: 712 };
    const second = { left: 119, right: 125, bottom: 700, top: 712 };
    expect(edges(regionsFor(chars(), new Set([4, 5]), 0, [second, shadow]))).toEqual([[96, 126, 700, 712]]);
  });

  it('reaches no unread object when nothing is withheld', () => {
    expect(regionsFor(chars(), new Set(), 0, [{ left: 0, right: 500, bottom: 0, top: 800 }])).toEqual({ ok: true, regions: [] });
  });
});

/** The text objects of a page laid out by page(), one per run of characters given by its first and last index. */
const objectsOf = (runs: ReadonlyArray<readonly [number, number]>): TextObject[] =>
  runs.map(([first, last]) => ({ bounds: { left: 0, right: 0, bottom: 0, top: 0 }, chars: Array.from({ length: last - first + 1 }, (_, k) => first + k) }));

/** The characters moved by (dx, dy), loose boxes and ink together. */
const moved = (chars: readonly PageChar[], dx: number, dy: number): PageChar[] =>
  chars.map((c) => {
    const shift = (b: Box | null): Box | null => b && { left: b.left + dx, right: b.right + dx, bottom: b.bottom + dy, top: b.top + dy };
    return { ...c, box: shift(c.box), ink: shift(c.ink) };
  });

describe('wordsOf: each text object\'s runs of glyphs with no blank between (challenger r3, F1)', () => {
  it('splits each object at its blanks, never joins two objects, and leaves blanks and generated characters out', () => {
    // "Ask Bo now" as "Ask " | "Bo" | " now", and a generated space PDFium added after the last.
    const chars = [...page(['Ask Bo now']), { text: ' ', generated: true, hyphen: false, box: null, ink: null, fontSize: SIZE }];
    expect(wordsOf(chars, objectsOf([[0, 3], [4, 5], [6, 10]]))).toEqual([
      { object: 0, chars: [0, 1, 2] },
      { object: 1, chars: [4, 5] },
      { object: 2, chars: [7, 8, 9] },
    ]);
    // One object drawing it all: a word per run of glyphs.
    expect(wordsOf(chars, objectsOf([[0, 10]])).map((w) => w.chars)).toEqual([
      [0, 1, 2],
      [4, 5],
      [7, 8, 9],
    ]);
  });
});

describe('copiesOf: a withheld word drawn again by another text object near it (challenger r3, F1)', () => {
  // "Ask Bo now" a word per object, "Bo" [96,108] withheld, and a second "Bo" drawn by an object of its own.
  const line = page(['Ask Bo now']);
  const objects = objectsOf([[0, 3], [4, 5], [6, 9], [10, 11]]);
  const withCopy = (copy: string, dx: number, dy: number): PageChar[] => [...line, ...moved(page([copy]), 24 + dx, dy)];
  const copies = (chars: readonly PageChar[], runs = objects): number[] => copiesOf(chars, new Set([4, 5]), wordsOf(chars, runs));

  it('finds a copy over the word, beside it and up to an em from it, each way', () => {
    expect(copies(withCopy('Bo', 6.3, 4))).toEqual([10, 11]);
    // Beside "Bo", 11.9 pt clear of it (the type is 12 pt), on the line and below it.
    expect(copies(withCopy('Bo', 23.9, 0))).toEqual([10, 11]);
    expect(copies(withCopy('Bo', -23.9, 0))).toEqual([10, 11]);
    expect(copies(withCopy('Bo', 0, -23.9))).toEqual([10, 11]);
  });

  it('does not take the same text more than an em away for a copy', () => {
    expect(copies(withCopy('Bo', 24.1, 0))).toEqual([]);
    expect(copies(withCopy('Bo', 0, 24.1))).toEqual([]);
  });

  it('reads the copy as the quotes are read: folded, and as whole words', () => {
    expect(copies(withCopy('BO', 6, 4))).toEqual([10, 11]);
    expect(copies([...line, ...moved(page(['Bo.']), 30, 4)], objectsOf([[0, 3], [4, 5], [6, 9], [10, 12]]))).toEqual([10, 11, 12]);
    expect(copies([...line, ...moved(page(['Bob']), 30, 4)], objectsOf([[0, 3], [4, 5], [6, 9], [10, 12]]))).toEqual([]);
    // A word that only begins with the withheld one is other text (a time beside an address's number).
    expect(copies([...line, ...moved(page(['Bo:3']), 30, 4)], objectsOf([[0, 3], [4, 5], [6, 9], [10, 13]]))).toEqual([]);
    expect(copies([...line, ...moved(page(['(Bo)']), 30, 4)], objectsOf([[0, 3], [4, 5], [6, 9], [10, 13]]))).toEqual([10, 11, 12, 13]);
  });

  it('takes no word of the withheld word\'s own object, and no word that has a withheld glyph, for a copy', () => {
    const chars = withCopy('Bo', 6, 4);
    const own = { bounds: { left: 0, right: 0, bottom: 0, top: 0 }, chars: [4, 5, 10, 11] };
    expect(wordsOf(chars, [own]).map((w) => w.chars)).toEqual([
      [4, 5],
      [10, 11],
    ]);
    expect(copies(chars, [...objectsOf([[0, 3], [6, 9]]), own])).toEqual([]);
    expect(copiesOf(chars, new Set([4, 5, 10]), wordsOf(chars, objects))).toEqual([]);
  });

  it('finds nothing when nothing is withheld, and skips a word with no position', () => {
    expect(copiesOf(withCopy('Bo', 6, 4), new Set(), wordsOf(withCopy('Bo', 6, 4), objects))).toEqual([]);
    const placeless = withCopy('Bo', 6, 4).map((c, i) => (i >= 10 ? { ...c, box: null, ink: null } : c));
    expect(copies(placeless)).toEqual([]);
    // A copy with no loose box is placed by its ink.
    const inked = withCopy('Bo', 6, 4).map((c, i) => (i >= 10 ? { ...c, box: null } : c));
    expect(copies(inked)).toEqual([10, 11]);
    expect(copies(inked.map((c, i) => (i >= 10 ? { ...c, ink: c.ink && { ...c.ink, left: c.ink.left + 30, right: c.ink.right + 30 } } : c)))).toEqual([]);
  });
});

describe('regionsFor: a neighbour pulled in brings the rest of its word (challenger r3, F1)', () => {
  // "xAVo y" as "xA" | "Vo" | " y": "Vo" is marked, A's ink reaches into it.
  const chars = withChar(page(['xAVo y']), 1, { ink: { right: 86 } });
  const words = wordsOf(chars, objectsOf([[0, 1], [2, 3], [4, 5]]));

  it('boxes the whole word of a glyph whose ink reaches into the box, though the rest of it reaches nothing', () => {
    expect(edges(regionsFor(chars, new Set([2, 3]), 0, [], words))).toEqual([[72, 96, 700, 712]]);
    // Without the words, only the glyph itself.
    expect(edges(regionsFor(chars, new Set([2, 3])))).toEqual([[78, 96, 700, 712]]);
  });

  it('stops at a blank and at the object\'s end', () => {
    // "ax A" | "Vo": the A's word is "A" alone.
    const spaced = withChar(page(['ax AVo']), 3, { ink: { right: 98 } });
    expect(edges(regionsFor(spaced, new Set([4, 5]), 0, [], wordsOf(spaced, objectsOf([[0, 3], [4, 5]]))))).toEqual([[90, 108, 700, 712]]);
    // "ax", 2 pt clear of "A" | "Vo" (the type is 12 pt): the A's word is its object's alone, or with "ax" when one
    // object draws all three.
    const joined = withChar(withChar(withChar(page(['axAVo']), 0, { box: { left: 70, right: 76 } }), 1, { box: { left: 76, right: 82 } }), 2, { ink: { right: 92 } });
    expect(edges(regionsFor(joined, new Set([3, 4]), 0, [], wordsOf(joined, objectsOf([[0, 1], [2, 2], [3, 4]]))))).toEqual([[84, 102, 700, 712]]);
    expect(edges(regionsFor(joined, new Set([3, 4]), 0, [], wordsOf(joined, objectsOf([[0, 2], [3, 4]]))))).toEqual([[70, 102, 700, 712]]);
  });

  it('brings the glyphs that abut it on its line, however they are drawn (a copy drawn a glyph at a time), up to a tenth of an em apart', () => {
    // Without the page's words, only the glyph itself: the fixpoint alone.
    expect(edges(regionsFor(chars, new Set([2, 3])))).toEqual([[78, 96, 700, 712]]);
    // "xAVo y" a glyph per object: A pulled in brings the x it abuts.
    const glyphs = wordsOf(chars, objectsOf([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]));
    expect(edges(regionsFor(chars, new Set([2, 3]), 0, [], glyphs))).toEqual([[72, 96, 700, 712]]);
    // The x 1.1 pt clear of the A (the type is 12 pt): still its word; 1.3 pt clear: another.
    const apart = (gap: number): PageChar[] => withChar(chars, 0, { box: { left: 72 - gap, right: 78 - gap }, ink: { left: 72.5 - gap, right: 77.5 - gap } });
    expect(edges(regionsFor(apart(1.1), new Set([2, 3]), 0, [], glyphs))).toEqual([[70.9, 96, 700, 712]]);
    expect(edges(regionsFor(apart(1.3), new Set([2, 3]), 0, [], glyphs))).toEqual([[78, 96, 700, 712]]);
    // An x on another line, or with no loose box, is not the A's word.
    expect(edges(regionsFor(withChar(chars, 0, { box: { bottom: 690, top: 702 } }), new Set([2, 3]), 0, [], glyphs))).toEqual([[78, 96, 700, 712]]);
    expect(edges(regionsFor(withChar(chars, 0, { box: null }), new Set([2, 3]), 0, [], glyphs))).toEqual([[78, 96, 700, 712]]);
    // Nor is a blank, or a glyph after one: "x A" leaves the x.
    const spaced = withChar(page(['x AVo']), 2, { ink: { right: 92 } });
    expect(edges(regionsFor(spaced, new Set([3, 4]), 0, [], wordsOf(spaced, objectsOf([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]))))).toEqual([[84, 102, 700, 712]]);
  });

  it('brings, through a glyph the reading left out (an unread object), the glyphs beyond it, and an unread object a glyph pulled in abuts', () => {
    // "Ask Bo" with "Bo" withheld [96,108], an unread one-glyph object over the o's end, and a z 1 pt past it.
    const z: PageChar = { text: 'z', generated: false, hyphen: false, box: { left: 115.5, right: 121.5, bottom: 700, top: 712 }, ink: { left: 116, right: 121, bottom: 701, top: 710 }, fontSize: SIZE };
    const chars = [...page(['Ask Bo']), z];
    const left = { left: 107, right: 114.5, bottom: 701, top: 710 };
    const words = wordsOf(chars, objectsOf([[0, 3], [4, 5], [6, 6]]));
    expect(edges(regionsFor(chars, new Set([4, 5]), 0, [left], words))).toEqual([[96, 121.5, 700, 712]]);
    expect(edges(regionsFor(chars, new Set([4, 5]), 0, [left]))).toEqual([[96, 114.5, 700, 712]]);
    // "xAVo y" a glyph per object: A pulled in brings x, and x the unread object half a point before it, which
    // meets no region and so is boxed on its own.
    const kerned = withChar(page(['xAVo y']), 1, { ink: { right: 86 } });
    const before = { left: 64, right: 71.5, bottom: 701, top: 710 };
    const glyphs = wordsOf(kerned, objectsOf([[0, 0], [1, 1], [2, 2], [3, 3], [5, 5]]));
    expect(edges(regionsFor(kerned, new Set([2, 3]), 0, [before], glyphs))).toEqual([
      [72, 96, 700, 712],
      [64, 71.5, 701, 710],
    ]);
    expect(edges(regionsFor(kerned, new Set([2, 3]), 0, [before]))).toEqual([[78, 96, 700, 712]]);
  });

  it('follows a chain: the far end of a word pulled in can pull in the next', () => {
    // "pq" | "xA" | "Vo": A pulled in brings x, whose ink reaches q's, which brings p.
    const chain = withChar(withChar(page(['pqxAVo']), 3, { ink: { right: 98 } }), 1, { ink: { right: 85 } });
    expect(edges(regionsFor(chain, new Set([4, 5]), 0, [], wordsOf(chain, objectsOf([[0, 1], [2, 3], [4, 5]]))))).toEqual([[72, 108, 700, 712]]);
  });
});

describe('meeting: which boxes overlap a region', () => {
  it('takes the overlap the fixpoint takes: positive area, more than SLIP each way', () => {
    const region = { left: 100, right: 110, bottom: 700, top: 712 };
    const boxes = [
      { left: 109, right: 120, bottom: 700, top: 712 },
      { left: 110, right: 120, bottom: 700, top: 712 },
      { left: 109.9995, right: 120, bottom: 700, top: 712 },
      { left: 0, right: 10, bottom: 0, top: 10 },
    ];
    expect(meeting(boxes, [region])).toEqual([boxes[0]]);
    expect(meeting(boxes, [])).toEqual([]);
  });
});

describe('boxesFor: the boxes drawn over what PDFium removed', () => {
  it('merges each unread object removed with the passage into the box it overlaps, and boxes one that overlaps none on its own, unlabelled', () => {
    const chars = page(['Ask Bo now']);
    const shadow = { left: 99, right: 111, bottom: 702, top: 714 };
    const apart = { left: 200, right: 212, bottom: 650, top: 662 };
    expect(boxesFor(chars, new Set([4, 5]), new Set([4, 5]), 0, [shadow, apart])).toEqual([
      { page: 0, left: 96, right: 111, bottom: 700, top: 714, fontSize: SIZE },
      { page: 0, ...apart, fontSize: 0 },
    ]);
  });

  it('boxes exactly the marked and the removed characters, with no fixpoint', () => {
    // A's ink reaches into "Vo", but PDFium removed only V and o: A keeps its place, unboxed.
    const chars = withChar(page(['xAVo y']), 1, { ink: { right: 86 } });
    expect(edges(boxesFor(chars, new Set([2, 3]), new Set([2, 3])))).toEqual([[84, 96, 700, 712]]);
    expect(edges(boxesFor(chars, new Set([2, 3]), new Set([1, 2, 3])))).toEqual([[78, 96, 700, 712]]);
  });

  it('skips generated characters and ones with no position, and boxes a removed one on another line', () => {
    const chars = withChar(page(['xg', 'Bo y']), 0, { box: null, ink: null });
    expect(edges(boxesFor(chars, new Set([4, 5]), new Set([0, 1, 2, 3, 4, 5]), 2))).toEqual([
      [78, 84, 700, 712],
      [72, 84, 680, 692],
    ]);
    expect(boxesFor(chars, new Set([4, 5]), new Set([4, 5]), 2)[0]?.page).toBe(2);
  });
});

describe('stillThere: which characters survived a removal', () => {
  it('finds every character of an unchanged page, and no generated one', () => {
    const chars = page(['Bo', 'Al']);
    expect([...stillThere(chars, chars)].sort((a, b) => a - b)).toEqual([0, 1, 4, 5]);
  });

  it('misses the removed ones, whatever order the rest come back in', () => {
    const before = page(['xAVo y']);
    const after = [before[5], before[0], before[4], before[1]] as PageChar[];
    expect([...stillThere(before, after)].sort((a, b) => a - b)).toEqual([0, 1, 4, 5]);
  });

  it('matches a character within a hundredth of a point, and not further', () => {
    const before = page(['Bo']);
    const near = withChar(before, 0, { box: { left: 72.005, right: 78.005 } });
    const far = withChar(before, 0, { box: { left: 72.05, right: 78.05 } });
    expect([...stillThere(before, near)].sort()).toEqual([0, 1]);
    expect([...stillThere(before, far)]).toEqual([1]);
    expect([...stillThere(before, withChar(before, 0, { box: null }))]).toEqual([1]);
  });

  it('counts a character drawn twice in the same place once per copy left', () => {
    const one = page(['B']);
    const twice = [...one, ...one];
    expect([...stillThere(twice, one)]).toEqual([0]);
    expect([...stillThere(twice, twice)]).toEqual([0, 1]);
  });

  it('never matches a character of other text at the same place', () => {
    const before = page(['B']);
    expect([...stillThere(before, [{ ...(before[0] as PageChar), text: 'b' }])]).toEqual([]);
  });
});

describe('labelSize: "withheld" only where it fits at a readable size', () => {
  const region = (width: number, height = 14.028, fontSize = 12) => ({ page: 0, left: 100, right: 100 + width, bottom: 700, top: 700 + height, fontSize });

  it('is 7 pt at the smallest', () => {
    expect(MIN_LABEL_PT).toBe(7);
  });

  it('labels "Quillon" at 12 pt at 0.8 of the type size, inside the box with a point to spare each side', () => {
    const size = labelSize(region(37.344));
    expect(size).toBeCloseTo(9.6, 6);
    expect(LABEL_EMS * (size as number) + 2).toBeLessThanOrEqual(37.344);
  });

  it('gives "Bo" at 12 pt no label: it would be below the floor', () => {
    expect(labelSize(region(14.676))).toBeNull();
  });

  it('shrinks to fit the width down to the floor (0.6 of the type size here), and no further', () => {
    expect(labelSize(region(32))).toBeCloseTo(30 / LABEL_EMS, 6);
    expect(labelSize(region(2 + 7.21 * LABEL_EMS))).toBeCloseTo(7.21, 6);
    expect(labelSize(region(2 + 7.19 * LABEL_EMS))).toBeNull();
  });

  it('never labels small type, whose label would be under 7 pt', () => {
    expect(labelSize(region(200, 9.4, 8))).toBeNull();
  });

  it('is never more than 0.8 of the box\'s height', () => {
    expect(labelSize(region(200, 10))).toBeCloseTo(8, 6);
  });
});
