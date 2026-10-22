// The signed-in reader, put on each on-request page (Astro.locals.session),
// and a member's session renewed on use past half its life (R10).
import type { MiddlewareHandler } from 'astro';
import { SESSION_COOKIE, readSession, renewIfDue, sessionSetCookie } from '../../../server/session.mjs';

export function makeSessionStep(deps: () => { key: Buffer | undefined; now: () => number }): MiddlewareHandler {
  return async (context, next) => {
    // A prerendered page has no reader: the server wrapper stamps theirs when it serves it.
    if (context.isPrerendered) return next();
    const { key, now } = deps();
    const session = readSession(context.request.headers.get('cookie'), key, now());
    context.locals.session = session;
    const response = await next();
    // A page that sets the session itself (sign-out, the callback) has the last word.
    if (response.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))) return response;
    const renewed = session && key ? renewIfDue(session, now()) : undefined;
    if (!renewed || !key) return response;
    const cookie = sessionSetCookie(renewed, key, now());
    try {
      response.headers.append('Set-Cookie', cookie);
      return response;
    } catch {
      // A redirect's headers are immutable: answer a copy that carries the cookie.
      const copy = new Response(response.body, response);
      copy.headers.append('Set-Cookie', cookie);
      return copy;
    }
  };
}
