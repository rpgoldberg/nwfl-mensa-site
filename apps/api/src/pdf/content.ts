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
  const id = /(^|[\s\0])ID[\s\0]/g;
  id.lastIndex = at;
  const found = id.exec(s);
  if (found === null) throw new Unreadable();
  const ei = /[\s\0]EI(?=[\s\0]|$|[()<>[\]{}/%])/g;
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
