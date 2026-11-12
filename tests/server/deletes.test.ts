import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deleteRepository, DELETE_ROUTE_CONFIG } from '../../src/server/routes/deletes.js';
import type { V1Routes } from '../../src/server/v1.js';
import { freshDatabase, queryRows, withClient, type FreshDatabase } from '../helpers/db.js';
import { recordQueries, type QueryLog } from '../helpers/queryLog.js';
import { rowsReferencing, seedAccessLog, snapshot } from '../helpers/rows.js';
import { call, startCopies, type Copies } from '../helpers/server.js';
import { buildTenancyFixture, type TenancyFixture } from '../helpers/tenancy.js';

// A test-only route that deletes exactly as the real one does, then throws:
// the rollback must leave every row in place.
const deleteThenFail: V1Routes = (v1) => {
  v1.delete<{ Params: { tenantId: string; repositoryId: string } }>(
    '/tenants/:tenantId/repositories/:repositoryId/then-fail',
    { config: DELETE_ROUTE_CONFIG },
    async (request) => {
      await deleteRepository(request);
      throw new Error('failed after the delete ran');
    },
  );
};

let db: FreshDatabase;
let fx: TenancyFixture;
let copies: Copies;
let baseUrl: string;
let log: QueryLog;

beforeEach(async () => {
  db = await freshDatabase();
  fx = await buildTenancyFixture(db);
  await withClient(db.ownerUrl, (c) => seedAccessLog(c, fx.readerId, [fx.tenantA, fx.tenantB]));
  copies = await startCopies(db.appUrl, 2, { v1Routes: [deleteThenFail] });
  baseUrl = copies.baseUrls[0] as string;
  log = recordQueries((copies.copies[0] as Copies['copies'][number]).pool);
});

afterEach(async () => {
  await copies.stop();
  await db.drop();
});

const tenantPath = (tenantId: string) => `/v1/tenants/${tenantId}`;
const repositoryPath = (tenantId: string, repositoryId: string) =>
  `/v1/tenants/${tenantId}/repositories/${repositoryId}`;

function del(path: string, token: string, url = baseUrl) {
  return call(url, path, { method: 'DELETE', token });
}

const TENANT_NOT_FOUND = { error: { code: 'tenant_not_found', message: 'No such tenant.' } };
const REPOSITORY_NOT_FOUND = {
  error: { code: 'repository_not_found', message: 'No such repository.' },
};
const PERMISSION_DENIED = {
  error: { code: 'permission_denied', message: 'The credential may not use this tenant.' },
};

function first<T>(items: T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error('fixture is missing an item');
  return item;
}

async function asOwner<T>(fn: (c: Parameters<typeof snapshot>[0]) => Promise<T>): Promise<T> {
  return await withClient(db.ownerUrl, fn);
}

const clientsAndCredentials = () =>
  asOwner(async (c) => ({
    clients: await queryRows(c, 'SELECT * FROM codegraph.clients ORDER BY id'),
    credentials: await queryRows(c, 'SELECT * FROM codegraph.credentials ORDER BY id'),
  }));

const nothingLeft = (found: Record<string, number>) => Object.values(found).every((n) => n === 0);

describe('a client deleting inside its granted tenant', () => {
  it('deletes a repository with 204, leaves nothing referencing it, and answers the retry 404', async () => {
    const web = first(fx.tenantA.repositories);
    const api = first(fx.tenantA.repositories.slice(1));
    const b = await asOwner((c) => snapshot(c, fx.tenantB.id));

    const response = await del(repositoryPath(fx.tenantA.id, web.id), fx.readerToken);
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();

    await asOwner(async (c) => {
      const left = await rowsReferencing(c, 'repository_id', web.id);
      expect(Object.keys(left)).toContain('content_access_log');
      expect(nothingLeft(left)).toBe(true);
      const a = await snapshot(c, fx.tenantA.id);
      expect(a.repositories.map((r) => r.id)).toEqual([api.id]);
      expect(a.log.map((r) => r.repository_id)).toEqual([api.id]);
      expect(await snapshot(c, fx.tenantB.id)).toEqual(b);
    });

    const retry = await del(repositoryPath(fx.tenantA.id, web.id), fx.readerToken);
    expect(retry).toMatchObject({ status: 404, body: REPOSITORY_NOT_FOUND });
  });

  it('deletes its granted tenant with 204, keeps clients and credentials, and its retry, now ungranted, answers 404', async () => {
    const kept = await clientsAndCredentials();
    const b = await asOwner((c) => snapshot(c, fx.tenantB.id));

    const response = await del(tenantPath(fx.tenantA.id), fx.readerToken);
    expect(response.status).toBe(204);

    await asOwner(async (c) => {
      expect(nothingLeft(await rowsReferencing(c, 'tenant_id', fx.tenantA.id))).toBe(true);
      expect(await snapshot(c, fx.tenantB.id)).toEqual(b);
    });
    expect(await clientsAndCredentials()).toEqual(kept);
    expect(log.texts().some((text) => text.includes('_as_operator'))).toBe(false);

    const retry = await del(tenantPath(fx.tenantA.id), fx.readerToken);
    expect(retry).toMatchObject({ status: 404, body: TENANT_NOT_FOUND });
  });
});

