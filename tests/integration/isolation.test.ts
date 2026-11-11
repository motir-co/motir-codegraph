import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { queryRows, sqlState, withClient } from '../helpers/db.js';
import { inBoundTransaction, type Binding } from '../helpers/tenancy.js';
import { foundation, type Foundation } from './foundation.fixture.js';

const RLS_VIOLATION = '42501';
const insertLog =
  'INSERT INTO codegraph.content_access_log (tenant_id, repository_id, client_id, content_ref) VALUES ($1, $2, $3, $4)';

// A fresh foundation per test: the revoke cases change grants and credentials.
let f: Foundation;
beforeEach(async () => {
  f = await foundation();
});
afterEach(async () => {
  await f.db.drop();
});

async function visible(c: pg.Client) {
  return {
    tenants: await queryRows(c, 'SELECT id, display_name FROM codegraph.tenants ORDER BY id'),
    repositories: await queryRows(
      c,
      'SELECT id, tenant_id, display_name FROM codegraph.repositories ORDER BY id',
    ),
  };
}

/** The whole tenant-owned population, read as the owner. */
async function population() {
  return await withClient(f.db.ownerUrl, async (c) => ({
    ...(await visible(c)),
    log: await queryRows(
      c,
      'SELECT tenant_id, repository_id, client_id, content_ref FROM codegraph.content_access_log ORDER BY content_ref',
    ),
  }));
}

function allRepositories() {
  return [f.fx.tenantA, f.fx.tenantB].flatMap((t) =>
    t.repositories.map((r) => ({ tenant: t.id, repository: r.id })),
  );
}

/** Every write the app login may attempt, each of which must touch nothing. */
async function attemptEveryWrite(c: pg.Client) {
  for (const { tenant, repository } of allRepositories()) {
    expect(await sqlState(c, insertLog, [tenant, repository, f.fx.readerId, 'refused'])).toBe(
      RLS_VIOLATION,
    );
    const rename = await c.query(
      "UPDATE codegraph.repositories SET display_name = 'hijacked' WHERE id = $1",
      [repository],
    );
    expect(rename.rowCount).toBe(0);
    const remove = await c.query('DELETE FROM codegraph.repositories WHERE id = $1', [repository]);
    expect(remove.rowCount).toBe(0);
  }
  for (const tenant of [f.fx.tenantA, f.fx.tenantB]) {
    const rename = await c.query("UPDATE codegraph.tenants SET display_name = 'x' WHERE id = $1", [
      tenant.id,
    ]);
    expect(rename.rowCount).toBe(0);
    const remove = await c.query('DELETE FROM codegraph.tenants WHERE id = $1', [tenant.id]);
    expect(remove.rowCount).toBe(0);
  }
}

describe('the granted tenant', () => {
  it('reads exactly its rows, renames its repository and appends to its access log', async () => {
    const { tenantA, readerId } = f.fx;
    const [web] = tenantA.repositories;
    if (web === undefined) throw new Error('fixture has no repository');
    const ref = `read-${randomUUID()}`;
    await withClient(f.db.appUrl, (c) =>
      inBoundTransaction(
        c,
        { clientId: readerId, tenantId: tenantA.id },
        async () => {
          expect(await visible(c)).toEqual({
            tenants: [{ id: tenantA.id, display_name: tenantA.name }],
            repositories: tenantA.repositories
              .map((r) => ({ id: r.id, tenant_id: tenantA.id, display_name: r.name }))
              .sort((x, y) => x.id.localeCompare(y.id)),
          });
          const rename = await c.query(
            "UPDATE codegraph.repositories SET display_name = 'acme-web-renamed' WHERE id = $1",
            [web.id],
          );
          expect(rename.rowCount).toBe(1);
          await c.query(insertLog, [tenantA.id, web.id, readerId, ref]);
        },
        { commit: true },
      ),
    );
    const after = await population();
    expect(after.log).toContainEqual({
      tenant_id: tenantA.id,
      repository_id: web.id,
      client_id: readerId,
      content_ref: ref,
    });
    expect(after.repositories).toContainEqual({
      id: web.id,
      tenant_id: tenantA.id,
      display_name: 'acme-web-renamed',
    });
  });

  it('cannot append a log row naming the other tenant and its repository', async () => {
    const [core] = f.fx.tenantB.repositories;
    if (core === undefined) throw new Error('fixture has no repository');
    const before = await population();
    await withClient(f.db.appUrl, (c) =>
      inBoundTransaction(c, { clientId: f.fx.readerId, tenantId: f.fx.tenantA.id }, async () => {
        expect(await sqlState(c, insertLog, [f.fx.tenantB.id, core.id, f.fx.readerId, 'x'])).toBe(
          RLS_VIOLATION,
        );
      }),
    );
    expect(await population()).toEqual(before);
  });
});

