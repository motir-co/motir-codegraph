import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp, registeredRoutes, unversionedRoutes } from '../../src/server/app.js';
import { createAppPool } from '../../src/server/pool.js';
import { freshDatabase, type FreshDatabase } from '../helpers/db.js';

let db: FreshDatabase;

beforeAll(async () => {
  db = await freshDatabase();
});

afterAll(async () => {
  await db.drop();
});

describe('the route enumeration', () => {
  it('finds no route outside /v1 but /health on the app main.ts builds', async () => {
    const pool = createAppPool(db.appUrl);
    // The same factory, with the same options, src/server/run.ts passes.
    const app = await buildApp({ pool });
    try {
      const routes = registeredRoutes(app);
      expect(routes).toContainEqual({ method: 'GET', url: '/health' });
      expect(unversionedRoutes(routes)).toEqual([]);
      // Fastify's automatic HEAD route counts as /health too.
      for (const route of routes.filter(({ url }) => url === '/health')) {
        expect(['GET', 'HEAD']).toContain(route.method);
      }
    } finally {
      await app.close();
      await pool.end();
    }
  });

  it('can fail: an unversioned route is reported', () => {
    expect(
      unversionedRoutes([
        { method: 'GET', url: '/health' },
        { method: 'HEAD', url: '/health' },
        { method: 'GET', url: '/v1/whoami' },
        { method: 'GET', url: '/admin' },
        { method: 'GET', url: '/v1x' },
      ]),
    ).toEqual([
      { method: 'GET', url: '/admin' },
      { method: 'GET', url: '/v1x' },
    ]);
  });

  it('records routes mounted on /v1 with their prefix', async () => {
    const pool = createAppPool(db.appUrl);
    const app = await buildApp({
      pool,
      v1Routes: [
        (v1) => {
          v1.get('/probe', () => ({ ok: true }));
        },
      ],
    });
    try {
      expect(registeredRoutes(app)).toContainEqual({ method: 'GET', url: '/v1/probe' });
      expect(unversionedRoutes(registeredRoutes(app))).toEqual([]);
    } finally {
      await app.close();
      await pool.end();
    }
  });

  it('refuses an app it did not build', async () => {
    const { default: Fastify } = await import('fastify');
    expect(() => registeredRoutes(Fastify())).toThrow(/buildApp/);
  });
});
