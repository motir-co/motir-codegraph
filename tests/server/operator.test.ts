import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { freshDatabase, queryRows, withClient, type FreshDatabase } from '../helpers/db.js';
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

const asOperator = (path: string, body?: unknown, method = 'POST') =>
  call(server.baseUrl, path, {
    method,
    token: fx.operatorToken,
    ...(body === undefined ? {} : { body }),
  });

const owner = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  withClient(db.ownerUrl, (c) => queryRows<T>(c, sql, params));

/** A count of every row the operator routes can create or change. */
async function snapshot() {
  const [row] = await owner<Record<string, number>>(`SELECT
      (SELECT count(*)::int FROM codegraph.tenants) AS tenants,
      (SELECT count(*)::int FROM codegraph.repositories) AS repositories,
      (SELECT count(*)::int FROM codegraph.clients) AS clients,
      (SELECT count(*)::int FROM codegraph.credentials) AS credentials,
      (SELECT count(*)::int FROM codegraph.credentials WHERE revoked_at IS NOT NULL) AS revoked_credentials,
      (SELECT count(*)::int FROM codegraph.grants) AS grants,
      (SELECT count(*)::int FROM codegraph.grants WHERE revoked_at IS NOT NULL) AS revoked_grants`);
  return row;
}

describe('the operator calls, with an operator credential', () => {
  it('create a tenant, register a repository under it, and create clients of both kinds', async () => {
    const tenant = await asOperator('/v1/operator/tenants', { displayName: 'Initech' });
    expect(tenant.status).toBe(201);
    const { tenantId } = tenant.body as { tenantId: string };
    expect(
      await owner('SELECT display_name FROM codegraph.tenants WHERE id = $1', [tenantId]),
    ).toEqual([{ display_name: 'Initech' }]);

    const repository = await asOperator('/v1/operator/repositories', {
      tenantId,
      displayName: 'initech-tps',
    });
    expect(repository.status).toBe(201);
    const { repositoryId } = repository.body as { repositoryId: string };
    expect(repository.body).toEqual({ tenantId, repositoryId });
    expect(
      await owner('SELECT tenant_id FROM codegraph.repositories WHERE id = $1', [repositoryId]),
    ).toEqual([{ tenant_id: tenantId }]);

    for (const kind of ['client', 'operator']) {
      const client = await asOperator('/v1/operator/clients', { name: `new ${kind}`, kind });
      expect(client.status).toBe(201);
      expect(client.body).toEqual({
        clientId: expect.any(String) as string,
        name: `new ${kind}`,
        kind,
      });
    }
  });

  it('issue a credential that authenticates, and revoke it so it no longer does', async () => {
    const issued = await asOperator(`/v1/operator/clients/${fx.readerId}/credentials`);
    expect(issued.status).toBe(201);
    const { token, credentialId } = issued.body as { token: string; credentialId: string };
    expect((await call(server.baseUrl, '/v1/whoami', { token })).status).toBe(200);

    const revoked = await asOperator(`/v1/operator/credentials/${credentialId}/revoke`);
    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({ credentialId, revoked: true });
    expect((await call(server.baseUrl, '/v1/whoami', { token })).status).toBe(401);

    const again = await asOperator(`/v1/operator/credentials/${credentialId}/revoke`);
    expect(again.body).toEqual({ credentialId, revoked: false });
    const unknown = randomUUID();
    expect((await asOperator(`/v1/operator/credentials/${unknown}/revoke`)).body).toEqual({
      credentialId: unknown,
      revoked: false,
    });
  });

  it('grant access (the same grant twice), and revoke it', async () => {
    const nameB = () =>
      call(server.baseUrl, `/v1/tenants/${fx.tenantB.id}/repositories`, { token: fx.readerToken });
    expect((await nameB()).status).toBe(403);

    const grant = { clientId: fx.readerId, tenantId: fx.tenantB.id };
    const first = await asOperator('/v1/operator/grants', grant);
    expect(first.status).toBe(200);
    const { grantId } = first.body as { grantId: string };
    expect(first.body).toEqual({ grantId, ...grant });
    expect((await asOperator('/v1/operator/grants', grant)).body).toEqual({ grantId, ...grant });
    expect((await nameB()).status).toBe(200);

    const revoked = await asOperator('/v1/operator/grants/revoke', grant);
    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({ ...grant, revoked: true });
    expect((await nameB()).status).toBe(403);
    expect((await asOperator('/v1/operator/grants/revoke', grant)).body).toEqual({
      ...grant,
      revoked: false,
    });
  });

  it('read a client back with its credentials and no token', async () => {
    const response = await asOperator(`/v1/operator/clients/${fx.readerId}`, undefined, 'GET');
    expect(response.status).toBe(200);
    const body = response.body as { credentials: Record<string, unknown>[] };
    expect(body).toMatchObject({ clientId: fx.readerId, kind: 'client' });
    expect(body.credentials.length).toBeGreaterThan(0);
    for (const credential of body.credentials) {
      expect(Object.keys(credential).sort()).toEqual(
        ['createdAt', 'credentialId', 'displayPrefix', 'revokedAt'].sort(),
      );
    }
  });

  it('read back a client with no credential as an empty list', async () => {
    const created = await asOperator('/v1/operator/clients', { name: 'bare', kind: 'client' });
    const { clientId } = created.body as { clientId: string };
    const response = await asOperator(`/v1/operator/clients/${clientId}`, undefined, 'GET');
    expect(response.body).toMatchObject({ clientId, name: 'bare', credentials: [] });
  });
});

