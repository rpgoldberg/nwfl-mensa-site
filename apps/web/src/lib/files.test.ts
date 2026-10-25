// REDACT R3c: /documents/[id].pdf, a PDF streamed from the API as the public may have it.
import { describe, expect, it } from 'vitest';
import type { FileRead } from './api/client';
import { ApiUnavailable } from './api/client';
import { NOT_READY_TEXT, serveFile } from './files';

const FILE = '3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7';
const body = (text: string) => new Blob([text]).stream() as ReadableStream<Uint8Array>;
const live = (read: (id: string) => Promise<FileRead>) => ({ file: read });

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
