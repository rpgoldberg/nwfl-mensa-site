// A posted HTML form, read no further than a cap (SOLO-APPROVE's switch; /prefs keeps its own copy of
// the same rule): a body over the cap, declared or chunked, is refused before it is buffered, and
// anything but a form is refused. Astro's origin check (security.checkOrigin) has already refused a
// cross-site post.

const FORM_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data'];

export type FormRead = { ok: true; field: (name: string) => string | undefined } | { ok: false; status: 400 | 413 | 415 };

/** The body, read no further than `limit` bytes, or undefined when it is longer. */
async function readCapped(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (stream) {
    const reader = stream.getReader();
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      size += part.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return undefined;
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

export async function readForm(request: Request, limit: number): Promise<FormRead> {
  const contentType = request.headers.get('content-type') ?? '';
  const type = contentType.replace(/;.*$/s, '').trim().toLowerCase();
  if (!FORM_TYPES.includes(type)) return { ok: false, status: 415 };
  if (Number(request.headers.get('content-length') ?? 0) > limit) return { ok: false, status: 413 };
  let body: Uint8Array<ArrayBuffer> | undefined;
  try {
    body = await readCapped(request.body, limit);
  } catch (error) {
    // Undici reads ahead of readCapped, so Astro's 64 KiB cap (astro.config.mjs) can fail a long
    // chunked body first: that is a body too large, too.
    return { ok: false, status: String(error).includes('Body size limit exceeded') ? 413 : 400 };
  }
  if (body === undefined) return { ok: false, status: 413 };
  let form: FormData;
  try {
    form = await new Response(body, { headers: { 'Content-Type': contentType } }).formData();
  } catch {
    return { ok: false, status: 400 };
  }
  return {
    ok: true,
    field: (name) => {
      const value = form.get(name);
      return typeof value === 'string' ? value : undefined;
    },
  };
}
