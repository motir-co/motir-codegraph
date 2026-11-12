import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_FAILED_AUTH_LIMIT, DEFAULT_RATE_LIMIT } from '../../src/server/v1.js';
import { freshDatabase, type FreshDatabase } from '../helpers/db.js';
import { recordQueries } from '../helpers/queryLog.js';
import { call, type CopyOptions, startServer, type ServerCopy } from '../helpers/server.js';
import {
  asOperator,
  buildTenancyFixture,
  newToken,
  type TenancyFixture,
} from '../helpers/tenancy.js';

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

/** A token nobody issued: a new one on every call, as a flood would send. */
const madeUp = () => randomBytes(24).toString('base64url');

const FAILED_LIMIT = 3;

/** A copy whose per-caller limit is out of the way, so only failures count. */
async function withCopy(
  options: CopyOptions,
  test: (copy: ServerCopy) => Promise<void>,
): Promise<void> {
  const copy = await startServer(db.appUrl, {
    rateLimit: { max: 1000, timeWindowMs: 60_000 },
    failedAuthLimit: { max: FAILED_LIMIT, timeWindowMs: 60_000 },
    ...options,
  });
  try {
    await test(copy);
  } finally {
    await copy.stop();
  }
}

describe('the /v1 failed-authentication limit', () => {
  it('refuses a new made-up token on every request 429 once the address has failed its limit, running no statement', async () => {
    await withCopy({}, async (copy) => {
      for (let i = 0; i < FAILED_LIMIT; i += 1) {
        expect((await call(copy.baseUrl, statusPath(), { token: madeUp() })).status).toBe(401);
      }
      const log = recordQueries(copy.pool);
      for (let i = 0; i < 5; i += 1) {
        const refused = await call(copy.baseUrl, statusPath(), { token: madeUp() });
        expect(refused.status).toBe(429);
        expect(refused.body).toEqual(RATE_LIMITED);
        expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
        expect(refused.headers.get('content-type')).toMatch(/^application\/json/);
      }
      expect(log.texts()).toEqual([]);
    });
  });

  it('counts a missing or malformed credential as a failure too', async () => {
    await withCopy({}, async (copy) => {
      expect((await call(copy.baseUrl, statusPath())).status).toBe(401);
      const basic = { headers: { authorization: `Basic ${madeUp()}` } };
      expect((await call(copy.baseUrl, statusPath(), basic)).status).toBe(401);
      expect((await call(copy.baseUrl, statusPath(), { token: madeUp() })).status).toBe(401);
      expect((await call(copy.baseUrl, statusPath(), { token: madeUp() })).status).toBe(429);
    });
  });

  it("spends one attempt on a credential's first success, and none once it is remembered", async () => {
    await withCopy({}, async (copy) => {
      for (let i = 0; i < FAILED_LIMIT + 3; i += 1) {
        expect(
          (await call(copy.baseUrl, statusPath(), { token: fixture.readerToken })).status,
        ).toBe(200);
      }
      for (let i = 0; i < FAILED_LIMIT - 1; i += 1) {
        expect((await call(copy.baseUrl, statusPath(), { token: madeUp() })).status).toBe(401);
      }
      expect((await call(copy.baseUrl, statusPath(), { token: madeUp() })).status).toBe(429);
    });
  });

  it('does not let concurrent made-up tokens overshoot the limit', async () => {
    await withCopy({}, async (copy) => {
      const log = recordQueries(copy.pool);
      const statuses = (
        await Promise.all(
          Array.from({ length: 20 }, () => call(copy.baseUrl, statusPath(), { token: madeUp() })),
        )
      ).map(({ status }) => status);
      expect(statuses.filter((status) => status === 401)).toHaveLength(FAILED_LIMIT);
      expect(statuses.filter((status) => status === 429)).toHaveLength(20 - FAILED_LIMIT);
      expect(log.texts().filter((text) => text.includes('codegraph_authenticate'))).toHaveLength(
        FAILED_LIMIT,
      );
    });
  });

  it('still serves a credential that has authenticated, from the same address, and counts it per credential', async () => {
    await withCopy({ rateLimit: { max: 4, timeWindowMs: 60_000 } }, async (copy) => {
      expect((await call(copy.baseUrl, statusPath(), { token: fixture.readerToken })).status).toBe(
        200,
      );
      for (let i = 0; i < FAILED_LIMIT + 2; i += 1) {
        await call(copy.baseUrl, statusPath(), { token: madeUp() });
      }
      // The flood's address is over its limit; the reader's credential is not.
      for (let i = 0; i < 3; i += 1) {
        expect(
          (await call(copy.baseUrl, statusPath(), { token: fixture.readerToken })).status,
        ).toBe(200);
      }
      // Its own per-credential limit (4) still holds.
      expect((await call(copy.baseUrl, statusPath(), { token: fixture.readerToken })).status).toBe(
        429,
      );
    });
  });

  it('refuses a credential that has not yet authenticated from an address over its limit', async () => {
    await withCopy({}, async (copy) => {
      for (let i = 0; i < FAILED_LIMIT; i += 1) {
        await call(copy.baseUrl, statusPath(), { token: madeUp() });
      }
      const log = recordQueries(copy.pool);
      const refused = await call(copy.baseUrl, statusPath(), { token: fixture.operatorToken });
      expect(refused.status).toBe(429);
      expect(log.texts()).toEqual([]);
    });
  });

  it('forgets a credential once it fails, so a revoked one is held to the limit again', async () => {
    await withCopy({}, async (copy) => {
      const { token, hash } = newToken();
      const credentialId = await asOperator<string>(
        db.appUrl,
        fixture.operatorId,
        "codegraph.codegraph_issue_credential($1, $2, 'cg_rl')",
        [fixture.readerId, hash],
      );
      expect((await call(copy.baseUrl, statusPath(), { token })).status).toBe(200);
      await asOperator(db.appUrl, fixture.operatorId, 'codegraph.codegraph_revoke_credential($1)', [
        credentialId,
      ]);
      // Its first success spent one attempt. Its first failure is still
      // remembered, so passes uncounted, and forgets it; each failure after
      // that spends one.
      for (let i = 0; i < FAILED_LIMIT; i += 1) {
        expect((await call(copy.baseUrl, statusPath(), { token })).status).toBe(401);
      }
      const log = recordQueries(copy.pool);
      expect((await call(copy.baseUrl, statusPath(), { token })).status).toBe(429);
      expect(log.texts()).toEqual([]);
    });
  });

  describe('behind a trusted proxy', () => {
    const from = (address: string, token: string) => ({
      token,
      headers: { 'x-forwarded-for': address },
    });

    it("counts each client address on its own, so one client's flood does not refuse another", async () => {
      await withCopy({ trustProxy: ['127.0.0.1'] }, async (copy) => {
        for (let i = 0; i < FAILED_LIMIT; i += 1) {
          await call(copy.baseUrl, statusPath(), from('203.0.113.7', madeUp()));
        }
        expect((await call(copy.baseUrl, statusPath(), from('203.0.113.7', madeUp()))).status).toBe(
          429,
        );
        // A client that has never authenticated, at another address, is
        // authenticated (the operator may not read status: 403, not 429).
        const other = await call(
          copy.baseUrl,
          statusPath(),
          from('198.51.100.20', fixture.operatorToken),
        );
        expect(other.status).toBe(403);
      });
    });

    it('ignores X-Forwarded-For from a peer it does not trust', async () => {
      await withCopy({ trustProxy: ['192.0.2.1'] }, async (copy) => {
        for (let i = 0; i < FAILED_LIMIT; i += 1) {
          await call(copy.baseUrl, statusPath(), from(`203.0.113.${String(i)}`, madeUp()));
        }
        // A new forwarded address each time does not buy a new allowance.
        expect(
          (await call(copy.baseUrl, statusPath(), from('203.0.113.99', madeUp()))).status,
        ).toBe(429);
      });
    });
  });

  it('defaults to 60 failures a minute', () => {
    expect(DEFAULT_FAILED_AUTH_LIMIT).toEqual({ max: 60, timeWindowMs: 60_000 });
  });
});
