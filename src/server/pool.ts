import pg from 'pg';

export interface AppPoolOptions {
  /** How long to wait for a connection before failing. */
  connectionTimeoutMillis?: number;
  /** The server-side limit on any one statement. */
  statementTimeoutMillis?: number;
  /** The most connections one copy of the server holds. */
  max?: number;
}

export const DEFAULT_CONNECTION_TIMEOUT_MS = 3_000;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;

/**
 * The pool the server runs every query on, connected as codegraph_app
 * (DATABASE_APP_URL). Both timeouts are bounded, so a database that is down or
 * stuck fails a request quickly instead of holding it open.
 */
export function createAppPool(connectionString: string, options: AppPoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    statement_timeout: options.statementTimeoutMillis ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    max: options.max ?? 10,
  });
  // An idle connection the database drops (a restart, a failover) is reported
  // here. Without a listener the event would crash the process; the next
  // request simply gets a new connection or a 503.
  pool.on('error', () => {
    // Nothing to do: the pool has already discarded the connection.
  });
  return pool;
}
