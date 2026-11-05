// ============================================================================
// The registration date (SPEC D4): RDAP, no key needed. The server comes from the IANA bootstrap
// file; only an https server is used. The date read is the latest "registration" or
// "reregistration" event: one after the issue date means the domain was likely bought by someone
// else since (the infested-wasteland case). A TLD with no RDAP, a domain the registry does not
// know, or an answer that cannot be read is "unknown": noted, never flagged. Every request goes
// through follow() (net.ts), so the registry and IANA get the same SSRF guards as any link.
// One bootstrap per run, one answer per domain.
// ============================================================================
import { getDomain } from 'tldts';
import { type NetDeps, follow } from './net.js';

export const RDAP_BOOTSTRAP = 'https://data.iana.org/rdap/dns.json';
const BOOTSTRAP_BYTES = 1024 * 1024;

export type RdapResult = { status: 'dated'; date: string } | { status: 'unknown'; why: 'no-rdap' | 'not-found' | 'error' };

export interface Rdap {
  registered(domain: string): Promise<RdapResult>;
}

/** The domain a registry holds: the ICANN registrable domain (a private suffix such as github.io is not a registry). */
export const rdapDomain = (host: string): string | undefined => getDomain(host) ?? undefined;

type Services = Map<string, string>;

function servicesOf(text: string | undefined): Services | undefined {
  try {
    const json = JSON.parse(text ?? '') as { services?: unknown };
    if (!Array.isArray(json.services)) return undefined;
    const out: Services = new Map();
    for (const entry of json.services as unknown[]) {
      if (!Array.isArray(entry) || !Array.isArray(entry[0]) || !Array.isArray(entry[1])) return undefined;
      const base = (entry[1] as unknown[]).find((u): u is string => typeof u === 'string' && u.startsWith('https://'));
      for (const tld of entry[0] as unknown[]) if (typeof tld === 'string' && base !== undefined) out.set(tld.toLowerCase(), base.endsWith('/') ? base : `${base}/`);
    }
    return out;
  } catch {
    return undefined;
  }
}

function latestRegistration(text: string | undefined): string | undefined {
  try {
    const events = (JSON.parse(text ?? '') as { events?: unknown }).events;
    if (!Array.isArray(events)) return undefined;
    const dates = events
      .filter((e): e is { eventAction: string; eventDate: string } => typeof e === 'object' && e !== null && ['registration', 'reregistration'].includes((e as { eventAction?: unknown }).eventAction as string) && typeof (e as { eventDate?: unknown }).eventDate === 'string')
      .map((e) => Date.parse(e.eventDate))
      .filter((t) => Number.isFinite(t));
    return dates.length === 0 ? undefined : new Date(Math.max(...dates)).toISOString().slice(0, 10);
  } catch {
    return undefined;
  }
}

export function makeRdap(net: NetDeps, options: { bootstrapUrl?: string } = {}): Rdap {
  let services: Promise<Services | undefined> | undefined;
  const answers = new Map<string, Promise<RdapResult>>();
  const bootstrap = (): Promise<Services | undefined> =>
    (services ??= follow(options.bootstrapUrl ?? RDAP_BOOTSTRAP, net, { accept: 'application/json', bodyBytes: BOOTSTRAP_BYTES }).then((got) =>
      got.final.status === 200 ? servicesOf(got.body) : undefined,
    ));
  const ask = async (domain: string): Promise<RdapResult> => {
    const base = (await bootstrap())?.get(domain.slice(domain.lastIndexOf('.') + 1));
    if (base === undefined) return { status: 'unknown', why: 'no-rdap' };
    const got = await follow(`${base}domain/${domain}`, net, { accept: 'application/rdap+json' });
    if (got.final.status === 404) return { status: 'unknown', why: 'not-found' };
    const date = got.final.status === 200 ? latestRegistration(got.body) : undefined;
    return date === undefined ? { status: 'unknown', why: 'error' } : { status: 'dated', date };
  };
  return {
    registered: (domain) => {
      let answer = answers.get(domain);
      if (answer === undefined) answers.set(domain, (answer = ask(domain)));
      return answer;
    },
  };
}
