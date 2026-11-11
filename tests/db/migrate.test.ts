import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checksum,
  migrate,
  MigrationChecksumError,
  MIGRATIONS_DIR,
  readMigrations,
} from '../../src/db/migrate.js';
import { freshDatabase, queryRows, withClient, type FreshDatabase } from '../helpers/db.js';

/** Every table, column, constraint, index, policy and grant in schema codegraph. */
const CATALOGUE_SNAPSHOT = `
  SELECT
    (SELECT json_agg(c ORDER BY c.table_name, c.ordinal_position) FROM (
       SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default
       FROM information_schema.columns WHERE table_schema = 'codegraph') c) AS columns,
    (SELECT json_agg(k ORDER BY k.conname) FROM (
       SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE connamespace = 'codegraph'::regnamespace) k) AS constraints,
    (SELECT json_agg(i ORDER BY i.indexname) FROM (
       SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'codegraph') i) AS indexes,
    (SELECT json_agg(g ORDER BY g.table_name, g.grantee, g.privilege_type) FROM (
       SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'codegraph') g) AS table_grants,
    (SELECT json_agg(g ORDER BY g.table_name, g.column_name, g.grantee, g.privilege_type) FROM (
       SELECT table_name, column_name, grantee, privilege_type
       FROM information_schema.column_privileges
       WHERE table_schema = 'codegraph' AND grantee = 'codegraph_app') g) AS column_grants,
    (SELECT json_agg(p ORDER BY p.tablename, p.policyname) FROM (
       SELECT tablename, policyname, roles, qual, with_check FROM pg_policies
       WHERE schemaname = 'codegraph') p) AS policies`;

let db: FreshDatabase | undefined;
const temporaryDirs: string[] = [];

afterEach(async () => {
  await db?.drop();
  db = undefined;
  for (const dir of temporaryDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function copyOfMigrations(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codegraph-migrations-'));
  temporaryDirs.push(dir);
  await cp(MIGRATIONS_DIR, dir, { recursive: true });
  return dir;
}

async function recorded(url: string): Promise<{ name: string; checksum: string }[]> {
  return withClient(
    url,
    async (c) =>
      (
        await c.query<{ name: string; checksum: string }>(
          'SELECT name, checksum FROM codegraph.schema_migrations ORDER BY name',
        )
      ).rows,
  );
}

describe('db:migrate', () => {
  it('applies every file in filename order and records each with its checksum', async () => {
    db = await freshDatabase({ migrate: false });
    const lines: string[] = [];
    const result = await db.migrate({ log: (line) => lines.push(line) });

    const files = await readMigrations(MIGRATIONS_DIR);
    expect(files.length).toBeGreaterThan(0);
    expect(result).toEqual({ applied: files.map((f) => f.name), skipped: [] });
    expect(lines).toEqual(files.map((f) => `applied ${f.name}`));
    expect(await recorded(db.ownerUrl)).toEqual(
      files.map((f) => ({ name: f.name, checksum: checksum(f.sql) })),
    );
  });

  it('applies nothing on a re-run and leaves the catalogue identical', async () => {
    const current = await freshDatabase();
    db = current;
    const snapshot = async () =>
      withClient(current.ownerUrl, async (c) => (await queryRows(c, CATALOGUE_SNAPSHOT))[0]);
    const before = await snapshot();
    const migrationsBefore = await recorded(db.ownerUrl);

    const lines: string[] = [];
    const result = await db.migrate({ log: (line) => lines.push(line) });

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(migrationsBefore.map((m) => m.name));
    expect(lines).toEqual([
      `nothing to apply (${String(migrationsBefore.length)} already applied)`,
    ]);
    expect(await recorded(db.ownerUrl)).toEqual(migrationsBefore);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses an edited applied migration by name and applies nothing in that run', async () => {
    const dir = await copyOfMigrations();
    db = await freshDatabase({ migrate: false });
    await db.migrate({ migrationsDir: dir });
    const before = await recorded(db.ownerUrl);

    const edited = join(dir, '0001_tenancy.sql');
    await writeFile(edited, `${await readFile(edited, 'utf8')}\n-- an edit\n`);
    await writeFile(join(dir, '9999_never_applied.sql'), 'CREATE TABLE codegraph.never (id int);');

    const run = db.migrate({ migrationsDir: dir });
    await expect(run).rejects.toBeInstanceOf(MigrationChecksumError);
    await expect(run).rejects.toThrow(/0001_tenancy\.sql/);
    expect(await recorded(db.ownerUrl)).toEqual(before);
    const never = await withClient(
      db.ownerUrl,
      async (c) => (await queryRows(c, "SELECT to_regclass('codegraph.never') AS t"))[0],
    );
    expect(never).toEqual({ t: null });
  });

  it('refuses a recorded migration whose file has gone', async () => {
    const dir = await copyOfMigrations();
    db = await freshDatabase({ migrate: false });
    await writeFile(join(dir, '9998_extra.sql'), 'SELECT 1;');
    await db.migrate({ migrationsDir: dir });
    await rm(join(dir, '9998_extra.sql'));
    await expect(db.migrate({ migrationsDir: dir })).rejects.toThrow(
      /9998_extra\.sql is recorded as applied but its file is missing/,
    );
  });

  it('rolls a failing migration back whole and names it', async () => {
    const dir = await copyOfMigrations();
    db = await freshDatabase({ migrate: false });
    await writeFile(
      join(dir, '9997_broken.sql'),
      'CREATE TABLE codegraph.half (id int); SELECT no_such_function();',
    );
    await expect(db.migrate({ migrationsDir: dir })).rejects.toThrow(
      /Migration 9997_broken\.sql failed/,
    );
    const state = await withClient(db.ownerUrl, async (c) => ({
      half: (await queryRows(c, "SELECT to_regclass('codegraph.half') AS t"))[0],
      names: await queryRows(c, 'SELECT name FROM codegraph.schema_migrations ORDER BY name'),
    }));
    expect(state.half).toEqual({ t: null });
    expect(state.names.map((r) => r['name'])).not.toContain('9997_broken.sql');
  });

  it('serialises concurrent runs so each file is applied exactly once', async () => {
    db = await freshDatabase({ migrate: false });
    const [first, second] = await Promise.all([db.migrate(), db.migrate()]);
    const files = (await readMigrations(MIGRATIONS_DIR)).map((f) => f.name);
    expect([...first.applied, ...second.applied].sort()).toEqual(files);
    expect(await recorded(db.ownerUrl)).toHaveLength(files.length);
  });

  it('runs as codegraph_owner only', async () => {
    db = await freshDatabase({ migrate: false });
    await expect(migrate({ connectionString: db.appUrl })).rejects.toThrow(
      /Migrations run as codegraph_owner only; DATABASE_URL connects as codegraph_app/,
    );
  });

  it('refuses a file whose name is not NNNN_lower_snake_case.sql', async () => {
    const dir = await copyOfMigrations();
    await writeFile(join(dir, 'Add Table.sql'), 'SELECT 1;');
    await expect(readMigrations(dir)).rejects.toThrow(/Add Table\.sql does not match/);
  });
});
