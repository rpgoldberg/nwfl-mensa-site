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
// (copiesOf), withheld too, a possessive after it ("Marsh's") included. Only a
// neighbour on a passage's line, or one whose word may be a copy of a withheld
// word, brings the rest of its word: a descender of the line above keeps its own
// glyph's box (REDACT-LOOK fix round 4, challenger F3). After the removal, the
// boxes drawn are exactly the characters that were removed and those objects
// (boxesFor), and a marked character still there is found by stillThere. Then the
// page fails closed on a second drawing of withheld text the boxes do not tie to
// the passage (fix round 4, challenger F1): a glyph drawn alone left within an em
// of a box on its line band (loneGlyphs; punctuation, a bullet or a line's next run
// aside, unless it is a letter or digit of the passage or a glyph drawn alone is
// beside it), or a withheld word drawn again where no box reached (drawnAgain): a
// word of 3 letters or more beside a box on its line or within an em of a withheld
// drawing of it, and anywhere on the page a passage of two words or more, 4 digits
// or more, or an email or web address (fix round 5, challenger S1).
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

/**
 * The box around these boxes, taken one at a time with Math.min and Math.max (NaN as a spread of them gives it), or
 * null for none. Never spread a page's boxes into one call (fix round 3, N5): V8 throws RangeError past about 125,000
 * arguments, and a page can hold millions.
 */
export function hull(boxes: Iterable<Box>): Box | null {
  let out: Box | null = null;
  for (const box of boxes) {
    if (out === null) out = { left: box.left, right: box.right, bottom: box.bottom, top: box.top };
    else {
      out.left = Math.min(out.left, box.left);
      out.right = Math.max(out.right, box.right);
      out.bottom = Math.min(out.bottom, box.bottom);
      out.top = Math.max(out.top, box.top);
    }
  }
  return out;
}

/** Push each item onto `out`, one at a time: a spread of them into push throws past about 125,000 (hull, N5). */
export function append<T>(out: T[], items: Iterable<T>): void {
  for (const item of items) out.push(item);
}

/** The largest of these numbers and `floor`, one at a time (hull, N5). */
function largest(values: Iterable<number>, floor = -Infinity): number {
  let out = floor;
  for (const value of values) out = Math.max(out, value);
  return out;
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
    append(out.source, reading.source.slice(at, to));
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
  return inLine(a, b) && (Math.abs(b.left - a.right) <= near || Math.abs(b.right - a.left) <= near);
}

/** Whether two boxes are on one line: they share at least half the height of the shorter. */
function inLine(a: Box, b: Box): boolean {
  return Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom) >= Math.min(a.top - a.bottom, b.top - b.bottom) / 2;
}

/** A word's letters and digits, with what is not one at either end taken out. */
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}\p{M}]+|[^\p{L}\p{N}\p{M}]+$/gu;
/** A run of letters (with their marks) or of digits. */
const WORD = /[\p{L}\p{M}]+|\p{N}+/gu;
const textAt = (chars: readonly PageChar[], indices: readonly number[]): string => indices.map((i) => (chars[i] as PageChar).text).join('');

/** The bands of the passage's lines: per line, from the lowest to the highest of its withheld glyphs' boxes. */
function passageBands(chars: readonly PageChar[], withheld: ReadonlySet<number>, lineOf: readonly number[]): Box[] {
  const bands = new Map<number, Box>();
  for (const i of withheld) {
    const c = chars[i] as PageChar;
    const box = c.box ?? c.ink;
    if (c.generated || isBlank(c) || box === null) continue;
    const band = bands.get(lineOf[i] as number);
    bands.set(lineOf[i] as number, band === undefined ? { ...box } : { left: Math.min(band.left, box.left), right: Math.max(band.right, box.right), bottom: Math.min(band.bottom, box.bottom), top: Math.max(band.top, box.top) });
  }
  return [...bands.values()];
}

/** An unmarked glyph with ink whose loose box is on none of the passage's lines. */
const offLine = (c: PageChar, marked: boolean, bands: readonly Box[]): boolean => !marked && c.ink !== null && c.box !== null && !bands.some((band) => inLine(c.box as Box, band));

