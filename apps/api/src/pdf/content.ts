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

// ============================================================================
// UNTRUSTED-PDF-GATE M-6 (fix round 6): operands as every reader takes them.
//
// Readers part ways on an operator given more operands than it takes: pdf.js
// and poppler keep the last, MuPDF the first, so "/M /Sh2 sh" drew a mesh in
// MuPDF that pdf.js, whose drawing the gate reads, never drew. pdf.js keeps
// the operands an unknown operator was given for the next one, which MuPDF
// drops; and pdf.js splits a word at the longest operator it knows ("qq" is
// q then q), where MuPDF and poppler read the word whole. So a content stream
// is read both ways, and refused when, in either, an operator is given more
// operands than it takes, an unknown one is given any, operands are left at
// its end, a number is not plain (pdf.js reads "1.5.3" as two numbers), or an
// operator word holds a byte outside printable ASCII. An operator given too
// few is let through (pdf.js skips it). Arities are pdf.js's (pdfjs-dist
// 6.4.299, EvaluatorPreprocessor.opMap); for sc and SC operands are numbers,
// and scn and SCN take one name at most, last.
// ============================================================================

/** How many operands each operator takes, at most. */
const OPERANDS: ReadonlyMap<string, number> = new Map(
  Object.entries({
    w: 1, J: 1, j: 1, M: 1, d: 2, ri: 1, i: 1, gs: 1, q: 0, Q: 0, cm: 6, m: 2, l: 2, c: 6, v: 4, y: 4, h: 0, re: 4,
    S: 0, s: 0, f: 0, F: 0, 'f*': 0, B: 0, 'B*': 0, b: 0, 'b*': 0, n: 0, W: 0, 'W*': 0, BT: 0, ET: 0, Tc: 1, Tw: 1,
    Tz: 1, TL: 1, Tf: 2, Tr: 1, Ts: 1, Td: 2, TD: 2, Tm: 6, 'T*': 0, Tj: 1, TJ: 1, "'": 1, '"': 3, d0: 2, d1: 6,
    CS: 1, cs: 1, SC: 4, SCN: 33, sc: 4, scn: 33, G: 1, g: 1, RG: 3, rg: 3, K: 4, k: 4, sh: 1, BI: 0, ID: 0, EI: 1,
    Do: 1, MP: 1, DP: 2, BMC: 1, BDC: 2, EMC: 0, BX: 0, EX: 0,
  }),
);
/** Words pdf.js's lexer knows besides the operators (read whole, then as an operand or an unknown command). */
const LEXED = new Set(['BM', 'BD', 'true', 'fa', 'fal', 'fals', 'false', 'nu', 'nul', 'null']);
const KEYWORDS = new Set(['true', 'false', 'null']);
const PLAIN_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;
const NUMBER_START = /^[0-9+\-.]/;
const PRINTABLE = /^[\x21-\x7e]+$/;

class OperandBreak extends Error {}

/** One way of reading a stream's operators: the operands waiting for the next one (true for a name). */
class Reading {
  private pending: boolean[] = [];

  operand(name: boolean): void {
    this.pending.push(name);
  }

  operator(op: string): void {
    const most = OPERANDS.get(op);
    const names = this.pending.filter(Boolean).length;
    const taken = this.pending.length;
    const lastName = this.pending.at(-1) === true;
    this.pending = [];
    if (most === undefined) {
      if (taken > 0) throw new OperandBreak(`a content stream gives the unknown operator ${op} more operands than it takes`);
      return;
    }
    const surplus = taken > most || ((op === 'sc' || op === 'SC') && names > 0) || ((op === 'scn' || op === 'SCN') && (names > 1 || (names === 1 && !lastName)));
    if (surplus) throw new OperandBreak(`a content stream gives ${op} more operands than it takes`);
  }

  get waiting(): boolean {
    return this.pending.length > 0;
  }
}

/** The operators pdf.js reads in a word: at each step the longest it knows, or the word's rest when it knows none. */
function pdfjsOperators(word: string): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < word.length) {
    let end = at + 1;
    let known = OPERANDS.has(word.slice(at, end)) || LEXED.has(word.slice(at, end));
    while (end < word.length) {
      const longer = word.slice(at, end + 1);
      const knows = OPERANDS.has(longer) || LEXED.has(longer);
      if (known && !knows) break;
      end += 1;
      known = knows;
    }
    out.push(word.slice(at, end));
    at = end;
    if (at < word.length && NUMBER_START.test(word.slice(at))) throw new OperandBreak(`a content stream holds a number readers split otherwise (${word})`);
  }
  return out;
}

