// ============================================================================
// REDACT R3a: where the marked passages are on a PDF page, as pure functions.
//
// A page is the list of characters PDFium reports, each with its box. The
// passages are found with the R2a matcher (render.ts: folded, look-alikes,
// whole words) in three readings of the page's text:
//
//   joined     a line break is a space, and a word hyphenated at a line end is
//              one word again ("Wren-" / "hallow" reads "Wrenhallow");
//   kept       the line-end hyphen stays ("Smith-" / "Jones" reads "Smith-Jones");
//   spaced     runs of single letters ("K e s t r e l") rejoined, and matched
//              without word edges, since a spaced run gives none: so
//              "K e s t r e l n o w" is caught, and a run "b e f o r e" loses
//              "b e f o" to a mark "befo" (over-redaction, the safe side). Normal
//              text is only ever matched on word edges ("before" keeps it);
//   collapsed  the spaces between single letters taken out, the rest kept,
//              so a word spaced beside a plain one ("J u n o Blackwood")
//              reads "Juno Blackwood", matched as whole words.
//
// Every character a match covers in any reading is withheld. Then each line's
// withheld characters become a region: exactly their glyphs' extent (the union
// of their loose boxes), one line tall, never widened and never run on into the
// margin (REDACT-LOOK, Ross 11-02: a box's width shows the passage's length,
// which is accepted, because content is never reflowed). PDFium removes every
// glyph whose tight box a region overlaps, so an unmarked neighbour whose ink
// reaches into a region (a kerned A, an italic f) goes too: the region is
// extended over it, until nothing more is reached (the collateral fixpoint), so
// no gap is left unboxed. A neighbour pulled in brings the rest of its word
// (its text object's run of glyphs with no blank between, wordsOf, and the
// glyphs that abut it on its line, however they are drawn), so no word is cut
// at the box's edge. PDFium's reading leaves out a text object drawn again
// at nearly its place (a shadow, a fake bold), so no character stands for it
// (unread): a region is extended over the whole of such an object it meets,
// so all of it is removed and boxed. A passage drawn a word at a time and drawn
// again so (a shadow) is read with the two interleaved ("Quillon Quillon Brask
// Brask"), so a quote matches once, across them: each word left out of the
// match that repeats a withheld word of another object near it is a copy
// (copiesOf), withheld too. After the removal, the boxes drawn are
// exactly the characters that were removed and those objects (boxesFor), and
// a marked character still there is found by stillThere.
//
// textMatches reads a plain string the same ways: the output gate's matcher.
// ============================================================================
import { probeFolded, quoteProbe, quoteSpans } from '../redaction/render.js';

