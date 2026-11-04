// A14 (S5a): the signed-in reader whose access token the site may forward to
// the API, on the news reads only (src/lib/api/client.ts). The API decides
// what the token may see (apps/api/src/auth/caller.ts); the site decides only
// whether to send it: for a valid session with its record on the server, and
// a token that is one RFC 6750 b64token with more than 30 seconds to live.
// There is no refresh (the provider grants no offline_access, and the API
// takes a site token for an hour at most): past that, the reader gets the
// public view, and the page says to sign in again. D4 with AC6 (b): the reader
// carries whether the session's groups claim holds an nwfl enrolee group
// (session.enrolee, server/session.mjs: nwfl-users, or nwfl-members set by
// hand; an officers group alone is not one), and the news reads send the token
// only when it does (src/data/live.ts); member standing is the API's to say.
// A session with no enrolee group never has its token sent, so its token's
// expiry is never news to it: the page says the account has no member access.
import type { AuthSetup } from '../../../server/auth-config.mjs';
import type { Session } from '../../../server/session.mjs';
import type { TokenStore } from '../../../server/token-store.mjs';
import { type Reader, sendable } from '../api/client';
import type { Tokens } from './oidc';

/** A token this close to its expiry is not sent: it could lapse on the way. */
export const EXPIRY_MARGIN_SECONDS = 30;

export interface ReaderDeps {
  tokens: Pick<TokenStore<Tokens>, 'get'>;
  /** Seconds. */
  now: () => number;
}

/** The reader to send, if any; lapsed when an enrolee's session is there but its token has run out (sign in again). */
export function readerFor(session: Session | undefined, { tokens, now }: ReaderDeps): { reader: Reader | undefined; lapsed: boolean } {
  const at = now();
  if (session === undefined || session.exp <= at) return { reader: undefined, lapsed: false };
  const record = tokens.get(session.sid, at);
  const expiresAt = record?.expires_at;
  if (record === undefined || record.access_token === '' || typeof expiresAt !== 'number' || Number.isNaN(expiresAt)) return { reader: undefined, lapsed: false };
  // D4: whether the groups claim holds an nwfl enrolee group goes with the reader; anything but true is no.
  const enrolee = session.enrolee === true;
  if (enrolee && expiresAt - EXPIRY_MARGIN_SECONDS <= at) return { reader: undefined, lapsed: true };
  // A token that is not one b64token is never sent (client.ts): it is no token, not a reader (S5a-1).
  return { reader: sendable({ bearer: record.access_token, enrolee }), lapsed: false };
}

/**
 * Where "sign in" leads from a page (the public box, "Sign in again"): back to `back`, asking for a
 * fresh sign-in even when signed in (flow.ts), so a lapsed token is replaced. None while
 * sign-in is not set up (it would answer 503) or in a build that offers none.
 */
export function signInLink(auth: SignInSetup, publicOnly: boolean, back: string): string | undefined {
  return signInOffered(auth, publicOnly) ? `/sign-in?return=${encodeURIComponent(back)}&again=1` : undefined;
}

export type SignInSetup = { setup: AuthSetup; key: Buffer | undefined };

/** Whether /sign-in works here: set up, with a session key, in a build that offers it. */
function signInOffered({ setup, key }: SignInSetup, publicOnly: boolean): boolean {
  return setup.enabled && key !== undefined && !publicOnly;
}

/**
 * The line on /news that sends a reader who is not signed in to the members copy: where "sign in"
 * leads, back to `back`. None for anyone signed in (a member already has the copy, an officer too, and
 * any other account has its own box) and wherever /sign-in is not available. It depends on the
 * session alone, so it is the same for every signed-out reader and the anonymous page stays cacheable.
 */
export function membersSignInLink(session: Session | undefined, auth: SignInSetup, publicOnly: boolean, back: string): string | undefined {
  return session === undefined && signInOffered(auth, publicOnly) ? `/sign-in?return=${encodeURIComponent(back)}` : undefined;
}
