// @ts-check
// The signed-in session (W4, R10), sealed into a host-only cookie with
// AES-256-GCM under a key from config (SESSION_KEY, never in the repo). The
// cookie holds who the person is and their (internal nwfl-) roles only; their tokens stay
// on the server (server/token-store.mjs), and the session is valid only while
// that record is there. A sealed value also carries the sign-in transaction
// (state, nonce, PKCE verifier) for ten minutes.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readCookie } from './cookies.mjs';
import { DEFAULT_SITE_GROUP_PREFIX, internalGroups } from './groups.mjs';
import { SESSION_COOKIE } from './policy.mjs';

export { SESSION_COOKIE };
export const AUTH_COOKIE = '__Host-nwfl-auth';
export const TRANSACTION_SECONDS = 600;

const OFFICER_SECONDS = 12 * 3600;
const MEMBER_SECONDS = 30 * 86400;
const MAX_GROUPS = 20;
const MAX_NAME = 80;
/** A clock a little behind ours still opens a fresh transaction. */
const SKEW_SECONDS = 60;

/**
 * The key, from SESSION_KEY: 32 bytes, base64. There is no default.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Buffer | undefined}
 */
export function sessionKey(env) {
  const raw = env['SESSION_KEY'];
  if (raw === undefined || raw === '') return undefined;
  const key = /^[A-Za-z0-9+/]+={0,2}$/.test(raw) ? Buffer.from(raw, 'base64') : Buffer.alloc(0);
  if (key.length !== 32) throw new Error('SESSION_KEY must be 32 bytes, base64 (openssl rand -base64 32)');
  return key;
}

/**
 * @param {unknown} value
 * @param {Buffer} key
 * @param {string} purpose bound in as additional data, so one sealed value never passes for another
 */
export function sealValue(value, key, purpose) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(purpose));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return `v1.${Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url')}`;
}

/**
 * @param {string | undefined} sealed
 * @param {Buffer} key
 * @param {string} purpose
 * @returns {any}
 */
export function openValue(sealed, key, purpose) {
  if (!sealed?.startsWith('v1.')) return undefined;
  const bytes = Buffer.from(sealed.slice(3), 'base64url');
  if (bytes.length < 12 + 16 + 1) return undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    const text = Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]).toString('utf8');
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * @typedef {{ sid: string, sub: string, name: string, groups: string[], member: boolean,
 *   officer: boolean, iat: number, exp: number, sliding: boolean }} Session
 */

/** Printable: no control character (C0 or DEL). @param {string} c */
const printable = (c) => /** @type {number} */ (c.codePointAt(0)) >= 0x20 && c !== '\u007f';

/** @param {unknown} value */
function displayName(value) {
  return typeof value === 'string' ? [...value].filter(printable).join('').trim().slice(0, MAX_NAME) : '';
}

/**
 * A session from the ID token's claims: officers 12 hours, members 30 days
 * renewed on use. Only the groups under the chapter's prefix are kept, by
 * their internal nwfl- names (groups.mjs), at most 20.
 *
 * @param {Record<string, unknown>} claims
 * @param {number} now seconds
 * @param {string} [groupPrefix] SITE_GROUP_PREFIX (auth-config.mjs); default nwfl-
 * @returns {Session}
 */
export function newSession(claims, now, groupPrefix = DEFAULT_SITE_GROUP_PREFIX) {
  const groups = internalGroups(Array.isArray(claims['groups']) ? claims['groups'] : [], groupPrefix).slice(0, MAX_GROUPS);
  const officer = groups.includes('nwfl-officers');
  const lifetime = officer ? OFFICER_SECONDS : MEMBER_SECONDS;
  return {
    sid: randomBytes(18).toString('base64url'),
    sub: String(claims['sub']),
    name: displayName(claims['name']) || displayName(claims['preferred_username']) || 'Member',
    groups,
    member: groups.includes('nwfl-members'),
    officer,
    iat: now,
    exp: now + lifetime,
    sliding: !officer,
  };
}

/**
 * A member session past half its life gets a fresh expiry; an officer's never.
 *
 * @param {Session} session
 * @param {number} now
 * @returns {Session | undefined}
 */
export function renewIfDue(session, now) {
  if (!session.sliding || session.exp - now > MEMBER_SECONDS / 2) return undefined;
  return { ...session, exp: now + MEMBER_SECONDS };
}

/** @param {string} name @param {string} value @param {number} maxAge */
const hostOnly = (name, value, maxAge) => `${name}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax; HttpOnly; Secure`;

/** @param {string} name */
export const clearCookie = (name) => hostOnly(name, '', 0);

/**
 * @param {Session} session
 * @param {Buffer} key
 * @param {number} now
 */
export function sessionSetCookie(session, key, now) {
  return hostOnly(SESSION_COOKIE, sealValue(session, key, SESSION_COOKIE), Math.max(0, session.exp - now));
}

/**
 * @param {string | null | undefined} cookieHeader
 * @param {Buffer | undefined} key
 * @param {number} now
 * @param {{ has(sid: string, now: number): boolean }} store the server's records: a session without one is over (signed out)
 * @returns {Session | undefined}
 */
export function readSession(cookieHeader, key, now, store) {
  if (!key) return undefined;
  /** @type {Session | undefined} */
  const session = openValue(readCookie(cookieHeader, SESSION_COOKIE), key, SESSION_COOKIE);
  return session && typeof session.exp === 'number' && session.exp > now && store.has(session.sid, now) ? session : undefined;
}

/** @typedef {{ state: string, nonce: string, verifier: string, back: string }} Transaction */

/**
 * @param {Transaction} tx
 * @param {Buffer} key
 * @param {number} now
 */
export function sealTransaction(tx, key, now) {
  return sealValue({ ...tx, at: now }, key, AUTH_COOKIE);
}

/**
 * @param {Transaction} tx
 * @param {Buffer} key
 * @param {number} now
 */
export function transactionSetCookie(tx, key, now) {
  return hostOnly(AUTH_COOKIE, sealTransaction(tx, key, now), TRANSACTION_SECONDS);
}

/**
 * The transaction this browser started, if it is less than ten minutes old.
 *
 * @param {string | null | undefined} cookieHeader
 * @param {Buffer} key
 * @param {number} now
 * @returns {(Transaction & { at: number }) | undefined}
 */
export function openTransaction(cookieHeader, key, now) {
  /** @type {(Transaction & { at: number }) | undefined} */
  const tx = openValue(readCookie(cookieHeader, AUTH_COOKIE), key, AUTH_COOKIE);
  if (!tx || typeof tx.at !== 'number') return undefined;
  return now - tx.at < TRANSACTION_SECONDS && tx.at - now <= SKEW_SECONDS ? tx : undefined;
}
