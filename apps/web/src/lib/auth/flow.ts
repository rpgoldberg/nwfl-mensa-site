// Sign-in, the callback and sign-out (W4), as plain steps the pages call. The
// callback takes a transaction only from this browser's own cookie, matches its
// state exactly, uses it once, within ten minutes, and has openid-client check
// the nonce. A refusal is told to the reader in plain words; what the provider
// said is never repeated, and only its error code (tidied) is logged.
import { timingSafeEqual } from 'node:crypto';
import { safeBack } from '../../../server/prefs.mjs';
import {
  AUTH_COOKIE,
  SESSION_COOKIE,
  type Session,
  TRANSACTION_SECONDS,
  clearCookie,
  newSession,
  openTransaction,
  readSession,
  sessionKey,
  sessionSetCookie,
  transactionSetCookie,
} from '../../../server/session.mjs';
import { authConfig, type AuthConfig, type AuthSetup } from '../../../server/auth-config.mjs';
import { PUBLIC_HOSTS } from '../../../server/public-hosts.mjs';
import { TokenStore, sharedTokenStore } from '../../../server/token-store.mjs';
import * as realOidc from './oidc';
import type { Tokens } from './oidc';

export type Refusal = 'expired' | 'mismatch' | 'used' | 'cancelled' | 'failed';

export const REFUSALS: Record<Refusal, string> = {
  expired: 'This sign-in took more than ten minutes, or was started in another window. Please start again.',
  mismatch: 'This sign-in does not match the one started in this browser. Please start again.',
  used: 'This sign-in has already been used. Please start again.',
  cancelled: 'Sign-in was cancelled. You can start again whenever you like.',
  failed: 'Something went wrong while signing you in. Please start again, and ask for help if it happens again.',
};

export type Outcome =
  /**
   * session: the one a completed sign-in has just opened (W-SIGNUP D3: the callback picks the first stop by it).
   * cache: the response's Cache-Control, when the redirect must never be stored (S2: to the profile's origin).
   */
  | { kind: 'redirect'; location: string; cookies: string[]; session?: Session; cache?: string }
  | { kind: 'refused'; reason: Refusal; cookies: string[] }
  | { kind: 'unavailable' };

