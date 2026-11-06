// ============================================================================
// LIGATURE: a glyph with no readable text where a withheld quote may be.
//
// A producer that has no Unicode for a glyph can still give it a /ToUnicode
// entry: Cairo writes U+FFFD for each glyph its source had none for (MuPDF's
// HTML layout leaves its fi, ff and ffi ligatures, and its small caps, so),
// and older fonts read their ligatures at private-use codes (U+F001 fi). No
// reader flags them (PDFium's map error is not set), and the matcher reads
// such a glyph as no letter, so "Fifi Amberwick" drawn "Fi" + the fi ligature
// reads "Fi\uFFFD Amberwick", matched by no quote, and was shown.
//
// Two answers, each on its own:
//   1. matchedChars (match.ts) lets such a glyph stand for a ligature of a
//      quote (ff, fi, fl, ffi, ffl, st, ct) where the rest of it reads as
//      the quote, so the whole run is boxed with the glyph;
//   2. readThrough, here, says whether a quote could still be read through
//      such a glyph left on a page: each one may stand for any letters, up to
//      its reach (three, the longest ligature, or as many as its ink is wide
//      at REACH_EM a letter), and the rest of the quote must read as it is,
//      on word edges. The engine (redact.ts verifyRedacted) asks it of
//      PDFium's reading of each copy, the gate (gate.ts) of pdf.js's, where
//      every such glyph reaches three letters; either one finding a quote is
//      no copy. So a page where unreadable glyphs could spell a quote (small
//      caps with no Unicode) is refused, and a ligature inside a longer word
//      ("o\uFFFDce") is not.
// ============================================================================
import { probeFolded, quoteLetters } from '../redaction/render.js';
import type { Box, PageChar } from './match.js';

/** U+FFFD, a private-use code point, a noncharacter at a plane's end of the BMP, or a lone surrogate: no text. */
const UNREADABLE = /^(?:[\uFFFD\uFFFE\uFFFF\uE000-\uF8FF\u{F0000}-\u{10FFFF}]|[\uD800-\uDFFF])$/u;

/** Whether a character a reader gives for a glyph is no text at all (LIGATURE). */
export const isUnreadable = (text: string): boolean => UNREADABLE.test(text);

/** The most letters any glyph with no text may stand for: the longest ligature, ffi or ffl. */
export const LIGATURE_REACH = 3;
/** The narrowest a letter is drawn, in ems: a glyph with no text whose ink is wider may stand for more letters. */
export const REACH_EM = 0.25;

/** A unit of text read through: a folded letter or digit, '' for anything else (an edge), or a glyph with no text and its reach. */
export type Unit = string | number;

const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;

/** The folded letters and digits of one character, an edge for anything else. */
function folded(text: string, out: Unit[]): void {
  const letters = [...probeFolded(text)].filter((ch) => LETTER_OR_DIGIT.test(ch));
  if (letters.length === 0) out.push('');
  else out.push(...letters);
}

const ANY_UNREADABLE = /[\uFFFD\uFFFE\uFFFF\uE000-\uF8FF\u{F0000}-\u{10FFFF}]|[\uD800-\uDFFF]/u;

/** A plain string's units, as the gate reads pdf.js's text: every glyph with no text reaches `reach` letters. None when it has no such glyph. */
export function textUnits(text: string, reach = LIGATURE_REACH): Unit[] {
  const out: Unit[] = [];
  if (!ANY_UNREADABLE.test(text)) return out;
  for (const ch of text) {
    if (isUnreadable(ch)) out.push(reach);
    else folded(ch, out);
  }
  return out;
}

/**
 * How many letters a glyph with no text may stand for: three, or more where it is longer, at REACH_EM a letter, along
 * either side of its ink or its advance (its loose box's width; both of that box's sides when it has no ink, so text
 * drawn up the page is measured too); any number when it has no place or no size.
 */
export function reachOf(c: PageChar): number {
  if ((c.ink === null && c.box === null) || !(c.fontSize > 0)) return Number.POSITIVE_INFINITY;
  const width = (b: Box): number => b.right - b.left;
  const height = (b: Box): number => b.top - b.bottom;
  const along = c.ink === null ? Math.max(width(c.box as Box), height(c.box as Box)) : Math.max(width(c.ink), height(c.ink), c.box === null ? 0 : width(c.box));
  return Math.max(LIGATURE_REACH, Math.ceil(along / (REACH_EM * c.fontSize)));
}

/** A page's units, as PDFium reads it: each glyph with no text reaches as far as reachOf says. None when it has no such glyph. */
export function charUnits(chars: readonly PageChar[]): Unit[] {
  const out: Unit[] = [];
  if (!chars.some((c) => isUnreadable(c.text))) return out;
  for (const c of chars) {
    if (isUnreadable(c.text)) out.push(reachOf(c));
    else folded(c.text, out);
  }
  return out;
}

const isLetter = (unit: Unit | undefined): boolean => typeof unit === 'string' && unit !== '';

/**
 * Whether any quote could be read in these units through a glyph with no text: a run of them, starting and ending on
 * a word's edge (no letter just outside it), whose letters read as the quote's (folded, look-alikes) in order, with at
 * least one such glyph in it standing for 1 to its reach of the quote's letters. Anything else between letters is
 * passed over, as the gate's probe does. False when no glyph is unreadable: the matcher reads that text.
 */
export function readThrough(units: readonly Unit[], quotes: readonly string[]): boolean {
  if (!units.some((unit) => typeof unit === 'number')) return false;
  for (const quote of quotes) {
    const letters = quoteLetters(quote);
    if (letters === null) continue;
    const m = letters.length;
    // plain[j]: j of the quote's letters read with no unreadable glyph yet; through[j]: with one at least.
    let plain = new Uint8Array(m + 1);
    let through = new Uint8Array(m + 1);
    let nextPlain = new Uint8Array(m + 1);
    let nextThrough = new Uint8Array(m + 1);
    for (let i = 0; i < units.length; i++) {
      const unit = units[i] as Unit;
      if (!isLetter(units[i - 1])) plain[0] = 1;
      nextPlain.fill(0);
      nextThrough.fill(0);
      for (let j = 0; j < m; j++) {
        if (plain[j] === 0 && through[j] === 0) continue;
        if (unit === '') {
          nextPlain[j] = plain[j] as number;
          nextThrough[j] = through[j] as number;
        } else if (typeof unit === 'string') {
          if ((letters[j] as RegExp).test(unit)) {
            if (plain[j] === 1) nextPlain[j + 1] = 1;
            if (through[j] === 1) nextThrough[j + 1] = 1;
          }
        } else {
          for (let t = 1; t <= Math.min(unit, m - j); t++) nextThrough[j + t] = 1;
        }
      }
      if (nextThrough[m] === 1 && !isLetter(units[i + 1])) return true;
      nextPlain[m] = 0;
      nextThrough[m] = 0;
      [plain, nextPlain] = [nextPlain, plain];
      [through, nextThrough] = [nextThrough, through];
    }
  }
  return false;
}
