import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { APP_LOGIN, OWNER_LOGIN, parseConnectionUrl } from './connection.js';

const BOOTSTRAP_SQL = fileURLToPath(new URL('../../db/bootstrap.sql', import.meta.url));

export interface BootstrapOptions {
  /** A superuser (local or CI only): DATABASE_ADMIN_URL. */
  adminUrl: string;
  /** codegraph_owner's URL: DATABASE_URL. Its database is the one bootstrapped. */
  ownerUrl: string;
  /** codegraph_app's URL: DATABASE_APP_URL. */
  appUrl: string;
}

export interface BootstrapResult {
  database: string;
  createdDatabase: boolean;
}

/**
 * Creates or re-asserts the two logins, sets their passwords from their own
 * URLs, and makes codegraph_owner the owner of the service's database
 * (creating the database when it does not exist). Idempotent.
 */
export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const owner = parseConnectionUrl('DATABASE_URL', options.ownerUrl);
  const app = parseConnectionUrl('DATABASE_APP_URL', options.appUrl);
  if (owner.user !== OWNER_LOGIN) {
    throw new Error(`DATABASE_URL must connect as ${OWNER_LOGIN}, not ${owner.user}.`);
  }
  if (app.user !== APP_LOGIN) {
    throw new Error(`DATABASE_APP_URL must connect as ${APP_LOGIN}, not ${app.user}.`);
  }
  if (owner.database !== app.database) {
    throw new Error('DATABASE_URL and DATABASE_APP_URL must name the same database.');
  }

  const admin = new pg.Client({ connectionString: options.adminUrl });
  await admin.connect();
  try {
    await admin.query(await readFile(BOOTSTRAP_SQL, 'utf8'));
    for (const login of [owner, app]) {
      await admin.query(
        `ALTER ROLE ${admin.escapeIdentifier(login.user)} PASSWORD ${admin.escapeLiteral(login.password)}`,
      );
    }

    const database = admin.escapeIdentifier(owner.database);
    const exists = await admin.query('SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1', [
      owner.database,
    ]);
    const createdDatabase = exists.rowCount === 0;
    if (createdDatabase) {
      await admin.query(`CREATE DATABASE ${database} OWNER ${OWNER_LOGIN}`);
    } else {
      await admin.query(`ALTER DATABASE ${database} OWNER TO ${OWNER_LOGIN}`);
    }
    // Only the owner may create schemas, or temporary tables and functions, in
    // the service's database: codegraph_app runs no DDL of any kind.
    await admin.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${database} FROM PUBLIC`);
    return { database: owner.database, createdDatabase };
  } finally {
    await admin.end();
  }
}