/** States already used, until their transaction would have expired anyway. */
export class ConsumedStates {
  readonly #until = new Map<string, number>();
  constructor(private readonly cap = 10_000) {}
  add(state: string, until: number): void {
    if (this.#until.size >= this.cap) this.#until.delete(this.#until.keys().next().value as string);
    this.#until.set(state, until);
  }
  has(state: string, now: number): boolean {
    return (this.#until.get(state) ?? 0) > now;
  }
}

export interface Deps {
  setup: AuthSetup;
  key: Buffer | undefined;
  /** Seconds. */
  now: () => number;
  oidc: Pick<typeof realOidc, 'startSignIn' | 'finishSignIn' | 'endSessionUrl'>;
  tokens: TokenStore<Tokens>;
  consumed: ConsumedStates;
  log: (line: string) => void;
}

const log = (d: Deps, level: string, msg: string, extra: Record<string, unknown> = {}) => d.log(JSON.stringify({ level, msg, ...extra }));

const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const OURS = new Set(PUBLIC_HOSTS.map((h) => h.hostname));

/**
 * S2: where sign-in starts when the reader asked for /sign-in on another host. The session cookie is
 * host-only on the callback's origin, so sign-in starts there. In production that is the SITE_ORIGIN
 * profile's origin, and every other Host goes there: one of ours, an unlisted one, one with a
 * trailing dot, or none. Outside production only our listed hosts go to the callback's origin, and
 * a local run (localhost, any host not ours) signs in where it is, as does a callback that is not a
 * URL. undefined on the home host itself. Only that origin, a fixed path and a sanitised return go
 * in: never an open redirect.
 */
function signInElsewhere(config: AuthConfig, host: string | null | undefined, to: string, again: boolean): string | undefined {
  const asked = host?.trim().toLowerCase() ?? '';
  const name = /^[a-z0-9.-]+(:\d{1,5})?$/.test(asked) ? asked.split(':')[0] : undefined;
  let home: URL;
  try {
    home = new URL(config.siteOrigin ?? config.redirectUri);
  } catch {
    return undefined;
  }
  if (name === home.hostname) return undefined;
  if (config.siteOrigin === undefined && (name === undefined || !OURS.has(name))) return undefined;
  const params = new URLSearchParams();
  if (to !== '/') params.set('return', to);
  if (again) params.set('again', '1');
  const query = params.toString();
  return `${home.origin}/sign-in${query ? `?${query}` : ''}`;
}

/**
 * `again`: a fresh sign-in even for someone signed in, for a new token ("Sign in again" on /news, A14).
 * `host`: the Host the reader asked for (S2): on another host (signInElsewhere), sign-in starts on the profile's.
 */
export async function beginSignIn(
  d: Deps,
  { cookieHeader, back, again = false, host }: { cookieHeader: string | null | undefined; back: string | null | undefined; again?: boolean; host?: string | null | undefined },
): Promise<Outcome> {
  const now = d.now();
  if (!d.setup.enabled || !d.key) {
    log(d, 'error', 'sign-in is not set up', { reason: d.setup.enabled ? 'SESSION_KEY is not set' : d.setup.reason });
    return { kind: 'unavailable' };
  }
  const to = safeBack(back);
  const elsewhere = signInElsewhere(d.setup.config, host, to, again);
  if (elsewhere) return { kind: 'redirect', location: elsewhere, cookies: [], cache: 'private, no-store' };
  if (!again && readSession(cookieHeader, d.key, now, d.tokens)) return { kind: 'redirect', location: to, cookies: [] };
  try {
    const start = await d.oidc.startSignIn(d.setup.config);
    const tx = { state: start.state, nonce: start.nonce, verifier: start.verifier, back: to };
    return { kind: 'redirect', location: start.location.href, cookies: [transactionSetCookie(tx, d.key, now)] };
  } catch (error) {
    log(d, 'error', 'the sign-in provider could not be reached', { err: String(error).slice(0, 200) });
    return { kind: 'unavailable' };
  }
}

/**
 * The tokens with the time their access token expires (A14: the site forwards it only while it has time to live).
 * No expires_in, or a nonsense one, gives no expires_at: it is then never forwarded.
 */
function withExpiry(tokens: Tokens, now: number): Tokens {
  const life = tokens.expires_in;
  return typeof life === 'number' && Number.isFinite(life) && life > 0 ? { ...tokens, expires_at: now + life } : tokens;
}

export async function completeSignIn(d: Deps, { url, cookieHeader }: { url: URL; cookieHeader: string | null | undefined }): Promise<Outcome> {
  if (!d.setup.enabled || !d.key) return { kind: 'unavailable' };
  const now = d.now();
  const cookies = [clearCookie(AUTH_COOKIE)];
  const refuse = (reason: Refusal, extra: Record<string, unknown> = {}): Outcome => {
    log(d, 'warn', 'sign-in refused', { reason, ...extra });
    return { kind: 'refused', reason, cookies };
  };
  const tx = openTransaction(cookieHeader, d.key, now);
  if (!tx) return refuse('expired');
  const state = url.searchParams.get('state') ?? '';
  if (!sameText(state, tx.state)) return refuse('mismatch');
  if (d.consumed.has(state, now)) return refuse('used');
  d.consumed.add(state, tx.at + TRANSACTION_SECONDS);
  const error = url.searchParams.get('error');
  if (error !== null) {
    return refuse(error === 'access_denied' ? 'cancelled' : 'failed', { error: error.replace(/[^a-z_]/g, '').slice(0, 40) });
  }
  try {
    const signedIn = await d.oidc.finishSignIn(d.setup.config, url, tx);
    const session = newSession(signedIn.claims, now, d.setup.config.groupPrefix);
    // A session this sign-in replaces (signing in again) ends here, its record with it.
    const replaced = readSession(cookieHeader, d.key, now, d.tokens);
    if (replaced) d.tokens.take(replaced.sid, now);
    d.tokens.put(session.sid, withExpiry(signedIn.tokens, now), session.exp);
    log(d, 'info', 'signed in', { officer: session.officer, member: session.member });
    return { kind: 'redirect', location: tx.back, cookies: [...cookies, sessionSetCookie(session, d.key, now)], session };
  } catch (err) {
    return refuse('failed', { err: String(err).slice(0, 200) });
  }
}

/** Where sign-out sends the reader, with the cookies it expires. */
export interface SignedOut {
  location: string;
  cookies: string[];
}

/**
 * Sign out: our own cookies expire by name, the tokens go, and the reader goes
 * on to end the provider's session. No Clear-Site-Data at all (SIGNOUT):
 * "cookies" would clear the whole registered domain, the provider's cookies (on
 * the profile's issuer origin, server/auth-config.mjs) and the reader's text
 * size and theme; "cache" held the installed app's navigation while the browser
 * cleared, and there is nothing members-only to clear, as every such answer is
 * private, no-store (server/policy.mjs); "storage" has nothing to clear, as the
 * site keeps nothing in the browser's storage. e2e/signout.spec.ts pins both.
 */
export async function signOut(d: Deps, { cookieHeader }: { cookieHeader: string | null | undefined }): Promise<SignedOut> {
  const now = d.now();
  const done = { cookies: [clearCookie(SESSION_COOKIE), clearCookie(AUTH_COOKIE)], location: '/signed-out' };
  const session = d.key ? readSession(cookieHeader, d.key, now, d.tokens) : undefined;
  const idToken = session ? d.tokens.take(session.sid, now)?.id_token : undefined;
  if (!d.setup.enabled) return done;
  try {
    const end = await d.oidc.endSessionUrl(d.setup.config, { idToken });
    return end ? { ...done, location: end.href } : done;
  } catch (error) {
    log(d, 'warn', 'the sign-in provider could not be reached to end its session', { err: String(error).slice(0, 200) });
    return done;
  }
}

/** The real dependencies, from the server's environment. */
export function depsFromEnv(env: Record<string, string | undefined>, logLine: (line: string) => void = console.log): Deps {
  let key: Buffer | undefined;
  try {
    key = sessionKey(env);
  } catch (error) {
    logLine(JSON.stringify({ level: 'error', msg: String(error) }));
  }
  return { setup: authConfig(env), key, now: () => Math.floor(Date.now() / 1000), oidc: realOidc, tokens: SHARED.tokens, consumed: SHARED.consumed, log: logLine };
}

const SHARED = { tokens: sharedTokenStore() as TokenStore<Tokens>, consumed: new ConsumedStates() };

let runtime: Deps | undefined;

/** The server's own dependencies, read from its environment once. */
export function runtimeDeps(): Deps {
  runtime ??= depsFromEnv(process.env);
  return runtime;
}
