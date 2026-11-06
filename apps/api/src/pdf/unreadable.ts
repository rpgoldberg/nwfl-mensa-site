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
//
// Fix 1 (F1, F5): a glyph can also read as a code point that is text, but not
// the glyph's. Ghostscript 10.05.1 re-distilling a WeasyPrint file writes no
// /ToUnicode entry for some ligatures, and the readers fall back on the glyph's
// number: Noto Serif's fi reads U+0856 (Mandaic), fl U+0857, ff U+0853, ffl
// U+0855; Carlito's ti U+08A2 and tt U+08B0 (Arabic); and it writes ffi as "f"
// and U+00CF (f and i summed). Neither reader flags them. So a letter whose
// Unicode does not fit its word counts as unreadable too (unreadableAt): one of
// a script other than its word's (Unicode's Script property; Han, Hiragana,
// Katakana, Bopomofo and Hangul are one), and a capital outside ASCII just
// after a small letter (an ASCII one is McDonald's). So is a glyph PDFium has
// no Unicode for (a map error: the engine refuses such a page already; the
// gate reads them so too), and a C0 control but tab, line feed, carriage
// return and PDFium's U+0002 (a crafted map to U+0000). Measured and left:
// the font's own cmap (Ghostscript writes its TrueType subsets with none, and
// a post table of format 3, so with no glyph names), and the glyph's advance
// against the font's for the code point (PDFium's FPDFFont_GetGlyphWidth looks
// the code point up backwards through the /ToUnicode, and says nothing when
// that fails; pdf.js gives no width a glyph). Not caught: a ligature read as a
// small accented Latin letter or a combining mark, a space or its first letter.
// ============================================================================
import { probeFolded, quoteLetters } from '../redaction/render.js';
import type { Box, PageChar } from './match.js';

/** U+FFFD, a private-use code point, a noncharacter at a plane's end of the BMP, or a lone surrogate: no text. */
const UNREADABLE = /^(?:[\uFFFD\uFFFE\uFFFF\uE000-\uF8FF\u{F0000}-\u{10FFFF}]|[\uD800-\uDFFF])$/u;
/** The C0 controls a page's text holds as text: tab, line feed, carriage return, and PDFium's U+0002 at a hyphen. */
const TEXT_CONTROLS = new Set([0x02, 0x09, 0x0a, 0x0d]);

/** Whether a character is a C0 control a page's text does not hold (fix 1, F5: a ligature mapped to U+0000). */
const isControl = (text: string): boolean => text.length === 1 && text.charCodeAt(0) < 0x20 && !TEXT_CONTROLS.has(text.charCodeAt(0));

/** Whether a character a reader gives for a glyph is no text at all (LIGATURE): U+FFFD, private use, a control. */
export const isUnreadable = (text: string): boolean => isControl(text) || UNREADABLE.test(text);

/** Unicode's scripts, as the Script property names them (node 24); a letter of none of them has a script of its own. */
const SCRIPT_NAMES =
  'Latin Greek Cyrillic Arabic Hebrew Armenian Georgian Devanagari Han Hiragana Katakana Bopomofo Hangul Thai Adlam Ahom Anatolian_Hieroglyphs Avestan Balinese Bamum Bassa_Vah Batak Bengali Bhaiksuki Brahmi Braille Buginese Buhid Canadian_Aboriginal Carian Caucasian_Albanian Chakma Cham Cherokee Chorasmian Coptic Cuneiform Cypriot Cypro_Minoan Deseret Dives_Akuru Dogra Duployan Egyptian_Hieroglyphs Elbasan Elymaic Ethiopic Garay Glagolitic Gothic Grantha Gujarati Gunjala_Gondi Gurmukhi Gurung_Khema Hanifi_Rohingya Hanunoo Hatran Imperial_Aramaic Inscriptional_Pahlavi Inscriptional_Parthian Javanese Kaithi Kannada Kawi Kayah_Li Kharoshthi Khitan_Small_Script Khmer Khojki Khudawadi Kirat_Rai Lao Lepcha Limbu Linear_A Linear_B Lisu Lycian Lydian Mahajani Makasar Malayalam Mandaic Manichaean Marchen Masaram_Gondi Medefaidrin Meetei_Mayek Mende_Kikakui Meroitic_Cursive Meroitic_Hieroglyphs Miao Modi Mongolian Mro Multani Myanmar Nabataean Nag_Mundari Nandinagari New_Tai_Lue Newa Nko Nushu Nyiakeng_Puachue_Hmong Ogham Ol_Chiki Ol_Onal Old_Hungarian Old_Italic Old_North_Arabian Old_Permic Old_Persian Old_Sogdian Old_South_Arabian Old_Turkic Old_Uyghur Oriya Osage Osmanya Pahawh_Hmong Palmyrene Pau_Cin_Hau Phags_Pa Phoenician Psalter_Pahlavi Rejang Runic Samaritan Saurashtra Sharada Shavian Siddham SignWriting Sinhala Sogdian Sora_Sompeng Soyombo Sundanese Sunuwar Syloti_Nagri Syriac Tagalog Tagbanwa Tai_Le Tai_Tham Tai_Viet Takri Tamil Tangsa Tangut Telugu Thaana Tibetan Tifinagh Tirhuta Todhri Toto Tulu_Tigalari Ugaritic Vai Vithkuqi Wancho Warang_Citi Yezidi Yi Zanabazar_Square';
