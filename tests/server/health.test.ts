import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { freshDatabase, type FreshDatabase } from '../helpers/db.js';
import { call, startServer } from '../helpers/server.js';

let db: FreshDatabase;

beforeAll(async () => {
  db = await freshDatabase();
});

afterAll(async () => {
  await db.drop();
});

/** The app login's URL for this database, on a port nothing listens on. */
function deadUrl(): string {
  const url = new URL(db.appUrl);
  url.port = '1';
  return url.toString();
}

describe('GET /health', () => {
  it('answers 200 with the process and database up, with no credential', async () => {
    const server = await startServer(db.appUrl);
    try {
      const response = await call(server.baseUrl, '/health');
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.body).toEqual({
        status: 'ok',
        process: { up: true, uptimeSeconds: expect.any(Number) as number },
        database: { up: true },
      });
    } finally {
      await server.stop();
    }
  });

  it('answers 503 quickly when the database cannot be reached', async () => {
    const server = await startServer(deadUrl());
    try {
      const started = Date.now();
      const response = await call(server.baseUrl, '/health');
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        status: 'unavailable',
        process: { up: true, uptimeSeconds: expect.any(Number) as number },
        database: { up: false },
      });
    } finally {
      await server.stop();
    }
  });

  it('answers 503 when the database does not answer in time', async () => {
    // A statement that outlives the health timeout: the probe gives up first.
    const server = await startServer(db.appUrl, { healthTimeoutMs: 50 });
    try {
      const slow = server.pool.query('SELECT pg_sleep(1)');
      const blocked = Array.from({ length: 9 }, () => server.pool.query('SELECT pg_sleep(1)'));
      const response = await call(server.baseUrl, '/health');
      expect(response.status).toBe(503);
      await Promise.all([slow, ...blocked]);
    } finally {
      await server.stop();
    }
  });
});
