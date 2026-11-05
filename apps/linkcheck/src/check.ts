// ============================================================================
// check (SPEC D4 step 2): one verdict per link, with its reason codes, the chain it followed, and the
// URL to keep if it is kept. Runs with a network but no PDF.
//
// Verdicts, most severe first: drop (removed unless Ross says yes), flag (Ross decides), review (the
// no-fetch list: "not checked: officer review"), confirm (a login-walled host: Ross's own yes), upgrade
// (kept, rewritten to https or trimmed), ok. A link is kept by default only when ok or upgrade; every
// other verdict needs Ross's yes, and some reasons cannot be kept at all (keepable: false): no https,
// a private address, a URL that does not parse or breaks the scheme, port or credentials rules.
//
// In order:
//   - hygiene: trailing sentence punctuation and stray spaces trimmed; the trimmed form is used if it
//     works, else the form as written is tried;
//   - the no-fetch list: no request of any kind, not even DNS (Binding additions, 11-04);
//   - login-walled hosts: DNS only, never fetched; kept at https;
//   - the link must be keepable as written (urls.ts parseKept, the contract with L2): no port, no IP
//     literal, no dotless host, no userinfo; a mailto keeps only its one address, its query dropped;
//   - http: only its https form is ever fetched (Ross: always https). If it fails at the transport, or
//     answers with a final status outside 2xx, the link has no https and is dropped;
//   - the status and the chain; an unrelated redirect (another registrable domain, by the Public
//     Suffix List; www to apex and http to https on one site are related); a redirect down to http;
//   - parked or for sale (parked.ts), with the nameservers of the registrable domain;
//   - the registration date (rdap.ts): one after the issue date is flagged re-registered;
//   - mailto: an MX, or A/AAAA as the fallback; a null MX takes no mail.
// Safe Browsing (Q4) is off until a key exists; every fetched web link notes it, since no hit is
// no evidence either way. A page's body is read only by parkedSignals, as data.
// ============================================================================
import { DnsFailure, resolveAddresses } from './dns.js';
import { type Fetched, type HopFailure, type NetDeps, follow } from './net.js';
import { type ParkedSignal, parkedSignals } from './parked.js';
import { type Rdap, rdapDomain } from './rdap.js';
import { type Kind, type ParsedLink, isLoginWalled, isNoFetch, keptUrl, parseKept, registrableDomain, trimTrailing } from './urls.js';

