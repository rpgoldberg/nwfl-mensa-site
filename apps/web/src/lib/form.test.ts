// SOLO-APPROVE: reading a posted form with a cap, as /prefs does: a body over the cap is refused
// before it is buffered, declared or chunked, and anything but a form is refused.
import { describe, expect, it } from 'vitest';
import { readForm } from './form';

const post = (body: BodyInit | null, headers: Record<string, string>) => new Request('https://x.invalid/officer-area/approval-rules', { method: 'POST', body, headers, duplex: 'half' } as RequestInit);
const chunked = (parts: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });

describe('readForm', () => {
  it('reads a urlencoded form under the cap', async () => {
    const result = await readForm(post('step=review&scope=content&reason=away', { 'content-type': 'application/x-www-form-urlencoded' }), 1024);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.field('reason')).toBe('away');
    if (result.ok) expect(result.field('missing')).toBeUndefined();
  });

  it('refuses another content type with 415, a declared or chunked body over the cap with 413', async () => {
    expect(await readForm(post('{}', { 'content-type': 'application/json' }), 1024)).toMatchObject({ ok: false, status: 415 });
    expect(await readForm(post('a=1', { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '5000' }), 1024)).toMatchObject({ ok: false, status: 413 });
    expect(await readForm(post(chunked(['a=', 'x'.repeat(600), 'x'.repeat(600)]), { 'content-type': 'application/x-www-form-urlencoded' }), 1024)).toMatchObject({ ok: false, status: 413 });
  });

  it('reads no body as an empty form', async () => {
    const result = await readForm(post(null, { 'content-type': 'application/x-www-form-urlencoded' }), 1024);
    expect(result.ok && result.field('step')).toBeUndefined();
  });

  it('refuses a body that breaks while read: too large when the server\'s own cap broke it, else 400', async () => {
    const failing = (message: string) =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error(message));
        },
      });
    expect(await readForm(post(failing('Body size limit exceeded'), { 'content-type': 'application/x-www-form-urlencoded' }), 1024)).toMatchObject({ ok: false, status: 413 });
    expect(await readForm(post(failing('socket hang up'), { 'content-type': 'application/x-www-form-urlencoded' }), 1024)).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses a body that is not a form of its declared type with 400', async () => {
    expect(await readForm(post('not multipart', { 'content-type': 'multipart/form-data; boundary=zzz' }), 1024)).toMatchObject({ ok: false, status: 400 });
  });
});
