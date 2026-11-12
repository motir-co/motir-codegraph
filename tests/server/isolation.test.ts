import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { BIND_TENANT_SQL } from '../../src/server/binding.js';
import { freshDatabase, type FreshDatabase } from '../helpers/db.js';
import { probeRoutes } from '../helpers/probe.js';
import { recordQueries, type QueryLog } from '../helpers/queryLog.js';
import { call, startServer, type ServerCopy } from '../helpers/server.js';
import { buildTenancyFixture, type TenancyFixture } from '../helpers/tenancy.js';

let db: FreshDatabase;
let fx: TenancyFixture;
let server: ServerCopy;
let log: QueryLog;

beforeAll(async () => {
  db = await freshDatabase();
  fx = await buildTenancyFixture(db);
  server = await startServer(db.appUrl, { v1Routes: [probeRoutes] });
  log = recordQueries(server.pool);
});

afterAll(async () => {
  await server.stop();
  await db.drop();
});

beforeEach(() => {
  log.clear();
});

const PERMISSION_DENIED = {
  error: { code: 'permission_denied', message: 'The credential may not use this tenant.' },
};
const REPOSITORY_NOT_FOUND = {
  error: { code: 'repository_not_found', message: 'No such repository.' },
};

const ids = (repositories: { id: string }[]) => repositories.map(({ id }) => id).sort();

describe('a client granted tenant A and not tenant B', () => {
  it('is answered from A when it names A', async () => {
    // The fixture's tenants differ (2 repositories against 3), so a scoped
    // read and an unscoped one cannot give the same answer.
    expect(fx.tenantA.repositories).toHaveLength(2);
    expect(fx.tenantB.repositories).toHaveLength(3);
    const response = await call(server.baseUrl, `/v1/tenants/${fx.tenantA.id}/repositories`, {
      token: fx.readerToken,
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ repositoryIds: ids(fx.tenantA.repositories) });
    expect(log.texts()).toContain(BIND_TENANT_SQL);
  });

  it('accepts the tenant id in upper case', async () => {
    const response = await call(
      server.baseUrl,
      `/v1/tenants/${fx.tenantA.id.toUpperCase()}/repositories`,
      { token: fx.readerToken },
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ repositoryIds: ids(fx.tenantA.repositories) });
  });

  it('is refused 403, not an empty list, when it names B, with no binding run', async () => {
    const response = await call(server.baseUrl, `/v1/tenants/${fx.tenantB.id}/repositories`, {
      token: fx.readerToken,
    });
    expect(response.status).toBe(403);
    expect(response.body).toEqual(PERMISSION_DENIED);
    expect(log.texts().some((text) => text.includes('set_config'))).toBe(false);
    expect(log.texts().at(-1)).toBe('ROLLBACK');
  });

  it('is refused 403 for a tenant id that does not exist, exactly as for B', async () => {
    const response = await call(server.baseUrl, `/v1/tenants/${randomUUID()}/repositories`, {
      token: fx.readerToken,
    });
    expect(response.status).toBe(403);
    expect(response.body).toEqual(PERMISSION_DENIED);
  });
});

describe('naming a repository', () => {
  const repository = (tenantId: string, repositoryId: string) =>
    call(server.baseUrl, `/v1/tenants/${tenantId}/repositories/${repositoryId}`, {
      token: fx.readerToken,
    });

  it('answers a repository of A', async () => {
    const [first] = fx.tenantA.repositories;
    const response = await repository(fx.tenantA.id, first?.id ?? '');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: first?.id, tenantId: fx.tenantA.id, name: first?.name });
  });

  it('refuses a repository of B, named through B, 403 permission_denied', async () => {
    const response = await repository(fx.tenantB.id, fx.tenantB.repositories[0]?.id ?? '');
    expect(response.status).toBe(403);
    expect(response.body).toEqual(PERMISSION_DENIED);
  });

  it('answers a repository id that does not exist 404 repository_not_found', async () => {
    const response = await repository(fx.tenantA.id, randomUUID());
    expect(response.status).toBe(404);
    expect(response.body).toEqual(REPOSITORY_NOT_FOUND);
  });

  it('answers a repository of B named under A 404 repository_not_found', async () => {
    const response = await repository(fx.tenantA.id, fx.tenantB.repositories[0]?.id ?? '');
    expect(response.status).toBe(404);
    expect(response.body).toEqual(REPOSITORY_NOT_FOUND);
  });

  it('answers a malformed repository id 404 without querying repositories', async () => {
    const response = await repository(fx.tenantA.id, 'not-a-uuid');
    expect(response.status).toBe(404);
    expect(response.body).toEqual(REPOSITORY_NOT_FOUND);
    expect(log.texts().some((text) => text.includes('codegraph.repositories'))).toBe(false);
  });
});