export interface Box {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

/**
 * One character as PDFium reports it. `generated`: PDFium added it (a line break or a space); `box`:
 * its loose box (advance by the font's ascent and descent), null when it has no position; `ink`: its
 * tight box, the one PDFium's removal tests; `fontSize`: the type size it is drawn at, in points.
 */
export interface PageChar {
  text: string;
  generated: boolean;
  hyphen: boolean;
  box: Box | null;
  ink: Box | null;
  fontSize: number;
}

/** An area to remove and box, on a page (0-based), in page space. */
export interface Region extends Box {
  page: number;
  fontSize: number;
}

export type Regions = { ok: true; regions: Region[] } | { ok: false; reason: string };

const isBreak = (c: PageChar): boolean => c.text === '\r' || c.text === '\n';
const HYPHENS = new Set(['-', '\u0002', '­', '‐']);
const SPACED_RUN = /(?<![\p{L}\p{N}\p{M}])[\p{L}\p{N}](?:\s+[\p{L}\p{N}](?![\p{L}\p{N}\p{M}]))+/gu;
/** The space between two single letters. */
const BETWEEN_SINGLES = /(?<=(?<![\p{L}\p{N}\p{M}])[\p{L}\p{N}])\s+(?=[\p{L}\p{N}](?![\p{L}\p{N}\p{M}]))/gu;

/**
 * A hyphen that ends a line: PDFium flags one it recognises (often as U+0002, with no line break
 * after it); a plain or soft hyphen counts when a line break follows.
 */
function lineEndHyphen(chars: readonly PageChar[], i: number): boolean {
  const c = chars[i] as PageChar;
  if (c.hyphen || c.text === '\u0002') return true;
  const next = chars[i + 1];
  return HYPHENS.has(c.text) && next !== undefined && isBreak(next);
}

/** A reading of the page: its text, and for each UTF-16 unit the page characters it stands for. */
interface Reading {
  text: string;
  source: number[][];
}

function emit(reading: Reading, text: string, indices: number[]): void {
  reading.text += text;
  for (let k = 0; k < text.length; k++) reading.source.push(indices);
}

function read(chars: readonly PageChar[], keepHyphen: boolean): Reading {
  const reading: Reading = { text: '', source: [] };
  let joining = false;
  chars.forEach((c, i) => {
    if (isBreak(c)) {
      if (!joining) emit(reading, ' ', []);
      return;
    }
    if (lineEndHyphen(chars, i)) {
      joining = true;
      if (keepHyphen) emit(reading, '-', [i]);
      else if (reading.source.length > 0) reading.source[reading.source.length - 1] = [...(reading.source.at(-1) as number[]), i];
      return;
    }
    joining = false;
    emit(reading, c.text, [i]);
  });
  return reading;
}

/** The letter-spaced runs of a reading, each with its spaces taken out, one per line. */
function spaced(reading: Reading): Reading {
  const out: Reading = { text: '', source: [] };
  for (const run of reading.text.matchAll(SPACED_RUN)) {
    for (let k = 0; k < run[0].length; k++) {
      const unit = run[0][k] as string;
      if (!/\s/u.test(unit)) emit(out, unit, reading.source[run.index + k] as number[]);
    }
    emit(out, '\n', []);
  }
  return out;
}

/** The reading with the spaces between single letters taken out. */
function collapsed(reading: Reading): Reading {
  const out: Reading = { text: '', source: [] };
  let at = 0;
  const keep = (to: number): void => {
    out.text += reading.text.slice(at, to);
    out.source.push(...reading.source.slice(at, to));
  };
  for (const gap of reading.text.matchAll(BETWEEN_SINGLES)) {
    keep(gap.index);
    at = gap.index + gap[0].length;
    // The spaces taken out stand with the letter before them, so a match covers them too.
    out.source[out.source.length - 1] = [...(out.source.at(-1) as number[]), ...reading.source.slice(gap.index, at).flat()];
  }
  keep(reading.text.length);
  return out;
}

/** The page characters any quote covers, in any reading. */
export function matchedChars(chars: readonly PageChar[], quotes: readonly string[]): Set<number> {
  const out = new Set<number>();
  if (quotes.length === 0) return out;
  const joined = read(chars, false);
  const readings: Array<[Reading, boolean]> = [
    [joined, true],
    [read(chars, true), true],
    [spaced(joined), false],
    [collapsed(joined), true],
  ];
  for (const [reading, wholeWords] of readings) {
    for (const [start, end] of quoteSpans(reading.text, quotes, wholeWords)) {
      for (let u = start; u < end; u++) for (const i of reading.source[u] as number[]) out.add(i);
    }
  }
  return out;
}

/** A long text is read in pieces this long, each overlapping the last by enough to hold any quote. */
const PIECE = 65_536;

/**
 * Whether any quote can be read in a plain string, in any of the readings of a page (line breaks
 * are \\n or \\r). Each piece is first probed natively (quoteProbe), and only a piece a quote's
 * probe hits is read character by character: megabytes of decoded streams stay fast.
 */
export function textMatches(text: string, quotes: readonly string[]): boolean {
  if (quotes.length === 0) return false;
  const probes = quotes.map((quote) => [quote, quoteProbe(quote)] as const);
  const overlap = Math.max(1024, 4 * Math.max(...quotes.map((quote) => quote.length)));
  for (let from = 0; from < text.length; from += PIECE - overlap) {
    const piece = text.slice(from, from + PIECE);
    const folded = probeFolded(piece);
    const hot = probes.filter(([, probe]) => probe === null || probe.test(folded)).map(([quote]) => quote);
    if (hot.length > 0) {
      const chars = [...piece].map((ch): PageChar => ({ text: ch, generated: false, hyphen: false, box: null, ink: null, fontSize: 0 }));
      if (matchedChars(chars, hot).size > 0) return true;
    }
    if (from + PIECE >= text.length) break;
  }
  return false;
}

interface Span extends Box {
  line: number;
  fontSize: number;
}

/**
 * Two boxes overlap with positive area, the test PDFium's removal makes (touching is not
 * overlapping), by more than a thousandth of a point each way: PDFium reports loose boxes in single
 * and tight boxes in double precision, so a space that only touches a passage can read as overlapping
 * it by a millionth. What PDFium does remove is measured afterwards and boxed (boxesFor).
 */
const SLIP = 0.001;
const overlap = (a: Box, b: Box): boolean =>
  Math.min(a.right, b.right) - Math.max(a.left, b.left) > SLIP && Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom) > SLIP;
