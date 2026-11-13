import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withDatabase } from '../../src/db/connection.js';
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
  tokenHash,
  type Binding,
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

/** Each operator function, with arguments that succeed for an operator. */
const OPERATOR_CALLS: [string, () => [string, unknown[]]][] = [
  ['codegraph_create_tenant', () => ['codegraph.codegraph_create_tenant($1)', ['Initech']]],
  [
    'codegraph_register_repository',
    () => ['codegraph.codegraph_register_repository($1, $2)', [fx.tenantA.id, 'acme-extra']],
  ],
  [
    'codegraph_create_client',
    () => ['codegraph.codegraph_create_client($1, $2)', ['ci', 'client']],
  ],
  [
    'codegraph_issue_credential',
    () => [
      'codegraph.codegraph_issue_credential($1, $2, $3)',
      [fx.readerId, tokenHash(), 'cg_new'],
    ],
  ],
  [
    'codegraph_revoke_credential',
    () => ['codegraph.codegraph_revoke_credential($1)', [randomUUID()]],
  ],
  [
    'codegraph_grant_access',
    () => ['codegraph.codegraph_grant_access($1, $2)', [fx.readerId, fx.tenantB.id]],
  ],
  [
    'codegraph_revoke_access',
    () => ['codegraph.codegraph_revoke_access($1, $2)', [fx.readerId, fx.tenantB.id]],
  ],
  ['codegraph_get_client', () => ['codegraph.codegraph_get_client($1)', [fx.readerId]]],
  [
    'codegraph_delete_tenant_as_operator',
    () => ['codegraph.codegraph_delete_tenant_as_operator($1)', [randomUUID()]],
  ],
  [
    'codegraph_delete_repository_as_operator',
    () => [
      'codegraph.codegraph_delete_repository_as_operator($1, $2)',
      [fx.tenantA.id, randomUUID()],
    ],
  ],
];

async function callAs(binding: Binding, sql: string, params: unknown[]): Promise<string | null> {
  return await withClient(db.appUrl, (c) =>
    inBoundTransaction(c, binding, () => sqlState(c, `SELECT ${sql}`, params)),
  );
}

async function scalar<T>(c: pg.Client, sql: string, params: unknown[] = []): Promise<T> {
  const rows = await queryRows<{ value: T }>(c, `SELECT ${sql} AS value`, params);
  return rows[0]?.value as T;
}

describe.each(OPERATOR_CALLS)('%s', (_name, call) => {
  it('refuses codegraph_app with no client bound', async () => {
    const [sql, params] = call();
    expect(await callAs({}, sql, params)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('refuses codegraph_app with a client-kind client bound', async () => {
    const [sql, params] = call();
    expect(await callAs({ clientId: fx.readerId }, sql, params)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('refuses a malformed client binding', async () => {
    const [sql, params] = call();
    expect(await callAs({ clientId: 'operator' }, sql, params)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('succeeds with an operator bound', async () => {
    const [sql, params] = call();
    expect(await callAs({ clientId: fx.operatorId }, sql, params)).toBeNull();
  });
});

describe('what the operator functions do', () => {
  it('grant_access returns the live grant rather than creating a second one, and the revokes report whether they revoked', async () => {
    await withClient(db.appUrl, (c) =>
      inBoundTransaction(c, { clientId: fx.operatorId }, async () => {
        const first = await scalar<string>(c, 'codegraph.codegraph_grant_access($1, $2)', [
          fx.readerId,
          fx.tenantB.id,
        ]);
        expect(
          await scalar<string>(c, 'codegraph.codegraph_grant_access($1, $2)', [
            fx.readerId,
            fx.tenantB.id,
          ]),
        ).toBe(first);
        const revoke = 'codegraph.codegraph_revoke_access($1, $2)';
        expect(await scalar<boolean>(c, revoke, [fx.readerId, fx.tenantB.id])).toBe(true);
        expect(await scalar<boolean>(c, revoke, [fx.readerId, fx.tenantB.id])).toBe(false);
        const regranted = await scalar<string>(c, 'codegraph.codegraph_grant_access($1, $2)', [
          fx.readerId,
          fx.tenantB.id,
        ]);
        expect(regranted).not.toBe(first);

        const credential = await scalar<string>(
          c,
          "codegraph.codegraph_issue_credential($1, $2, 'cg_x')",
          [fx.readerId, tokenHash()],
        );
        const revokeCredential = 'codegraph.codegraph_revoke_credential($1)';
        expect(await scalar<boolean>(c, revokeCredential, [credential])).toBe(true);
        expect(await scalar<boolean>(c, revokeCredential, [credential])).toBe(false);
      }),
    );
  });

  it('issue_credential relies on the table’s checks: a token-length value or a long prefix is refused', async () => {
    const issue = 'codegraph.codegraph_issue_credential($1, $2, $3)';
    expect(
      await callAs({ clientId: fx.operatorId }, issue, [
        fx.readerId,
        Buffer.from('cg_plaintext'),
        'cg',
      ]),
    ).toBe('23514');
    expect(
      await callAs({ clientId: fx.operatorId }, issue, [
        fx.readerId,
        tokenHash(),
        'cg_much_too_long',
      ]),
    ).toBe('23514');
  });
});

describe('codegraph_bootstrap_operator', () => {
  it('is not executable by codegraph_app, even with an operator bound', async () => {
    expect(
      await callAs(
        { clientId: fx.operatorId },
        "codegraph.codegraph_bootstrap_operator('sneaky', $1, 'cg_sn')",
        [tokenHash()],
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('is executable by codegraph_owner and creates an operator with a live credential', async () => {
    const hash = tokenHash();
    const created = await withClient(db.ownerUrl, (c) =>
      scalar<string>(c, "codegraph.codegraph_bootstrap_operator('first', $1, 'cg_fi')", [hash]),
    );
    const found = await withClient(db.appUrl, (c) =>
      queryRows(c, 'SELECT client_id, client_kind FROM codegraph.codegraph_authenticate($1)', [
        hash,
      ]),
    );
    expect(found).toEqual([{ client_id: created, client_kind: 'operator' }]);
  });
});

describe('the functions the migrations create', () => {
  const FUNCTIONS = `
    SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef,
           p.proconfig::text[] AS config,
           ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)::text[] AS executors
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'codegraph'
       -- An extension's own functions (pg_trgm, 0005) are its members, not the migrations'.
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
     ORDER BY p.proname`;

  it('are SECURITY DEFINER, owned by codegraph_owner, pinned to codegraph, pg_temp, and executable only where intended', async () => {
    const rows = await withClient(withDatabase(db.adminUrl, db.name), (c) =>
      queryRows(c, FUNCTIONS),
    );
    const appCallable = new Set([
      'codegraph_authenticate',
      'codegraph_bound_tenant',
      // The queue's one cross-tenant read (0010), which a worker calls unbound.
      'codegraph_claim_index_job',
      'codegraph_tenant_exists',
      ...OPERATOR_CALLS.map(([name]) => name),
    ]);
    expect(rows).toEqual(
      [...appCallable, 'codegraph_bootstrap_operator', 'codegraph_require_operator']
        .sort()
        .map((proname) => ({
          proname,
          owner: 'codegraph_owner',
          prosecdef: true,
          config: ['search_path=codegraph, pg_temp'],
          executors: appCallable.has(proname)
            ? ['codegraph_app', 'codegraph_owner']
            : ['codegraph_owner'],
        })),
    );
  });
});
