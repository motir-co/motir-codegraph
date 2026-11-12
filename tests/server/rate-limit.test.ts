import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_RATE_LIMIT } from '../../src/server/v1.js';
import { freshDatabase, type FreshDatabase } from '../helpers/db.js';
import { recordQueries } from '../helpers/queryLog.js';
import { call, startServer, type ServerCopy } from '../helpers/server.js';
import { buildTenancyFixture, type TenancyFixture } from '../helpers/tenancy.js';

const LIMIT = 3;
const RATE_LIMITED = {
  error: {
    code: 'rate_limited',
    message: 'Too many requests; retry after the Retry-After seconds.',
  },
};

let db: FreshDatabase;
let fixture: TenancyFixture;
let server: ServerCopy | undefined;

beforeAll(async () => {
  db = await freshDatabase();
  fixture = await buildTenancyFixture(db);
});

afterAll(async () => {
  await db.drop();
});

let baseUrl: string;
let pool: ServerCopy['pool'];

beforeEach(async () => {
  // A fresh copy per test, so each starts with empty counters.
  await server?.stop();
  const copy = await startServer(db.appUrl, {
    rateLimit: { max: LIMIT, timeWindowMs: 60_000 },
  });
  server = copy;
  baseUrl = copy.baseUrl;
  pool = copy.pool;
});

afterAll(async () => {
  await server?.stop();
});

const statusPath = () => {
  const repository = fixture.tenantA.repositories[0];
  if (repository === undefined) throw new Error('fixture has no repository');
  return `/v1/tenants/${fixture.tenantA.id}/repositories/${repository.id}/status`;
};

describe('the /v1 rate limit', () => {
  it('refuses a caller over its limit 429 rate_limited, with Retry-After, and runs no statement', async () => {
    for (let i = 0; i < LIMIT; i += 1) {
      expect((await call(baseUrl, statusPath(), { token: fixture.readerToken })).status).toBe(200);
    }
    // Recorded from here only: the log does not serve pool.query, which
    // /health uses.
    const log = recordQueries(pool);
    const refused = await call(baseUrl, statusPath(), { token: fixture.readerToken });
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual(RATE_LIMITED);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(refused.headers.get('content-type')).toMatch(/^application\/json/);
    expect(log.texts()).toEqual([]);
  });

  it('counts each credential on its own', async () => {
    for (let i = 0; i < LIMIT; i += 1) {
      await call(baseUrl, statusPath(), { token: fixture.readerToken });
    }
    expect((await call(baseUrl, statusPath(), { token: fixture.readerToken })).status).toBe(429);
    // The operator's credential has its own counter, and is not refused.
    const operator = await call(baseUrl, statusPath(), { token: fixture.operatorToken });
    expect(operator.status).not.toBe(429);
  });

  it('limits a caller with no credential by its address, before authentication', async () => {
    for (let i = 0; i < LIMIT; i += 1) {
      expect((await call(baseUrl, statusPath())).status).toBe(401);
    }
    const refused = await call(baseUrl, statusPath());
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual(RATE_LIMITED);
  });

  it('does not limit /health', async () => {
    for (let i = 0; i < LIMIT + 2; i += 1) {
      expect((await call(baseUrl, '/health')).status).toBe(200);
    }
  });

  it('defaults to 1200 a minute', () => {
    expect(DEFAULT_RATE_LIMIT).toEqual({ max: 1200, timeWindowMs: 60_000 });
  });
});
