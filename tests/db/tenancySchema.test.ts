import { randomBytes, randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  freshDatabase,
  INSUFFICIENT_PRIVILEGE,
  queryRows,
  sqlState,
  withClient,
  type FreshDatabase,
} from '../helpers/db.js';

let db: FreshDatabase;

beforeAll(async () => {
  db = await freshDatabase();
});

afterAll(async () => {
  await db.drop();
});

/** Rows written as the owner, which the owner policy admits on every forced table. */
async function seed(owner: pg.Client) {
  const tenant = randomUUID();
  const otherTenant = randomUUID();
  const repository = randomUUID();
  const otherRepository = randomUUID();
  const client = randomUUID();
  await owner.query('INSERT INTO codegraph.tenants (id, display_name) VALUES ($1, $2), ($3, $4)', [
    tenant,
    'Tenant A',
    otherTenant,
    'Tenant B',
  ]);
  await owner.query(
    'INSERT INTO codegraph.repositories (id, tenant_id, display_name) VALUES ($1, $2, $3), ($4, $5, $6)',
    [repository, tenant, 'repo-a', otherRepository, otherTenant, 'repo-b'],
  );
  await owner.query(
    "INSERT INTO codegraph.clients (id, name, kind) VALUES ($1, 'reader', 'client')",
    [client],
  );
  await owner.query(
    "INSERT INTO codegraph.credentials (client_id, token_hash, display_prefix) VALUES ($1, $2, 'cg_abc')",
    [client, randomBytes(32)],
  );
  await owner.query('INSERT INTO codegraph.grants (client_id, tenant_id) VALUES ($1, $2)', [
    client,
    tenant,
  ]);
  await owner.query(
    "INSERT INTO codegraph.content_access_log (tenant_id, repository_id, client_id, content_ref) VALUES ($1, $2, $3, 'src/a.ts@blob')",
    [tenant, repository, client],
  );
  return { tenant, otherTenant, repository, otherRepository, client };
}

