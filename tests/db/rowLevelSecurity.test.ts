import { randomUUID } from 'node:crypto';

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
import {
  buildTenancyFixture,
  inBoundTransaction,
  type Binding,
  type TenancyFixture,
} from '../helpers/tenancy.js';

const RLS_VIOLATION = '42501'; // new row violates row-level security policy
const MUST_BE_OWNER = '42501'; // Postgres reports must-be-owner as insufficient_privilege
const TENANT_TABLES = [
  'tenants',
  'repositories',
  'content_access_log',
  'blob',
  'blob_contents',
  'blob_fact',
] as const;

let db: FreshDatabase;
let fx: TenancyFixture;

beforeAll(async () => {
  db = await freshDatabase();
  fx = await buildTenancyFixture(db);
});

afterAll(async () => {
  await db.drop();
});

async function visible(c: pg.Client) {
  const tenants = await queryRows<{ id: string; display_name: string }>(
    c,
    'SELECT id, display_name FROM codegraph.tenants ORDER BY display_name',
  );
  const repositories = await queryRows<{ id: string; tenant_id: string; display_name: string }>(
    c,
    'SELECT id, tenant_id, display_name FROM codegraph.repositories ORDER BY display_name',
  );
  return { tenants, repositories };
}

async function rowCount(c: pg.Client, sql: string, params: unknown[]): Promise<number | null> {
  return (await c.query(sql, params)).rowCount;
}

const insertLog =
  'INSERT INTO codegraph.content_access_log (tenant_id, repository_id, client_id, content_ref) VALUES ($1, $2, $3, $4)';

async function ownerSnapshot() {
  return await withClient(db.ownerUrl, async (c) => ({
    repositories: await queryRows(
      c,
      'SELECT id, tenant_id, display_name FROM codegraph.repositories ORDER BY id',
    ),
    log: await queryRows(
      c,
      'SELECT tenant_id, repository_id, content_ref FROM codegraph.content_access_log ORDER BY content_ref',
    ),
  }));
}

describe('a session bound to a tenant it is granted', () => {
  it('reads exactly that tenant, renames its repository and appends to its access log', async () => {
    const [repoA] = fx.tenantA.repositories;
    if (repoA === undefined) throw new Error('fixture has no repository');
    const ref = `granted-${randomUUID()}`;
    await withClient(db.appUrl, (c) =>
      inBoundTransaction(
        c,
        { clientId: fx.readerId, tenantId: fx.tenantA.id },
        async () => {
          const seen = await visible(c);
          expect(seen.tenants).toEqual([{ id: fx.tenantA.id, display_name: fx.tenantA.name }]);
          expect(seen.repositories).toEqual(
            fx.tenantA.repositories
              .map((r) => ({ id: r.id, tenant_id: fx.tenantA.id, display_name: r.name }))
              .sort((x, y) => x.display_name.localeCompare(y.display_name)),
          );
          expect(
            await rowCount(
              c,
              'UPDATE codegraph.repositories SET display_name = display_name WHERE id = $1',
              [repoA.id],
            ),
          ).toBe(1);
          // A plain INSERT: RETURNING would need SELECT, which the app does not hold.
          await c.query(insertLog, [fx.tenantA.id, repoA.id, fx.readerId, ref]);
        },
        { commit: true },
      ),
    );
    const log = await withClient(db.ownerUrl, (c) =>
      queryRows(
        c,
        'SELECT tenant_id, repository_id FROM codegraph.content_access_log WHERE content_ref = $1',
        [ref],
      ),
    );
    expect(log).toEqual([{ tenant_id: fx.tenantA.id, repository_id: repoA.id }]);
  });

  it('cannot write an access-log row for another tenant’s repository', async () => {
    const [repoB] = fx.tenantB.repositories;
    if (repoB === undefined) throw new Error('fixture has no repository');
    const before = await ownerSnapshot();
    await withClient(db.appUrl, (c) =>
      inBoundTransaction(c, { clientId: fx.readerId, tenantId: fx.tenantA.id }, async () => {
        expect(await sqlState(c, insertLog, [fx.tenantB.id, repoB.id, fx.readerId, 'cross'])).toBe(
          RLS_VIOLATION,
        );
      }),
    );
    expect(await ownerSnapshot()).toEqual(before);
  });
});

describe.each<[string, () => Binding]>([
  [
    'bound to a tenant it is not granted',
    () => ({ clientId: fx.readerId, tenantId: fx.tenantB.id }),
  ],
  ['with nothing bound', () => ({})],
  ['with only the tenant bound', () => ({ tenantId: fx.tenantA.id })],
  ['with a malformed tenant', () => ({ clientId: fx.readerId, tenantId: 'not-a-uuid' })],
  ['with a malformed client', () => ({ clientId: `${fx.readerId}x`, tenantId: fx.tenantA.id })],
  ['with empty settings', () => ({ clientId: '', tenantId: '' })],
])('a session %s', (_label, binding) => {
  it('sees no row, and every write is refused or touches nothing', async () => {
    const before = await ownerSnapshot();
    await withClient(db.appUrl, (c) =>
      inBoundTransaction(
        c,
        binding(),
        async () => {
          expect(await visible(c)).toEqual({ tenants: [], repositories: [] });
          for (const tenant of [fx.tenantA, fx.tenantB]) {
            for (const repository of tenant.repositories) {
              expect(
                await sqlState(c, insertLog, [tenant.id, repository.id, fx.readerId, 'refused']),
              ).toBe(RLS_VIOLATION);
              expect(
                await rowCount(
                  c,
                  "UPDATE codegraph.repositories SET display_name = 'hijacked' WHERE id = $1",
                  [repository.id],
                ),
              ).toBe(0);
              expect(
                await rowCount(c, 'DELETE FROM codegraph.repositories WHERE id = $1', [
                  repository.id,
                ]),
              ).toBe(0);
            }
            expect(
              await rowCount(c, 'DELETE FROM codegraph.tenants WHERE id = $1', [tenant.id]),
            ).toBe(0);
          }
        },
        { commit: true },
      ),
    );
    expect(await ownerSnapshot()).toEqual(before);
  });
});

