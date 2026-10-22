// Sign-in, the callback and sign-out (W4), as plain steps the pages call. The
// callback takes a transaction only from this browser's own cookie, matches its
// state exactly, uses it once, within ten minutes, and has openid-client check
// the nonce. A refusal is told to the reader in plain words; what the provider
// said is never repeated, and only its error code (tidied) is logged. Sign-out
// ends the provider's session before it clears the site's cookies.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readCookie } from '../../../server/cookies.mjs';
import { prefsCookies, readPrefs, safeBack, SIZE_COOKIE, THEME_COOKIE } from '../../../server/prefs.mjs';
import {
  AUTH_COOKIE,
  OUT_COOKIE,
  SESSION_COOKIE,
  TRANSACTION_SECONDS,
  clearCookie,
  hostOnly,
  newSession,
  openTransaction,
  openValue,
  readSession,
  sealValue,
  sessionKey,
  sessionSetCookie,
  transactionSetCookie,
} from '../../../server/session.mjs';
import { authConfig, type AuthSetup } from '../../../server/auth-config.mjs';
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

export const CLEAR_SITE_DATA = '"cookies", "storage"';
/** This origin's storage only: cookies wait until the provider has ended its session. */
export const CLEAR_STORAGE = '"storage"';

export type Outcome =
  | { kind: 'redirect'; location: string; cookies: string[]; clearSiteData?: string }
  | { kind: 'refused'; reason: Refusal; cookies: string[] }
  | { kind: 'unavailable' };

/** Server-side token store: by session id, until the session ends, at most `cap` sessions. */
export class TokenStore {
  readonly #entries = new Map<string, { tokens: Tokens; until: number }>();
  constructor(private readonly cap = 10_000) {}
  put(sid: string, tokens: Tokens, until: number): void {
    if (this.#entries.size >= this.cap) this.#entries.delete(this.#entries.keys().next().value as string);
    this.#entries.set(sid, { tokens, until });
  }
  get(sid: string, now: number): Tokens | undefined {
    const entry = this.#entries.get(sid);
    if (entry && entry.until > now) return entry.tokens;
    this.#entries.delete(sid);
    return undefined;
  }
  take(sid: string, now: number): Tokens | undefined {
    const tokens = this.get(sid, now);
    this.#entries.delete(sid);
    return tokens;
  }
}

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
  tokens: TokenStore;
  consumed: ConsumedStates;
  log: (line: string) => void;
}

const log = (d: Deps, level: string, msg: string, extra: Record<string, unknown> = {}) => d.log(JSON.stringify({ level, msg, ...extra }));

const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function beginSignIn(d: Deps, { cookieHeader, back }: { cookieHeader: string | null | undefined; back: string | null | undefined }): Promise<Outcome> {
  const now = d.now();
  if (!d.setup.enabled || !d.key) {
    log(d, 'error', 'sign-in is not set up', { reason: d.setup.enabled ? 'SESSION_KEY is not set' : d.setup.reason });
    return { kind: 'unavailable' };
  }
  const to = safeBack(back);
  if (readSession(cookieHeader, d.key, now)) return { kind: 'redirect', location: to, cookies: [] };
  try {
    const start = await d.oidc.startSignIn(d.setup.config);
    const tx = { state: start.state, nonce: start.nonce, verifier: start.verifier, back: to };
    return { kind: 'redirect', location: start.location.href, cookies: [transactionSetCookie(tx, d.key, now)] };
  } catch (error) {
    log(d, 'error', 'the sign-in provider could not be reached', { err: String(error).slice(0, 200) });
    return { kind: 'unavailable' };
  }
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
    const session = newSession(signedIn.claims, now);
    d.tokens.put(session.sid, signedIn.tokens, session.exp);
    log(d, 'info', 'signed in', { officer: session.officer, member: session.member });
    return { kind: 'redirect', location: tx.back, cookies: [...cookies, sessionSetCookie(session, d.key, now)] };
  } catch (err) {
    return refuse('failed', { err: String(err).slice(0, 200) });
  }
}

