// ============================================================================
// The strict URL rule at save (EDITOR A3a, SPEC-v3 3.2). No network: syntax only.
//
// A URL may be saved when linkcheck would keep it (urls.ts parseKept, copied here byte for byte:
// https or mailto, a DNS name and no IP literal, no port, no user:password@, at most 2048
// characters, no hidden characters), and two things more, which only make the API stricter:
//   - https written: an http:// address, or a bare www. one, is refused ("use https://"); the
//     checker would upgrade it, but what is printed and linked is what the officer wrote;
//   - written plainly: https:// or mailto: in lower case, then the address, with no spaces.
// Where only a web page will do (an event's or a venue's url), an email address is refused too.
// Every refusal carries a reason in plain words, for the officer who wrote it.
//
// Used by the markup (links and bare URLs in text) and by EventService writes (url, and the URLs
// in an occurrence's detail). The shared table (test/fixtures/url-rules.json) pins the answers,
// and linkcheck's suite checks the same table, so the two can never diverge. Reused by the link
// gate (A3b) and the event screens (E6).
// ============================================================================
import { CONTROLS, type KeptRefusal, MAX_URL_LENGTH, parseKept, trimTrailing } from './urls.js';

export type UrlRefusal = KeptRefusal | 'http' | 'not-plain' | 'not-web';

export interface UrlProblem {
  code: UrlRefusal;
  /** A sentence ending, after the address: "must start with https://, not http://". */
  reason: string;
}

export interface UrlRuleOptions {
  /** Whether a mailto: address may stand here (a link may; an event's web address may not). Default true. */
  mail?: boolean;
}

const REASONS: Record<UrlRefusal, string> = {
  http: 'must start with https://, not http://',
  'not-plain': 'must be written plainly: https:// or mailto: in lower case, and no spaces',
  'not-web': 'is an email address, but this needs a web address starting with https://',
  scheme: 'is not a web address starting with https:// or an email address starting with mailto:',
  credentials: 'has a user name or password in it (the part before an @), which is not allowed',
  port: 'names a port (a colon and a number after the site name), which is not allowed',
  'ip-literal': 'uses a number (an IP address) instead of a site name',
  'local-name': 'has no dot in its site name (a local name such as localhost)',
  'host-name': 'has a site name with characters that are not allowed (only letters, digits, dots and inner hyphens)',
  'too-long': `is longer than ${MAX_URL_LENGTH} characters`,
  control: 'has hidden characters in it, so type it again by hand',
  malformed: 'cannot be read as an address, so check it for typing mistakes',
};
const WWW_REASON = 'must be written in full, starting with https://';

/** https:// or mailto:, in lower case, then no white space: the address as written. */
const PLAIN = /^(?:https:\/\/|mailto:)\S+$/;

const refused = (code: UrlRefusal): UrlProblem => ({ code, reason: REASONS[code] });

/** Why `input` may not be saved as a URL, or null when it may. */
export function urlProblem(input: string, options: UrlRuleOptions = {}): UrlProblem | null {
  const parsed = parseKept(input);
  if (!parsed.ok) return refused(parsed.reason);
  const { scheme } = parsed.link;
  if (scheme === 'http') return /^\s*www\./i.test(input) ? { code: 'http', reason: WWW_REASON } : refused('http');
  if (scheme === 'mailto' && options.mail === false) return refused('not-web');
  if (!PLAIN.test(input)) return refused('not-plain');
  return null;
}

const SHOWN_MAX = 60;

/** A URL as a message shows it: hidden characters as "?", and at most 60 characters. */
export function shownUrl(url: string): string {
  const visible = url.replace(CONTROLS, '?');
  return visible.length > SHOWN_MAX ? `${visible.slice(0, SHOWN_MAX)}...` : visible;
}

/** The message for one refused URL: `the link "http://example.org/" must start with https://, not http://`. */
export const urlMessage = (what: 'the link' | 'the address', url: string, problem: UrlProblem): string => `${what} "${shownUrl(url)}" ${problem.reason}`;

/** A URL printed in text: http(s):// or www. up to white space or a quote (linkcheck extract.ts, the same pattern). */
export const URL_IN_TEXT = /(?:https?:\/\/|www\.)[^\s<>"'`]+/giu;

/**
 * Past this a found URL is far over the limit whatever punctuation trails it, so it is not trimmed
 * (trimTrailing counts brackets for each character it takes off: quadratic on a hostile run of them).
 */
const TRIM_MAX = MAX_URL_LENGTH + 16;

export interface TextUrl {
  url: string;
  /** Where the URL starts in the text. */
  index: number;
}

/** The bare URLs in `text`, each without the sentence punctuation after it. */
export function urlsInText(text: string): TextUrl[] {
  return [...text.matchAll(URL_IN_TEXT)].map((match) => ({
    url: match[0].length > TRIM_MAX ? match[0] : trimTrailing(match[0]),
    index: match.index,
  }));
}

export interface LineProblem {
  line: number;
  message: string;
}

/** Each bad bare URL in plain text (an occurrence's detail), with its line, counting from 1. */
export function textUrlProblems(text: string, options: UrlRuleOptions = {}): LineProblem[] {
  return text.split(/\r\n?|\n/).flatMap((lineText, index) =>
    urlsInText(lineText).flatMap(({ url }) => {
      const problem = urlProblem(url, options);
      return problem === null ? [] : [{ line: index + 1, message: urlMessage('the address', url, problem) }];
    }),
  );
}
