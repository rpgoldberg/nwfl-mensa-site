// REDACT R3c: /documents/[id].pdf, a PDF streamed from the API as the public may have it.
import { describe, expect, it } from 'vitest';
import type { FileRead, Reader } from './api/client';
import { ApiUnavailable } from './api/client';
import { NOT_READY_TEXT, serveFile } from './files';

const FILE = '3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7';
const body = (text: string) => new Blob([text]).stream() as ReadableStream<Uint8Array>;
const live = (read: (id: string, as?: Reader) => Promise<FileRead>) => ({ file: read });

describe('serveFile', () => {
  it('streams a PDF inline, under a safe name, with its length', async () => {
    const res = await serveFile(live(() => Promise.resolve({ kind: 'pdf', filename: 'picnic-with-withheld.pdf', size: 6, body: body('%PDF-1') })), FILE);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('inline; filename="picnic-with-withheld.pdf"');
    expect(res.headers.get('content-length')).toBe('6');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe('%PDF-1');
  });

  it('names the file by its id when the API gave a name that is not plain', async () => {
    for (const filename of ['', 'a"b.pdf', 'x.pdf\r\nSet-Cookie: a=b', 'Zoë.pdf', '../x.pdf', 'report.exe', `${'a'.repeat(81)}.pdf`]) {
      const res = await serveFile(live(() => Promise.resolve({ kind: 'pdf', filename, size: 1, body: body('x') })), FILE);
      expect(res.headers.get('content-disposition'), filename).toBe(`inline; filename="${FILE}.pdf"`);
    }
  });

  it('says, in plain words, that a file still being made is not ready yet: 503, try again in a minute', async () => {
    const res = await serveFile(live(() => Promise.resolve({ kind: 'not_ready' })), FILE);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    expect(NOT_READY_TEXT).toBe('This file is being prepared; try again in a minute.');
    expect(html).toContain(NOT_READY_TEXT);
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toContain('<a href="/">');
  });

  it('is not found for a withheld or missing file, a site without the API, and a bad id', async () => {
    for (const [name, source, id] of [
      ['not found', live(() => Promise.resolve({ kind: 'not_found' })), FILE],
      ['no API', undefined, FILE],
      ['no id', live(() => Promise.reject(new Error('asked'))), undefined],
    ] as const) {
      const res = await serveFile(source, id);
      expect(res.status, name).toBe(404);
      expect(await res.text(), name).toContain('No such file');
    }
  });

  it('says the file is temporarily unavailable when the API cannot answer, and lets any other error fail', async () => {
    const res = await serveFile(live(() => Promise.reject(new ApiUnavailable('ReadFile'))), FILE);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('temporarily unavailable');
    await expect(serveFile(live(() => Promise.reject(new TypeError('bug'))), FILE)).rejects.toThrow('bug');
  });
});

// A14 (S5a): a members copy, read with a signed-in reader's token.
describe('serveFile as a signed-in reader', () => {
  const member: Reader = { bearer: 'member.token' };
  const snapshot = async (res: Response) => ({ status: res.status, headers: [...res.headers], body: await res.text() });

  it("reads with the reader's token, and never lets a shared cache keep what it got", async () => {
    const asked: (string | undefined)[] = [];
    const res = await serveFile(
      live((_id, as) => {
        asked.push(as?.bearer);
        return Promise.resolve({ kind: 'pdf', filename: 'pensa-mensa-2026-10.pdf', size: 6, body: body('%PDF-1') });
      }),
      FILE,
      member,
    );
    expect(asked).toEqual(['member.token']);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.text()).toBe('%PDF-1');
  });

  it('leaves the public read as it was: no cache rule of its own, the site policy decides', async () => {
    const res = await serveFile(live(() => Promise.resolve({ kind: 'pdf', filename: 'x.pdf', size: 1, body: body('x') })), FILE);
    expect(res.headers.get('cache-control')).toBeNull();
  });

  it("answers a file the reader may not have exactly as a missing one: the same 404, byte for byte, as a random id's to the public", async () => {
    const random = await snapshot(await serveFile(live(() => Promise.resolve({ kind: 'not_found' })), '00000000-0000-4000-8000-0000000000aa'));
    for (const reader of [member, undefined]) {
      const withheld = await snapshot(await serveFile(live(() => Promise.resolve({ kind: 'not_found' })), FILE, reader));
      expect(withheld).toEqual(random);
    }
    expect(random.status).toBe(404);
  });

  it("keeps not ready and unavailable the same as the public's", async () => {
    for (const read of [() => Promise.resolve({ kind: 'not_ready' } as FileRead), () => Promise.reject(new ApiUnavailable('ReadFile'))]) {
      const anonymous = await snapshot(await serveFile(live(read), FILE));
      expect(await snapshot(await serveFile(live(read), FILE, member))).toEqual(anonymous);
    }
  });
});

// PDFVIEW: "Download" asks for ?download=1. The answer is the same file under the same name, as an
// attachment; nothing else changes: the copy read (the same id, the same reader), the length, and the
// cache rule (none of its own for the public, private and never stored for a signed-in reader).
describe('serveFile for a download', () => {
  const member: Reader = { bearer: 'member.token' };
  const pdf = (): Promise<FileRead> => Promise.resolve({ kind: 'pdf', filename: 'pensa-mensa-2026-10.pdf', size: 6, body: body('%PDF-1') });

  it('answers the same file as an attachment under the same name', async () => {
    const res = await serveFile(live(pdf), FILE, undefined, { download: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="pensa-mensa-2026-10.pdf"');
    expect(await res.text()).toBe('%PDF-1');
    const plain = await serveFile(live(() => Promise.resolve({ kind: 'pdf', filename: 'Zoë.pdf', size: 1, body: body('x') })), FILE, undefined, { download: true });
    expect(plain.headers.get('content-disposition')).toBe(`attachment; filename="${FILE}.pdf"`);
  });

  it('changes nothing but the disposition: the copy asked for, the headers and the cache rule', async () => {
    for (const reader of [undefined, member]) {
      const asked: [string, string | undefined][] = [];
      const read = (id: string, as?: Reader) => {
        asked.push([id, as?.bearer]);
        return pdf();
      };
      const inline = await serveFile(live(read), FILE, reader);
      const attached = await serveFile(live(read), FILE, reader, { download: true });
      expect(asked).toEqual([
        [FILE, reader?.bearer],
        [FILE, reader?.bearer],
      ]);
      const rest = (res: Response) => [...res.headers].filter(([name]) => name !== 'content-disposition');
      expect(rest(attached)).toEqual(rest(inline));
      expect(attached.headers.get('cache-control')).toBe(reader === undefined ? null : 'private, no-store');
      expect(await attached.text()).toBe(await inline.text());
    }
  });

  it('is inline unless download is asked for', async () => {
    for (const options of [undefined, {}, { download: false }]) {
      const res = await serveFile(live(pdf), FILE, undefined, options);
      expect(res.headers.get('content-disposition')).toBe('inline; filename="pensa-mensa-2026-10.pdf"');
    }
  });

  it('keeps every answer that is not the file as it was: a 404, not ready and unavailable', async () => {
    const snapshot = async (res: Response) => ({ status: res.status, headers: [...res.headers], body: await res.text() });
    for (const read of [() => Promise.resolve({ kind: 'not_found' } as FileRead), () => Promise.resolve({ kind: 'not_ready' } as FileRead), () => Promise.reject(new ApiUnavailable('ReadFile'))]) {
      expect(await snapshot(await serveFile(live(read), FILE, undefined, { download: true }))).toEqual(await snapshot(await serveFile(live(read), FILE)));
    }
  });
});
