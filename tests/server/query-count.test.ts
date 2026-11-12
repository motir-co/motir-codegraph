import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { BIND_TENANT_SQL } from '../../src/server/binding.js';
import { freshDatabase, type FreshDatabase } from '../helpers/db.js';
import { probeRoutes } from '../helpers/probe.js';
import { recordQueries, type QueryLog } from '../helpers/queryLog.js';
import { call, startServer, type ServerCopy } from '../helpers/server.js';
import { asOperator, buildTenancyFixture, type TenancyFixture } from '../helpers/tenancy.js';

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

/** The statements one authenticated request naming A issued. */
async function oneRequest(): Promise<string[]> {
  log.clear();
  const response = await call(server.baseUrl, `/v1/tenants/${fx.tenantA.id}/repositories`, {
    token: fx.readerToken,
  });
  expect(response.status).toBe(200);
  return log.texts();
}

function counts(texts: string[]) {
  return {
    authenticate: texts.filter((text) => text.includes('codegraph_authenticate')).length,
    binding: texts.filter((text) => text.includes('set_config')).length,
    total: texts.length,
  };
}

describe('the per-request cost of authentication and binding', () => {
  it('is one authenticate call and one binding statement setting both settings', async () => {
    const texts = await oneRequest();
    expect(counts(texts)).toEqual({ authenticate: 1, binding: 1, total: 5 });
    expect(texts).toEqual([
      'BEGIN',
      'SELECT client_id, client_kind, tenant_ids FROM codegraph.codegraph_authenticate($1)',
      BIND_TENANT_SQL,
      'SELECT id FROM codegraph.repositories ORDER BY id',
      'COMMIT',
    ]);
    expect(BIND_TENANT_SQL).toContain("set_config('app.client_id'");
    expect(BIND_TENANT_SQL).toContain("set_config('app.tenant_id'");
  });

  it('stays the same after the client is granted 25 more tenants', async () => {
    const before = counts(await oneRequest());
    for (let i = 0; i < 25; i += 1) {
      const tenantId = await asOperator<string>(
        db.appUrl,
        fx.operatorId,
        'codegraph.codegraph_create_tenant($1)',
        [`extra ${String(i)}`],
      );
      await asOperator(db.appUrl, fx.operatorId, 'codegraph.codegraph_grant_access($1, $2)', [
        fx.readerId,
        tenantId,
      ]);
    }
    const whoami = await call(server.baseUrl, '/v1/whoami', { token: fx.readerToken });
    expect((whoami.body as { tenantIds: string[] }).tenantIds).toHaveLength(26);
    expect(counts(await oneRequest())).toEqual(before);
  });
});
