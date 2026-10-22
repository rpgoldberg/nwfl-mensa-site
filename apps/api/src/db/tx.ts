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
  try {
    await client.query('BEGIN');
    const result = await fn(client);
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