/** The scripts Japanese, Chinese and Korean words mix: one, for this. */
const EAST_ASIAN = new Set(['Han', 'Hiragana', 'Katakana', 'Bopomofo', 'Hangul']);
const SCRIPTS = SCRIPT_NAMES.split(' ').map((name) => [EAST_ASIAN.has(name) ? 'East_Asian' : name, new RegExp(`^\\p{Script=${name}}$`, 'u')] as const);
/** Letters shared by scripts (Common, Inherited): no script of their own, for this. */
const SHARED = /^[\p{Script=Common}\p{Script=Inherited}]$/u;
const LETTER = /^\p{L}$/u;
const MARK = /^\p{M}$/u;
const CAPITAL = /^[\p{Lu}\p{Lt}]$/u;
const SMALL = /^\p{Ll}$/u;
/** Scripts already looked up, by code point; cleared when it holds MAX_SCRIPTS_KNOWN, so a page of every letter cannot grow it. */
const scriptsKnown = new Map<number, string | null>();
const MAX_SCRIPTS_KNOWN = 4096;

/** A letter's script, or null when it has none of its own (Common, Inherited). */
function scriptOf(letter: string): string | null {
  const cp = letter.codePointAt(0) as number;
  if (cp < 0x80) return 'Latin';
  const known = scriptsKnown.get(cp);
  if (known !== undefined) return known;
  const script = SHARED.test(letter) ? null : (SCRIPTS.find(([, test]) => test.test(letter))?.[0] ?? `unlisted ${cp}`);
  if (scriptsKnown.size >= MAX_SCRIPTS_KNOWN) scriptsKnown.clear();
  scriptsKnown.set(cp, script);
  return script;
}

/** Adds to `out` the letters of one word (their indices in `texts`) whose Unicode does not fit it (see the header). */
function misfits(texts: readonly string[], word: readonly number[], out: Set<number>): void {
  const scripts = word.map((i) => scriptOf(texts[i] as string));
  const counts = new Map<string, number>();
  for (const script of scripts) if (script !== null) counts.set(script, (counts.get(script) ?? 0) + 1);
  if (counts.size > 1) {
    const most = Math.max(...counts.values());
    const ruling = [...counts].filter(([, n]) => n === most);
    // One script with the most letters rules the word; where two share the most, none does, and every letter is out.
    const rule = ruling.length === 1 ? (ruling[0] as [string, number])[0] : null;
    scripts.forEach((script, k) => {
      if (script !== null && script !== rule) out.add(word[k] as number);
    });
  }
  for (let k = 1; k < word.length; k++) {
    const letter = texts[word[k] as number] as string;
    if (letter.codePointAt(0) as number >= 0x80 && CAPITAL.test(letter) && SMALL.test(texts[word[k - 1] as number] as string)) out.add(word[k] as number);
  }
}

/** Whether a character is plain ASCII text: a printable one, or a control a page's text holds. */
const plain = (code: number): boolean => code < 0x80 && (code >= 0x20 || TEXT_CONTROLS.has(code));

/**
 * The characters, by index, that read as no text or as text that is not their glyph's (see the header): U+FFFD, private
 * use, a control; and a letter whose Unicode does not fit its word, a run of letters and marks. Empty for plain ASCII.
 */
export function unreadableAt(texts: readonly string[]): Set<number> {
  const out = new Set<number>();
  if (texts.every((text) => text.length === 1 && plain(text.charCodeAt(0)))) return out;
  let word: number[] = [];
  const close = (): void => {
    if (word.length > 1) misfits(texts, word, out);
    word = [];
  };
  texts.forEach((text, i) => {
    if (isUnreadable(text)) {
      out.add(i);
      close();
    } else if (LETTER.test(text)) word.push(i);
    else if (!MARK.test(text)) close();
  });
  close();
  return out;
}

/** The characters of a page, by index, that read as no text or not as their glyph (unreadableAt), and PDFium's map errors. */
export function unreadableChars(chars: readonly PageChar[]): Set<number> {
  const out = unreadableAt(chars.map((c) => c.text));
  chars.forEach((c, i) => {
    if (c.unmapped === true) out.add(i);
  });
  return out;
}

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

/** A plain string's units, as the gate reads pdf.js's text: every glyph with no text (unreadableAt) reaches `reach` letters. None when it has no such glyph. */
export function textUnits(text: string, reach = LIGATURE_REACH): Unit[] {
  const out: Unit[] = [];
  const chars = [...text];
  const unreadable = unreadableAt(chars);
  if (unreadable.size === 0) return out;
  chars.forEach((ch, i) => {
    if (unreadable.has(i)) out.push(reach);
    else folded(ch, out);
  });
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

/** A page's units, as PDFium reads it: each glyph with no text (unreadableChars) reaches as far as reachOf says. None when it has no such glyph. */
export function charUnits(chars: readonly PageChar[]): Unit[] {
  const out: Unit[] = [];
  const unreadable = unreadableChars(chars);
  if (unreadable.size === 0) return out;
  chars.forEach((c, i) => {
    if (unreadable.has(i)) out.push(reachOf(c));
    else folded(c.text, out);
  });
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
