import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { freshDatabase, queryRows, withClient, type FreshDatabase } from '../helpers/db.js';
import {
  buildTenancyFixture,
  inBoundTransaction,
  tokenHash,
  type TenancyFixture,
} from '../helpers/tenancy.js';

let db: FreshDatabase;
let fx: TenancyFixture;

beforeAll(async () => {
  db = await freshDatabase();
  fx = await buildTenancyFixture(db);
});

afterAll(async () => {
  await db.drop();
});

/** Calls codegraph_authenticate as codegraph_app, with nothing bound. */
async function authenticate(hash: Buffer | null) {
  return await withClient(db.appUrl, (c) =>
    queryRows<{ client_id: string; client_kind: string; tenant_ids: string[] }>(
      c,
      'SELECT client_id, client_kind, tenant_ids::text[] AS tenant_ids FROM codegraph.codegraph_authenticate($1)',
      [hash],
    ),
  );
}

/** Runs one operator function call as the fixture's operator and commits it. */
async function asOperator(sql: string, params: unknown[]): Promise<void> {
  await withClient(db.appUrl, (c) =>
    inBoundTransaction(
      c,
      { clientId: fx.operatorId },
      async () => {
        await c.query(sql, params);
      },
      { commit: true },
    ),
  );
}

describe('codegraph_authenticate', () => {
  it('answers a live credential with its client, kind and exactly its granted tenants', async () => {
    expect(await authenticate(fx.readerHash)).toEqual([
      { client_id: fx.readerId, client_kind: 'client', tenant_ids: [fx.tenantA.id] },
    ]);
    await asOperator('SELECT codegraph.codegraph_grant_access($1, $2)', [
      fx.readerId,
      fx.tenantB.id,
    ]);
    expect(await authenticate(fx.readerHash)).toEqual([
      {
        client_id: fx.readerId,
        client_kind: 'client',
        tenant_ids: [fx.tenantA.id, fx.tenantB.id].sort(),
      },
    ]);
    await asOperator('SELECT codegraph.codegraph_revoke_access($1, $2)', [
      fx.readerId,
      fx.tenantB.id,
    ]);
    expect(await authenticate(fx.readerHash)).toEqual([
      { client_id: fx.readerId, client_kind: 'client', tenant_ids: [fx.tenantA.id] },
    ]);
  });

  it('answers a client with no live grant with an empty tenant list', async () => {
    const hash = tokenHash();
    let clientId = '';
    await withClient(db.appUrl, (c) =>
      inBoundTransaction(
        c,
        { clientId: fx.operatorId },
        async () => {
          const rows = await queryRows<{ id: string }>(
            c,
            "SELECT codegraph.codegraph_create_client('lonely', 'client') AS id",
          );
          clientId = rows[0]?.id ?? '';
          await c.query("SELECT codegraph.codegraph_issue_credential($1, $2, 'cg_lo')", [
            clientId,
            hash,
          ]);
        },
        { commit: true },
      ),
    );
    expect(await authenticate(hash)).toEqual([
      { client_id: clientId, client_kind: 'client', tenant_ids: [] },
    ]);
  });

  it('answers an operator with its operator kind', async () => {
    const hash = tokenHash();
    const operatorId = await withClient(db.ownerUrl, async (c) => {
      const rows = await queryRows<{ id: string }>(
        c,
        "SELECT codegraph.codegraph_bootstrap_operator('second-operator', $1, 'cg_op2') AS id",
        [hash],
      );
      return rows[0]?.id;
    });
    expect(await authenticate(hash)).toEqual([
      { client_id: operatorId, client_kind: 'operator', tenant_ids: [] },
    ]);
  });

  it('answers a revoked credential with no row', async () => {
    const hash = tokenHash();
    await withClient(db.appUrl, (c) =>
      inBoundTransaction(
        c,
        { clientId: fx.operatorId },
        async () => {
          const rows = await queryRows<{ id: string }>(
            c,
            "SELECT codegraph.codegraph_issue_credential($1, $2, 'cg_rv') AS id",
            [fx.readerId, hash],
          );
          await c.query('SELECT codegraph.codegraph_revoke_credential($1)', [rows[0]?.id]);
        },
        { commit: true },
      ),
    );
    expect(await authenticate(hash)).toEqual([]);
    expect(await authenticate(fx.readerHash)).toHaveLength(1);
  });

  it.each<[string, () => Buffer | null]>([
    ['an unknown hash', () => tokenHash()],
    ['a NULL', () => null],
    ['an empty hash', () => Buffer.alloc(0)],
    ['a 31-byte prefix of a live hash', () => fx.readerHash.subarray(0, 31)],
    ['a live hash with a 33rd byte appended', () => Buffer.concat([fx.readerHash, Buffer.of(0)])],
  ])('answers %s with no row', async (_label, hash) => {
    expect(await authenticate(hash())).toEqual([]);
  });
});
