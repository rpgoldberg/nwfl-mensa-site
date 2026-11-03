// ============================================================================
// REDACT R3a: marked-content properties out of a content stream.
//
// "/Span <</ActualText (...)>> BDC" carries text a reader copies, or a screen
// reader speaks, in place of the glyphs it wraps; /Alt and /E do the same,
// and a named property list points at more of it. None of that is a glyph,
// so removing glyphs does not touch it. The redacted copy keeps each tag and
// drops its properties: "/Span BMC". Everything else stays byte for byte.
//
// A stream this lexer cannot read to the end (an unterminated string or
// dictionary, an inline image without EI, a BDC without a tag) is refused:
// the copy is not given, rather than given with properties left in.
// ============================================================================

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
/** PDF whitespace (NUL, tab, LF, FF, CR, space) as the inside of a regular-expression class: never \s, which misses NUL and takes U+00A0. */
export const PDF_WS = '\\x00\\t\\n\\f\\r ';
const DELIMITERS = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)));
const REGULAR = /^(?:[+-]?(?:\d+\.?\d*|\.\d+)|true|false|null)$/;

class Unreadable extends Error {
  constructor() {
    super('the content stream has marked content that cannot be read');
  }
}

interface Operand {
  start: number;
  end: number;
  name: boolean;
}

/** The end (exclusive) of the literal string that starts at `at` (an open parenthesis). */
function stringEnd(s: string, at: number): number {
  let depth = 0;
  for (let i = at; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i += 1;
    else if (c === '(') depth += 1;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  throw new Unreadable();
}

function hexEnd(s: string, at: number): number {
  const end = s.indexOf('>', at);
  if (end < 0) throw new Unreadable();
  return end + 1;
}

function regularEnd(s: string, at: number): number {
  let i = at;
  while (i < s.length && !WHITESPACE.has(s.charCodeAt(i)) && !DELIMITERS.has(s.charCodeAt(i))) i += 1;
  return i;
}

/** The end of an inline image's data: just past the EI that follows ID, standing alone. */
function inlineImageEnd(s: string, at: number): number {
  const id = new RegExp(`(^|[${PDF_WS}])ID[${PDF_WS}]`, 'g');
  id.lastIndex = at;
  const found = id.exec(s);
  if (found === null) throw new Unreadable();
  const ei = new RegExp(`[${PDF_WS}]EI(?=[${PDF_WS}]|$|[()<>[\\]{}/%])`, 'g');
  ei.lastIndex = found.index + found[0].length;
  const end = ei.exec(s);
  if (end === null) throw new Unreadable();
  return end.index + end[0].length;
}

/** The content stream with every BDC property list dropped (the tag kept, as BMC). Throws when it cannot be read. */
export function stripMarkedContentProperties(stream: Uint8Array): Uint8Array {
  const s = Buffer.from(stream).toString('latin1');
  const edits: Array<[number, number, string]> = [];
  let operands: Operand[] = [];
  let depth = 0;
  let compositeStart = 0;
  let i = 0;
  const operand = (start: number, end: number, name = false): void => {
    if (depth === 0) operands.push({ start, end, name });
  };
  while (i < s.length) {
    const code = s.charCodeAt(i);
    const c = s[i] as string;
    if (WHITESPACE.has(code)) {
      i += 1;
    } else if (c === '%') {
      const eol = s.slice(i).search(/[\r\n]/);
      i = eol < 0 ? s.length : i + eol;
    } else if (c === '(') {
      const end = stringEnd(s, i);
      operand(i, end);
      i = end;
    } else if (s.startsWith('<<', i) || c === '[') {
      if (depth === 0) compositeStart = i;
      depth += 1;
      i += c === '[' ? 1 : 2;
    } else if (s.startsWith('>>', i) || c === ']') {
      depth -= 1;
      i += c === ']' ? 1 : 2;
      if (depth < 0) throw new Unreadable();
      operand(compositeStart, i);
    } else if (c === '<') {
      const end = hexEnd(s, i);
      operand(i, end);
      i = end;
    } else if (c === '/') {
      const end = regularEnd(s, i + 1);
      operand(i, end, true);
      i = end;
    } else {
      const end = Math.max(regularEnd(s, i), i + 1);
      const word = s.slice(i, end);
      if (depth > 0 || REGULAR.test(word)) operand(i, end);
      else if (word === 'BI') {
        i = inlineImageEnd(s, end);
        operands = [];
        continue;
      } else {
        if (word === 'BDC') {
          const [tag, properties] = operands.slice(-2);
          if (tag === undefined || properties === undefined || !tag.name) throw new Unreadable();
          edits.push([tag.start, end, `${s.slice(tag.start, tag.end)} BMC`]);
        }
        operands = [];
      }
      i = end;
    }
  }
  if (depth !== 0) throw new Unreadable();
  let out = '';
  let at = 0;
  for (const [start, end, text] of edits) {
    out += s.slice(at, start) + text;
    at = end;
  }
  return Buffer.from(out + s.slice(at), 'latin1');
}

/**
 * Where each inline picture may begin in decoded content, as pdf.js's lexer reads it (UNTRUSTED-PDF-GATE M1,
 * fix round 4): the start of every regular word (not a string, hex string, name or comment) that holds "BI".
 * pdf.js ends a command at the longest operator it knows, so "qBI" is q then BI, "200BI" is 200 then BI and
 * "BIG" is BI then G; a word holding BI anywhere is counted, which takes in a few words pdf.js would not read
 * as BI and never leaves one out. Past each, the picture's data is skipped, to the EI after its ID. Null
 * when the content cannot be read to its end (an unterminated string or hex string): a caller counts that
 * as a picture.
 */
export function inlinePictureStarts(stream: Uint8Array): number[] | null {
  const s = Buffer.from(stream).toString('latin1');
  const starts: number[] = [];
  let i = 0;
  try {
    while (i < s.length) {
      const code = s.charCodeAt(i);
      const c = s[i] as string;
      if (c === '%') {
        const eol = s.slice(i).search(/[\r\n]/);
        i = eol < 0 ? s.length : i + eol;
      } else if (c === '(') i = stringEnd(s, i);
      else if (c === '<' && s[i + 1] !== '<') i = hexEnd(s, i);
      else if (c === '/') i = regularEnd(s, i + 1);
      else if (WHITESPACE.has(code) || DELIMITERS.has(code)) i += 1;
      else {
        const end = regularEnd(s, i);
        if (!s.slice(i, end).includes('BI')) i = end;
        else {
          starts.push(i);
          try {
            i = inlineImageEnd(s, end);
          } catch {
            // No ID or no EI after it: nothing past it is read, and it is counted already.
            i = s.length;
          }
        }
      }
    }
  } catch {
    return null;
  }
  return starts;
}
