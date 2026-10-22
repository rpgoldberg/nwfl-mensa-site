// The public-only build flag (MT-50): a deployment built with PUBLIC_ONLY=true
// has no sign-in at all. One gate in the middleware answers every sign-in
// route with the 404 page, whatever routes the officer area later adds, so a
// public-only deployment cannot reach an OIDC client or a session.
import type { MiddlewareHandler } from 'astro';

/** Sign-in, every OIDC route (the callback included) and the officer area. */
export const SIGN_IN_PATHS = ['/sign-in', '/auth', '/officer-area'] as const;

export function isSignInPath(path: string): boolean {
  return SIGN_IN_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function makeGate(publicOnly: boolean): MiddlewareHandler {
  return (context, next) => (publicOnly && isSignInPath(context.url.pathname) ? context.rewrite('/404') : next());
}
