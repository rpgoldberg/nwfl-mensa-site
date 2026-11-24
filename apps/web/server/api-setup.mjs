// @ts-check
// The API's address and timeout, from API_URL and API_TIMEOUT_MS: for the site's own reads
// (src/lib/api/client.ts re-exports it) and for the machine route (machine-route.mjs), which sits
// outside Astro's bundle. One reading, so the two can never disagree on what a valid address is.

export const DEFAULT_TIMEOUT_MS = 3000;

/** @typedef {{ baseUrl: string, timeoutMs: number }} ApiConfig */
/** @typedef {{ enabled: false } | { enabled: true, config: ApiConfig } | { enabled: true, error: string }} ApiSetup */

/**
 * API_URL (http: or https:, the bare origin) and API_TIMEOUT_MS (1 to 60000, default 3000). Off with no
 * API_URL; on but set up wrongly, with the reason, when either is not as it must be.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {ApiSetup}
 */
export function apiSetup(env) {
  const raw = env['API_URL'];
  if (!raw) return { enabled: false };
  /** @type {URL} */
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { enabled: true, error: 'API_URL is not a URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { enabled: true, error: 'API_URL must be http: or https:' };
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    return { enabled: true, error: 'API_URL must be an origin only: no credentials, path, query or fragment' };
  }
  const timeout = env['API_TIMEOUT_MS'] ?? String(DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number(timeout);
  if (!/^\d+$/.test(timeout) || timeoutMs < 1 || timeoutMs > 60_000) return { enabled: true, error: 'API_TIMEOUT_MS must be a whole number of milliseconds from 1 to 60000' };
  return { enabled: true, config: { baseUrl: url.origin, timeoutMs } };
}