describe('the operator calls, with a client credential', () => {
  const CALLS: [string, string, unknown?][] = [
    ['POST', '/v1/operator/tenants', { displayName: 'Sneaky' }],
    ['POST', '/v1/operator/repositories', { tenantId: '', displayName: 'sneaky' }],
    ['POST', '/v1/operator/clients', { name: 'sneaky', kind: 'operator' }],
    ['GET', '/v1/operator/clients/:reader'],
    ['POST', '/v1/operator/clients/:reader/credentials'],
    ['POST', '/v1/operator/credentials/:credential/revoke'],
    ['POST', '/v1/operator/grants', { clientId: '', tenantId: '' }],
    ['POST', '/v1/operator/grants/revoke', { clientId: '', tenantId: '' }],
  ];

  it.each(CALLS)('%s %s is refused 403 and changes nothing', async (method, template, body) => {
    const [credential] = await owner<{ id: string }>(
      'SELECT id FROM codegraph.credentials WHERE client_id = $1 LIMIT 1',
      [fx.readerId],
    );
    const path = template
      .replace(':reader', fx.readerId)
      .replace(':credential', credential?.id ?? '');
    const filled =
      body === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(body as Record<string, string>).map(([key, value]) => [
              key,
              value === '' ? (key === 'clientId' ? fx.readerId : fx.tenantB.id) : value,
            ]),
          );
    const before = await snapshot();
    log.clear();
    const response = await call(server.baseUrl, path, {
      method,
      token: fx.readerToken,
      ...(filled === undefined ? {} : { body: filled }),
    });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: { code: 'permission_denied', message: 'This call needs an operator credential.' },
    });
    expect(
      log.texts().some((text) => text.includes('codegraph_') && !text.includes('authenticate')),
    ).toBe(false);
    expect(await snapshot()).toEqual(before);
  });
});

