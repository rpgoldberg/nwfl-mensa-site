// @ts-check
// The server's record of each signed-in session: its tokens (W4), which never
// reach the browser. A session is valid only while its record is here, so
// sign-out ends it at once, and a restart signs everyone out: the site runs as
// one replica until W5a's shared store. One store per process: the site's
// bundle and the server wrapper load this file separately, so it lives on
// globalThis.

/** @template {object} T */
export class TokenStore {
  /** @type {Map<string, { tokens: T, until: number }>} */
  #entries = new Map();

  /** @param {number} cap the most records kept; the oldest goes first */
  constructor(cap = 10_000) {
    this.cap = cap;
  }

  /** @param {string} sid @param {T} tokens @param {number} until seconds */
  put(sid, tokens, until) {
    if (this.#entries.size >= this.cap) this.#entries.delete(/** @type {string} */ (this.#entries.keys().next().value));
    this.#entries.set(sid, { tokens, until });
  }

  /** @param {string} sid @param {number} now @returns {T | undefined} */
  get(sid, now) {
    const entry = this.#entries.get(sid);
    if (entry && entry.until > now) return entry.tokens;
    this.#entries.delete(sid);
    return undefined;
  }

  /** Whether the session is still live. @param {string} sid @param {number} now */
  has(sid, now) {
    return this.get(sid, now) !== undefined;
  }

  /** The tokens, and the record gone with them (sign-out). @param {string} sid @param {number} now */
  take(sid, now) {
    const tokens = this.get(sid, now);
    this.#entries.delete(sid);
    return tokens;
  }

  /** A renewed session keeps its record as long. @param {string} sid @param {number} until */
  extend(sid, until) {
    const entry = this.#entries.get(sid);
    if (entry) entry.until = until;
  }
}

const SHARED = Symbol.for('nwfl-mensa.token-store');

/** @returns {TokenStore<any>} */
export function sharedTokenStore() {
  const global = /** @type {Record<symbol, TokenStore<any> | undefined>} */ (/** @type {unknown} */ (globalThis));
  return (global[SHARED] ??= new TokenStore());
}
