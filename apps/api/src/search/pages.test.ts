// ARCHIVE-SEARCH S2: the index job's own failure paths, with a made-up database (test/search/pages.test.ts
// runs it against a real one). Every name is made up.
import { describe, expect, it } from 'vitest';
import type { Db } from '../db/pool.js';
import { SWEEP_BATCH, type Texter, indexFile, indexSweeper } from './pages.js';

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
    expect(await step()).toEqual({ deleted: 0, indexed: 0, left: 0 });
    expect(asked).toHaveLength(2);
  });
});
