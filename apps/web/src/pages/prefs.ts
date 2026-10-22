// The text size and theme controls post here (R30): a plain HTML form, so they
// work with no script. The new settings go into two cookies, then the reader
// goes back to the page, with the Aa panel open again if the press came from it.
// Astro's origin check (security.checkOrigin) refuses a cross-site post first.
import type { APIRoute } from 'astro';
import { applyChange, prefsCookies, readPrefs, safeBack } from '../../server/prefs.mjs';

export const prerender = false;

const FORM_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data'];
/** Four short fields; a body bigger than this is not the form, and is never buffered. */
const MAX_FORM_BYTES = 4096;
const TOO_LARGE = Symbol('too large');

/** The body, read no further than `limit` bytes, whether declared or chunked. */
async function readCapped(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array<ArrayBuffer> | typeof TOO_LARGE> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (stream) {
    const reader = stream.getReader();
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      size += part.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return TOO_LARGE;
      }
      chunks.push(part.value);
    }
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

// The connection closes after a refusal, so the server does not read on.
const tooLarge = () => new Response('Too large.', { status: 413, headers: { Connection: 'close' } });
const unreadable = () => new Response('Send the form.', { status: 400 });

function field(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === 'string' ? value : undefined;
}

export const POST: APIRoute = async ({ request }) => {
  const contentType = request.headers.get('content-type') ?? '';
  const type = contentType.replace(/;.*$/s, '').trim().toLowerCase();
  if (!FORM_TYPES.includes(type)) return new Response('Send the form.', { status: 415 });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_FORM_BYTES) return tooLarge();
  let form: FormData;
  try {
    const body = await readCapped(request.body, MAX_FORM_BYTES);
    if (body === TOO_LARGE) return tooLarge();
    form = await new Response(body, { headers: { 'Content-Type': contentType } }).formData();
  } catch (error) {
    // Undici reads ahead of readCapped, so Astro's 64 KiB cap (astro.config.mjs)
    // can fail a long chunked body first: that is a body too large, too.
    return String(error).includes('Body size limit exceeded') ? tooLarge() : unreadable();
  }
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
