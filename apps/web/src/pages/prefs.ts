// The text size and theme controls post here (R30): a plain HTML form, so they
// work with no script. The new settings go into two cookies, then the reader
// goes back to the page, with the Aa panel open again if the press came from it.
// Astro's origin check (security.checkOrigin) refuses a cross-site post first.
import type { APIRoute } from 'astro';
import { applyChange, prefsCookies, readPrefs, safeBack } from '../../server/prefs.mjs';

export const prerender = false;

const FORM_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data'];

function field(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === 'string' ? value : undefined;
}

export const POST: APIRoute = async ({ request }) => {
  const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!FORM_TYPES.includes(type)) return new Response('Send the form.', { status: 415 });
  const form = await request.formData();
  const prefs = applyChange(readPrefs(request.headers.get('cookie')), {
    size: field(form, 'size'),
    theme: field(form, 'theme'),
  });
  const headers = new Headers({
    Location: `${safeBack(field(form, 'back'))}${field(form, 'from') === 'menu' ? '#reader-menu' : ''}`,
  });
  for (const cookie of prefsCookies(prefs)) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
};

/** A bookmark or a typed address lands here with nothing to change. */
export const GET: APIRoute = () => new Response(null, { status: 303, headers: { Location: '/' } });
