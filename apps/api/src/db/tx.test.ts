// The transaction helper's failure path that a live database cannot easily
// show: a ROLLBACK that fails too. The client is then destroyed, not reused.
import { describe, expect, it } from 'vitest';
import { inTransaction } from './tx.js';

describe('inTransaction', () => {
  it('destroys the client when even the ROLLBACK fails, and rethrows the first error', async () => {
    const released: unknown[] = [];
    const client = {
      query: (text: string) => (text === 'BEGIN' ? Promise.resolve({ rows: [], rowCount: 0 }) : Promise.reject(new Error(`${text} failed`))),
      release: (destroy?: boolean) => void released.push(destroy),
    };
    const db = { query: () => Promise.resolve({ rows: [] }), connect: () => Promise.resolve(client) };
    await expect(inTransaction(db, () => Promise.reject(new Error('the step failed')))).rejects.toThrow('the step failed');
    expect(released).toEqual([true]);
  });
});