describe('revoking a grant', () => {
  it('shuts the client out of the tenant from the next transaction on', async () => {
    const own = await freshDatabase();
    try {
      const f = await buildTenancyFixture(own);
      const [repoA] = f.tenantA.repositories;
      if (repoA === undefined) throw new Error('fixture has no repository');
      const bound = { clientId: f.readerId, tenantId: f.tenantA.id };
      await withClient(own.appUrl, async (c) => {
        await inBoundTransaction(c, bound, async () => {
          expect((await visible(c)).tenants).toHaveLength(1);
        });
        await inBoundTransaction(
          c,
          { clientId: f.operatorId },
          async () => {
            const revoked = await queryRows<{ revoked: boolean }>(
              c,
              'SELECT codegraph.codegraph_revoke_access($1, $2) AS revoked',
              [f.readerId, f.tenantA.id],
            );
            expect(revoked).toEqual([{ revoked: true }]);
          },
          { commit: true },
        );
        await inBoundTransaction(c, bound, async () => {
          expect(await visible(c)).toEqual({ tenants: [], repositories: [] });
          expect(await sqlState(c, insertLog, [f.tenantA.id, repoA.id, f.readerId, 'after'])).toBe(
            RLS_VIOLATION,
          );
          expect(
            await rowCount(
              c,
              "UPDATE codegraph.repositories SET display_name = 'x' WHERE id = $1",
              [repoA.id],
            ),
          ).toBe(0);
        });
      });
    } finally {
      await own.drop();
    }
  });
});

describe('codegraph_app cannot loosen row-level security', () => {
  it.each(TENANT_TABLES)('on %s', async (table) => {
    const policy = `${table}_tenant`;
    await withClient(db.appUrl, async (c) => {
      await c.query('BEGIN');
      for (const statement of [
        `ALTER TABLE codegraph.${table} DISABLE ROW LEVEL SECURITY`,
        `ALTER TABLE codegraph.${table} NO FORCE ROW LEVEL SECURITY`,
        `ALTER POLICY ${policy} ON codegraph.${table} USING (true)`,
        `DROP POLICY ${policy} ON codegraph.${table}`,
      ]) {
        expect(await sqlState(c, statement), statement).toBe(MUST_BE_OWNER);
      }
      await c.query('ROLLBACK');
    });
  });
});

describe('the policy shape', () => {
  it('forces row-level security with one tenant policy and one owner policy on each table', async () => {
    const shape = await withClient(db.ownerUrl, async (c) => {
      // With codegraph off the search_path, pg_get_expr prints names qualified.
      await c.query('SET search_path = pg_catalog');
      return {
        tables: await queryRows(
          c,
          `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'codegraph' AND c.relname = ANY($1) ORDER BY 1`,
          [TENANT_TABLES],
        ),
        policies: await queryRows(
          c,
          `SELECT tablename, policyname, permissive, roles::text[] AS roles, cmd, qual, with_check
             FROM pg_policies WHERE schemaname = 'codegraph' ORDER BY tablename, policyname`,
        ),
      };
    });
    expect(shape.tables).toEqual(
      [...TENANT_TABLES].sort().map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
      })),
    );
    const column = {
      tenants: 'id',
      repositories: 'tenant_id',
      content_access_log: 'tenant_id',
      blob: 'tenant_id',
      blob_contents: 'tenant_id',
      blob_fact: 'tenant_id',
    };
    const expected = [...TENANT_TABLES].sort().flatMap((table) => {
      const bound = `(${column[table]} = ( SELECT codegraph.codegraph_bound_tenant() AS codegraph_bound_tenant))`;
      return [
        {
          tablename: table,
          policyname: `${table}_owner`,
          permissive: 'PERMISSIVE',
          roles: ['codegraph_owner'],
          cmd: 'ALL',
          qual: 'true',
          with_check: 'true',
        },
        {
          tablename: table,
          policyname: `${table}_tenant`,
          permissive: 'PERMISSIVE',
          roles: ['codegraph_app'],
          cmd: 'ALL',
          qual: bound,
          with_check: bound,
        },
      ];
    });
    expect(shape.policies).toEqual(expected);
  });
});

describe('table privileges', () => {
  it('are still those 0001 granted: no SELECT on the log, nothing on clients, credentials or grants', async () => {
    await withClient(db.appUrl, async (c) => {
      await c.query('BEGIN');
      for (const table of ['content_access_log', 'clients', 'credentials', 'grants']) {
        expect(await sqlState(c, `SELECT 1 FROM codegraph.${table}`), table).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
      }
      await c.query('ROLLBACK');
    });
  });
});