/**
 * Why a content stream's operands do not match its operators for every reader (fix round 6, M-6), or null: read as
 * pdf.js reads it and as MuPDF and poppler read it. A stream that cannot be read to its end is refused too.
 */
export function operandBreak(stream: Uint8Array): string | null {
  const s = Buffer.from(stream).toString('latin1');
  const pdfjs = new Reading();
  const whole = new Reading();
  const both = (name: boolean): void => {
    pdfjs.operand(name);
    whole.operand(name);
  };
  const open: string[] = [];
  let i = 0;
  try {
    while (i < s.length) {
      const code = s.charCodeAt(i);
      const c = s[i] as string;
      if (WHITESPACE.has(code)) i += 1;
      else if (c === '%') {
        const eol = s.slice(i).search(/[\r\n]/);
        i = eol < 0 ? s.length : i + eol;
      } else if (c === '(') {
        i = stringEnd(s, i);
        if (open.length === 0) both(false);
      } else if (s.startsWith('<<', i) || c === '[') {
        open.push(c === '[' ? ']' : '>>');
        i += c === '[' ? 1 : 2;
      } else if (s.startsWith('>>', i) || c === ']') {
        const close = c === ']' ? ']' : '>>';
        if (open.pop() !== close) throw new Unreadable();
        i += close.length;
        if (open.length === 0) both(false);
      } else if (c === '<') {
        i = hexEnd(s, i);
        if (open.length === 0) both(false);
      } else if (c === '/') {
        i = regularEnd(s, i + 1);
        if (open.length === 0) both(true);
      } else if (c === ')') throw new Unreadable();
      else {
        const end = Math.max(regularEnd(s, i), i + 1);
        const word = s.slice(i, end);
        i = end;
        if (open.length > 0) continue;
        if (PLAIN_NUMBER.test(word) || KEYWORDS.has(word)) {
          both(false);
          continue;
        }
        if (NUMBER_START.test(word) || !PRINTABLE.test(word)) throw new OperandBreak(`a content stream holds a number readers split otherwise (${word})`);
        const split = pdfjsOperators(word);
        whole.operator(word);
        for (const op of split) {
          if (KEYWORDS.has(op)) pdfjs.operand(false);
          else pdfjs.operator(op);
        }
        if (word === 'BI') i = inlineImageEnd(s, i);
      }
    }
    if (open.length > 0) throw new Unreadable();
  } catch (error) {
    if (error instanceof OperandBreak) return error.message;
    return 'a content stream cannot be read';
  }
  return pdfjs.waiting || whole.waiting ? 'a content stream ends with operands no operator takes' : null;
}

/** A name decoded once, as pdf.js and PDFium decode it (BOXLABEL fix round 3, R3-1): each #XX, in either case. */
export const decodedOnce = (raw: string): string => raw.replace(/#([0-9A-Fa-f]{2})/g, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

/**
 * The names a content stream holds (BOXLABEL fix round 3, R3-1), each decoded once as pdf.js and PDFium decode it
 * (#XX in either case), read with the lexer above: strings, hex strings and comments are skipped, and an inline
 * picture from BI to its EI, as operandBreak skips it. A string, hex string or inline picture that does not end runs
 * to the end of the stream, for a reader as here, so no name is read past its start.
 */
export function contentNames(stream: Uint8Array): string[] {
  const s = Buffer.from(stream).toString('latin1');
  const names: string[] = [];
  let i = 0;
  try {
    while (i < s.length) {
      const c = s[i] as string;
      if (WHITESPACE.has(s.charCodeAt(i)) || c === '[' || c === ']' || c === ')' || c === '>') i += 1;
      else if (c === '%') {
        const eol = s.slice(i).search(/[\r\n]/);
        i = eol < 0 ? s.length : i + eol;
      } else if (c === '(') i = stringEnd(s, i);
      else if (s.startsWith('<<', i)) i += 2;
      else if (c === '<') i = hexEnd(s, i);
      else if (c === '/') {
        const end = regularEnd(s, i + 1);
        names.push(decodedOnce(s.slice(i + 1, end)));
        i = end;
      } else {
        const end = Math.max(regularEnd(s, i), i + 1);
        i = s.slice(i, end) === 'BI' ? inlineImageEnd(s, end) : end;
      }
    }
  } catch {
    // Unreadable from here on: what follows is a string's or a picture's data.
  }
  return names;
}
