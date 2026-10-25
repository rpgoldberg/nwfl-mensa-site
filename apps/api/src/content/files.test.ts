// REDACT R3c: the file read's name and cap, without a database.
import { Code, createClient, createRouterTransport } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';
import { ContentService } from '../gen/nwfl/mensa/v1/content_pb.js';
import { rejectAllTokens } from '../auth/caller.js';
import { apiInterceptors } from '../grpc/interceptors.js';
import { createStructuredLogger } from '../platform/logger.js';
import type { ReadResult } from '../pdf/store.js';
import { CHUNK_BYTES, MAX_SERVED_BYTES, fileHandlers, fileName } from './files.js';

const ID = '3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7';

describe('fileName', () => {
  it('is the title in ASCII letters, digits and hyphens, lower case, ending in .pdf', () => {
    expect(fileName('Report by Zoë Núñez: Q3 (draft)', ID)).toBe('report-by-zoe-nunez-q3-draft.pdf');
    expect(fileName('Picnic with [withheld]', ID)).toBe('picnic-with-withheld.pdf');
    expect(fileName('a/../b\\"c\r\nd', ID)).toBe('a-b-c-d.pdf');
  });

  it('falls back to the id when the title leaves nothing, and keeps at most 80 characters', () => {
    expect(fileName('', ID)).toBe(`${ID}.pdf`);
    expect(fileName('日本語 — ✓', ID)).toBe(`${ID}.pdf`);
    expect(fileName(null, ID)).toBe(`${ID}.pdf`);
    const long = fileName('word '.repeat(40), ID);
    expect(long.length).toBeLessThanOrEqual(84);
    expect(long).toMatch(/^word(-word)*\.pdf$/);
  });
});

describe('fileHandlers', () => {
  const client = (result: ReadResult, found: { title: string | null } | null = { title: 'T' }) => {
    const calls: string[] = [];
    const transport = createRouterTransport((router) =>
      router.service(
        ContentService,
        fileHandlers({
          db: {} as never,
          find: (_db, id) => {
            calls.push(`find ${id}`);
            return Promise.resolve(found);
          },
          read: (_db, id, audience) => {
            calls.push(`read ${id} ${audience}`);
            return Promise.resolve(result);
          },
        }),
      ),
      { router: { interceptors: apiInterceptors({ logger: createStructuredLogger({ level: 'silent' }), verifier: rejectAllTokens }) } },
    );
    return { calls, files: createClient(ContentService, transport) };
  };
  const collect = async (c: ReturnType<typeof client>, fileId = ID) => {
    const parts: string[] = [];
    for await (const m of c.files.readFile({ fileId })) parts.push(m.part.case === 'chunk' ? `chunk ${m.part.value.length}` : String(m.part.case));
    return parts;
  };

  it('streams the head, then chunks of at most CHUNK_BYTES', async () => {
    const pdf = new Uint8Array(CHUNK_BYTES * 2 + 5);
    expect(await collect(client({ kind: 'pdf', pdf, original: false }))).toEqual(['head', `chunk ${CHUNK_BYTES}`, `chunk ${CHUNK_BYTES}`, 'chunk 5']);
  });

  it('refuses a file over 10 MiB as not found', async () => {
    expect(MAX_SERVED_BYTES).toBe(10 * 1024 * 1024);
    const c = client({ kind: 'pdf', pdf: new Uint8Array(MAX_SERVED_BYTES + 1), original: false });
    await expect(collect(c)).rejects.toMatchObject({ code: Code.NotFound, rawMessage: 'file not found' });
  });

  it('answers hidden, refused and not found alike, and reads nothing for a file it cannot find or an id that is not one', async () => {
    for (const result of [{ kind: 'hidden' }, { kind: 'refused', reason: 'scan' }, { kind: 'not_found' }] as const) {
      await expect(collect(client(result))).rejects.toMatchObject({ code: Code.NotFound, rawMessage: 'file not found' });
    }
    const unseen = client({ kind: 'pdf', pdf: new Uint8Array(1), original: true }, null);
    await expect(collect(unseen)).rejects.toMatchObject({ code: Code.NotFound, rawMessage: 'file not found' });
    expect(unseen.calls).toEqual([`find ${ID}`]);
    const bad = client({ kind: 'pdf', pdf: new Uint8Array(1), original: true });
    await expect(collect(bad, 'nope')).rejects.toMatchObject({ code: Code.NotFound, rawMessage: 'file not found' });
    expect(bad.calls).toEqual([]);
  });

  it('says not ready, alone', async () => {
    expect(await collect(client({ kind: 'not_ready' }))).toEqual(['notReady']);
  });
});

describe('fileHandlers when the call is cancelled', () => {
  it('stops between chunks', async () => {
    const pdf = new Uint8Array(CHUNK_BYTES * 3);
    const handlers = fileHandlers({ db: {} as never, find: () => Promise.resolve({ title: 'T' }), read: () => Promise.resolve({ kind: 'pdf', pdf, original: false }) });
    const controller = new AbortController();
    const ctx = { signal: controller.signal, values: { get: () => ({ audience: 'public' }) } } as never;
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const m of handlers.readFile({ fileId: ID }, ctx)) {
          seen.push(String(m.part?.case));
          if (m.part?.case === 'chunk') controller.abort();
        }
      })(),
    ).rejects.toThrow();
    expect(seen).toEqual(['head', 'chunk']);
  });
});