describe.each<[string, (fx: Foundation['fx']) => Binding]>([
  ['the ungranted tenant', (fx) => ({ clientId: fx.readerId, tenantId: fx.tenantB.id })],
  ['no setting', () => ({})],
  ['a malformed tenant', (fx) => ({ clientId: fx.readerId, tenantId: `${fx.tenantA.id}'--` })],
])('a session bound to %s', (_label, binding) => {
  it('reads nothing of either tenant, and every write is refused or affects zero rows', async () => {
    const before = await population();
    await withClient(f.db.appUrl, (c) =>
      inBoundTransaction(
        c,
        binding(f.fx),
        async () => {
          expect(await visible(c)).toEqual({ tenants: [], repositories: [] });
          await attemptEveryWrite(c);
        },
        { commit: true },
      ),
    );
    expect(await population()).toEqual(before);
  });
});

describe('revocation', () => {
  it('a revoked grant shuts the next transaction out, with no change to the session code', async () => {
    const { tenantA, readerId, operatorId } = f.fx;
    const session = async (c: pg.Client) =>
      inBoundTransaction(c, { clientId: readerId, tenantId: tenantA.id }, () => visible(c));
    await withClient(f.db.appUrl, async (c) => {
      expect((await session(c)).repositories).toHaveLength(2);
      await inBoundTransaction(
        c,
        { clientId: operatorId },
        async () => {
          await c.query('SELECT codegraph.codegraph_revoke_access($1, $2)', [readerId, tenantA.id]);
        },
        { commit: true },
      );
      expect(await session(c)).toEqual({ tenants: [], repositories: [] });
      const before = await population();
      await inBoundTransaction(
        c,
        { clientId: readerId, tenantId: tenantA.id },
        async () => {
          await attemptEveryWrite(c);
        },
        { commit: true },
      );
      expect(await population()).toEqual(before);
    });
  });

  it('codegraph_authenticate answers the issued credential, and not once it is revoked', async () => {
    const { readerHash, readerId, tenantA, operatorId } = f.fx;
    const authenticate = () =>
      withClient(f.db.appUrl, (c) =>
        queryRows(
          c,
          'SELECT client_id, client_kind, tenant_ids::text[] AS tenant_ids FROM codegraph.codegraph_authenticate($1)',
          [readerHash],
        ),
      );
    expect(await authenticate()).toEqual([
      { client_id: readerId, client_kind: 'client', tenant_ids: [tenantA.id] },
    ]);
    const credentialId = await withClient(f.db.ownerUrl, async (c) => {
      const rows = await queryRows<{ id: string }>(
        c,
        'SELECT id FROM codegraph.credentials WHERE token_hash = $1',
        [readerHash],
      );
      return rows[0]?.id;
    });
    await withClient(f.db.appUrl, (c) =>
      inBoundTransaction(
        c,
        { clientId: operatorId },
        async () => {
          await c.query('SELECT codegraph.codegraph_revoke_credential($1)', [credentialId]);
        },
        { commit: true },
      ),
    );
    expect(await authenticate()).toEqual([]);
  });
});
