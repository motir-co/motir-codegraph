import type pg from 'pg';

import { queryRows } from './db.js';

/** Every row of every table in schema codegraph whose columns hold `value`. */
export async function rowsReferencing(c: pg.Client, column: string, value: string) {
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

/** A tenant's own rows, in a stable order, for before/after comparisons. */
export async function snapshot(c: pg.Client, tenantId: string) {
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

/**
 * One access-log row per repository of each tenant, inserted as the owner so
 * the fixture's grants stay as they are (the reader is granted A only).
 */
export async function seedAccessLog(
  c: pg.Client,
  clientId: string,
  tenants: { id: string; repositories: { id: string; name: string }[] }[],
): Promise<void> {
  for (const tenant of tenants) {
    for (const repository of tenant.repositories) {
      await c.query(
        'INSERT INTO codegraph.content_access_log (tenant_id, repository_id, client_id, content_ref) VALUES ($1, $2, $3, $4)',
        [tenant.id, repository.id, clientId, `${repository.name}@seed`],
      );
    }
  }
}