describe('refusals of the operator calls', () => {
  it.each([
    ['a non-uuid tenantId', '/v1/operator/repositories', { tenantId: 'acme', displayName: 'x' }],
    ['an empty displayName', '/v1/operator/tenants', { displayName: '' }],
    ['a blank displayName', '/v1/operator/tenants', { displayName: '   ' }],
    ['an unknown kind', '/v1/operator/clients', { name: 'x', kind: 'admin' }],
    ['a missing field', '/v1/operator/grants', { clientId: randomUUID() }],
    ['an extra field', '/v1/operator/tenants', { displayName: 'x', id: randomUUID() }],
  ])('answer %s 400 invalid_request with no function called', async (_case, path, body) => {
    log.clear();
    const response = await asOperator(path, body);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'invalid_request' } });
    expect(
      log.texts().some((text) => text.includes('codegraph_') && !text.includes('authenticate')),
    ).toBe(false);
  });

  // Every operator body route, a body it accepts, and each of that body's
  // fields: all of them are strings, so each is sent once as a value of
  // every other JSON type a coercing validator would turn into a string.
  const bodyRoutes: readonly [path: string, valid: Record<string, string>][] = [
    ['/v1/operator/tenants', { displayName: 'Initech' }],
    ['/v1/operator/repositories', { tenantId: randomUUID(), displayName: 'initech-tps' }],
    ['/v1/operator/clients', { name: 'a client', kind: 'client' }],
    ['/v1/operator/grants', { clientId: randomUUID(), tenantId: randomUUID() }],
    ['/v1/operator/grants/revoke', { clientId: randomUUID(), tenantId: randomUUID() }],
  ];
  const wrongTypes: readonly [label: string, value: unknown][] = [
    ['a number', 7],
    ['a boolean', true],
    ['a one-element array', ['x']],
    ['null', null],
    ['an object', { value: 'x' }],
  ];
  it.each(
    bodyRoutes.flatMap(([path, valid]) =>
      Object.keys(valid).flatMap((field) =>
        wrongTypes.map(
          ([label, value]) => [path, field, label, { ...valid, [field]: value }] as const,
        ),
      ),
    ),
  )(
    'answer %s with %s as %s 400 invalid_request, storing nothing',
    async (path, field, _label, body) => {
      const before = await snapshot();
      log.clear();
      const response = await asOperator(path, body);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: { code: 'invalid_request', message: expect.stringContaining(field) as string },
      });
      expect(
        log.texts().some((text) => text.includes('codegraph_') && !text.includes('authenticate')),
      ).toBe(false);
      expect(await snapshot()).toEqual(before);
    },
  );

  it('store a displayName exactly as sent once it is a string', async () => {
    const response = await asOperator('/v1/operator/tenants', { displayName: '7' });
    expect(response.status).toBe(201);
    const { tenantId } = response.body as { tenantId: string };
    expect(
      await owner('SELECT display_name FROM codegraph.tenants WHERE id = $1', [tenantId]),
    ).toEqual([{ display_name: '7' }]);
  });

  it('answer a non-uuid :clientId 400 invalid_request', async () => {
    const response = await asOperator('/v1/operator/clients/not-a-uuid', undefined, 'GET');
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('answer a body that is not JSON 400 invalid_request', async () => {
    const response = await fetch(`${server.baseUrl}/v1/operator/tenants`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fx.operatorToken}`, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('answer a repository under a missing tenant 404 tenant_not_found', async () => {
    const response = await asOperator('/v1/operator/repositories', {
      tenantId: randomUUID(),
      displayName: 'orphan',
    });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'tenant_not_found', message: 'No such tenant.' },
    });
  });

  it('answer a missing client 404 client_not_found when issuing to it or reading it', async () => {
    const missing = randomUUID();
    const issue = await asOperator(`/v1/operator/clients/${missing}/credentials`);
    expect(issue.status).toBe(404);
    expect(issue.body).toEqual({ error: { code: 'client_not_found', message: 'No such client.' } });
    const read = await asOperator(`/v1/operator/clients/${missing}`, undefined, 'GET');
    expect(read.status).toBe(404);
    expect(read.body).toEqual({ error: { code: 'client_not_found', message: 'No such client.' } });
  });

  it('answer a grant to a missing client or tenant 404 by what is missing', async () => {
    const noClient = await asOperator('/v1/operator/grants', {
      clientId: randomUUID(),
      tenantId: fx.tenantA.id,
    });
    expect(noClient.status).toBe(404);
    expect(noClient.body).toMatchObject({ error: { code: 'client_not_found' } });
    const noTenant = await asOperator('/v1/operator/grants', {
      clientId: fx.readerId,
      tenantId: randomUUID(),
    });
    expect(noTenant.status).toBe(404);
    expect(noTenant.body).toMatchObject({ error: { code: 'tenant_not_found' } });
  });

  it('answer a revoke of a grant that does not exist 200 revoked: false', async () => {
    const grant = { clientId: randomUUID(), tenantId: randomUUID() };
    const response = await asOperator('/v1/operator/grants/revoke', grant);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ...grant, revoked: false });
  });
});
