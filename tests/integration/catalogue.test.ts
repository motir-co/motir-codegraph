import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INSUFFICIENT_PRIVILEGE, queryRows, sqlState, withClient } from '../helpers/db.js';
import { foundation, type Foundation } from './foundation.fixture.js';

/**
 * Tables that carry no tenant row, or whose rows codegraph_app reaches only
 * through owner functions. The exclusion is safe only while codegraph_app has
 * no privilege on them at all, which the privilege guard below asserts.
 */
const PRE_BINDING = ['clients', 'credentials', 'grants', 'schema_migrations'];
const BOUND = '( SELECT codegraph.codegraph_bound_tenant() AS codegraph_bound_tenant)';

let f: Foundation;
beforeAll(async () => {
  f = await foundation();
});
afterAll(async () => {
  await f.db.drop();
});

interface Finding {
  table: string;
  problem: string;
}

/**
 * The tenant-owned set, derived from the catalogue: `tenants`, plus every
 * table in schema codegraph with a `tenant_id` column, minus PRE_BINDING.
 */
async function tenantOwnedTables(c: pg.Client): Promise<{ table: string; column: string }[]> {
  const rows = await queryRows<{ table: string; column: string }>(
    c,
    `SELECT c.relname AS table, CASE WHEN c.relname = 'tenants' THEN 'id' ELSE 'tenant_id' END AS column
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'codegraph' AND c.relkind IN ('r', 'p')
        AND (c.relname = 'tenants' OR EXISTS (
              SELECT 1 FROM pg_attribute a
               WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped))
        AND NOT (c.relname = ANY($1))
      ORDER BY 1`,
    [PRE_BINDING],
  );
  return rows;
}

/**
 * Every rule a tenant-owned table must meet: RLS enabled and forced, exactly
 * one policy for codegraph_app comparing its tenant column to the uncorrelated
 * bound-tenant sub-select in both USING and WITH CHECK, and one for
 * codegraph_owner. Returns what fails; an empty list is a pass.
 */
