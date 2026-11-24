// ============================================================================
// ARCHIVE-SEARCH (SEARCH-HYPH): the text the search index stores.
//
// pageText() is the ONE line-end hyphen rule. The reader's find
// (apps/web/public/scripts/viewer-find.js) is to read a page the same way, and
// test/fixtures/hyphen-cases.json pins both (the web app's copy of the fixture
// and its parity test come with the reader's change).
//
//   * Each item's string is NFKC-normalised (a printed ligature is its letters,
//     a no-break space a space). Every run of white space is one space, and a
//     line end (hasEOL) is a space.
//   * U+00AD, the soft hyphen, folds to nothing.
//   * A line ending in a letter and then "-" or U+2010, with a letter first on
//     the next line, joins with neither hyphen nor space: "mem-" / "bers" reads
//     "members". The word with its hyphen kept ("well-known") goes to `extra`,
//     so a compound that happened to break at its own hyphen is still found as
//     typed.
//   * A line ending in a letter and then U+00AD joins the same way, with nothing
//     for `extra`: a soft hyphen is never part of the word.
//   * The line end may be on the item or on an empty item right after it (pdf.js
//     gives both). A blank line, white space, a digit or anything else that is
//     no letter cancels the join.
//   * Two items on one line that meet with no white space (a font change, a drop
//     capital, a redaction box's label drawn beside a word) are two words: a
//     space goes between them, so "today" beside a "Private" label is found as
//     "today". The word as drawn, without that space ("Welcome" from "W" and
//     "elcome"), goes to `extra`, so it is still found as typed.
//
// What is proven about exposure, and what is not. The PDF gate reads a page as
// drawn (a space between items) and by position (pdf/gate.ts), each in the
// joined and kept forms (pdf/match.ts). This text is not always one of those
// readings: a hyphen before an empty line-end item, and the drawn form of runs
// that meet with no space, are not shown to be. So the gate does not cover what
// is joined here; S2's text job refuses a page whose joined `text` or `extra`
// matches a withheld passage, and the end-to-end parity test (synthetic PDFs
// through the gate's reader, then pageText) is unit GATE-HYPH-JOIN.
//
// A change to this rule bumps TEXT_VERSION, and every page is extracted again.
// ============================================================================

/** The revision of pageText(): stored with each page row. */
export const TEXT_VERSION = 1;

/** One text item of a page, as pdf.js getTextContent gives it. */
export interface TextItem {
  str: string;
  hasEOL?: boolean;
}

export interface PageText {
  /** The joined reading: what is searched and what a snippet shows. */
  text: string;
  /** The kept-hyphen forms of the words the rule joined, space-separated. */
  extra: string;
}

const SOFT_HYPHEN = '­';
const SPACE = /\s/u;
const LETTER = /\p{L}/u;
const LETTER_THEN_HYPHEN = /\p{L}[-‐]$/u;
const ENDS_IN_LETTER = /\p{L}$/u;

/** A page's text items as one searchable text. */
export function pageText(items: readonly TextItem[]): PageText {
  let text = '';
  const kept: string[] = [];
  // The word being read as its kept form would spell it, and whether a join made it differ from the text.
  let word = '';
  let joined = false;
  // A line just ended in a letter and a hyphen ('hyphen') or a letter and a soft hyphen ('soft').
  let pending: 'hyphen' | 'soft' | null = null;
  // The last character read was a soft hyphen.
  let soft = false;
  // The word as drawn: the text's word without the spaces put between items that meet, and whether one was put.
  let drawn = '';
  let split = false;
  // The last item ended on this line, with no white space after it.
  let meets = false;

  const endWord = (): void => {
    if (joined) kept.push(word);
    word = '';
    joined = false;
  };
  const space = (): void => {
    endWord();
    if (split) kept.push(drawn);
    drawn = '';
    split = false;
    if (text !== '' && !text.endsWith(' ')) text += ' ';
  };

  for (const { str, hasEOL } of items) {
    for (const c of str.normalize('NFKC')) {
      if (c === SOFT_HYPHEN) {
        soft = true;
        continue;
      }
      soft = false;
      if (SPACE.test(c)) {
        pending = null;
        meets = false;
        space();
        continue;
      }
      if (meets) {
        // Two items meet on a line: two words in the text, one as drawn.
        meets = false;
        endWord();
        text += ' ';
        split = true;
      }
      if (pending !== null) {
        if (!LETTER.test(c)) space();
        else if (pending === 'hyphen') {
          // The hyphen leaves the text and stays, as "-", in the kept form.
          text = text.slice(0, -1);
          drawn = drawn.slice(0, -1);
          word = `${word.slice(0, -1)}-`;
          joined = true;
        }
        pending = null;
      }
      text += c;
      word += c;
      drawn += c;
    }
    if (hasEOL !== true) meets = text !== '' && !text.endsWith(' ') && pending === null;
    else {
      meets = false;
      if (pending !== null) {
        // A second line end in a row: a blank line, not a split word.
        pending = null;
        space();
      } else if (soft && ENDS_IN_LETTER.test(text)) pending = 'soft';
      else if (!soft && LETTER_THEN_HYPHEN.test(text)) pending = 'hyphen';
      else space();
      soft = false;
    }
  }
  endWord();
  if (split) kept.push(drawn);
  return { text: text.trimEnd(), extra: kept.join(' ') };
}

/** An item's text in the index's one form: NFKC, no soft hyphen, runs of space as one, blank lines dropped. */
export function plain(value: string): string {
  return value
    .normalize('NFKC')
    .replaceAll(SOFT_HYPHEN, '')
    .split('\n')
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

/** At most `bytes` of UTF-8, cut on a character. */
export function capUtf8(value: string, bytes: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= bytes) return value;
  let end = bytes;
  // A continuation byte (10xxxxxx) at the cut means the cut is inside a character: back up to its first byte.
  while (((encoded[end] as number) & 0xc0) === 0x80) end--;
  return encoded.subarray(0, end).toString('utf8');
}
