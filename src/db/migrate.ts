import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { OWNER_LOGIN } from './connection.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));

/**
 * One fixed advisory-lock key for every run, so two concurrent runs against
 * the same database serialise instead of interleaving. ("codegraph" as a
 * 32-bit number, so the key is recognisable in pg_locks.)
 */
export const MIGRATION_LOCK_KEY = 0x636f6465;

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrateOptions {
  /** codegraph_owner's URL: DATABASE_URL. */
  connectionString: string;
  migrationsDir?: string;
  log?: (line: string) => void;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export class MigrationChecksumError extends Error {
  constructor(readonly file: string) {
    super(
      `Migration ${file} was edited after it was applied (its checksum no longer matches ` +
        `schema_migrations). Applied migrations are never edited: add a new file instead.`,
    );
    this.name = 'MigrationChecksumError';
  }
}

export function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/** The migration files in the order they apply: by filename. */
export async function readMigrations(dir: string): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  for (const name of names) {
    if (!MIGRATION_FILE.test(name)) {
      throw new Error(`Migration ${name} does not match NNNN_lower_snake_case.sql.`);
    }
    const sql = await readFile(join(dir, name), 'utf8');
    files.push({ name, sql, checksum: checksum(sql) });
  }
  return files;
}

/**
 * Applies every migration not yet recorded in codegraph.schema_migrations, in
 * filename order, each in its own transaction, under one advisory lock.
 *
 * Every recorded file's checksum is verified BEFORE anything is applied, so a
 * run that finds an edited migration applies nothing at all.
 */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const log = options.log ?? (() => undefined);
  const files = await readMigrations(options.migrationsDir ?? MIGRATIONS_DIR);

  const client = new pg.Client({ connectionString: options.connectionString });
  await client.connect();
  try {
    const who = await client.query<{ current_user: string }>('SELECT current_user');
    const login = who.rows[0]?.current_user;
    if (login !== OWNER_LOGIN) {
      throw new Error(
        `Migrations run as ${OWNER_LOGIN} only; DATABASE_URL connects as ${String(login)}.`,
      );
    }

    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      // The bookkeeping exists before the first migration so that migration
      // can be recorded in the same transaction that applies it.
      await client.query('CREATE SCHEMA IF NOT EXISTS codegraph');
      await client.query(`
        CREATE TABLE IF NOT EXISTS codegraph.schema_migrations (
          name text PRIMARY KEY,
          checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
          applied_at timestamptz NOT NULL DEFAULT now()
        )`);

      const recorded = new Map(
        (
          await client.query<{ name: string; checksum: string }>(
            'SELECT name, checksum FROM codegraph.schema_migrations',
          )
        ).rows.map((row) => [row.name, row.checksum]),
      );
      const known = new Set(files.map((file) => file.name));
      for (const name of recorded.keys()) {
        if (!known.has(name)) {
          throw new Error(`Migration ${name} is recorded as applied but its file is missing.`);
        }
      }
      for (const file of files) {
        const applied = recorded.get(file.name);
        if (applied !== undefined && applied !== file.checksum) {
          throw new MigrationChecksumError(file.name);
        }
      }

      const result: MigrateResult = { applied: [], skipped: [] };
      for (const file of files) {
        if (recorded.has(file.name)) {
          result.skipped.push(file.name);
          continue;
        }
        await client.query('BEGIN');
        try {
          await client.query(file.sql);
          await client.query(
            'INSERT INTO codegraph.schema_migrations (name, checksum) VALUES ($1, $2)',
            [file.name, file.checksum],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw new Error(`Migration ${file.name} failed: ${(error as Error).message}`, {
            cause: error,
          });
        }
        log(`applied ${file.name}`);
        result.applied.push(file.name);
      }
      if (result.applied.length === 0) {
        log(`nothing to apply (${String(result.skipped.length)} already applied)`);
      }
      return result;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}
