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
//              without word edges, since a spaced run gives none;
//   collapsed  the spaces between single letters taken out, the rest kept,
//              so a word spaced beside a plain one ("J u n o Blackwood")
//              reads "Juno Blackwood", matched as whole words.
//
// Every character a match covers in any reading is withheld. Then each line's
// withheld characters become a region, widened to the next multiple of a
// fixed step (WIDTH_STEP_EM of the type size) within the line, so the box drawn
// over it does not give away how long the passage was. A box that would reach
// the line's end runs on to the page's right margin (the left one mirrored),
// or to the next text further right in the same band, so its right edge does
// not show where the passage ended.
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

/** One character as PDFium reports it. `generated`: PDFium added it (a line break or a space); `box` null: no position. */
export interface PageChar {
  text: string;
  generated: boolean;
  hyphen: boolean;
  box: Box | null;
  fontSize: number;
}

/** An area to remove and box, on a page (0-based), in page space. */
export interface Region extends Box {
  page: number;
  fontSize: number;
}

export type Regions = { ok: true; regions: Region[] } | { ok: false; reason: string };

/** The box width step, in ems of the passage's type size. */
export const WIDTH_STEP_EM = 4;

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
      const chars = [...piece].map((ch): PageChar => ({ text: ch, generated: false, hyphen: false, box: null, fontSize: 0 }));
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
 * Widened to a whole number of steps from its left edge. One that would reach the line's end runs
 * on to `reach` when that is further; otherwise it is kept within the line (shifted left first).
 */
function widen(span: Span, line: Box, reach: number): Span {
  const step = WIDTH_STEP_EM * span.fontSize;
  const width = Math.max(1, Math.ceil((span.right - span.left) / step - 1e-9)) * step;
  if (span.left + width >= line.right - 1e-9 && reach > line.right) return { ...span, right: reach };
  const right = Math.min(span.left + width, line.right);
  return { ...span, left: Math.max(line.left, right - width), right };
}

/**
 * The regions to remove and box for these withheld characters, or why there can be none. Given the
 * page's width, a box that reaches a line's end runs on to the right margin (see the header).
 */
export function regionsFor(chars: readonly PageChar[], withheld: ReadonlySet<number>, page = 0, pageWidth?: number): Regions {
  const lineOf: number[] = [];
  const lines: Box[] = [];
  let line = 0;
  chars.forEach((c, i) => {
    if (isBreak(c) && !(c.text === '\r' && chars[i + 1]?.text === '\n')) line += 1;
    lineOf.push(line);
    if (c.box !== null && !c.generated) {
      const extent = lines[line];
      lines[line] = extent === undefined ? { ...c.box } : {
        left: Math.min(extent.left, c.box.left),
        right: Math.max(extent.right, c.box.right),
        bottom: Math.min(extent.bottom, c.box.bottom),
        top: Math.max(extent.top, c.box.top),
      };
    }
    // PDFium's own line-end hyphen often has no line break after it: the next character starts a line.
    if ((c.hyphen || c.text === '\u0002') && !isBreak(chars[i + 1] ?? c)) line += 1;
  });

  const spans: Span[] = [];
  let last = -1;
  for (const i of [...withheld].sort((a, b) => a - b)) {
    const c = chars[i] as PageChar;
    if (c.generated || isBreak(c)) continue;
    if (c.box === null) {
      if (/^\s*$/u.test(c.text)) continue;
      return { ok: false, reason: `a withheld passage on page ${page + 1} has no position` };
    }
    const current = spans.at(-1);
    let between = false;
    for (let k = last + 1; k < i && !between; k++) {
      const b = chars[k] as PageChar;
      between = !b.generated && !isBreak(b) && !withheld.has(k);
    }
    if (current !== undefined && current.line === lineOf[i] && !between) {
      current.left = Math.min(current.left, c.box.left);
      current.right = Math.max(current.right, c.box.right);
      current.bottom = Math.min(current.bottom, c.box.bottom);
      current.top = Math.max(current.top, c.box.top);
      current.fontSize = Math.max(current.fontSize, c.fontSize);
    } else spans.push({ ...c.box, line: lineOf[i] as number, fontSize: c.fontSize });
    last = i;
  }

  // How far right a box at this line's end may run: the mirrored margin, short of other text in the band.
  const margin = pageWidth === undefined ? -Infinity : pageWidth - Math.min(...lines.filter(Boolean).map((l) => l.left));
  const reachOf = (lineNo: number, extent: Box): number => {
    let reach = Math.max(extent.right, margin);
    chars.forEach((c, i) => {
      if (c.box === null || c.generated || lineOf[i] === lineNo) return;
      const middle = (c.box.bottom + c.box.top) / 2;
      if (c.box.left >= extent.right && middle > extent.bottom && middle < extent.top) reach = Math.min(reach, c.box.left);
    });
    return reach;
  };

  const regions: Region[] = [];
  for (const lineNo of new Set(spans.map((s) => s.line))) {
    const extent = lines[lineNo] as Box;
    const reach = reachOf(lineNo, extent);
    const onLine = spans.filter((s) => s.line === lineNo).map((s) => widen(s, extent, reach));
    onLine.sort((a, b) => a.left - b.left);
    const merged: Span[] = [];
    for (const span of onLine) {
      let current = span;
      let prior = merged.at(-1);
      while (prior !== undefined && current.left < prior.right) {
        merged.pop();
        current = widen(
          {
            line: lineNo,
            left: Math.min(prior.left, current.left),
            right: Math.max(prior.right, current.right),
            bottom: Math.min(prior.bottom, current.bottom),
            top: Math.max(prior.top, current.top),
            fontSize: Math.max(prior.fontSize, current.fontSize),
          },
          extent,
          reach,
        );
        prior = merged.at(-1);
      }
      merged.push(current);
    }
    for (const { left, right, bottom, top, fontSize } of merged) regions.push({ page, left, right, bottom, top, fontSize });
  }
  return { ok: true, regions };
}
