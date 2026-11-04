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
// no gap is left unboxed. After the removal, the boxes drawn are exactly the
// characters that were removed (boxesFor), and a marked one still there is
// found by stillThere.
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
 * The regions to remove and box for these withheld characters, or why there can be none: exactly
 * their extent per line, extended over every unmarked character PDFium would remove with them (its
 * ink overlaps a region), until no more is reached.
 */
export function regionsFor(chars: readonly PageChar[], withheld: ReadonlySet<number>, page = 0): Regions {
  const lineOf = linesOf(chars);
  const boxed = new Set(withheld);
  let found = exactRegions(chars, boxed, withheld, lineOf, page);
  // Each round boxes at least one more character, so as many rounds as characters reach the fixpoint.
  for (let round = 0; round < chars.length && found.ok; round++) {
    const regions = found.regions;
    const reached = chars.flatMap((c, i) =>
      boxed.has(i) || c.generated || isBlank(c) || c.ink === null || !regions.some((region) => overlap(c.ink as Box, region)) ? [] : [i],
    );
    if (reached.length === 0) break;
    for (const i of reached) boxed.add(i);
    found = exactRegions(chars, boxed, withheld, lineOf, page);
  }
  return found;
}

/**
 * The boxes to draw once PDFium has removed the text: exactly the marked and the removed characters,
 * per line, with no fixpoint (nothing more is removed). A character with no loose box is boxed at
 * its ink, or not at all when it has neither (regionsFor has already refused a marked one).
 */
export function boxesFor(chars: readonly PageChar[], withheld: ReadonlySet<number>, removed: ReadonlySet<number>, page = 0): Region[] {
  // With no character treated as marked, exactRegions never refuses.
  return (exactRegions(chars, new Set([...withheld, ...removed]), new Set(), linesOf(chars), page) as { ok: true; regions: Region[] }).regions;
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
