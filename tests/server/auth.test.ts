import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashToken, MAX_TOKEN_LENGTH, parseBearer } from '../../src/server/auth.js';
import { freshDatabase, type FreshDatabase } from '../helpers/db.js';
import { probeRoutes } from '../helpers/probe.js';
import { recordQueries, type QueryLog } from '../helpers/queryLog.js';
import { call, startServer, type ServerCopy } from '../helpers/server.js';
import {
  asOperator,
  buildTenancyFixture,
  newToken,
  type TenancyFixture,
} from '../helpers/tenancy.js';

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

const UNAUTHENTICATED = {
  error: { code: 'unauthenticated', message: 'A valid bearer credential is required.' },
};

describe('parseBearer and hashToken', () => {
  it('reads a Bearer token, with the scheme in any case', () => {
    expect(parseBearer('Bearer abc')).toBe('abc');
    expect(parseBearer('bearer abc')).toBe('abc');
  });

  it.each([
    ['missing', undefined],
    ['another scheme', 'Basic abc'],
    ['no token', 'Bearer'],
    ['an empty token', 'Bearer '],
    ['a token holding whitespace', 'Bearer abc def'],
    ['a token after two spaces', 'Bearer  abc'],
    ['a token holding a newline', 'Bearer abc\ndef'],
    ['a token over the limit', `Bearer ${'a'.repeat(MAX_TOKEN_LENGTH + 1)}`],
  ])('refuses %s', (_case, header) => {
    expect(parseBearer(header)).toBeNull();
  });

  it('accepts a token at the limit', () => {
    expect(parseBearer(`Bearer ${'a'.repeat(MAX_TOKEN_LENGTH)}`)).toHaveLength(MAX_TOKEN_LENGTH);
  });

  it('hashes with SHA-256 into 32 bytes, as the fixture stores it', () => {
    const { token, hash } = newToken();
    expect(hashToken(token)).toEqual(hash);
    expect(hashToken(token)).toHaveLength(32);
  });
});

describe('a /v1 request without a valid credential', () => {
  it.each([
    ['no Authorization header', {}],
    ['a non-Bearer scheme', { authorization: 'Basic dXNlcjpwYXNz' }],
    ['an empty token', { authorization: 'Bearer ' }],
    ['a token holding whitespace', { authorization: 'Bearer abc def' }],
  ])('with %s is answered 401 with no statement run', async (_case, headers) => {
    const response = await call(server.baseUrl, '/v1/whoami', { headers });
    expect(response.status).toBe(401);
    expect(response.body).toEqual(UNAUTHENTICATED);
    expect(log.texts()).toEqual([]);
  });

  it('with an unknown token runs BEGIN, one authenticate and ROLLBACK, and nothing else', async () => {
    const response = await call(server.baseUrl, `/v1/tenants/${fx.tenantA.id}/repositories`, {
      token: newToken().token,
    });
    expect(response.status).toBe(401);
    expect(response.body).toEqual(UNAUTHENTICATED);
    expect(log.texts()).toEqual([
      'BEGIN',
      'SELECT client_id, client_kind, tenant_ids FROM codegraph.codegraph_authenticate($1)',
      'ROLLBACK',
    ]);
  });

  it('with a token whose credential was revoked after it authenticated once is answered 401', async () => {
    const { token, hash } = newToken();
    const credentialId = await asOperator<string>(
      db.appUrl,
      fx.operatorId,
      "codegraph.codegraph_issue_credential($1, $2, 'cg_rv')",
      [fx.readerId, hash],
    );
    expect((await call(server.baseUrl, '/v1/whoami', { token })).status).toBe(200);

    await asOperator(db.appUrl, fx.operatorId, 'codegraph.codegraph_revoke_credential($1)', [
      credentialId,
    ]);
    log.clear();
    const response = await call(server.baseUrl, `/v1/tenants/${fx.tenantA.id}/repositories`, {
      token,
    });
    expect(response.status).toBe(401);
    expect(response.body).toEqual(UNAUTHENTICATED);
    const texts = log.texts();
    expect(texts).toHaveLength(3);
    expect(texts.filter((text) => text.includes('codegraph_authenticate'))).toHaveLength(1);
    expect(texts.some((text) => text.includes('set_config'))).toBe(false);
    expect(texts.some((text) => text.includes('repositories'))).toBe(false);
  });
});

describe('who is calling', () => {
  it('answers whoami with the reader as a client', async () => {
    const response = await call(server.baseUrl, '/v1/whoami', { token: fx.readerToken });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      clientId: fx.readerId,
      kind: 'client',
      tenantIds: [fx.tenantA.id],
    });
  });

  it('answers an unknown /v1 path 401 without a token and route_not_found with one', async () => {
    const anonymous = await call(server.baseUrl, '/v1/does-not-exist');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toEqual(UNAUTHENTICATED);

    const known = await call(server.baseUrl, '/v1/does-not-exist', { token: fx.readerToken });
    expect(known.status).toBe(404);
    expect(known.body).toEqual({
      error: { code: 'route_not_found', message: 'No route answers GET /v1/does-not-exist.' },
    });
  });

  it('answers 503 service_unavailable when no connection can be had', async () => {
    const url = new URL(db.appUrl);
    url.port = '1';
    const dead = await startServer(url.toString(), { v1Routes: [probeRoutes] });
    try {
      const response = await call(dead.baseUrl, '/v1/whoami', { token: fx.readerToken });
      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        error: { code: 'service_unavailable', message: 'The database cannot be reached.' },
      });
    } finally {
      await dead.stop();
    }
  });
});
