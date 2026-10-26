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

  it('runs a step\'s queries one at a time on its client, even when the step starts them together', async () => {
    let running = 0;
    let overlapped = false;
    const order: string[] = [];
    const client = {
      query: async (text: string) => {
        running++;
        if (running > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, text === 'a' ? 20 : 1));
        order.push(text);
        running--;
        if (text === 'bad') throw new Error('bad failed');
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    };
    const db = { query: () => Promise.resolve({ rows: [] }), connect: () => Promise.resolve(client) };
    await inTransaction(db, async (tx) => {
      const failed = tx.query('bad').catch((error: Error) => error.message);
      await Promise.all([tx.query('a'), tx.query('b'), failed]);
      expect(await failed).toBe('bad failed');
    });
    expect(overlapped).toBe(false);
    expect(order).toEqual(['BEGIN', 'bad', 'a', 'b', 'COMMIT']);
  });
});
