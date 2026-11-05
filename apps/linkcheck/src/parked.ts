// ============================================================================
// Parked or for-sale domains (SPEC D4), from several signals; any one means drop, and Ross confirms:
//   - parking-ns     the domain's nameservers are a parking provider's;
//   - marketplace    the final page is on a domain marketplace;
//   - for-sale-text  the page's visible text says the domain is for sale or parked;
//   - parking-feed   a near-empty page that only loads a parking ad feed.
// The page is read as text only (tags, scripts, styles and comments stripped by pattern), never run.
// The lists are a starting set, meant to grow as Ross's answers show what they miss.
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

const visible = (html: string): string =>
  html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

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
