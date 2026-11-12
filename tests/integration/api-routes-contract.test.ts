import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { registeredRoutes } from '../../src/server/app.js';
import { ERROR_STATUS, handleError } from '../../src/server/errors.js';
import { createAppPool } from '../../src/server/pool.js';
import { V1_PREFIX, v1Plugin } from '../../src/server/v1.js';
import { documentedErrorCodes, markdownSection } from '../helpers/apiContract.js';
import { freshDatabase, type FreshDatabase } from '../helpers/db.js';
import { packageScripts, scriptNodeArgs } from '../helpers/processes.js';
import { recordQueries, type QueryLog } from '../helpers/queryLog.js';
import { call, startServer, type ServerCopy } from '../helpers/server.js';

interface Route {
  method: string;
  url: string;
}

const isV1 = (url: string) => url === V1_PREFIX || url.startsWith(`${V1_PREFIX}/`);

/** The route's url with every `:param` filled with a random uuid. */
const filled = (url: string) => url.replace(/:[A-Za-z]+/g, () => randomUUID());

/**
 * Calls every route with no credential and returns the ones that did not
 * answer 401 `unauthenticated` in the one error body.
 */
async function routesNotRefused(baseUrl: string, routes: Route[]): Promise<Route[]> {
  const leaks: Route[] = [];
  for (const route of routes) {
    const response = await call(baseUrl, filled(route.url), { method: route.method });
    const refused =
      response.status === 401 &&
      JSON.stringify(response.body) ===
        JSON.stringify({
          error: { code: 'unauthenticated', message: 'A valid bearer credential is required.' },
        });
    if (!refused) {
      leaks.push(route);
    }
  }
  return leaks;
}

let db: FreshDatabase;
let server: ServerCopy;
let log: QueryLog;

beforeAll(async () => {
  db = await freshDatabase();
  server = await startServer(db.appUrl);
  log = recordQueries(server.pool);
});

afterAll(async () => {
  await server.stop();
  await db.drop();
});

beforeEach(() => {
  log.clear();
});

describe('every /v1 route goes through the one authentication path', () => {
  it('answers 401 with no credential, on every route the app registers, with no statement run', async () => {
    const routes = registeredRoutes(server.app).filter(
      ({ method, url }) => isV1(url) && method !== 'HEAD',
    );
    // The operator calls, the deletes and the status route at least.
    expect(routes.length).toBeGreaterThanOrEqual(11);
    expect(await routesNotRefused(server.baseUrl, routes)).toEqual([]);
    expect(log.texts()).toEqual([]);
  });

  it('can fail: a /v1 route registered outside the plugin is reported', async () => {
    const pool = createAppPool(db.appUrl);
    // Built as buildApp builds it (the same error handler), but with one
    // route registered on the app itself instead of on the /v1 plugin.
    const app = Fastify();
    app.setErrorHandler(handleError);
    const routes: Route[] = [];
    app.addHook('onRoute', ({ method, url }) => {
      for (const verb of Array.isArray(method) ? method : [method]) {
        if (verb !== 'HEAD') routes.push({ method: verb, url });
      }
    });
    await app.register(v1Plugin, { prefix: V1_PREFIX, pool });
    app.get(`${V1_PREFIX}/tenants/:tenantId/leak`, () => ({ leaked: true }));
    try {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = app.server.address() as AddressInfo;
      const leaks = await routesNotRefused(
        `http://127.0.0.1:${String(port)}`,
        routes.filter(({ url }) => isV1(url)),
      );
      expect(leaks).toEqual([{ method: 'GET', url: '/v1/tenants/:tenantId/leak' }]);
    } finally {
      await app.close();
      await pool.end();
    }
  });
});

describe('docs/api-contract.md', () => {
  it('lists exactly the refusal codes and statuses src/server/errors.ts maps', () => {
    expect(documentedErrorCodes()).toEqual({ ...ERROR_STATUS });
  });
});

describe('the README’s Try the API recipe', () => {
  const recipe = markdownSection('README.md', /^## Try the API/);

  it('names only pnpm scripts package.json has', () => {
    const scripts = packageScripts();
    const named = [...recipe.matchAll(/\bpnpm (?:--?[a-z-]+ )*([a-z][\w:-]*)/g)]
      .map((match) => match[1] as string)
      .filter((name) => name !== 'install');
    expect(named).toEqual(
      expect.arrayContaining(['db:bootstrap', 'db:migrate', 'serve', 'operator:bootstrap', 'test']),
    );
    for (const name of named) {
      expect(scripts, name).toHaveProperty(name);
    }
  });

  it('starts the server and the bootstrap command with the commands the journey spawns', () => {
    expect(scriptNodeArgs('serve')).toContain('src/server/main.ts');
    expect(scriptNodeArgs('operator:bootstrap')).toContain('src/cli/bootstrap-operator.ts');
  });
});
