// ARCHIVE-SEARCH S2: the index job's own failure paths, with a made-up database (test/search/pages.test.ts
// runs it against a real one). Every name is made up.
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/pool.js';
import type { TextRequest } from '../pdf/text-protocol.js';
import { SWEEP_BATCH, type Texter, indexFile, indexSweeper } from './pages.js';

// What each audience is served is the store's to say (pdf/regenerate.ts copyInputs); here, two made-up copies.
const SERVED: Record<string, { hash: Buffer; quotes: string[] } | null> = {
  public: { hash: Buffer.from('aa', 'hex'), quotes: ['850-555-0142', '12 Orchard Lane'] },
  members: { hash: Buffer.from('bb', 'hex'), quotes: ['12 Orchard Lane'] },
};
vi.mock('../pdf/regenerate.js', () => ({
  copyInputs: (db: Pick<Db, 'query'>, _fileId: string, audience: string) => db.query('SELECT 1').then(() => SERVED[audience] ?? null),
}));

const never: Texter = () => Promise.reject(new Error('the reader was asked'));

describe('indexFile', () => {
  it('never rejects: a database that cannot be asked is a failure per audience, heard by code and never by message', async () => {
    const warned: unknown[] = [];
    const down = { query: () => Promise.reject(Object.assign(new Error('connection lost near "Kestrel Ambry"'), { code: '08006' })) } as unknown as Db;
    expect(await indexFile(down, 'file-1', { text: never, warn: (fields, message) => void warned.push([fields, message]) })).toEqual([
      { audience: 'public', outcome: 'failed', code: '08006' },
      { audience: 'members', outcome: 'failed', code: '08006' },
    ]);
    expect(warned).toEqual([
      [{ file_id: 'file-1', audience: 'public', code: '08006' }, 'a PDF copy was not indexed'],
      [{ file_id: 'file-1', audience: 'members', code: '08006' }, 'a PDF copy was not indexed'],
    ]);
    // An error with no code of its own.
    const odd = { query: () => Promise.reject(new Error('no code')) } as unknown as Db;
    expect(await indexFile(odd, 'file-1', { text: never, audiences: ['members'] })).toEqual([{ audience: 'members', outcome: 'failed', code: 'failed' }]);
  });
});

describe('indexFile and the reader', () => {
  it('sends each audience\'s own copy with that audience\'s own withheld passages and the sha256 of those bytes, and puts its pages under that sha', async () => {
    const copies: Record<string, Buffer> = { aa: Buffer.from('the public copy'), bb: Buffer.from('the members copy') };
    const puts: unknown[][] = [];
    const db = {
      query: (sql: string, values: unknown[] = []) => {
        if (sql.includes('FROM pdf_copy')) return Promise.resolve({ rows: [{ status: 'ready', bytes: copies[(values[1] as Buffer).toString('hex')] }] });
        if (sql.includes('search_page_put')) puts.push(values);
        return Promise.resolve({ rows: [] });
      },
    } as unknown as Db;
    const asked: TextRequest[] = [];
    const text: Texter = (job) => {
      asked.push(job);
      return Promise.resolve({ sha256: job.sha256, pages: [{ text: `text of ${Buffer.from(job.copy).toString()}`, extra: 'kept-form' }] });
    };
    expect(await indexFile(db, 'file-1', { text, textVersion: 7 })).toEqual([
      { audience: 'public', outcome: 'indexed', pages: 1 },
      { audience: 'members', outcome: 'indexed', pages: 1 },
    ]);
    const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
    expect(asked.map((job) => [Buffer.from(job.copy).toString(), job.sha256, job.quotes])).toEqual([
      ['the public copy', sha(copies['aa'] as Buffer), ['850-555-0142', '12 Orchard Lane']],
      ['the members copy', sha(copies['bb'] as Buffer), ['12 Orchard Lane']],
    ]);
    expect(puts).toEqual([
      ['file-1', 'public', Buffer.from(sha(copies['aa'] as Buffer), 'hex'), 7, ['text of the public copy'], ['kept-form']],
      ['file-1', 'members', Buffer.from(sha(copies['bb'] as Buffer), 'hex'), 7, ['text of the members copy'], ['kept-form']],
    ]);
  });
});

describe('indexSweeper', () => {
  it('reads ten copies a step by default, and only for the audiences that have an index', async () => {
    expect(SWEEP_BATCH).toBe(10);
    const asked: string[] = [];
    const db = {
      query: (sql: string) => {
        asked.push(sql);
        if (sql.includes('search_page_sweep')) return Promise.resolve({ rows: [] });
        if (sql.includes('search_page_lacking')) return Promise.resolve({ rows: [{ file_id: 'file-1', audience: 'officers' }, { file_id: 'file-2', audience: 'everyone' }] });
        return Promise.reject(new Error('asked for a file'));
      },
    } as unknown as Db;
    const step = indexSweeper(db, { text: never });
    expect(await step()).toEqual({ deleted: 0, indexed: 0, left: 0 });
    expect(asked).toHaveLength(2);
    // Through: a step after that only sweeps (S2 challenge M2: a withdrawn item's rows go a drain later), and lists nothing.
    expect(await step()).toEqual({ deleted: 0, indexed: 0, left: 0 });
    expect(asked.slice(2)).toEqual(['SELECT search_page_sweep() AS n']);
  });
});
