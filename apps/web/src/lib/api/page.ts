// How an on-request page reads the API: a read that the API could not answer
// is "not ok", and the page says the section is temporarily unavailable in
// plain words, with status 503 and nothing stored. Any other error is a bug,
// and is left to fail as one.
import { ApiUnavailable } from './client';

export type Loaded<T> = { ok: true; value: T } | { ok: false };

export async function attempt<T>(read: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    if (error instanceof ApiUnavailable) return { ok: false };
    throw error;
  }
}

/** Astro.response, or any response being built: 503, never stored. */
export function markUnavailable(response: { status?: number | undefined; headers: Headers }): void {
  response.status = 503;
  response.headers.set('Cache-Control', 'no-store');
}

/**
 * W-SIGNUP fix 1 (NOTE-7): a signed-out reader sent to sign in, by a 303 marked private, which
 * server/policy.mjs answers private, no-store: no shared cache keeps the redirect for anyone.
 */
export function signInFirst(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'private' } });
}