/** The withheld characters' words of two letters or digits or more, folded. */
function heldWords(chars: readonly PageChar[], withheld: ReadonlySet<number>): string[] {
  let text = '';
  let last = -2;
  for (const i of [...withheld].sort((a, b) => a - b)) {
    text += `${i === last + 1 ? '' : ' '}${(chars[i] as PageChar).text}`;
    last = i;
  }
  return (text.match(WORD) ?? []).map(probeFolded).filter((word) => word.length >= 2);
}

/** A word's glyph advances, each as a share of the whole; empty when any glyph has no loose box. */
function shapeOf(chars: readonly PageChar[], word: readonly number[]): number[] {
  const widths = word.map((i) => (chars[i] as PageChar).box).map((box) => (box === null ? NaN : box.right - box.left));
  const whole = widths.reduce((sum, width) => sum + width, 0);
  return widths.length >= 2 && Number.isFinite(whole) && whole > 0 ? widths.map((width) => width / whole) : [];
}

/** The shapes of the withheld part of each word, of two glyphs or more. */
function heldShapes(chars: readonly PageChar[], withheld: ReadonlySet<number>, words: readonly Word[]): number[][] {
  return words.map(({ chars: run }) => shapeOf(chars, run.filter((i) => withheld.has(i)))).filter((shape) => shape.length > 0);
}

/** How far each glyph's share of its word may differ for two words to have one shape. */
const SHAPE = 0.02;
const sameShape = (a: readonly number[], b: readonly number[]): boolean => a.length > 0 && a.length === b.length && a.every((share, k) => Math.abs(share - (b[k] as number)) <= SHAPE);

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
 * another once the word between them is removed, so it can look removed when it is not. An unmarked
 * glyph off the passage's lines (`bands`, a descender of the line above) is boxed at its advance by its
 * ink's height, so its box ends where its ink does and never reaches the next line (fix round 4, F3).
 */
function exactRegions(chars: readonly PageChar[], boxed: ReadonlySet<number>, marked: ReadonlySet<number>, lineOf: readonly number[], page: number, bands: readonly Box[]): Regions {
  const spans: Span[] = [];
  let last = -1;
  for (const i of [...boxed].sort((a, b) => a - b)) {
    const c = chars[i] as PageChar;
    if (c.generated || isBreak(c) || (isBlank(c) && !marked.has(i))) continue;
    const loose = c.box ?? (marked.has(i) ? null : c.ink);
    if (loose === null) {
      if (isBlank(c) || !marked.has(i)) continue;
      return { ok: false, reason: `a withheld passage on page ${page + 1} has no position` };
    }
    const box = offLine(c, marked.has(i), bands) ? { left: loose.left, right: loose.right, bottom: (c.ink as Box).bottom, top: (c.ink as Box).top } : loose;
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
    const into = new Set(out.filter((region) => overlap(box, region)));
    out = [...out.filter((region) => !into.has(region)), { page, ...(hull([box, ...into]) as Box), fontSize: largest([...into].map((region) => region.fontSize), 0) }];
  }
  return out;
}

/**
 * The regions to remove and box for these withheld characters, or why there can be none: exactly
 * their extent per line, extended over every unmarked character PDFium would remove with them (its
 * ink overlaps a region), over the bounds of every text object PDFium does not read (`unreadObjects`,
 * from unread) that overlaps a region, and, given the page's `words` (from wordsOf), over the rest of
 * the word of each character pulled in: its text object's run, and every glyph and unread object that
 * abuts it on its line (REDACT-LOOK fix round 3, challenger F1), until no more is reached. A character pulled in
 * from another line brings its word only when that word may be a copy of a withheld one: it holds a withheld word
 * or is part of one, or its glyphs are as many as a withheld word's, in the same proportions (a copy in a font that
 * lies about its text); any other is boxed alone (fix round 4, challenger F3).
 */