/** Within a hundredth of a point: two readings of the same glyph's place. */
const SAME = 0.01;
const isBlank = (c: PageChar): boolean => /^\s*$/u.test(c.text);

/** How far apart two glyphs' loose boxes may be, in ems of the larger type, for one to continue the other's word. */
const ABUT = 0.1;

/**
 * Whether box b continues box a's word on the page (REDACT-LOOK fix round 3), however each is drawn: on a's line
 * (they share at least half the height of the shorter), beginning where a ends or ending where a begins, within
 * ABUT of an em of type `size` (a glyph's loose box beside a glyph's, or beside an unread object's bounds).
 */
function abutting(a: Box, b: Box, size: number): boolean {
  const near = ABUT * size;
  const shared = Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom);
  const inLine = shared >= Math.min(a.top - a.bottom, b.top - b.bottom) / 2;
  return inLine && (Math.abs(b.left - a.right) <= near || Math.abs(b.right - a.left) <= near);
}

/** Each character's line: a line break starts one, and so does PDFium's line-end hyphen with none after it. */
function linesOf(chars: readonly PageChar[]): number[] {
  const lineOf: number[] = [];
  let line = 0;
  chars.forEach((c, i) => {
    if (isBreak(c) && !(c.text === '\r' && chars[i + 1]?.text === '\n')) line += 1;
    lineOf.push(line);
    if ((c.hyphen || c.text === '\u0002') && !isBreak(chars[i + 1] ?? c)) line += 1;
  });
  return lineOf;
}

/**
 * The regions that box exactly these characters: per line, a span for each run of them with no other
 * character between, spans that overlap or touch merged (without widening). A marked character
 * with no position refuses; any other is boxed at its ink, or skipped when it has neither. An
 * unmarked space is never boxed: it has no ink, and PDFium's reading drops a space left next to
 * another once the word between them is removed, so it can look removed when it is not.
 */
function exactRegions(chars: readonly PageChar[], boxed: ReadonlySet<number>, marked: ReadonlySet<number>, lineOf: readonly number[], page: number): Regions {
  const spans: Span[] = [];
  let last = -1;
  for (const i of [...boxed].sort((a, b) => a - b)) {
    const c = chars[i] as PageChar;
    if (c.generated || isBreak(c) || (isBlank(c) && !marked.has(i))) continue;
    const box = c.box ?? (marked.has(i) ? null : c.ink);
    if (box === null) {
      if (isBlank(c) || !marked.has(i)) continue;
      return { ok: false, reason: `a withheld passage on page ${page + 1} has no position` };
    }
    const current = spans.at(-1);
    let between = false;
    for (let k = last + 1; k < i && !between; k++) {
      const b = chars[k] as PageChar;
      between = !b.generated && !isBreak(b) && !boxed.has(k);
    }
    if (current !== undefined && current.line === lineOf[i] && !between) {
      current.left = Math.min(current.left, box.left);
      current.right = Math.max(current.right, box.right);
      current.bottom = Math.min(current.bottom, box.bottom);
      current.top = Math.max(current.top, box.top);
      current.fontSize = Math.max(current.fontSize, c.fontSize);
    } else spans.push({ ...box, line: lineOf[i] as number, fontSize: c.fontSize });
    last = i;
  }

  const regions: Region[] = [];
  for (const lineNo of new Set(spans.map((s) => s.line))) {
    const onLine = spans.filter((s) => s.line === lineNo).sort((a, b) => a.left - b.left);
    const merged: Span[] = [];
    for (const span of onLine) {
      const prior = merged.at(-1);
      if (prior !== undefined && span.left <= prior.right + SAME) {
        prior.right = Math.max(prior.right, span.right);
        prior.bottom = Math.min(prior.bottom, span.bottom);
        prior.top = Math.max(prior.top, span.top);
        prior.fontSize = Math.max(prior.fontSize, span.fontSize);
      } else merged.push({ ...span });
    }
    for (const { left, right, bottom, top, fontSize } of merged) regions.push({ page, left, right, bottom, top, fontSize });
  }
  return { ok: true, regions };
}