describe('a client outside its granted tenants', () => {
  it('is refused 403 for tenant B and its repositories, and B is unchanged', async () => {
    const before = await asOwner((c) => snapshot(c, fx.tenantB.id));
    log.clear();

    const tenant = await del(tenantPath(fx.tenantB.id), fx.readerToken);
    const repository = await del(
      repositoryPath(fx.tenantB.id, first(fx.tenantB.repositories).id),
      fx.readerToken,
    );
    expect(tenant).toMatchObject({ status: 403, body: PERMISSION_DENIED });
    expect(repository).toMatchObject({ status: 403, body: PERMISSION_DENIED });

    expect(await asOwner((c) => snapshot(c, fx.tenantB.id))).toEqual(before);
    const texts = log.texts();
    expect(texts.some((text) => text.includes('_as_operator'))).toBe(false);
    expect(texts.some((text) => /^DELETE/i.test(text))).toBe(false);
  });

  it('answers 404 for a B repository named under A, and deletes nothing in B', async () => {
    const before = await asOwner((c) => snapshot(c, fx.tenantB.id));
    const response = await del(
      repositoryPath(fx.tenantA.id, first(fx.tenantB.repositories).id),
      fx.readerToken,
    );
    expect(response).toMatchObject({ status: 404, body: REPOSITORY_NOT_FOUND });
    expect(await asOwner((c) => snapshot(c, fx.tenantB.id))).toEqual(before);
  });

  it('answers 404 tenant_not_found for a tenant that does not exist', async () => {
    const response = await del(tenantPath(randomUUID()), fx.readerToken);
    expect(response).toMatchObject({ status: 404, body: TENANT_NOT_FOUND });
  });
});

describe('an operator', () => {
  it('deletes tenant B, which it holds no grant on, through the definer function, and answers the retry 404', async () => {
    const kept = await clientsAndCredentials();
    const a = await asOwner((c) => snapshot(c, fx.tenantA.id));
    log.clear();

    const response = await del(tenantPath(fx.tenantB.id), fx.operatorToken);
    expect(response.status).toBe(204);
    expect(log.texts().some((text) => text.includes('codegraph_delete_tenant_as_operator'))).toBe(
      true,
    );

    await asOwner(async (c) => {
      expect(nothingLeft(await rowsReferencing(c, 'tenant_id', fx.tenantB.id))).toBe(true);
      for (const repository of fx.tenantB.repositories) {
        expect(nothingLeft(await rowsReferencing(c, 'repository_id', repository.id))).toBe(true);
      }
      expect(await snapshot(c, fx.tenantA.id)).toEqual(a);
    });
    expect(await clientsAndCredentials()).toEqual(kept);

    const retry = await del(tenantPath(fx.tenantB.id), fx.operatorToken);
    expect(retry).toMatchObject({ status: 404, body: TENANT_NOT_FOUND });
  });

  it('deletes a repository of an ungranted tenant with 204', async () => {
    const repository = first(fx.tenantB.repositories).id;
    const response = await del(repositoryPath(fx.tenantB.id, repository), fx.operatorToken);
    expect(response.status).toBe(204);
    await asOwner(async (c) => {
      expect(nothingLeft(await rowsReferencing(c, 'repository_id', repository))).toBe(true);
    });
  });

  it('answers a missing repository 404 repository_not_found and a missing tenant 404 tenant_not_found', async () => {
    expect(await del(repositoryPath(fx.tenantA.id, randomUUID()), fx.operatorToken)).toMatchObject({
      status: 404,
      body: REPOSITORY_NOT_FOUND,
    });
    expect(await del(repositoryPath(randomUUID(), randomUUID()), fx.operatorToken)).toMatchObject({
      status: 404,
      body: TENANT_NOT_FOUND,
    });
  });
});

describe('malformed ids', () => {
  it.each([
    ['an operator', 'operatorToken'],
    ['a client', 'readerToken'],
  ] as const)(
    'answer 404 of their kind for %s, with no delete statement run',
    async (_who, token) => {
      log.clear();
      expect(await del(tenantPath('not-a-uuid'), fx[token])).toMatchObject({
        status: 404,
        body: TENANT_NOT_FOUND,
      });
      expect(
        await del(repositoryPath('not-a-uuid', first(fx.tenantA.repositories).id), fx[token]),
      ).toMatchObject({ status: 404, body: TENANT_NOT_FOUND });
      expect(await del(repositoryPath(fx.tenantA.id, 'not-a-uuid'), fx[token])).toMatchObject({
        status: 404,
        body: REPOSITORY_NOT_FOUND,
      });
      const texts = log.texts();
      expect(texts.some((text) => /DELETE|_as_operator|tenant_exists/i.test(text))).toBe(false);
    },
  );
});

describe('the transaction', () => {
  it('rolls a delete back when the route fails after it ran', async () => {
    const repository = first(fx.tenantA.repositories).id;
    const before = await asOwner((c) => snapshot(c, fx.tenantA.id));
    for (const token of [fx.readerToken, fx.operatorToken]) {
      const response = await del(`${repositoryPath(fx.tenantA.id, repository)}/then-fail`, token);
      expect(response.status).toBe(500);
    }
    expect(await asOwner((c) => snapshot(c, fx.tenantA.id))).toEqual(before);
  });

  it('serves a delete from one copy and its retry from the other alike', async () => {
    const [one, two] = copies.baseUrls as [string, string];
    const repository = first(fx.tenantA.repositories).id;
    expect((await del(repositoryPath(fx.tenantA.id, repository), fx.readerToken, one)).status).toBe(
      204,
    );
    expect(await del(repositoryPath(fx.tenantA.id, repository), fx.readerToken, two)).toMatchObject(
      { status: 404, body: REPOSITORY_NOT_FOUND },
    );
  });
});