export const VERDICTS = ['ok', 'upgrade', 'confirm', 'review', 'flag', 'drop'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Each reason, its verdict, whether a yes can keep it, and the suggested fix the sheet shows. */
export const REASONS = {
  'no-https': ['drop', false, 'No https version answers; find an https page or remove the link.'],
  'private-address': ['drop', false, 'It points into a private network; it cannot be kept.'],
  malformed: ['drop', false, 'The address cannot be read; correct it by hand or remove the link.'],
  scheme: ['drop', false, 'Only web (https) and email links are kept.'],
  port: ['drop', false, 'It names a port (even 80 or 443); remove the port, or the link.'],
  credentials: ['drop', false, 'It carries a user name or password; it cannot be kept.'],
  'ip-literal': ['drop', false, 'It names a bare IP address instead of a site name; it cannot be kept.'],
  'local-name': ['drop', false, 'Its host has no dot (a local name such as localhost); it cannot be kept.'],
  'too-long': ['drop', false, 'It is over 2048 characters; it cannot be kept.'],
  control: ['drop', false, 'It holds hidden control characters; it cannot be kept.'],
  nxdomain: ['drop', true, 'No such domain; check the spelling.'],
  'no-address': ['drop', true, 'The domain has no web address any more.'],
  dead: ['drop', true, 'The page is gone (404 or 410); find where it moved or remove the link.'],
  parked: ['drop', true, 'The domain looks parked or for sale; it may belong to someone else now.'],
  'no-mail': ['drop', true, 'That domain takes no email.'],
  blocked: ['flag', true, 'The site refused the checker (401 or 403); open it yourself.'],
  'rate-limited': ['flag', true, 'The site asked the checker to slow down (429); try again later or open it yourself.'],
  'server-error': ['flag', true, 'The site had an error (5xx); try again later.'],
  'http-error': ['flag', true, 'The site gave an unexpected answer; open it yourself.'],
  timeout: ['flag', true, 'The site did not answer in time; try again later.'],
  tls: ['flag', true, 'The secure connection failed (certificate or TLS); open it yourself.'],
  unreachable: ['flag', true, 'The site could not be reached; try again later.'],
  protocol: ['flag', true, 'The site did not answer as a web server; open it yourself.'],
  'dns-failure': ['flag', true, 'The name could not be looked up just now; try again later.'],
  'unrelated-redirect': ['flag', true, 'It now leads to another site; check that it is the right one.'],
  'redirect-to-http': ['flag', true, 'It redirects to a plain http page.'],
  'bad-redirect': ['flag', true, 'It redirects somewhere a link may not go.'],
  'too-many-redirects': ['flag', true, 'It redirects more than five times.'],
  're-registered': ['flag', true, 'The domain was registered again after the issue date; it may belong to someone else now.'],
  'login-walled': ['confirm', true, 'Not fetched (it needs a sign-in); open it yourself and answer yes or no.'],
  'no-fetch': ['review', true, 'Not checked: officer review.'],
  upgraded: ['upgrade', true, 'Kept at https.'],
  trimmed: ['upgrade', true, 'Kept without the stray punctuation or spaces.'],
} as const satisfies Record<string, readonly [Verdict, boolean, string]>;
export type Reason = keyof typeof REASONS;

export const NOTES = ['https-assumed', 'mx-fallback', 'rdap-unknown', 'rdap-not-found', 'safe-browsing-off', 'parking-ns', 'marketplace', 'for-sale-text', 'parking-feed'] as const;
export type Note = (typeof NOTES)[number];

export interface ChainHop {
  url: string;
  status?: number;
}

export interface CheckResult {
  /** The URL as extracted. */
  url: string;
  kind?: Kind;
  verdict: Verdict;
  reasons: Reason[];
  notes: Note[];
  /** Whether Ross's yes can keep it. */
  keepable: boolean;
  /** The URL to keep (https, or mailto), if any. */
  kept?: string;
  chain: ChainHop[];
  finalUrl?: string;
  /** The latest registration date RDAP gave, YYYY-MM-DD. */
  registered?: string;
  fix?: string;
}

export interface CheckDeps extends NetDeps {
  /** YYYY-MM-DD: a registration after it is flagged. */
  issueDate: string;
  rdap?: Rdap;
}

const SEVERITY: Record<Verdict, number> = { ok: 0, upgrade: 1, confirm: 2, review: 3, flag: 4, drop: 5 };
const verdictOf = (reason: Reason): Verdict => REASONS[reason][0];

function result(url: string, kind: Kind | undefined, reasons: Reason[], extra: Partial<CheckResult> = {}): CheckResult {
  const sorted = [...new Set(reasons)].sort((a, b) => SEVERITY[verdictOf(b)] - SEVERITY[verdictOf(a)]);
  const verdict = sorted.reduce<Verdict>((worst, r) => (SEVERITY[verdictOf(r)] > SEVERITY[worst] ? verdictOf(r) : worst), 'ok');
  const out: CheckResult = { url, ...(kind === undefined ? {} : { kind }), verdict, reasons: sorted, notes: extra.notes ?? [], keepable: false, chain: extra.chain ?? [] };
  if (extra.kept !== undefined) out.kept = extra.kept;
  out.keepable = out.kept !== undefined && sorted.every((r) => REASONS[r][1]);
  if (extra.finalUrl !== undefined) out.finalUrl = extra.finalUrl;
  if (extra.registered !== undefined) out.registered = extra.registered;
  const first = sorted[0];
  if (first !== undefined) out.fix = REASONS[first][2];
  return out;
}

/** Trailing sentence punctuation and stray spaces trimmed: a URL never holds a raw space. */
export const hygiene = (raw: string): string => trimTrailing(raw.replace(/\s+/g, ''));

const TRANSPORT: readonly HopFailure[] = ['tls', 'unreachable', 'timeout', 'protocol'];
const UNREADABLE: readonly HopFailure[] = ['scheme', 'port', 'credentials', 'malformed', 'too-long', 'control'];
const NOT_THERE: readonly HopFailure[] = ['nxdomain', 'nodata', 'private-address', 'no-fetch', 'login-walled'];

const is2xx = (status: number): boolean => status >= 200 && status <= 299;

function evaluate(fetched: Fetched, origin: string): Reason[] {
  const { failure } = fetched;
  if (failure !== undefined) {
    if (failure === 'nodata') return ['no-address'];
    if (UNREADABLE.includes(failure)) return fetched.hops.length > 1 ? ['bad-redirect'] : [failure];
    return [failure];
  }
  const reasons: Reason[] = [];
  const status = fetched.final.status as number;
  if (status === 404 || status === 410) reasons.push('dead');
  else if (status === 401 || status === 403) reasons.push('blocked');
  else if (status === 429) reasons.push('rate-limited');
  else if (status >= 500 && status <= 599) reasons.push('server-error');
  else if (!is2xx(status)) reasons.push('http-error');
  if (fetched.downgraded) reasons.push('redirect-to-http');
  const final = new URL(fetched.final.url).hostname.replace(/^\[(.*)\]$/, '$1');
  if (fetched.hops.length > 1 && registrableDomain(final) !== registrableDomain(origin)) reasons.push('unrelated-redirect');
  return reasons;
}

const works = (r: CheckResult): boolean => r.verdict === 'ok' || r.verdict === 'upgrade';

export interface Checker {
  check(raw: string): Promise<CheckResult>;
}

export function makeChecker(deps: CheckDeps): Checker {
  const nsCache = new Map<string, Promise<string[]>>();
  const rdapCache = new Map<string, ReturnType<Rdap['registered']>>();
  const nsOf = (domain: string): Promise<string[]> => {
    let got = nsCache.get(domain);
    if (got === undefined) nsCache.set(domain, (got = deps.dns.resolveNs(domain).catch(() => [])));
    return got;
  };
  const registered = (rdap: Rdap, domain: string): ReturnType<Rdap['registered']> => {
    let got = rdapCache.get(domain);
    if (got === undefined) rdapCache.set(domain, (got = rdap.registered(domain)));
    return got;
  };

  async function mail(raw: string, link: ParsedLink): Promise<CheckResult> {
    const kept = link.url;
    if (isNoFetch(link.host)) return result(raw, 'mail', ['no-fetch'], { kept });
    try {
      const mx = await deps.dns.resolveMx(link.host);
      // A null MX (RFC 7505) says the domain takes no mail.
      if (mx.length > 0) return result(raw, 'mail', mx.every((m) => m.exchange === '' || m.exchange === '.') ? ['no-mail'] : [], { kept });
    } catch (error) {
      const code = error instanceof DnsFailure ? error.code : 'servfail';
      if (code === 'nxdomain') return result(raw, 'mail', ['nxdomain'], { kept });
      if (code !== 'nodata') return result(raw, 'mail', ['dns-failure'], { kept });
    }
    const resolved = await resolveAddresses(link.host, deps.dns);
    if (resolved.ok) return result(raw, 'mail', [], { kept, notes: ['mx-fallback'] });
    if (resolved.reason === 'nxdomain') return result(raw, 'mail', ['nxdomain'], { kept });
    if (resolved.reason === 'dns-failure') return result(raw, 'mail', ['dns-failure'], { kept });
    return result(raw, 'mail', ['no-mail'], { kept });
  }

  async function web(raw: string, link: ParsedLink): Promise<CheckResult> {
    const https = keptUrl(link);
    if (isNoFetch(link.host)) return result(raw, 'web', ['no-fetch'], { kept: https });
    const notes: Note[] = [];
    if (isLoginWalled(link.host)) {
      const resolved = await resolveAddresses(link.host, deps.dns);
      if (!resolved.ok) return result(raw, 'web', [resolved.reason === 'nodata' ? 'no-address' : resolved.reason], { kept: https });
      return result(raw, 'web', ['login-walled'], { kept: https, notes: link.scheme === 'http' ? ['https-assumed'] : [] });
    }
    const fetched = await follow(https, deps);
    const reasons = evaluate(fetched, link.host);
    let kept: string | undefined = https;
    if (link.scheme === 'http') {
      // Only a working https answer upgrades: a transport failure or any final status outside 2xx
      // means the https form does not work, so the link has no https (N3; Ross: always https).
      const noHttps = fetched.failure === undefined ? !is2xx(fetched.final.status as number) : TRANSPORT.includes(fetched.failure);
      if (reasons.length === 0) reasons.unshift('upgraded');
      else if (noHttps) {
        reasons.unshift('no-https');
        kept = undefined;
      }
    }
    let registeredOn: string | undefined;
    const domain = rdapDomain(link.host);
    if (domain !== undefined && !(fetched.failure !== undefined && NOT_THERE.includes(fetched.failure))) {
      const signals: ParkedSignal[] = parkedSignals({
        ns: await nsOf(domain),
        ...(fetched.failure === undefined ? { finalUrl: fetched.final.url } : {}),
        ...(fetched.body === undefined ? {} : { body: fetched.body }),
      });
      if (signals.length > 0) reasons.push('parked');
      notes.push(...signals);
      if (deps.rdap) {
        const answer = await registered(deps.rdap, domain);
        if (answer.status === 'dated') {
          registeredOn = answer.date;
          if (answer.date > deps.issueDate) reasons.push('re-registered');
        } else notes.push(answer.why === 'not-found' ? 'rdap-not-found' : 'rdap-unknown');
      }
    }
    notes.push('safe-browsing-off');
    return result(raw, 'web', reasons, {
      ...(kept === undefined ? {} : { kept }),
      notes,
      chain: fetched.hops.map((h) => (h.status === undefined ? { url: h.url } : { url: h.url, status: h.status })),
      ...(fetched.failure === undefined ? { finalUrl: fetched.final.url } : {}),
      ...(registeredOn === undefined ? {} : { registered: registeredOn }),
    });
  }

  async function one(raw: string, candidate: string): Promise<CheckResult> {
    const parsed = parseKept(candidate);
    if (!parsed.ok) return result(raw, undefined, [parsed.reason]);
    return parsed.link.kind === 'mail' ? mail(raw, parsed.link) : web(raw, parsed.link);
  }

  return {
    async check(raw) {
      const trimmed = hygiene(raw);
      const first = await one(raw, trimmed);
      if (trimmed === raw) return first;
      if (works(first)) return result(raw, first.kind, [...first.reasons, 'trimmed'], first);
      const asWritten = await one(raw, raw);
      return works(asWritten) ? asWritten : first;
    },
  };
}

/** Each distinct URL checked once, in the order first seen, `concurrency` at a time, sharing one checker's caches. */
export async function checkAll(urls: readonly string[], deps: CheckDeps, concurrency = 4): Promise<CheckResult[]> {
  const unique = [...new Set(urls)];
  const checker = makeChecker(deps);
  const out: CheckResult[] = new Array<CheckResult>(unique.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < unique.length) {
      const i = next;
      next += 1;
      out[i] = await checker.check(unique[i] as string);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, unique.length)) }, lane));
  return out;
}
