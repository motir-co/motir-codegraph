import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { requestDb } from '../../src/server/binding.js';
import { ApiError, ERROR_STATUS, type ErrorCode } from '../../src/server/errors.js';
import type { V1Routes } from '../../src/server/v1.js';
import { freshDatabase, type FreshDatabase } from '../helpers/db.js';
import { call, startServer, type ServerCopy } from '../helpers/server.js';
import { buildTenancyFixture, type TenancyFixture } from '../helpers/tenancy.js';

const THROWN: ErrorCode[] = [
  'unauthenticated',
  'permission_denied',
  'repository_not_found',
  'tenant_not_found',
  'service_unavailable',
];

// Test-only routes under /v1 (so behind authentication): one per code, and one
// that throws an ordinary Error.
const throwing: V1Routes = (v1) => {
  v1.get<{ Params: { code: ErrorCode } }>('/throw/:code', (request) => {
    throw new ApiError(request.params.code, `refused with ${request.params.code}`);
  });
  v1.get('/crash', () => {
    throw new Error('secret detail from deep inside');
  });
  // Database errors raised on the request transaction, by SQLSTATE.
  v1.get<{ Params: { name: keyof typeof DATABASE_ERRORS } }>('/db-error/:name', async (request) => {
    await requestDb(request).query(DATABASE_ERRORS[request.params.name]);
    return { reached: true };
  });
};

const DATABASE_ERRORS = {
  invalidText: "SELECT 'not-a-uuid'::uuid",
  knownForeignKey:
    "DO $$ BEGIN RAISE foreign_key_violation USING CONSTRAINT = 'grants_client_id_fkey'; END $$",
  unknownForeignKey:
    "DO $$ BEGIN RAISE foreign_key_violation USING CONSTRAINT = 'elsewhere_fkey'; END $$",
  bareForeignKey: 'DO $$ BEGIN RAISE foreign_key_violation; END $$',
  otherState: 'SELECT 1 / 0',
} as const;

let db: FreshDatabase;
let server: ServerCopy;
let fx: TenancyFixture;

beforeAll(async () => {
  db = await freshDatabase();
  fx = await buildTenancyFixture(db);
  server = await startServer(db.appUrl, { v1Routes: [throwing] });
});

afterAll(async () => {
  await server.stop();
  await db.drop();
});

describe('the one error body', () => {
  it.each(THROWN)('answers %s with its status and code', async (code) => {
    const response = await call(server.baseUrl, `/v1/throw/${code}`, { token: fx.readerToken });
    expect(response.status).toBe(ERROR_STATUS[code]);
    expect(response.body).toEqual({ error: { code, message: `refused with ${code}` } });
  });

  it('answers an unknown path 404 route_not_found', async () => {
    const response = await call(server.baseUrl, '/nowhere?x=1');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'route_not_found', message: 'No route answers GET /nowhere.' },
    });
  });

  it('answers an ordinary Error 500 internal_error without its message or stack', async () => {
    const response = await call(server.baseUrl, '/v1/crash', { token: fx.readerToken });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'internal_error', message: 'The server could not complete the request.' },
    });
    expect(JSON.stringify(response.body)).not.toContain('secret detail');
  });

  it('gives ApiError the status its code maps to', () => {
    expect(new ApiError('tenant_not_found', 'gone').statusCode).toBe(404);
  });
});

describe('database errors', () => {
  const INTERNAL = {
    error: { code: 'internal_error', message: 'The server could not complete the request.' },
  };

  it.each([
    [
      'invalidText',
      400,
      { error: { code: 'invalid_request', message: 'The request is not valid.' } },
    ],
    ['knownForeignKey', 404, { error: { code: 'client_not_found', message: 'No such client.' } }],
    ['unknownForeignKey', 500, INTERNAL],
    ['bareForeignKey', 500, INTERNAL],
    ['otherState', 500, INTERNAL],
  ] as const)('answers %s with %i', async (name, status, body) => {
    const response = await call(server.baseUrl, `/v1/db-error/${name}`, {
      token: fx.readerToken,
    });
    expect(response.status).toBe(status);
    expect(response.body).toEqual(body);
  });
});
