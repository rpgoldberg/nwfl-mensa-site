// READER2: search within the issue (public/scripts/viewer.js wires it). It reads only the text pdf.js
// gives for the one file the reader is showing, the copy the site serves this reader: the public copy's
// text is the redacted file's, so a search there can never surface what the redaction took out. Nothing
// is sent anywhere. A page's text items (as pdf.js's getTextContent gives them, the same ones its text
// layer draws, one span each) are joined, folded to lower case with every run of space as one, and each
// character keeps its item and its place in it, so a match can be painted in the text layer's spans.

export const NO_TEXT = 'No searchable text on this page';
const SPACE = /\s/;

/**
 * What was typed, as the page text is folded: lower case, trimmed, every run of space one space.
 *
 * @param {string} raw
 */
export const queryOf = (raw) => raw.trim().replace(/\s+/g, ' ').toLowerCase();

/** @typedef {{ str: string, hasEOL?: boolean }} TextItem */
/** @typedef {{ text: string, item: number[], at: number[], end: number[] }} TextIndex */

/**
 * A page's text, folded, with each UTF-16 unit's item and the span of that item's string it came from
 * (at to end; -1 for the space a line's end adds). Counted in UTF-16 units throughout, as strings are, so
 * a character outside the basic plane (an emoji, two units) shifts no match after it.
 *
 * @param {TextItem[]} items
 * @returns {TextIndex}
 */
export function indexText(items) {
  let text = '';
  /** @type {number[]} */
  const item = [];
  /** @type {number[]} */
  const at = [];
  /** @type {number[]} */
  const end = [];
  /** @param {string} out @param {number} i @param {number} k @param {number} e */
  const put = (out, i, k, e) => {
    text += out;
    for (let u = 0; u < out.length; u++) {
      item.push(i);
      at.push(k);
      end.push(e);
    }
  };
  const spaced = () => text === '' || text.endsWith(' ');
  items.forEach(({ str, hasEOL }, i) => {
    let k = 0;
    for (const c of str) {
      const e = k + c.length;
      if (SPACE.test(c)) {
        if (!spaced()) put(' ', i, k, e);
      } else {
        const lower = c.toLowerCase();
        // A letter whose lower case is longer (İ) is kept as it is.
        put(lower.length === c.length ? lower : c, i, k, e);
      }
      k = e;
    }
    if (hasEOL && !spaced()) put(' ', -1, -1, -1);
  });
  return { text, item, at, end };
}

/**
 * Whether a page has any text to search: a scanned page has none.
 *
 * @param {TextItem[]} items
 */
export const hasText = (items) => items.some(({ str }) => str.trim() !== '');

/**
 * Where a folded query starts in a page's text, each match after the last one ends.
 *
 * @param {TextIndex} index
 * @param {string} query
 */
export function findIn(index, query) {
  /** @type {number[]} */
  const out = [];
  if (query === '') return out;
  let from = index.text.indexOf(query);
  while (from !== -1) {
    out.push(from);
    from = index.text.indexOf(query, from + query.length);
  }
  return out;
}

/** @typedef {{ item: number, from: number, to: number }} HitRange */

/**
 * Each item's part of the match at `start`, `length` characters long; the space a line's end adds is in none.
 *
 * @param {TextIndex} index
 * @param {number} start
 * @param {number} length
 * @returns {HitRange[]}
 */
export function rangesOf(index, start, length) {
  /** @type {HitRange[]} */
  const out = [];
  for (let c = start; c < start + length; c++) {
    const item = /** @type {number} */ (index.item[c]);
    const at = /** @type {number} */ (index.at[c]);
    const end = /** @type {number} */ (index.end[c]);
    if (item === -1) continue;
    const last = out.at(-1);
    if (last && last.item === item) last.to = end;
    else out.push({ item, from: at, to: end });
  }
  return out;
}

/**
 * The count beside the search field.
 *
 * @param {number} n
 * @param {number} count
 */
export const matchLabel = (n, count) => (count === 0 ? 'No matches' : `${n} of ${count}`);

/**
 * Paints matches in a drawn page's text layer: each match's part of each span is wrapped in a mark of
 * its own (pdf.js's own viewer wraps them in spans; a mark is clear of the text layer's span rules, and
 * says what it is), the current match apart. Spans painted before are given
 * back their text first. Returns the current match's first mark, to scroll to.
 *
 * @param {{ createElement(tag: string): any }} doc
 * @param {{ divs: any[], strs: string[], painted: Set<number> }} layer
 * @param {{ ranges: HitRange[], current: boolean }[]} hits
 */
export function paintHits(doc, layer, hits) {
  for (const k of layer.painted) layer.divs[k].textContent = layer.strs[k];
  layer.painted.clear();
  /** @type {Map<number, { from: number, to: number, current: boolean }[]>} */
  const byItem = new Map();
  for (const hit of hits) {
    for (const r of hit.ranges) {
      if (layer.divs[r.item] === undefined) continue;
      byItem.set(r.item, [...(byItem.get(r.item) ?? []), { from: r.from, to: r.to, current: hit.current }]);
    }
  }
  let mark;
  for (const [k, parts] of byItem) {
    const str = /** @type {string} */ (layer.strs[k]);
    /** @type {any[]} */
    const kids = [];
    let end = 0;
    for (const part of parts) {
      if (part.from > end) kids.push(str.slice(end, part.from));
      const el = doc.createElement('mark');
      el.className = part.current ? 'viewer-hit viewer-hit--current' : 'viewer-hit';
      el.textContent = str.slice(part.from, part.to);
      kids.push(el);
      if (part.current) mark ??= el;
      end = part.to;
    }
    if (end < str.length) kids.push(str.slice(end));
    layer.divs[k].replaceChildren(...kids);
    layer.painted.add(k);
  }
  return mark;
}