describe('codegraph_app, the login the service runs as', () => {
  it('owns no relation in the database', async () => {
    const owned = await withClient(
      db.ownerUrl,
      async (c) =>
        (
          await queryRows(
            c,
            "SELECT count(*)::int AS n FROM pg_class WHERE relowner = 'codegraph_app'::regrole",
          )
        )[0],
    );
    expect(owned).toEqual({ n: 0 });
    const owners = await withClient(
      db.ownerUrl,
      async (c) =>
        await queryRows(
          c,
          "SELECT DISTINCT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relnamespace = 'codegraph'::regnamespace",
        ),
    );
    expect(owners).toEqual([{ owner: 'codegraph_owner' }]);
  });

  it('has CREATE on no schema and cannot create a table', async () => {
    await withClient(db.appUrl, async (c) => {
      const schemas = await c.query<{ nspname: string }>(
        "SELECT nspname FROM pg_namespace WHERE has_schema_privilege(oid, 'CREATE')",
      );
      expect(schemas.rows).toEqual([]);
      await c.query('BEGIN');
      expect(await sqlState(c, 'CREATE TABLE codegraph.mine (id int)')).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      expect(await sqlState(c, 'CREATE TABLE public.mine (id int)')).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlState(c, 'CREATE SCHEMA mine')).toBe(INSUFFICIENT_PRIVILEGE);
      await c.query('ROLLBACK');
    });
  });

  it('cannot disable row-level security on repositories', async () => {
    await withClient(db.appUrl, async (c) => {
      await c.query('BEGIN');
      expect(
        await sqlState(c, 'ALTER TABLE codegraph.repositories DISABLE ROW LEVEL SECURITY'),
      ).toBe(INSUFFICIENT_PRIVILEGE);
      await c.query('ROLLBACK');
    });
  });

  it.each(['clients', 'credentials', 'grants', 'schema_migrations'])(
    'cannot select from %s',
    async (table) => {
      await withClient(db.appUrl, async (c) => {
        await c.query('BEGIN');
        expect(await sqlState(c, `SELECT * FROM codegraph.${table}`)).toBe(INSUFFICIENT_PRIVILEGE);
        await c.query('ROLLBACK');
      });
    },
  );

  it('holds exactly the grant matrix the schema contract allows', async () => {
    const matrix = await withClient(
      db.appUrl,
      async (c) =>
        (
          await c.query<{ table: string; privilege: string; allowed: boolean }>(`
        SELECT t AS table, p AS privilege, has_table_privilege('codegraph.' || t, p) AS allowed
        FROM unnest(ARRAY['tenants','repositories','clients','credentials','grants',
                          'content_access_log','schema_migrations',
                          'blob','blob_contents','blob_fact']) t,
             unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
        ORDER BY 1, 2`)
        ).rows,
    );
    const allowed = matrix
      .filter((row) => row.allowed)
      .map((row) => `${row.table}:${row.privilege}`);
    expect(allowed.sort()).toEqual(
      [
        'blob:DELETE',
        'blob:INSERT',
        'blob:SELECT',
        'blob_contents:DELETE',
        'blob_contents:INSERT',
        'blob_contents:SELECT',
        'blob_fact:DELETE',
        'blob_fact:INSERT',
        'blob_fact:SELECT',
        'content_access_log:INSERT',
        'repositories:DELETE',
        'repositories:SELECT',
        'tenants:DELETE',
        'tenants:SELECT',
      ].sort(),
    );
    const columns = await withClient(
      db.appUrl,
      async (c) =>
        (
          await c.query<{ table: string; column: string }>(`
        SELECT table_name AS table, column_name AS column
        FROM information_schema.columns
        WHERE table_schema = 'codegraph'
          AND has_column_privilege('codegraph.' || table_name, column_name, 'UPDATE')
        ORDER BY 1, 2`)
        ).rows,
    );
    expect(columns).toEqual([
      { table: 'blob', column: 'extractor_version' },
      { table: 'blob', column: 'language' },
      { table: 'blob', column: 'lossy' },
      { table: 'blob', column: 'outcome' },
      { table: 'blob', column: 'parsed_with_errors' },
      { table: 'blob', column: 'refused_cap_bytes' },
      { table: 'repositories', column: 'display_name' },
      { table: 'tenants', column: 'display_name' },
    ]);
  });

  it('appends to the access log but cannot change or remove a row; cannot insert tenants or repositories', async () => {
    const ids = await withClient(db.ownerUrl, seed);
    await withClient(db.appUrl, async (c) => {
      await c.query('BEGIN');
      // Bound to the granted tenant, so row-level security (0002) admits the
      // rows and only the table privileges are measured here.
      await c.query(
        "SELECT set_config('app.client_id', $1, true), set_config('app.tenant_id', $2, true)",
        [ids.client, ids.tenant],
      );
      expect(
        await sqlState(
          c,
          "INSERT INTO codegraph.content_access_log (tenant_id, repository_id, client_id, content_ref) VALUES ($1, $2, $3, 'src/b.ts@blob')",
          [ids.tenant, ids.repository, ids.client],
        ),
      ).toBeNull();
      expect(await sqlState(c, "UPDATE codegraph.content_access_log SET content_ref = 'x'")).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      expect(await sqlState(c, 'DELETE FROM codegraph.content_access_log')).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      expect(
        await sqlState(c, "INSERT INTO codegraph.tenants (display_name) VALUES ('mine')"),
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect(
        await sqlState(
          c,
          "INSERT INTO codegraph.repositories (tenant_id, display_name) VALUES ($1, 'mine')",
          [ids.tenant],
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect(
        await sqlState(
          c,
          "UPDATE codegraph.repositories SET display_name = 'renamed' WHERE id = $1",
          [ids.repository],
        ),
      ).toBeNull();
      expect(
        await sqlState(c, 'UPDATE codegraph.repositories SET created_at = now() WHERE id = $1', [
          ids.repository,
        ]),
      ).toBe(INSUFFICIENT_PRIVILEGE);
      await c.query('ROLLBACK');
    });
  });
});

describe('credentials', () => {
  it('has no column that could hold a token', async () => {
    const columns = await withClient(
      db.ownerUrl,
      async (c) =>
        (
          await c.query<{ column_name: string; data_type: string }>(
            "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'codegraph' AND table_name = 'credentials' ORDER BY ordinal_position",
          )
        ).rows,
    );
    expect(columns.map((c) => c.column_name)).toEqual([
      'id',
      'client_id',
      'token_hash',
      'display_prefix',
      'created_at',
      'revoked_at',
    ]);
    expect(columns.some((c) => /token$|secret/.test(c.column_name))).toBe(false);
    expect(columns.find((c) => c.column_name === 'token_hash')?.data_type).toBe('bytea');
  });

  it('stores only a 32-byte hash, unique, and a display prefix of at most 12 characters', async () => {
    await withClient(db.ownerUrl, async (c) => {
      const client = randomUUID();
      await c.query('BEGIN');
      await c.query("INSERT INTO codegraph.clients (id, name, kind) VALUES ($1, 'c', 'client')", [
        client,
      ]);
      const insert = (hash: Buffer, prefix = 'cg_1') =>
        sqlState(
          c,
          'INSERT INTO codegraph.credentials (client_id, token_hash, display_prefix) VALUES ($1, $2, $3)',
          [client, hash, prefix],
        );
      const hash = randomBytes(32);
      expect(await insert(hash)).toBeNull();
      expect(await insert(hash)).toBe('23505');
      for (const length of [0, 16, 31, 33, 64]) {
        expect(await insert(randomBytes(length))).toBe('23514');
      }
      expect(await insert(randomBytes(32), 'x'.repeat(13))).toBe('23514');
      expect(await insert(randomBytes(32), '')).toBe('23514');
      expect(await insert(randomBytes(32), 'x'.repeat(12))).toBeNull();
      await c.query('ROLLBACK');
    });
  });

  it('allows one live grant per client and tenant', async () => {
    await withClient(db.ownerUrl, async (c) => {
      const ids = await seed(c);
      await c.query('BEGIN');
      expect(
        await sqlState(c, 'INSERT INTO codegraph.grants (client_id, tenant_id) VALUES ($1, $2)', [
          ids.client,
          ids.tenant,
        ]),
      ).toBe('23505');
      await c.query('UPDATE codegraph.grants SET revoked_at = now() WHERE client_id = $1', [
        ids.client,
      ]);
      expect(
        await sqlState(c, 'INSERT INTO codegraph.grants (client_id, tenant_id) VALUES ($1, $2)', [
          ids.client,
          ids.tenant,
        ]),
      ).toBeNull();
      await c.query('ROLLBACK');
    });
  });
});

describe('cascading deletes', () => {
  it('a repository delete removes every row referencing its (tenant, repository) pair', async () => {
    await withClient(db.ownerUrl, async (c) => {
      const ids = await seed(c);
      await c.query('DELETE FROM codegraph.repositories WHERE id = $1', [ids.repository]);
      const left = await c.query(
        'SELECT count(*)::int AS n FROM codegraph.content_access_log WHERE repository_id = $1',
        [ids.repository],
      );
      expect(left.rows[0]).toEqual({ n: 0 });
      const tenant = await c.query(
        'SELECT count(*)::int AS n FROM codegraph.tenants WHERE id = $1',
        [ids.tenant],
      );
      expect(tenant.rows[0]).toEqual({ n: 1 });
    });
  });

  it('a tenant delete removes its repositories, their log rows and its grants, and keeps its clients and their credentials', async () => {
    await withClient(db.ownerUrl, async (c) => {
      const ids = await seed(c);
      await c.query('DELETE FROM codegraph.tenants WHERE id = $1', [ids.tenant]);
      const counts = (
        await queryRows(
          c,
          `SELECT
             (SELECT count(*)::int FROM codegraph.repositories WHERE tenant_id = $1) AS repositories,
             (SELECT count(*)::int FROM codegraph.content_access_log WHERE tenant_id = $1) AS log_rows,
             (SELECT count(*)::int FROM codegraph.grants WHERE tenant_id = $1) AS grants,
             (SELECT count(*)::int FROM codegraph.clients WHERE id = $2) AS clients,
             (SELECT count(*)::int FROM codegraph.credentials WHERE client_id = $2) AS credentials,
             (SELECT count(*)::int FROM codegraph.repositories WHERE tenant_id = $3) AS other_repositories`,
          [ids.tenant, ids.client, ids.otherTenant],
        )
      )[0];
      expect(counts).toEqual({
        repositories: 0,
        log_rows: 0,
        grants: 0,
        clients: 1,
        credentials: 1,
        other_repositories: 1,
      });
    });
  });

  it('rejects an access-log row naming another tenant’s repository', async () => {
    await withClient(db.ownerUrl, async (c) => {
      const ids = await seed(c);
      await c.query('BEGIN');
      expect(
        await sqlState(
          c,
          "INSERT INTO codegraph.content_access_log (tenant_id, repository_id, client_id, content_ref) VALUES ($1, $2, $3, 'x')",
          [ids.tenant, ids.otherRepository, ids.client],
        ),
      ).toBe('23503');
      await c.query('ROLLBACK');
    });
  });
});

describe('the catalogue', () => {
  it('holds no column named for a Motir organisation, project or workspace', async () => {
    const columns = await withClient(
      db.ownerUrl,
      async (c) =>
        (
          await c.query<{ table_name: string; column_name: string }>(
            "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'codegraph'",
          )
        ).rows,
    );
    expect(columns.length).toBeGreaterThan(0);
    const forbidden = /^(organisations?|organizations?|orgs?|projects?|workspaces?)$/;
    const offenders = columns.filter((c) =>
      c.column_name.split('_').some((segment) => forbidden.test(segment)),
    );
    expect(offenders).toEqual([]);
  });
});