/** Where sign-out sends the reader, with what it clears. */
export interface SignedOut {
  location: string;
  cookies: string[];
  clearSiteData: string;
}

/**
 * Sign out: the session and its tokens go now, and the reader goes on to end
 * the provider's session. Clear-Site-Data "cookies" waits for the way back
 * (landSignedOut): it clears the whole registered domain, the provider's
 * cookies too (login.nwflorida.us), which would leave it no session to end.
 */
export async function signOut(d: Deps, { cookieHeader }: { cookieHeader: string | null | undefined }): Promise<SignedOut> {
  const now = d.now();
  const cookies = [clearCookie(SESSION_COOKIE), clearCookie(AUTH_COOKIE)];
  if (!d.key) return { cookies, clearSiteData: CLEAR_SITE_DATA, location: '/signed-out' };
  const session = readSession(cookieHeader, d.key, now);
  const idToken = session ? d.tokens.take(session.sid, now)?.id_token : undefined;
  // The way back carries the reader's text size and theme, sealed and
  // short-lived, and is bound to this browser by the out cookie.
  const out = randomBytes(18).toString('base64url');
  const state = sealValue({ prefs: readPrefs(cookieHeader), out, exp: now + TRANSACTION_SECONDS }, d.key, 'signed-out');
  let location = `/signed-out?state=${state}`;
  if (d.setup.enabled) {
    try {
      const end = await d.oidc.endSessionUrl(d.setup.config, { idToken, state });
      if (end) location = end.href;
    } catch (error) {
      log(d, 'warn', 'the sign-in provider could not be reached to end its session', { err: String(error).slice(0, 200) });
    }
  }
  return { cookies: [...cookies, hostOnly(OUT_COOKIE, out, TRANSACTION_SECONDS)], clearSiteData: CLEAR_STORAGE, location };
}

type Landing = { kind: 'redirect'; location: string; cookies: string[]; clearSiteData?: string } | { kind: 'page' };

interface SignedOutState {
  prefs?: { size?: unknown; theme?: unknown };
  out?: unknown;
  exp?: unknown;
}

function openSignedOut(d: Deps, state: string): SignedOutState | undefined {
  const sealed = d.key ? (openValue(state, d.key, 'signed-out') as SignedOutState | undefined) : undefined;
  return sealed && typeof sealed.exp === 'number' && sealed.exp > d.now() ? sealed : undefined;
}

/**
 * Back from the provider's sign-out, in three steps: with `state`, clear every
 * cookie and storage, but only in the browser that signed out (a link from
 * elsewhere signs no one out); with `restore`, set text size and theme again;
 * then the page itself.
 */
export function landSignedOut(d: Deps, { url, cookieHeader }: { url: URL; cookieHeader: string | null | undefined }): Landing {
  const plain = { kind: 'redirect' as const, location: '/signed-out', cookies: [] };
  const state = url.searchParams.get('state');
  if (state !== null) {
    const out = openSignedOut(d, state)?.out;
    const bound = readCookie(cookieHeader, OUT_COOKIE);
    if (typeof out !== 'string' || !bound || !sameText(bound, out)) return plain;
    return { ...plain, location: `/signed-out?restore=${encodeURIComponent(state)}`, cookies: [clearCookie(OUT_COOKIE)], clearSiteData: CLEAR_SITE_DATA };
  }
  const restore = url.searchParams.get('restore');
  if (restore !== null) {
    const prefs = openSignedOut(d, restore)?.prefs;
    // Read back through the cookie parser, so only a size and theme it knows pass.
    return { ...plain, cookies: prefs ? prefsCookies(readPrefs(`${SIZE_COOKIE}=${prefs.size}; ${THEME_COOKIE}=${prefs.theme}`)) : [] };
  }
  return { kind: 'page' };
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

const SHARED = { tokens: new TokenStore(), consumed: new ConsumedStates() };

let runtime: Deps | undefined;

/** The server's own dependencies, read from its environment once. */
export function runtimeDeps(): Deps {
  runtime ??= depsFromEnv(process.env);
  return runtime;
}
