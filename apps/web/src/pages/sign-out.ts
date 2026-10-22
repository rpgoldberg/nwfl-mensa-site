// Sign out (W4): a POST only, origin-checked (the server wrapper and Astro).
// The session and its tokens go, Clear-Site-Data empties the site's cookies and
// storage, and the reader goes on to end the provider's session as well.
import type { APIRoute } from 'astro';
import { runtimeDeps, signOut } from '../lib/auth/flow';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const out = await signOut(runtimeDeps(), { cookieHeader: request.headers.get('cookie') });
  const headers = new Headers({ Location: out.location, 'Clear-Site-Data': out.clearSiteData });
  for (const cookie of out.cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
};

/** A link or a typed address never signs anyone out. */
export const GET: APIRoute = () => new Response('Sign out with the button on any page.', { status: 405, headers: { Allow: 'POST' } });
