import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { queryRows, withClient } from '../helpers/db.js';
import { inBoundTransaction } from '../helpers/tenancy.js';
import { foundation, type Foundation } from './foundation.fixture.js';

let f: Foundation;
beforeEach(async () => {
  f = await foundation();
  // Each of A's repositories and B's gets an access-log row, appended by the
  // app login bound to a tenant it is granted, as the read API will.
  await withClient(f.db.appUrl, async (c) => {
    await inBoundTransaction(
      c,
      { clientId: f.fx.operatorId },
      async () => {
        await c.query('SELECT codegraph.codegraph_grant_access($1, $2)', [
          f.fx.readerId,
          f.fx.tenantB.id,
        ]);
      },
      { commit: true },
    );
  });
  await withClient(f.db.appUrl, async (c) => {
    for (const tenant of [f.fx.tenantA, f.fx.tenantB]) {
      await inBoundTransaction(
        c,
        { clientId: f.fx.readerId, tenantId: tenant.id },
        async () => {
          for (const repository of tenant.repositories) {
            await c.query(
              'INSERT INTO codegraph.content_access_log (tenant_id, repository_id, client_id, content_ref) VALUES ($1, $2, $3, $4)',
              [tenant.id, repository.id, f.fx.readerId, `${repository.name}@${randomUUID()}`],
            );
          }
        },
        { commit: true },
      );
    }
  });
});
afterEach(async () => {
  await f.db.drop();
});

/** Every row of every table in schema codegraph whose columns hold `value`. */
async function rowsReferencing(c: pg.Client, column: string, value: string) {
  const tables = await queryRows<{ table_name: string }>(
    c,
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'codegraph' AND column_name = $1 ORDER BY 1`,
    [column],
  );
  const found: Record<string, number> = {};
  for (const { table_name } of tables) {
    const rows = await queryRows<{ n: string }>(
      c,
      `SELECT count(*) AS n FROM codegraph.${c.escapeIdentifier(table_name)} WHERE ${c.escapeIdentifier(column)} = $1`,
      [value],
    );
    found[table_name] = Number(rows[0]?.n);
  }
  return found;
}

async function snapshot(c: pg.Client, tenantId: string) {
  return {
    tenants: await queryRows(c, 'SELECT * FROM codegraph.tenants WHERE id = $1', [tenantId]),
    repositories: await queryRows(
      c,
      'SELECT * FROM codegraph.repositories WHERE tenant_id = $1 ORDER BY id',
      [tenantId],
    ),
    log: await queryRows(
      c,
      'SELECT * FROM codegraph.content_access_log WHERE tenant_id = $1 ORDER BY id',
      [tenantId],
    ),
    grants: await queryRows(c, 'SELECT * FROM codegraph.grants WHERE tenant_id = $1 ORDER BY id', [
      tenantId,
    ]),
  };
}

describe('deleting a repository', () => {
  it('leaves no row referencing its (tenant, repository) pair, and keeps its sibling', async () => {
    const [web, api] = f.fx.tenantA.repositories;
    if (web === undefined || api === undefined) throw new Error('fixture has no repositories');
    await withClient(f.db.ownerUrl, async (c) => {
      const b = await snapshot(c, f.fx.tenantB.id);
      await c.query('DELETE FROM codegraph.repositories WHERE id = $1', [web.id]);
      const left = await rowsReferencing(c, 'repository_id', web.id);
      expect(Object.keys(left)).toContain('content_access_log');
      expect(Object.values(left).every((n) => n === 0)).toBe(true);
      const remaining = await snapshot(c, f.fx.tenantA.id);
      expect(remaining.repositories.map((r) => r.id)).toEqual([api.id]);
      expect(remaining.log.map((r) => r.repository_id)).toEqual([api.id]);
      expect(await snapshot(c, f.fx.tenantB.id)).toEqual(b);
    });
  });
});

describe('deleting a tenant', () => {
  it('removes its repositories, their log rows and its grants, and keeps clients, credentials and the other tenant', async () => {
    await withClient(f.db.ownerUrl, async (c) => {
      const b = await snapshot(c, f.fx.tenantB.id);
      const clients = await queryRows(c, 'SELECT * FROM codegraph.clients ORDER BY id');
      const credentials = await queryRows(c, 'SELECT * FROM codegraph.credentials ORDER BY id');
      await c.query('DELETE FROM codegraph.tenants WHERE id = $1', [f.fx.tenantA.id]);
      const left = await rowsReferencing(c, 'tenant_id', f.fx.tenantA.id);
      expect(Object.keys(left).sort()).toEqual(['content_access_log', 'grants', 'repositories']);
      expect(Object.values(left).every((n) => n === 0)).toBe(true);
      for (const repository of f.fx.tenantA.repositories) {
        const byRepository = await rowsReferencing(c, 'repository_id', repository.id);
        expect(Object.values(byRepository).every((n) => n === 0)).toBe(true);
      }
      expect(await queryRows(c, 'SELECT * FROM codegraph.clients ORDER BY id')).toEqual(clients);
      expect(await queryRows(c, 'SELECT * FROM codegraph.credentials ORDER BY id')).toEqual(
        credentials,
      );
      expect(await snapshot(c, f.fx.tenantB.id)).toEqual(b);
    });
  });
});
