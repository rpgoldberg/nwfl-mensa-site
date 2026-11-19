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
//
// Joining adds no exposure: the PDF gate already reads the joined and the kept
// forms (pdf/match.ts), so a withheld word split across a line is a refused
// copy, and a refused copy is never indexed. A wrong join only changes which
// word finds the page.
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

  const space = (): void => {
    if (joined) kept.push(word);
    word = '';
    joined = false;
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
        space();
        continue;
      }
      if (pending !== null) {
        if (!LETTER.test(c)) space();
        else if (pending === 'hyphen') {
          // The hyphen leaves the text and stays, as "-", in the kept form.
          text = text.slice(0, -1);
          word = `${word.slice(0, -1)}-`;
          joined = true;
        }
        pending = null;
      }
      text += c;
      word += c;
    }
    if (hasEOL === true) {
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
  if (joined) kept.push(word);
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