/**
 * The regions with each box merged into the regions it overlaps (they become one region, its type size
 * the largest of theirs), or made a region of its own when it overlaps none: one with no type size, so
 * with no label.
 */
function absorb(regions: readonly Region[], boxes: readonly Box[], page: number): Region[] {
  let out = regions.map((region) => ({ ...region }));
  for (const box of boxes) {
    const into = out.filter((region) => overlap(box, region));
    const all: Box[] = [box, ...into];
    out = [
      ...out.filter((region) => !into.includes(region)),
      {
        page,
        left: Math.min(...all.map((b) => b.left)),
        right: Math.max(...all.map((b) => b.right)),
        bottom: Math.min(...all.map((b) => b.bottom)),
        top: Math.max(...all.map((b) => b.top)),
        fontSize: Math.max(0, ...into.map((region) => region.fontSize)),
      },
    ];
  }
  return out;
}

/**
 * The regions to remove and box for these withheld characters, or why there can be none: exactly
 * their extent per line, extended over every unmarked character PDFium would remove with them (its
 * ink overlaps a region), over the bounds of every text object PDFium does not read (`unreadObjects`,
 * from unread) that overlaps a region, and, given the page's `words` (from wordsOf), over the rest of
 * the word of each character pulled in: its text object's run, and every glyph and unread object that
 * abuts it on its line (REDACT-LOOK fix round 3, challenger F1), until no more is reached.
 */
export function regionsFor(chars: readonly PageChar[], withheld: ReadonlySet<number>, page = 0, unreadObjects: readonly Box[] = [], words?: readonly Word[]): Regions {
  const lineOf = linesOf(chars);
  const wordOf = new Map<number, readonly number[]>();
  for (const word of words ?? []) for (const i of word.chars) wordOf.set(i, word.chars);
  const boxed = new Set(withheld);
  const reached: Box[] = [];
  const regions = (): Regions => {
    const exact = exactRegions(chars, boxed, withheld, lineOf, page);
    return exact.ok ? { ok: true, regions: absorb(exact.regions, reached, page) } : exact;
  };
  let found = regions();
  // Each round boxes at least one more character or object, so as many rounds as there are reach the fixpoint.
  for (let round = 0; round < chars.length + unreadObjects.length && found.ok; round++) {
    const meets = (box: Box): boolean => (found as { regions: Region[] }).regions.some((region) => overlap(box, region));
    // A glyph pulled in brings the rest of its word: its text object's run (words), and, given the page's words,
    // every glyph and unread object that abuts it on its line however it is drawn (a copy drawn a glyph at a time,
    // one of whose glyphs the reading left out), so no copy of a passage is cut at the box's edge.
    const glyphs = chars.flatMap((c, i) => (boxed.has(i) || c.generated || isBlank(c) || c.ink === null || !meets(c.ink) ? [] : [i]));
    const objects = unreadObjects.filter((box) => !reached.includes(box) && meets(box));
    const pulled = new Set<number>();
    const touched: Box[] = [];
    const free = (j: number): boolean => !boxed.has(j) && !pulled.has(j);
    // What abuts a glyph's loose box (`size` its type size) or an unread object's bounds (size 0: the glyph's own).
    const abutters = (box: Box, size: number): void => {
      if (words === undefined) return;
      chars.forEach((d, j) => {
        if (free(j) && !d.generated && !isBlank(d) && d.box !== null && abutting(box, d.box, Math.max(size, d.fontSize))) glyphs.push(j);
      });
      for (const object of unreadObjects) {
        if (size > 0 && !reached.includes(object) && !objects.includes(object) && !touched.includes(object) && abutting(box, object, size)) objects.push(object);
      }
    };
    while (glyphs.length > 0 || objects.length > 0) {
      const i = glyphs.pop();
      if (i === undefined) {
        const object = objects.pop() as Box;
        touched.push(object);
        abutters(object, 0);
      } else if (free(i)) {
        pulled.add(i);
        const c = chars[i] as PageChar;
        glyphs.push(...(wordOf.get(i) ?? []).filter(free));
        if (c.box !== null) abutters(c.box, c.fontSize);
      }
    }
    if (pulled.size === 0 && touched.length === 0) break;
    for (const i of pulled) boxed.add(i);
    reached.push(...touched);
    found = regions();
  }
  return found;
}

