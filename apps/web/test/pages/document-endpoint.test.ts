// REDACT R3c: /documents/[id].pdf, on request; with no API (the canary) every file is not found.
import { describe, expect, it } from 'vitest';
import { GET, prerender } from '../../src/pages/documents/[id].pdf';

type Ctx = Parameters<typeof GET>[0];
const url = new URL('https://localhost/documents/0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20.pdf');

describe('/documents/[id].pdf, with no API', () => {
  it('is not found, on request', async () => {
    expect(prerender).toBe(false);
    const res = (await GET({ params: { id: '0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20' }, locals: {}, url } as unknown as Ctx)) as Response;
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('No such file');
  });

  // A14: a session cookie changes nothing without an API: the same 404, byte for byte.
  it('answers a signed-in reader the same', async () => {
    const id = '0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20';
    const anonymous = (await GET({ params: { id }, locals: {}, url } as unknown as Ctx)) as Response;
    const session = { sid: 's', sub: 'u', name: 'n', groups: ['nwfl-members'], member: true, enrolee: true, officer: false, iat: 0, exp: 4_000_000_000, sliding: true };
    const signedIn = (await GET({ params: { id }, locals: { session }, url } as unknown as Ctx)) as Response;
    expect(signedIn.status).toBe(anonymous.status);
    expect([...signedIn.headers]).toEqual([...anonymous.headers]);
    expect(await signedIn.text()).toBe(await anonymous.text());
  });
});

// PDFVIEW: ?download=1 is read here and nowhere else; with no API it is the same 404.
describe('/documents/[id].pdf?download=1, with no API', () => {
  it('is the same 404 as the plain address', async () => {
    const id = '0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20';
    const at = (search: string) => GET({ params: { id }, locals: {}, url: new URL(`https://localhost/documents/${id}.pdf${search}`) } as unknown as Ctx) as Promise<Response>;
    const plain = await at('');
    const download = await at('?download=1');
    expect(download.status).toBe(404);
    expect([...download.headers]).toEqual([...plain.headers]);
    expect(await download.text()).toBe(await plain.text());
  });
});
