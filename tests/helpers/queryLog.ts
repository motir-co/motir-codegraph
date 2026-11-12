import type pg from 'pg';

/** One statement a pooled connection ran. */
export interface LoggedQuery {
  text: string;
}

export interface QueryLog {
  /** Every statement run since the last `clear()`, in order. */
  readonly statements: LoggedQuery[];
  texts(): string[];
  clear(): void;
}

function statementText(args: unknown[]): string {
  const first = args[0];
  if (typeof first === 'string') {
    return first;
  }
  if (first !== null && typeof first === 'object' && 'text' in first) {
    return String(first.text);
  }
  return String(first);
}

/**
 * Records every statement run on a connection the pool hands out, so a test
 * can assert on the queries a request issued rather than on timing. It wraps
 * the pool's own `connect`, which `pool.query` also goes through.
 */
export function recordQueries(pool: pg.Pool): QueryLog {
  const statements: LoggedQuery[] = [];
  const wrapped = new WeakSet<pg.PoolClient>();
  const connect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
  (pool as { connect: () => Promise<pg.PoolClient> }).connect = async () => {
    const client = await connect();
    if (!wrapped.has(client)) {
      wrapped.add(client);
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      (client as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
        statements.push({ text: statementText(args) });
        return query(...args);
      };
    }
    return client;
  };
  return {
    statements,
    texts: () => statements.map(({ text }) => text),
    clear: () => {
      statements.length = 0;
    },
  };
}