/**
 * The boxes to draw once PDFium has removed the text: exactly the marked and the removed characters,
 * per line, with no fixpoint (nothing more is removed), and the text objects PDFium does not read that
 * were removed with them (`unreadObjects`, those the regions reached). A character with no loose box is
 * boxed at its ink, or not at all when it has neither (regionsFor has already refused a marked one).
 */
export function boxesFor(chars: readonly PageChar[], withheld: ReadonlySet<number>, removed: ReadonlySet<number>, page = 0, unreadObjects: readonly Box[] = []): Region[] {
  // With no character treated as marked, exactRegions never refuses.
  const exact = exactRegions(chars, new Set([...withheld, ...removed]), new Set(), linesOf(chars), page) as { ok: true; regions: Region[] };
  return absorb(exact.regions, unreadObjects, page);
}

/** The boxes that overlap a region, by the test the collateral fixpoint makes. */
export function meeting(boxes: readonly Box[], regions: readonly Box[]): Box[] {
  return boxes.filter((box) => regions.some((region) => overlap(box, region)));
}

/** A text object PDFium's page draws: its bounds in page space, and the characters of the reading it draws. */
export interface TextObject {
  bounds: Box;
  chars: readonly number[];
}

/** A word: a run of one text object's characters (`object`, its index) with no blank or generated one between them. */
export interface Word {
  object: number;
  chars: number[];
}

/**
 * The words of the page's text objects (REDACT-LOOK fix round 3, challenger F1): each object's characters split
 * at every blank or generated one, and wherever the reading puts a character of another object between two of them.
 */
export function wordsOf(chars: readonly PageChar[], objects: readonly TextObject[]): Word[] {
  const words: Word[] = [];
  objects.forEach(({ chars: drawn }, object) => {
    let run: number[] = [];
    const end = (): void => {
      if (run.length > 0) words.push({ object, chars: run });
      run = [];
    };
    for (const i of drawn) {
      const c = chars[i] as PageChar;
      if (run.length > 0 && run.at(-1) !== i - 1) end();
      if (c.generated || isBlank(c)) end();
      else run.push(i);
    }
    end();
  });
  return words;
}

/** The extent of these characters: their loose boxes, or their ink where they have none; null when none has either. */
function extentOf(chars: readonly PageChar[], indices: readonly number[]): Box | null {
  const boxes = indices.flatMap((i) => (chars[i] as PageChar).box ?? (chars[i] as PageChar).ink ?? []);
  if (boxes.length === 0) return null;
  return {
    left: Math.min(...boxes.map((b) => b.left)),
    right: Math.max(...boxes.map((b) => b.right)),
    bottom: Math.min(...boxes.map((b) => b.bottom)),
    top: Math.max(...boxes.map((b) => b.top)),
  };
}

/** What is not a letter, digit or mark at either end of a word. */
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}\p{M}]+|[^\p{L}\p{N}\p{M}]+$/gu;

/**
 * The characters of every word that repeats a withheld word of another text object within an em of it
 * (REDACT-LOOK fix round 3, challenger F1): a copy of a passage drawn a word at a time and drawn again so (a
 * shadow), which PDFium reads interleaved with it word by word, so that a quote matches once, across the two,
 * and the words it leaves are in no match. A word repeats a withheld one when the quotes' matcher reads the
 * withheld glyphs' text as all of it (folded; punctuation at either end aside, so "Brask," repeats "Brask" and
 * "12:30" does not repeat "12"); the em is the withheld word's type size. A word with a withheld glyph is never
 * a copy.
 */
