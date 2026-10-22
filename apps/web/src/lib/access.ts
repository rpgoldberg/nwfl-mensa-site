// The public-only build flag (MT-50): a deployment built with PUBLIC_ONLY=true
// has no sign-in at all. One gate in the middleware answers every sign-in
// route with the 404 page, whatever routes the officer area later adds and
// however the URL spells them, so a public-only deployment cannot reach an
// OIDC client or a session.
import type { MiddlewareHandler } from 'astro';

/** Sign-in and sign-out, every OIDC route (the callback included) and the officer area. */
export const SIGN_IN_PATHS = ['/sign-in', '/sign-out', '/signed-out', '/auth', '/officer-area'] as const;

export function isSignInPath(path: string): boolean {
  return SIGN_IN_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * The path as a route: decoded, slashes collapsed, .html dropped, lower case.
 * Astro renders /sign-in for /sign-in.html and /%73ign-in.html; /sign-in/index
 * is under /sign-in already.
 */
function asRoute(pathname: string): string {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    // Broken encoding: the server wrapper answers 400 before Astro sees it.
  }
  return path.replace(/\/{2,}/g, '/').replace(/\.html$/i, '').toLowerCase();
}

/** Gated: the route that will render, or failing that the path read as one. */
function gated(routePattern: string | undefined, pathname: string): boolean {
  return isSignInPath(routePattern ?? '') || isSignInPath(asRoute(pathname));
}

export function makeGate(publicOnly: boolean): MiddlewareHandler {
  return (context, next) => (publicOnly && gated(context.routePattern, context.url.pathname) ? context.rewrite('/404') : next());
}