async function scan(c: pg.Client): Promise<{ tables: string[]; findings: Finding[] }> {
  // With codegraph off the search_path, pg_get_expr prints names qualified.
  await c.query('SET LOCAL search_path = pg_catalog');
  const tables = await tenantOwnedTables(c);
  const findings: Finding[] = [];
  for (const { table, column } of tables) {
    const [flags] = await queryRows<{ enabled: boolean; forced: boolean }>(
      c,
      `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'codegraph' AND c.relname = $1`,
      [table],
    );
    if (flags?.enabled !== true)
      findings.push({ table, problem: 'row-level security not enabled' });
    if (flags?.forced !== true) findings.push({ table, problem: 'row-level security not forced' });
    const policies = await queryRows<{
      roles: string[];
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(
      c,
      `SELECT roles::text[] AS roles, cmd, qual, with_check FROM pg_policies
        WHERE schemaname = 'codegraph' AND tablename = $1`,
      [table],
    );
    const app = policies.filter((p) => p.roles.includes('codegraph_app'));
    const owner = policies.filter((p) => p.roles.includes('codegraph_owner'));
    const expected = `(${column} = ${BOUND})`;
    if (app.length !== 1) {
      findings.push({ table, problem: `${String(app.length)} policies for codegraph_app` });
    }
    for (const policy of app) {
      if (policy.cmd !== 'ALL' || policy.roles.length !== 1) {
        findings.push({ table, problem: 'codegraph_app policy is not FOR ALL TO codegraph_app' });
      }
      if (policy.qual !== expected || policy.with_check !== expected) {
        findings.push({
          table,
          problem: `codegraph_app policy is ${String(policy.qual)} / ${String(policy.with_check)}, not ${expected}`,
        });
      }
    }
    if (owner.length !== 1) {
      findings.push({ table, problem: `${String(owner.length)} policies for codegraph_owner` });
    }
    if (policies.length !== app.length + owner.length) {
      findings.push({ table, problem: 'a policy for a role other than the two logins' });
    }
  }
  return { tables: tables.map((t) => t.table), findings };
}

describe('the catalogue', () => {
  it('holds no column with an organisation, organization, org, project or workspace word segment', async () => {
    const columns = await withClient(f.db.ownerUrl, (c) =>
      queryRows<{ table_name: string; column_name: string }>(
        c,
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'codegraph' ORDER BY 1, 2`,
      ),
    );
    expect(columns.length).toBeGreaterThan(0);
    const forbidden = /^(organisations?|organizations?|orgs?|projects?|workspaces?)$/;
    expect(
      columns.filter((col) =>
        col.column_name.split('_').some((segment) => forbidden.test(segment)),
      ),
    ).toEqual([]);
  });

  it('forces row-level security with both policies on every tenant-owned table', async () => {
    const result = await withClient(f.db.ownerUrl, async (c) => {
      await c.query('BEGIN');
      try {
        return await scan(c);
      } finally {
        await c.query('ROLLBACK');
      }
    });
    expect(result.tables).toEqual(
      expect.arrayContaining([
        'blob',
        'blob_contents',
        'blob_fact',
        'content_access_log',
        'repositories',
        'tenants',
      ]),
    );
    expect(result.findings).toEqual([]);
  });

  it('self-check: the scan reports a tenant_id table without forced row-level security', async () => {
    const result = await withClient(f.db.ownerUrl, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('CREATE TABLE codegraph.scratch_unguarded (id uuid, tenant_id uuid)');
        await c.query('ALTER TABLE codegraph.scratch_unguarded ENABLE ROW LEVEL SECURITY');
        return await scan(c);
      } finally {
        await c.query('ROLLBACK');
      }
    });
    expect(result.tables).toContain('scratch_unguarded');
    expect(result.findings.filter((x) => x.table === 'scratch_unguarded')).toEqual([
      { table: 'scratch_unguarded', problem: 'row-level security not forced' },
      { table: 'scratch_unguarded', problem: '0 policies for codegraph_app' },
      { table: 'scratch_unguarded', problem: '0 policies for codegraph_owner' },
    ]);
    const gone = await withClient(f.db.ownerUrl, (c) =>
      queryRows(c, "SELECT to_regclass('codegraph.scratch_unguarded') AS t"),
    );
    expect(gone).toEqual([{ t: null }]);
  });

  it('self-check: the scan reports a correlated tenant policy', async () => {
    const result = await withClient(f.db.ownerUrl, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(
          'ALTER POLICY repositories_tenant ON codegraph.repositories USING (tenant_id = codegraph.codegraph_bound_tenant())',
        );
        return await scan(c);
      } finally {
        await c.query('ROLLBACK');
      }
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.table).toBe('repositories');
  });
});

describe('codegraph_app', () => {
  it('holds no superuser, no BYPASSRLS and no membership in codegraph_owner', async () => {
    const roles = await withClient(f.db.ownerUrl, (c) =>
      queryRows(
        c,
        `SELECT r.rolsuper, r.rolbypassrls,
                pg_has_role('codegraph_app', 'codegraph_owner', 'MEMBER') AS member_of_owner
           FROM pg_roles r WHERE r.rolname = 'codegraph_app'`,
      ),
    );
    expect(roles).toEqual([{ rolsuper: false, rolbypassrls: false, member_of_owner: false }]);
  });

  it('holds no CREATE on the database or any schema', async () => {
    const privileges = await withClient(f.db.appUrl, (c) =>
      queryRows<{ target: string; create: boolean }>(
        c,
        `SELECT 'database' AS target, has_database_privilege(current_database(), 'CREATE') AS create
         UNION ALL
         SELECT nspname, has_schema_privilege(oid, 'CREATE') FROM pg_namespace
          WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'`,
      ),
    );
    expect(privileges.length).toBeGreaterThanOrEqual(3);
    expect(privileges.filter((p) => p.create)).toEqual([]);
  });

  it('holds no privilege of any kind on the pre-binding tables', async () => {
    const held = await withClient(f.db.appUrl, (c) =>
      queryRows(
        c,
        `SELECT t.name, p.privilege FROM unnest($1::text[]) AS t(name)
           CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p(privilege)
          WHERE has_table_privilege('codegraph.' || t.name, p.privilege)
             OR (p.privilege IN ('SELECT','INSERT','UPDATE','REFERENCES')
                 AND has_any_column_privilege('codegraph.' || t.name, p.privilege))`,
        [PRE_BINDING],
      ),
    );
    expect(held).toEqual([]);
  });

  it('is refused every statement that would widen what it can reach', async () => {
    await withClient(f.db.appUrl, async (c) => {
      await c.query('BEGIN');
      const refused = [
        'SET ROLE codegraph_owner',
        'CREATE TABLE codegraph.mine (id int)',
        'CREATE TABLE public.mine (id int)',
        'ALTER TABLE codegraph.repositories DISABLE ROW LEVEL SECURITY',
        'ALTER TABLE codegraph.repositories NO FORCE ROW LEVEL SECURITY',
        'SELECT 1 FROM codegraph.content_access_log',
        "INSERT INTO codegraph.tenants (display_name) VALUES ('mine')",
        `INSERT INTO codegraph.repositories (tenant_id, display_name) VALUES ('${f.fx.tenantA.id}', 'mine')`,
        ...PRE_BINDING.map((table) => `SELECT 1 FROM codegraph.${table}`),
      ];
      for (const statement of refused) {
        expect(await sqlState(c, statement), statement).toBe(INSUFFICIENT_PRIVILEGE);
      }
      await c.query('ROLLBACK');
    });
  });
});
