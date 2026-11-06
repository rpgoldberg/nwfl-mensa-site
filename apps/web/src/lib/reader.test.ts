// PDFVIEW: /read/<id>, the issue read inside the site. The page shows whichever copy /documents/<id>.pdf
// gives this reader, and says which: the public copy, with the notice that some personal details are
// hidden, or a members copy. It reads the file's head only, never its bytes, and never a URL from the
// query: the paths it gives are the same-origin /documents/<id>.pdf for that id, and its Download.
import { describe, expect, it } from 'vitest';
import type { FileRead, Reader } from './api/client';
import { ApiUnavailable } from './api/client';
import { MEMBERS_COPY, NEEDS_SCRIPT, PUBLIC_COPY, readPaths, readView, readerPath } from './reader';

const FILE = '3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7';
const member: Reader = { bearer: 'member.token' };

/** A file read whose body records whether it was read or let go. */
function pdf(log: string[], who: string): FileRead {
  const body = new ReadableStream<Uint8Array>({
    pull() {
      log.push(`${who} read`);
    },
    cancel() {
      log.push(`${who} let go`);
    },
  }, { highWaterMark: 0 });
  return { kind: 'pdf', filename: 'pensa-mensa-2026-10.pdf', size: 6, body };
}

/** The API as the site reads it: the reader's answer, and the public's. */
function api(mine: FileRead['kind'], publics: FileRead['kind'], log: string[] = []) {
  const asked: (string | undefined)[] = [];
  const answer = (kind: FileRead['kind'], who: string): FileRead => (kind === 'pdf' ? pdf(log, who) : ({ kind } as FileRead));
  return {
    asked,
    log,
    live: {
      file: (id: string, as?: Reader) => {
        expect(id).toBe(FILE);
        asked.push(as?.bearer);
        return Promise.resolve(answer(as === undefined ? publics : mine, as === undefined ? 'public' : 'reader'));
      },
    },
  };
}

describe('the notices', () => {
  it('say what the copy is, in plain words', () => {
    expect(PUBLIC_COPY).toBe('Public copy: some personal details are hidden for privacy. Members can sign in for the full issue.');
    expect(MEMBERS_COPY).toBe('Members copy');
    expect(NEEDS_SCRIPT).toBe('Reading the issue on this page needs JavaScript, which is off or blocked. You can still open it in another app, or download it.');
  });
});

describe('readPaths', () => {
  it('gives the same-origin file for the id, and its download', () => {
    expect(readPaths(FILE)).toEqual({ pdf: `/documents/${FILE}.pdf`, download: `/documents/${FILE}.pdf?download=1`, read: `/read/${FILE}` });
  });
});

describe('readerPath', () => {
  it("is the reader's page for a file's address, and the file itself for anything else", () => {
    expect(readerPath(`/documents/${FILE}.pdf`)).toBe(`/read/${FILE}`);
    for (const href of [`/documents/${FILE}.pdf?download=1`, `/documents/${FILE}`, `https://example.com/documents/${FILE}.pdf`, '/documents/x.pdf']) expect(readerPath(href), href).toBe(href);
  });
});

describe('readView', () => {
  it('the public: the public copy, read once as the public, its bytes never read', async () => {
    const a = api('pdf', 'pdf');
    expect(await readView(a.live, FILE, undefined)).toEqual({ kind: 'ok', copy: 'public', filename: 'pensa-mensa-2026-10.pdf', ...readPaths(FILE) });
    expect(a.asked).toEqual([undefined]);
    expect(a.log).toEqual(['public let go']);
  });

  it('a signed-in reader with a file the public may have too: the public copy', async () => {
    const a = api('pdf', 'pdf');
    expect(await readView(a.live, FILE, member)).toMatchObject({ kind: 'ok', copy: 'public' });
    expect(a.asked).toEqual(['member.token', undefined]);
    expect(a.log).toEqual(['reader let go', 'public let go']);
  });

  it('a signed-in reader with a file the public may not have, or not yet: a members copy', async () => {
    expect(await readView(api('pdf', 'not_found').live, FILE, member)).toMatchObject({ kind: 'ok', copy: 'members' });
    expect(await readView(api('pdf', 'not_ready').live, FILE, member)).toMatchObject({ kind: 'ok', copy: 'members' });
  });

  it("a signed-in reader served other bytes than the public's for the same file (a member's or an officer's copy): not the public copy", async () => {
    const two = (theirs: Partial<{ filename: string; size: number }>) => ({
      file: (_id: string, as?: Reader): Promise<FileRead> =>
        Promise.resolve({ kind: 'pdf', filename: 'pensa-mensa.pdf', size: 6, body: new ReadableStream(), ...(as === undefined ? theirs : {}) }),
    });
    expect(await readView(two({ size: 7 }), FILE, member)).toMatchObject({ kind: 'ok', copy: 'members', filename: 'pensa-mensa.pdf' });
    expect(await readView(two({ filename: 'pensa-mensa-withheld.pdf' }), FILE, member)).toMatchObject({ kind: 'ok', copy: 'members' });
    expect(await readView(two({}), FILE, member)).toMatchObject({ kind: 'ok', copy: 'public' });
  });

  it("a file the reader may not have is not found, as a missing one; not ready is not ready; the public's file is never asked for then", async () => {
    for (const reader of [undefined, member]) {
      const missing = api('not_found', 'not_found');
      expect(await readView(missing.live, FILE, reader)).toEqual({ kind: 'not_found' });
      expect(missing.asked).toEqual([reader?.bearer]);
      expect(await readView(api('not_ready', 'not_ready').live, FILE, reader)).toEqual({ kind: 'not_ready' });
    }
  });

  it('is not found with no API, with no id, and for anything that is not a file id, without asking', async () => {
    const a = api('pdf', 'pdf');
    expect(await readView(undefined, FILE, undefined)).toEqual({ kind: 'not_found' });
    for (const id of [undefined, '', 'x', `${FILE}.pdf`, FILE.toUpperCase(), `../${FILE}`, `${FILE}?file=https://example.com/a.pdf`]) {
      expect(await readView(a.live, id, member), String(id)).toEqual({ kind: 'not_found' });
    }
    expect(a.asked).toEqual([]);
  });

  it('lets the API being unavailable through, for the page to say so', async () => {
    const live = { file: () => Promise.reject(new ApiUnavailable('ReadFile')) };
    await expect(readView(live, FILE, undefined)).rejects.toBeInstanceOf(ApiUnavailable);
  });

  it('a body that fails as it is let go changes nothing', async () => {
    const broken: FileRead = { kind: 'pdf', filename: 'x.pdf', size: 1, body: new ReadableStream({ cancel: () => Promise.reject(new Error('gone')) }) };
    expect(await readView({ file: () => Promise.resolve(broken) }, FILE, undefined)).toMatchObject({ kind: 'ok', copy: 'public' });
  });
});
