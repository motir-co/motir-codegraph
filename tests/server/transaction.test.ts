import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { freshDatabase, queryRows, withClient, type FreshDatabase } from '../helpers/db.js';
import { probeRoutes } from '../helpers/probe.js';
import { call, startCopies, startServer, type ServerCopy } from '../helpers/server.js';
import { asOperator, buildTenancyFixture, type TenancyFixture } from '../helpers/tenancy.js';

const SERVER_SRC = fileURLToPath(new URL('../../src/server/', import.meta.url));

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

async function tenantCount(): Promise<number> {
  const rows = await withClient(db.ownerUrl, (c) =>
    queryRows<{ n: number }>(c, 'SELECT count(*)::int AS n FROM codegraph.tenants'),
  );
  return rows[0]?.n ?? -1;
}

async function repositoryName(id: string): Promise<string | undefined> {
  const rows = await withClient(db.ownerUrl, (c) =>
    queryRows<{ display_name: string }>(
      c,
      'SELECT display_name FROM codegraph.repositories WHERE id = $1',
      [id],
    ),
  );
  return rows[0]?.display_name;
}

describe('the operator guard', () => {
  it('refuses the reader 403 and lets the operator through', async () => {
    const reader = await call(server.baseUrl, '/v1/operator-probe', {
      method: 'POST',
      token: fx.readerToken,
    });
    expect(reader.status).toBe(403);
    expect(reader.body).toEqual({
      error: { code: 'permission_denied', message: 'This call needs an operator credential.' },
    });

    const operator = await call(server.baseUrl, '/v1/operator-probe', {
      method: 'POST',
      token: fx.operatorToken,
    });
    expect(operator.status).toBe(200);
    expect(operator.body).toEqual({ operator: fx.operatorId });
  });

  it("maps the database's own refusal (42501) to 403 and creates no tenant", async () => {
    const before = await tenantCount();
    const response = await call(server.baseUrl, '/v1/operator-db-probe', {
      method: 'POST',
      token: fx.readerToken,
    });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: { code: 'permission_denied', message: 'The credential may not make this call.' },
    });
    expect(await tenantCount()).toBe(before);
  });

  it('lets the operator create a tenant through the same function, and commits it', async () => {
    const before = await tenantCount();
    const response = await call(server.baseUrl, '/v1/operator-db-probe', {
      method: 'POST',
      token: fx.operatorToken,
    });
    expect(response.status).toBe(200);
    expect(await tenantCount()).toBe(before + 1);
  });
});

describe('the request transaction', () => {
  const repo = () => fx.tenantA.repositories[0]?.id ?? '';
  const rename = (fail: boolean) =>
    call(
      server.baseUrl,
      `/v1/tenants/${fx.tenantA.id}/repositories/${repo()}/rename-probe${fail ? '?fail=1' : ''}`,
      { method: 'POST', token: fx.readerToken },
    );

  it('keeps a write a success answer reports, visible to the next request', async () => {
    const response = await rename(false);
    expect(response.status).toBe(200);
    const { name } = response.body as { name: string };
    expect(await repositoryName(repo())).toBe(name);
    const next = await call(server.baseUrl, `/v1/tenants/${fx.tenantA.id}/repositories/${repo()}`, {
      token: fx.readerToken,
    });
    expect(next.body).toMatchObject({ name });
  });

  it('rolls back a write followed by an error answer', async () => {
    const before = await repositoryName(repo());
    const response = await rename(true);
    expect(response.status).toBe(403);
    expect(await repositoryName(repo())).toBe(before);
  });

  it('returns every connection to the pool after 50 requests with mixed outcomes', async () => {
    const paths = [
      { path: '/v1/whoami', token: fx.readerToken },
      { path: `/v1/tenants/${fx.tenantB.id}/repositories`, token: fx.readerToken },
      { path: '/v1/whoami', token: 'unknown-token' },
      { path: '/v1/whoami' },
      { path: '/v1/nowhere', token: fx.readerToken },
    ];
    for (let i = 0; i < 50; i += 1) {
      const { path, token } = paths[i % paths.length] as { path: string; token?: string };
      await call(server.baseUrl, path, token === undefined ? {} : { token });
    }
    await rename(true);
    await rename(false);
    // onResponse runs after the answer is written; let it finish.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.pool.totalCount - server.pool.idleCount).toBe(0);
    expect(server.pool.waitingCount).toBe(0);
  });
});

describe('two copies', () => {
  it('answer the reader alike, including the 403 after a revoke made between calls', async () => {
    const copies = await startCopies(db.appUrl, 2, { v1Routes: [probeRoutes] });
    try {
      const nameA = (i: number) =>
        call(copies.baseUrls[i % 2] as string, `/v1/tenants/${fx.tenantA.id}/repositories`, {
          token: fx.readerToken,
        });
      const first = await nameA(0);
      const second = await nameA(1);
      expect(first.status).toBe(200);
      expect(second).toMatchObject({ status: first.status, body: first.body });

      await asOperator(db.appUrl, fx.operatorId, 'codegraph.codegraph_revoke_access($1, $2)', [
        fx.readerId,
        fx.tenantA.id,
      ]);
      const third = await nameA(2);
      const fourth = await nameA(3);
      expect(third.status).toBe(403);
      expect(fourth).toMatchObject({ status: 403, body: third.body });

      await asOperator(db.appUrl, fx.operatorId, 'codegraph.codegraph_grant_access($1, $2)', [
        fx.readerId,
        fx.tenantA.id,
      ]);
    } finally {
      await copies.stop();
    }
  });

  it('src/server holds no module-level cache', async () => {
    const files = (await readdir(SERVER_SRC)).filter((file) => file.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = await readFile(`${SERVER_SRC}${file}`, 'utf8');
      // Module scope is every line that starts in column 0.
      const moduleLines = source.split('\n').filter((line) => /^\S/.test(line));
      const offending = moduleLines.filter(
        (line) =>
          /^(export\s+)?(let|var)\s/.test(line) ||
          /^(export\s+)?const\s+\w+\s*(:[^=]+)?=\s*new\s+(Map|Set|WeakMap|WeakSet)\b/.test(line),
      );
      expect(offending, file).toEqual([]);
    }
  });
});
