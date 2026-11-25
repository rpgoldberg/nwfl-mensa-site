// ============================================================================
// ARCHIVE-SEARCH S3: what a visitor may ask (plan section 3).
//
// The query is trimmed and NFKC-normalised, then held to 2 to 100 characters
// and at most 8 words; a page is 1 to 10, of ten hits. Anything else is
// INVALID_ARGUMENT, and no refusal repeats a word of the query: a refusal is
// logged and shown, and what a visitor typed is neither.
//
// The text that passes goes to the database as ONE bound parameter of
// websearch_to_tsquery (sql.ts), which reads it as words, quoted phrases, `or`
// and a leading hyphen, and has no prefix or wildcard form.
// ============================================================================
import { Code, ConnectError } from '@connectrpc/connect';

export const MIN_CHARS = 2;
export const MAX_CHARS = 100;
export const MAX_WORDS = 8;
/** Hits a page, and the last page: at most a hundred hits can ever be read for one query. */
export const PAGE_SIZE = 10;
export const MAX_PAGE = 10;
/**
 * The most UTF-16 units a query may arrive as, checked BEFORE it is normalised: NFKC can make one
 * character eighteen, so a megabyte of the wrong character is not normalised to find out it is long.
 */
export const MAX_RAW_UNITS = 400;

export interface ParsedQuery {
  /** Trimmed, NFKC, runs of white space as one space. */
  text: string;
  /** Characters (code points), which is what the log line carries: never the text. */
  chars: number;
  words: number;
}

const refuse = (reason: string): ConnectError => new ConnectError(reason, Code.InvalidArgument);

export function parseQuery(raw: string): ParsedQuery {
  if (raw.length > MAX_RAW_UNITS) throw refuse(`a search is at most ${MAX_CHARS} characters`);
  const text = raw.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  // What is left of the control characters once white space is folded: Postgres refuses a NUL outright.
  if (/\p{Cc}/u.test(text)) throw refuse('a search is plain words');
  const chars = [...text].length;
  if (chars < MIN_CHARS) throw refuse(`a search is at least ${MIN_CHARS} characters`);
  if (chars > MAX_CHARS) throw refuse(`a search is at most ${MAX_CHARS} characters`);
  const words = text.split(' ').length;
  if (words > MAX_WORDS) throw refuse(`a search is at most ${MAX_WORDS} words`);
  return { text, chars, words };
}

/** The page asked for, 1-based; 0 (the field left unset) is the first. */
export function pageNumber(page: number): number {
  if (!Number.isInteger(page) || page < 0 || page > MAX_PAGE) throw refuse(`page is 1 to ${MAX_PAGE}`);
  return page === 0 ? 1 : page;
}
