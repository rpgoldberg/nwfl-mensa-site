// ============================================================================
// Parked or for-sale domains (SPEC D4), from several signals; any one means drop, and the editor confirms:
//   - parking-ns     the domain's nameservers are a parking provider's;
//   - marketplace    the final page is on a domain marketplace;
//   - for-sale-text  the page's visible text says the domain is for sale or parked;
//   - parking-feed   a near-empty page that only loads a parking ad feed.
// The page is read as text only (tags, scripts, styles and comments stripped by a linear scan), never run.
// The lists are a starting set, meant to grow as the editor's answers show what they miss.
// ============================================================================
import { hostIsUnder } from './urls.js';

export type ParkedSignal = 'parking-ns' | 'marketplace' | 'for-sale-text' | 'parking-feed';

export const PARKING_NS = ['sedoparking.com', 'parkingcrew.net', 'bodis.com', 'above.com', 'parklogic.com', 'ztomy.com', 'dan.com', 'afternic.com'];
export const MARKETPLACES = ['sedo.com', 'dan.com', 'afternic.com', 'hugedomains.com', 'buydomains.com', 'undeveloped.com', 'atom.com', 'squadhelp.com', 'brandbucket.com'];
/** A marketplace that is also an ordinary site: only these paths. */
const MARKETPLACE_PATHS: readonly [string, RegExp][] = [['godaddy.com', /^\/(forsale|domainsearch\/find)\b/i]];
const FOR_SALE = [
  /\bthis domain (name )?(is|may be) for sale\b/i,
  /\bthe domain \S+ (is|may be) for sale\b/i,
  /\bbuy this domain\b/i,
  /\bmake an offer on this domain\b/i,
  /\b(this )?(web )?page is parked\b/i,
  /\bparked free\b/i,
  /\bdomain (is )?parked\b/i,
];
const FEEDS = [/\/\/(www\.)?google\.com\/adsense\/domains\/caf\.js/i, /parkingcrew/i, /sedoparking/i, /bodis\.com/i, /parklogic/i];
const NEAR_EMPTY = 200;

const RAW_TEXT = ['script', 'style', 'noscript', 'template'];

/**
 * The visible text of a page, by one linear scan (N2: the earlier patterns took seconds on a hostile
 * 256 KiB body such as "<" repeated). Comments, tags and raw-text elements (script, style, noscript,
 * template) become a space; one left open runs to the end of the body, as a browser reads it. Every
 * search starts where the last one stopped and a failed search ends the scan, so no byte is read twice.
 */
function visible(html: string): string {
  // ASCII only (S4): a full Unicode lower-casing can change the length (U+0130 becomes two code units),
  // and the indices found in it are used on the body. Tag names are ASCII; the phrases match with /i.
  const lower = html.replace(/[A-Z]/g, (c) => c.toLowerCase());
  let out = '';
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf('<', at);
    if (open === -1) {
      out += html.slice(at);
      break;
    }
    out += `${html.slice(at, open)} `;
    let end: number;
    if (lower.startsWith('<!--', open)) {
      const close = lower.indexOf('-->', open + 4);
      end = close === -1 ? html.length : close + 3;
    } else {
      const name = RAW_TEXT.find((n) => lower.startsWith(n, open + 1) && !/[a-z0-9-]/.test(lower.charAt(open + 1 + n.length)));
      const close = name === undefined ? -1 : lower.indexOf(`</${name}`, open + 1);
      const from = name === undefined ? open : close;
      const gt = from === -1 ? -1 : lower.indexOf('>', from);
      end = gt === -1 ? html.length : gt + 1;
    }
    at = end;
  }
  return out.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A title that says the page is missing, or that names a server's or host's stock page. */
const STOCK_TITLE = /\b(not found|404|410|gone|no longer|does ?n[o']?t exist|error|welcome to nginx|it works|default (web )?(site )?page|test page|index of|account suspended|site not found|not configured|coming soon|under construction)\b/i;
const MAX_TITLE = 1024;

/**
 * LINKS-REMEMBER (b): whether a 404 or 410 body still looks like a real page: a title of its own (not a
 * "not found" or a server's or host's stock title) and a non-trivial visible text. Parked and for-sale
 * pages are caught by parkedSignals first; this reads the body as data only, by the same linear scan.
 */
export function showsPage(body: string | undefined): boolean {
  if (body === undefined) return false;
  const lower = body.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const open = lower.indexOf('<title');
  const start = open === -1 ? -1 : lower.indexOf('>', open);
  const close = start === -1 ? -1 : lower.indexOf('</title', start);
  if (close === -1) return false;
  const title = body.slice(start + 1, Math.min(close, start + 1 + MAX_TITLE)).replace(/\s+/g, ' ').trim();
  if (title === '' || STOCK_TITLE.test(title)) return false;
  return visible(body).length - title.length >= NEAR_EMPTY;
}

export interface ParkedInput {
  ns?: readonly string[];
  finalUrl?: string;
  body?: string;
}

export function parkedSignals(input: ParkedInput): ParkedSignal[] {
  const out: ParkedSignal[] = [];
  if ((input.ns ?? []).some((ns) => PARKING_NS.some((p) => hostIsUnder(ns.toLowerCase().replace(/\.$/, ''), p)))) out.push('parking-ns');
  if (input.finalUrl !== undefined) {
    const url = new URL(input.finalUrl);
    const host = url.hostname;
    if (MARKETPLACES.some((m) => hostIsUnder(host, m)) || MARKETPLACE_PATHS.some(([m, path]) => hostIsUnder(host, m) && path.test(url.pathname))) out.push('marketplace');
  }
  if (input.body !== undefined) {
    const text = visible(input.body);
    if (FOR_SALE.some((p) => p.test(text))) out.push('for-sale-text');
    else if (text.length < NEAR_EMPTY && FEEDS.some((p) => p.test(input.body as string))) out.push('parking-feed');
  }
  return out;
}
