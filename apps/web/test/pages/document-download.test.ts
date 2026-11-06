// PDFVIEW fix 1 (N3): /documents/[id].pdf asks for an attachment on ?download=1 and on nothing else;
// any other value, or the name in another case, stays inline. A live API stands in, serving one file.
import { describe, expect, it, vi } from 'vitest';

const ID = '0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20';

vi.mock('../../src/data', () => ({
  liveData: () => ({
    file: () =>
      Promise.resolve({
        kind: 'pdf',
        filename: 'pensa-mensa-2026-10.pdf',
        size: 6,
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('%PDF-1'));
            c.close();
          },
        }),
      }),
  }),
}));

const { GET } = await import('../../src/pages/documents/[id].pdf');
type Ctx = Parameters<typeof GET>[0];
const at = async (search: string) => (await GET({ params: { id: ID }, locals: {}, url: new URL(`https://localhost/documents/${ID}.pdf${search}`) } as unknown as Ctx)) as Response;

describe('/documents/[id].pdf and ?download', () => {
  it('is an attachment on download=1', async () => {
    const res = await at('?download=1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="pensa-mensa-2026-10.pdf"');
  });

  it('stays inline for download=0, an empty value, any other value, or DOWNLOAD=1', async () => {
    for (const search of ['', '?download=0', '?download=', '?download', '?download=true', '?download=yes', '?download=01', '?download=1%20', '?DOWNLOAD=1', '?Download=1']) {
      const res = await at(search);
      expect(res.status, search).toBe(200);
      expect(res.headers.get('content-disposition'), search).toBe('inline; filename="pensa-mensa-2026-10.pdf"');
    }
  });
});
