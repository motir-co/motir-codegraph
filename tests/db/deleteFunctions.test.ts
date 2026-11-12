import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

let db: FreshDatabase;
let fx: TenancyFixture;

beforeEach(async () => {
  db = await freshDatabase();
  fx = await buildTenancyFixture(db);
});

afterEach(async () => {
  await db.drop();
});

/** One function call as codegraph_app with `binding`, committed. */
async function callAs<T>(binding: Binding, sql: string, params: unknown[]): Promise<T> {
  return await withClient(db.appUrl, (c) =>
    inBoundTransaction(
      c,
      binding,
      async () =>
        (await queryRows<{ value: T }>(c, `SELECT ${sql} AS value`, params))[0]?.value as T,
      { commit: true },
    ),
  );
}

async function stateAs(binding: Binding, sql: string, params: unknown[]) {
  return await withClient(db.appUrl, (c) =>
    inBoundTransaction(c, binding, () => sqlState(c, `SELECT ${sql}`, params)),
  );
}

async function counts() {
  return await withClient(
    db.ownerUrl,
    async (c) =>
      (
        await queryRows<{ tenants: number; repositories: number; grants: number }>(
          c,
          `SELECT (SELECT count(*)::int FROM codegraph.tenants) AS tenants,
                (SELECT count(*)::int FROM codegraph.repositories) AS repositories,
                (SELECT count(*)::int FROM codegraph.grants) AS grants`,
        )
      )[0],
  );
}

const DELETE_TENANT = 'codegraph.codegraph_delete_tenant_as_operator($1)';
const DELETE_REPOSITORY = 'codegraph.codegraph_delete_repository_as_operator($1, $2)';
const EXISTS = 'codegraph.codegraph_tenant_exists($1)';

describe('the operator delete functions, as codegraph_app', () => {
  it('raise 42501 with a client bound and delete nothing', async () => {
    const before = await counts();
    const repository = fx.tenantB.repositories[0]?.id;
    expect(await stateAs({ clientId: fx.readerId }, DELETE_TENANT, [fx.tenantB.id])).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(
      await stateAs({ clientId: fx.readerId }, DELETE_REPOSITORY, [fx.tenantB.id, repository]),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await counts()).toEqual(before);
  });

  it('delete an ungranted tenant for an operator, true and then false', async () => {
    const operator = { clientId: fx.operatorId };
    expect(await callAs<boolean>(operator, DELETE_TENANT, [fx.tenantB.id])).toBe(true);
    expect(await callAs<boolean>(operator, DELETE_TENANT, [fx.tenantB.id])).toBe(false);
    expect(await counts()).toEqual({ tenants: 1, repositories: 2, grants: 1 });
  });

  it('delete an ungranted repository only under its own tenant, true and then false', async () => {
    const operator = { clientId: fx.operatorId };
    const repository = fx.tenantB.repositories[0]?.id;
    expect(await callAs<boolean>(operator, DELETE_REPOSITORY, [fx.tenantA.id, repository])).toBe(
      false,
    );
    expect(await callAs<boolean>(operator, DELETE_REPOSITORY, [fx.tenantB.id, repository])).toBe(
      true,
    );
    expect(await callAs<boolean>(operator, DELETE_REPOSITORY, [fx.tenantB.id, repository])).toBe(
      false,
    );
    expect(await counts()).toEqual({ tenants: 2, repositories: 4, grants: 1 });
  });
});

describe('codegraph_tenant_exists, as codegraph_app', () => {
  it('answers whether the tenant exists, for any bound client or none', async () => {
    for (const binding of [{}, { clientId: fx.readerId }, { clientId: fx.operatorId }]) {
      expect(await callAs<boolean>(binding, EXISTS, [fx.tenantB.id])).toBe(true);
      expect(await callAs<boolean>(binding, EXISTS, [randomUUID()])).toBe(false);
    }
  });
});
