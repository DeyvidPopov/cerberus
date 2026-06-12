// Database access infrastructure (PROJECT.md §4.3). Repositories are the ONLY
// layer that knows SQL exists; the pool and transaction helper live here with them.
// Every query in this layer is parameterized — string-concatenated SQL is banned.
import pg from 'pg';
import type { Pool, PoolClient } from 'pg';

/** Anything that can run a parameterized query: the pool or a transaction client. */
export type Db = Pool | PoolClient;

/** Create the connection pool from a connection string. */
export function createPool(connectionString: string): Pool {
  return new pg.Pool({ connectionString });
}

/**
 * Run `fn` inside a transaction, committing on success and rolling back on any
 * error. The callback receives a client bound to the transaction.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
