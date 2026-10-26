// ============================================================================
// One transaction per write RPC. Every workflow step reads, checks and writes
// several rows and an audit event; they land together or not at all. The
// client always goes back to the pool, destroyed if even the ROLLBACK failed.
// ============================================================================
import { Code, ConnectError } from '@connectrpc/connect';
import type pg from 'pg';
import type { Db } from './pool.js';

export interface TxClient {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
  release(destroy?: boolean): void;
}

export async function inTransaction<T>(db: Db, fn: (client: TxClient) => Promise<T>): Promise<T> {
  if (db.connect === undefined) throw new ConnectError('transactions need a pool', Code.Internal);
  const client = (await db.connect()) as unknown as TxClient;
  // One query at a time on the client: a step may start several together (Promise.all), and a
  // client handed a query while another runs queues it itself, which pg deprecates (pg@9 removes it).
  let tail: Promise<unknown> = Promise.resolve();
  const serial: TxClient = {
    query: <R extends pg.QueryResultRow>(text: string, values?: unknown[]) => {
      const run = tail.then(() => client.query<R>(text, values));
      tail = run.catch(() => undefined);
      return run;
    },
    release: client.release.bind(client),
  };
  try {
    await client.query('BEGIN');
    const result = await fn(serial);
    await client.query('COMMIT');
    client.release();
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
      client.release();
    } catch {
      client.release(true);
    }
    throw error;
  }
}