export function copiesOf(chars: readonly PageChar[], withheld: ReadonlySet<number>, words: readonly Word[]): number[] {
  const marked = words.flatMap(({ object, chars: run }) => {
    const held = run.filter((i) => withheld.has(i));
    const box = extentOf(chars, held);
    if (box === null) return [];
    const em = Math.max(...held.map((i) => (chars[i] as PageChar).fontSize));
    return [{ object, text: held.map((i) => (chars[i] as PageChar).text).join(''), near: { left: box.left - em, right: box.right + em, bottom: box.bottom - em, top: box.top + em } }];
  });
  const out: number[] = [];
  for (const { object, chars: run } of words) {
    const box = extentOf(chars, run);
    if (box === null || run.some((i) => withheld.has(i))) continue;
    // The word's letters and digits, the punctuation at either end aside, are all a match of the withheld text.
    const core = run.map((i) => (chars[i] as PageChar).text).join('').replace(EDGE_PUNCTUATION, '');
    const repeats = (text: string): boolean => quoteSpans(core, [text]).some(([start, end]) => start === 0 && end === core.length);
    if (marked.some((m) => m.object !== object && overlap(box, m.near) && repeats(m.text))) out.push(...run);
  }
  return out;
}

/**
 * What PDFium's reading leaves out of a page's text objects (REDACT-LOOK fix round 2, challenger F2).
 * PDFium reads a text object drawn again at nearly the place of one before it once (a shadow, a fake bold),
 * and a glyph drawn again at its own place once: what it leaves out is in no reading, so no character
 * stands for it, and no box is measured for it. `objects`: the bounds of each text object the reading has
 * no character of (a generated one aside); `parts`: for one it reads in part, each side of its bounds
 * that the characters it read do not reach, loose boxes and ink together.
 */
export function unread(chars: readonly PageChar[], objects: readonly TextObject[]): { objects: Box[]; parts: Box[] } {
  const out: { objects: Box[]; parts: Box[] } = { objects: [], parts: [] };
  for (const { bounds, chars: drawn } of objects) {
    const boxes = drawn.flatMap((i) => {
      const c = chars[i] as PageChar;
      return c.generated ? [] : [c.box, c.ink].filter((box): box is Box => box !== null);
    });
    if (boxes.length === 0) {
      out.objects.push(bounds);
      continue;
    }
    const { left, right, bottom, top } = bounds;
    const read = {
      left: Math.min(...boxes.map((b) => b.left)),
      right: Math.max(...boxes.map((b) => b.right)),
      bottom: Math.min(...boxes.map((b) => b.bottom)),
      top: Math.max(...boxes.map((b) => b.top)),
    };
    if (read.left > left) out.parts.push({ left, right: read.left, bottom, top });
    if (right > read.right) out.parts.push({ left: read.right, right, bottom, top });
    if (read.bottom > bottom) out.parts.push({ left, right, bottom, top: read.bottom });
    if (top > read.top) out.parts.push({ left, right, bottom: read.top, top });
  }
  return out;
}

/**
 * The characters of `before` still on the page in `after`: the same text with a loose box within a
 * hundredth of a point, each character of `after` standing for one of `before`. Generated
 * characters and ones with no position are never counted.
 */
export function stillThere(before: readonly PageChar[], after: readonly PageChar[]): Set<number> {
  const left = new Map<string, Box[]>();
  for (const c of after) {
    if (c.generated || c.box === null) continue;
    left.set(c.text, [...(left.get(c.text) ?? []), c.box]);
  }
  const there = new Set<number>();
  before.forEach((c, i) => {
    if (c.generated || c.box === null) return;
    const box = c.box;
    const same = left.get(c.text) ?? [];
    const k = same.findIndex((b) => Math.abs(b.left - box.left) <= SAME && Math.abs(b.right - box.right) <= SAME && Math.abs(b.bottom - box.bottom) <= SAME && Math.abs(b.top - box.top) <= SAME);
    if (k < 0) return;
    same.splice(k, 1);
    there.add(i);
  });
  return there;
}
