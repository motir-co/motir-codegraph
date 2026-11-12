import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { freshDatabase, queryRows, withClient, type FreshDatabase } from '../helpers/db.js';
import {
  buildTenancyFixture,
  inBoundTransaction,
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

const asOperator = <T extends Record<string, unknown>>(sql: string, params: unknown[]) =>
  withClient(db.appUrl, (c) =>
    inBoundTransaction(c, { clientId: fx.operatorId }, () => queryRows<T>(c, sql, params)),
  );

describe('codegraph_get_client', () => {
  it('returns the client and its credential, with no token or hash column', async () => {
    const rows = await asOperator('SELECT * FROM codegraph.codegraph_get_client($1)', [
      fx.readerId,
    ]);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(
      [
        'client_id',
        'created_at',
        'credential_created_at',
        'credential_id',
        'display_prefix',
        'kind',
        'name',
        'revoked_at',
      ].sort(),
    );
    expect(rows[0]).toMatchObject({
      client_id: fx.readerId,
      kind: 'client',
      display_prefix: 'cg_rd',
    });
  });

  it('returns one row with null credential columns for a client with none', async () => {
    const created = await withClient(db.appUrl, (c) =>
      inBoundTransaction(
        c,
        { clientId: fx.operatorId },
        async () =>
          (
            await queryRows<{ id: string }>(
              c,
              "SELECT codegraph.codegraph_create_client('bare', 'client') AS id",
            )
          )[0]?.id,
        { commit: true },
      ),
    );
    const rows = await asOperator('SELECT * FROM codegraph.codegraph_get_client($1)', [created]);
    expect(rows).toEqual([
      expect.objectContaining({ client_id: created, credential_id: null, display_prefix: null }),
    ]);
  });

  it('returns no row for a client that does not exist', async () => {
    expect(
      await asOperator('SELECT * FROM codegraph.codegraph_get_client($1)', [randomUUID()]),
    ).toEqual([]);
  });
});
