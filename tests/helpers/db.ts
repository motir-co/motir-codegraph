import { randomBytes } from 'node:crypto';

import pg from 'pg';

import { requireEnv } from '../../src/config.js';
import { bootstrap } from '../../src/db/bootstrap.js';
import { withDatabase } from '../../src/db/connection.js';
import { migrate, type MigrateOptions } from '../../src/db/migrate.js';

/**
 * A database of its own for one test file: bootstrapped through the real
 * `bootstrap()` (which creates it), so every test measures the same path the
 * README and CI take. The logins are cluster-wide and shared.
 */
export interface FreshDatabase {
  name: string;
  adminUrl: string;
  ownerUrl: string;
  appUrl: string;
  migrate(options?: Partial<MigrateOptions>): ReturnType<typeof migrate>;
  drop(): Promise<void>;
}

export async function freshDatabase(options: { migrate?: boolean } = {}): Promise<FreshDatabase> {
  const adminUrl = requireEnv('DATABASE_ADMIN_URL');
  const name = `codegraph_test_${randomBytes(6).toString('hex')}`;
  const ownerUrl = withDatabase(requireEnv('DATABASE_URL'), name);
  const appUrl = withDatabase(requireEnv('DATABASE_APP_URL'), name);
  await bootstrap({ adminUrl, ownerUrl, appUrl });

  const db: FreshDatabase = {
    name,
    adminUrl,
    ownerUrl,
    appUrl,
    migrate: (overrides = {}) => migrate({ connectionString: ownerUrl, ...overrides }),
    async drop() {
      const admin = new pg.Client({ connectionString: adminUrl });
      await admin.connect();
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(name)} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    },
  };
  if (options.migrate !== false) {
    await db.migrate();
  }
  return db;
}

/** Runs `fn` with a connected client and always closes it. */
export async function withClient<T>(
  url: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** The SQLSTATE a statement fails with, or null when it succeeds. */
export async function sqlState(
  client: pg.Client,
  sql: string,
  params: unknown[] = [],
): Promise<string | null> {
  await client.query('SAVEPOINT probe');
  try {
    await client.query(sql, params);
    await client.query('RELEASE SAVEPOINT probe');
    return null;
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT probe');
    return (error as { code?: string }).code ?? 'unknown';
  }
}

export const INSUFFICIENT_PRIVILEGE = '42501';

/** A query's rows, typed as unknown values until a test asserts their shape. */
export async function queryRows<T extends pg.QueryResultRow = Record<string, unknown>>(
  client: pg.Client,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await client.query<T>(sql, params)).rows;
}
