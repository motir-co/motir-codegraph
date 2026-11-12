import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { freshDatabase, type FreshDatabase } from '../helpers/db.js';
import { probeRoutes } from '../helpers/probe.js';
import { call, startServer, type ServerCopy } from '../helpers/server.js';
import { asOperator, buildTenancyFixture, type TenancyFixture } from '../helpers/tenancy.js';

let db: FreshDatabase;
let fx: TenancyFixture;
let server: ServerCopy;

beforeAll(async () => {
  db = await freshDatabase();
  fx = await buildTenancyFixture(db);
  server = await startServer(db.appUrl, { v1Routes: [probeRoutes] });
});

afterAll(async () => {
  await server.stop();
  await db.drop();
});

describe('revoking and re-granting access on a running server', () => {
  it('takes effect on the next call, with no restart', async () => {
    const nameA = () =>
      call(server.baseUrl, `/v1/tenants/${fx.tenantA.id}/repositories`, { token: fx.readerToken });

    expect((await nameA()).status).toBe(200);

    await asOperator(db.appUrl, fx.operatorId, 'codegraph.codegraph_revoke_access($1, $2)', [
      fx.readerId,
      fx.tenantA.id,
    ]);
    const refused = await nameA();
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: { code: 'permission_denied' } });

    await asOperator(db.appUrl, fx.operatorId, 'codegraph.codegraph_grant_access($1, $2)', [
      fx.readerId,
      fx.tenantA.id,
    ]);
    const restored = await nameA();
    expect(restored.status).toBe(200);
    expect((restored.body as { repositoryIds: string[] }).repositoryIds).toHaveLength(2);
  });
});