export function regionsFor(chars: readonly PageChar[], withheld: ReadonlySet<number>, page = 0, unreadObjects: readonly Box[] = [], words?: readonly Word[]): Regions {
  const lineOf = linesOf(chars);
  const wordOf = new Map<number, readonly number[]>();
  for (const word of words ?? []) for (const i of word.chars) wordOf.set(i, word.chars);
  // A glyph pulled in brings its word only from a passage's line, or when its word may be a copy of a withheld word
  // (holds one, or is part of one): a descender of the line above is boxed alone (fix round 4, challenger F3).
  const bands = passageBands(chars, withheld, lineOf);
  const held = heldWords(chars, withheld);
  const shapes = heldShapes(chars, withheld, words ?? []);
  const bringsWord = (i: number): boolean => {
    // A glyph pulled in has ink (meetingGlyphs), so it has a box to place it by.
    const c = chars[i] as PageChar;
    if (bands.some((band) => inLine((c.box ?? c.ink) as Box, band))) return true;
    const word = wordOf.get(i) ?? [i];
    const core = probeFolded(textAt(chars, word).replace(EDGE_PUNCTUATION, ''));
    return (core !== '' && held.some((text) => core.includes(text) || text.includes(core))) || shapes.some((shape) => sameShape(shapeOf(chars, word), shape));
  };
  const boxed = new Set(withheld);
  const reached: Box[] = [];
  const regions = (): Regions => {
    const exact = exactRegions(chars, boxed, withheld, lineOf, page, bands);
    return exact.ok ? { ok: true, regions: absorb(exact.regions, reached, page) } : exact;
  };
  let found = regions();
  // Each round boxes at least one more character or object, so as many rounds as there are reach the fixpoint.
  for (let round = 0; round < chars.length + unreadObjects.length && found.ok; round++) {
    const meets = (box: Box): boolean => (found as { regions: Region[] }).regions.some((region) => overlap(box, region));
    // A glyph pulled in brings the rest of its word: its text object's run (words), and, given the page's words,
    // every glyph and unread object that abuts it on its line however it is drawn (a copy drawn a glyph at a time,
    // one of whose glyphs the reading left out), so no copy of a passage is cut at the box's edge.
    const meetingGlyphs = chars.flatMap((c, i) => (boxed.has(i) || c.generated || isBlank(c) || c.ink === null || !meets(c.ink) ? [] : [i]));
    const glyphs = meetingGlyphs.filter(bringsWord);
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
    for (const i of meetingGlyphs) if (free(i)) pulled.add(i);
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
  // With no character treated as marked, exactRegions never refuses; the withheld ones still set the passage's lines.
  const lineOf = linesOf(chars);
  const exact = exactRegions(chars, new Set([...withheld, ...removed]), new Set(), lineOf, page, passageBands(chars, withheld, lineOf)) as { ok: true; regions: Region[] };
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
  return hull(indices.flatMap((i) => (chars[i] as PageChar).box ?? (chars[i] as PageChar).ink ?? []));
}

/**
 * Each word's withheld glyphs: their text object, their text, and their reach, an em of their type (the largest)
 * around their extent, within which a copy of them is looked for (copiesOf, drawnAgain).
 */
function heldDrawings(chars: readonly PageChar[], withheld: ReadonlySet<number>, words: readonly Word[]): Array<{ object: number; text: string; near: Box }> {
  return words.flatMap(({ object, chars: run }) => {
    const held = run.filter((i) => withheld.has(i));
    const box = extentOf(chars, held);
    if (box === null) return [];
    const em = largest(held.map((i) => (chars[i] as PageChar).fontSize));
    return [{ object, text: textAt(chars, held), near: { left: box.left - em, right: box.right + em, bottom: box.bottom - em, top: box.top + em } }];
  });
}

/** A possessive after a word: 's, or an apostrophe alone. */
const POSSESSIVE = /^['’ʼ]s?$/iu;

/**
 * The characters of every word that repeats a withheld word of another text object within an em of it
 * (REDACT-LOOK fix round 3, challenger F1): a copy of a passage drawn a word at a time and drawn again so (a
 * shadow), which PDFium reads interleaved with it word by word, so that a quote matches once, across the two,
 * and the words it leaves are in no match. A word repeats a withheld one when the quotes' matcher reads the
 * withheld glyphs' text as all of it (folded; punctuation at either end aside, so "Brask," repeats "Brask" and
 * "12:30" does not repeat "12"), or as all of it but a possessive after it ("Brask's", fix round 4, challenger F2);
 * the em is the withheld word's type size. A word with a withheld glyph is never a copy.
 */
export function copiesOf(chars: readonly PageChar[], withheld: ReadonlySet<number>, words: readonly Word[]): number[] {
  const marked = heldDrawings(chars, withheld, words);
  const out: number[] = [];
  for (const { object, chars: run } of words) {
    const box = extentOf(chars, run);
    if (box === null || run.some((i) => withheld.has(i))) continue;
    // The word's letters and digits, the punctuation at either end aside, are all a match of the withheld text, but
    // for a possessive after it.
    const core = textAt(chars, run).replace(EDGE_PUNCTUATION, '');
    const repeats = (text: string): boolean => quoteSpans(core, [text]).some(([start, end]) => start === 0 && (end === core.length || POSSESSIVE.test(core.slice(end))));
    if (marked.some((m) => m.object !== object && overlap(box, m.near) && repeats(m.text))) append(out, run);
  }
  return out;
}

/** The characters of each text object that draws one glyph or none (blanks aside). */
function oneGlyphObjects(chars: readonly PageChar[], objects: readonly TextObject[]): Array<{ glyphs: number[]; chars: readonly number[] }> {
  return objects
    .map(({ chars: drawn }) => ({ glyphs: drawn.filter((i) => !(chars[i] as PageChar).generated && !isBlank(chars[i] as PageChar)), chars: drawn }))
    .filter(({ glyphs }) => glyphs.length <= 1);
}

/** Whether a glyph's ink is within an em of a region (the larger of the two type sizes) and on its line band. */
const beside = (ink: Box, fontSize: number, region: Region): boolean =>
  Math.max(region.left - ink.right, ink.left - region.right, 0) <= Math.max(fontSize, region.fontSize) && Math.min(ink.top, region.top) - Math.max(ink.bottom, region.bottom) > SLIP;

/** A letter or a digit. */
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * The glyphs of text objects that draw one glyph each, still on the page (`left`), within an em of a region (the
 * larger of the two type sizes) with their ink on its line band (REDACT-LOOK fix round 4, challenger F1): a copy of a
 * passage drawn a glyph at a time and letter-spaced unlike it, so that the glyphs that abut the ones a box reached are
 * too far apart to be taken for its word, and are left beside the box. The page is refused. Ordinary text drawn a
 * glyph to an object is not counted (fix round 5, challenger S1): punctuation or a symbol (a list's bullet, the full
 * stop after a link), or the next run of a line, the glyph before it in the reading on its line being one of an object
 * of several. It still counts when it is a letter or digit of a `withheld` glyph, folded, or when a glyph of another
 * one-glyph object is next to it on its line (a copy drawn a glyph at a time, whatever its font says its glyphs are).
 */
export function loneGlyphs(chars: readonly PageChar[], objects: readonly TextObject[], regions: readonly Region[], left: ReadonlySet<number>, withheld: ReadonlySet<number>): number[] {
  const single = new Set(oneGlyphObjects(chars, objects).flatMap((object) => object.chars));
  const held = new Set([...withheld].flatMap((i) => [...probeFolded((chars[i] as PageChar).text)]).filter((ch) => LETTER_OR_DIGIT.test(ch)));
  // The glyph next to glyph i in the reading, before it (step -1) or after it (+1), when that one is on i's line.
  const nextTo = (i: number, step: number, box: Box): number | undefined => {
    for (let j = i + step; j >= 0 && j < chars.length; j += step) {
      const d = chars[j] as PageChar;
      if (!d.generated && !isBlank(d) && d.box !== null) return inLine(d.box, box) ? j : undefined;
    }
    return undefined;
  };
  const ordinary = (i: number): boolean => {
    const c = chars[i] as PageChar;
    if (c.box === null || [...probeFolded(c.text)].some((ch) => held.has(ch))) return false;
    const before = nextTo(i, -1, c.box);
    const after = nextTo(i, 1, c.box);
    if ([before, after].some((j) => j !== undefined && single.has(j))) return false;
    return !LETTER_OR_DIGIT.test(c.text) || before !== undefined;
  };
  const out: number[] = [];
  for (const { glyphs } of oneGlyphObjects(chars, objects)) {
    const i = glyphs[0];
    if (i === undefined || !left.has(i)) continue;
    const c = chars[i] as PageChar;
    const ink = c.ink ?? c.box;
    if (ink === null || ordinary(i)) continue;
    if (regions.some((region) => beside(ink, c.fontSize, region))) out.push(i);
  }
  return out.sort((a, b) => a - b);
}

/** A withheld word long enough to count when drawn again: 3 letters or more, or 4 digits or more. */
const counts = (word: string): boolean => (/^\p{N}/u.test(word) ? word.length >= 4 : [...word].filter((ch) => /\p{L}/u.test(ch)).length >= 3);
/** An email or web address, written as one word. */
const ADDRESS = /@|:\/\/|(?:^|[^\p{L}\p{N}])www\./iu;

/**
 * A quote's withheld words: each of its words of 3 letters or 4 digits or more, but an email or web address whole,
 * as one word (`whole`), since its parts (a name, a domain) are often shown elsewhere and are not the address; and
 * each quote of two words or more with no address in it, whole (`runs`).
 */
function withheldWordsOf(quotes: readonly string[]): { whole: string[]; parts: string[]; runs: string[] } {
  const tokens = quotes.flatMap((quote) => quote.split(/\s+/u)).map((token) => token.replace(EDGE_PUNCTUATION, ''));
  return {
    whole: [...new Set(tokens.filter((token) => ADDRESS.test(token)))],
    parts: [...new Set(tokens.filter((token) => !ADDRESS.test(token)).flatMap((token) => token.match(WORD) ?? []))].filter(counts),
    runs: quotes.filter((quote) => !ADDRESS.test(quote) && (quote.match(WORD) ?? []).length >= 2),
  };
}

/**
 * The characters still on the page (`left`) of each withheld word drawn again (REDACT-LOOK fix round 4, challenger F1).
 * The withheld words are the words of the quotes found on the page, of 3 letters or more or 4 digits or more (an email
 * or web address whole, and no word counted inside one drawn on the page), and each of those quotes of two words or
 * more, whole; each is looked for as the quotes are (folded, look-alikes, as a whole word, so a possessive after it
 * counts) in the page's reading, with the characters PDFium generated between two glyphs of text objects that draw one
 * glyph each taken out, so that a copy drawn a glyph at a time reads as its words. A passage of two words or more, a
 * run of digits or an address found where any glyph of it is left is a second drawing of withheld text that no box ties
 * to the passage, wherever it is on the page. A word of letters is one only where a glyph of it that is left is beside
 * one of the `regions` on its line band (within an em, as loneGlyphs) or within an em of a `withheld` drawing of that
 * word (copiesOf's reach): a shadow's word the boxes stopped short of. The same word elsewhere on the page ("Thanks,
 * Quillon," where "Quillon Brask" is withheld, a "Street" or a "Drive" of another address) is ordinary text (fix round
 * 5, challenger S1). Any found refuses the page.
 */
export function drawnAgain(chars: readonly PageChar[], objects: readonly TextObject[], quotes: readonly string[], left: ReadonlySet<number>, withheld: ReadonlySet<number>, regions: readonly Region[]): number[] {
  const { whole, parts, runs } = withheldWordsOf(quotes.filter((quote) => matchedChars(chars, [quote]).size > 0));
  if (whole.length + parts.length + runs.length === 0) return [];
  const single = new Set(oneGlyphObjects(chars, objects).flatMap((object) => object.chars));
  const drawn = (c: PageChar): boolean => !c.generated && !isBreak(c);
  // For each character, the last drawn one before it and the first after it (-1 for none).
  const prior: number[] = [];
  let last = -1;
  chars.forEach((c, i) => {
    prior.push(last);
    if (drawn(c)) last = i;
  });
  const following: number[] = new Array<number>(chars.length);
  let next = -1;
  for (let i = chars.length - 1; i >= 0; i--) {
    following[i] = next;
    if (drawn(chars[i] as PageChar)) next = i;
  }
  const reading: Reading = { text: '', source: [] };
  chars.forEach((c, i) => {
    if (drawn(c)) emit(reading, c.text, [i]);
    else if (!single.has(prior[i] as number) || !single.has(following[i] as number)) emit(reading, ' ', []);
  });
  // A withheld word inside an email or web address drawn on the page is a part of that address, not the word.
  const inAddress = ([start, end]: [number, number]): boolean => {
    const before = reading.text.slice(0, start);
    const after = reading.text.slice(end);
    return ADDRESS.test(`${before.slice(before.search(/\S*$/u))}${reading.text.slice(start, end)}${after.slice(0, after.search(/\s|$/u))}`);
  };
  const drawings = heldDrawings(chars, withheld, wordsOf(chars, objects));
  // A glyph of a word drawn again that ties it to the passage: beside a box on its line, or near a withheld drawing of the word.
  const near = (i: number, word: string): boolean => {
    const c = chars[i] as PageChar;
    const box = c.box ?? c.ink;
    return box !== null && (regions.some((region) => beside(c.ink ?? box, c.fontSize, region)) || drawings.some((d) => overlap(box, d.near) && quoteSpans(d.text, [word]).length > 0));
  };
  const glyphsOf = ([start, end]: [number, number]): number[] => reading.source.slice(start, end).flat();
  const spans = [
    ...quoteSpans(reading.text, [...whole, ...runs]),
    ...parts.flatMap((word) => quoteSpans(reading.text, [word]).filter((span) => !inAddress(span) && (/^\p{N}/u.test(word) || glyphsOf(span).some((i) => left.has(i) && near(i, word))))),
  ];
  const out = new Set<number>();
  for (const [start, end] of spans) {
    for (let u = start; u < end; u++) for (const i of reading.source[u] as number[]) if (left.has(i)) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
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
    const read = hull(boxes) as Box;
    if (read.left > left) out.parts.push({ left, right: read.left, bottom, top });
    if (right > read.right) out.parts.push({ left: read.right, right, bottom, top });
    if (read.bottom > bottom) out.parts.push({ left, right, bottom, top: read.bottom });
    if (top > read.top) out.parts.push({ left, right, bottom: read.top, top });
  }
  return out;
}

/**
 * Of the parts `unread` finds once the text is removed, those that are more than the place the removal vacated:
 * PDFium keeps a text object's bounds over the glyphs removed from its end, which the reading after no longer holds.
 * A part is only that place when it lies within the loose box of a glyph of `before` that is gone (not in `there`),
 * neither withheld nor on a passage's line, and is clear of every passage's line band (challenger r5, the para
 * family); or when it lies within the extent of a run of characters gone from one line, one after the other in the
 * reading (generated ones aside), a withheld one among them: the passage and the spaces beside it at the end of its
 * line's own object (fix round 5, challenger S1). Any other part is kept, and refuses.
 */
export function notVacated(before: readonly PageChar[], withheld: ReadonlySet<number>, there: ReadonlySet<number>, parts: readonly Box[]): Box[] {
  const lineOf = linesOf(before);
  const bands = passageBands(before, withheld, lineOf);
  const places = before.flatMap((c, i) => (!c.generated && !there.has(i) && offLine(c, withheld.has(i), bands) ? [c.box as Box] : []));
  const vacated: Box[] = [];
  let run: number[] = [];
  const close = (): void => {
    if (run.some((i) => withheld.has(i))) vacated.push(extentOf(before, run) as Box);
    run = [];
  };
  before.forEach((c, i) => {
    if (c.generated) return;
    const gone = !there.has(i) && c.box !== null;
    if (!gone || (run.length > 0 && lineOf[run[0] as number] !== lineOf[i])) close();
    if (gone) run.push(i);
  });
  close();
  const within = (part: Box, place: Box): boolean => part.left >= place.left - SLIP && part.right <= place.right + SLIP && part.bottom >= place.bottom - SLIP && part.top <= place.top + SLIP;
  return parts.filter((part) => !vacated.some((place) => within(part, place)) && (bands.some((band) => overlap(part, band)) || !places.some((place) => within(part, place))));
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
