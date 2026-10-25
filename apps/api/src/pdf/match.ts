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
//              without word edges, since a spaced run gives none.
//
// Every character a match covers in any reading is withheld. Then each line's
// withheld characters become a region, widened to the next multiple of a
// fixed step (WIDTH_STEP_EM of the type size) within the line, so the box drawn
// over it does not give away how long the passage was.
// ============================================================================
import { quoteSpans } from '../redaction/render.js';

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

/** The page characters any quote covers, in any reading. */
export function matchedChars(chars: readonly PageChar[], quotes: readonly string[]): Set<number> {
  const out = new Set<number>();
  if (quotes.length === 0) return out;
  const joined = read(chars, false);
  const readings: Array<[Reading, boolean]> = [
    [joined, true],
    [read(chars, true), true],
    [spaced(joined), false],
  ];
  for (const [reading, wholeWords] of readings) {
    for (const [start, end] of quoteSpans(reading.text, quotes, wholeWords)) {
      for (let u = start; u < end; u++) for (const i of reading.source[u] as number[]) out.add(i);
    }
  }
  return out;
}

interface Span extends Box {
  line: number;
  fontSize: number;
}

/** Widened to a whole number of steps from its left edge, kept within the line (shifted left first). */
function widen(span: Span, line: Box): Span {
  const step = WIDTH_STEP_EM * span.fontSize;
  const width = Math.max(1, Math.ceil((span.right - span.left) / step - 1e-9)) * step;
  const right = Math.min(span.left + width, line.right);
  return { ...span, left: Math.max(line.left, right - width), right };
}

/** The regions to remove and box for these withheld characters, or why there can be none. */
export function regionsFor(chars: readonly PageChar[], withheld: ReadonlySet<number>, page = 0): Regions {
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

  const regions: Region[] = [];
  for (const lineNo of new Set(spans.map((s) => s.line))) {
    const extent = lines[lineNo] as Box;
    const onLine = spans.filter((s) => s.line === lineNo).map((s) => widen(s, extent));
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
        );
        prior = merged.at(-1);
      }
      merged.push(current);
    }
    for (const { left, right, bottom, top, fontSize } of merged) regions.push({ page, left, right, bottom, top, fontSize });
  }
  return { ok: true, regions };
}
