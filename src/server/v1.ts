import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

import { authenticate } from './auth.js';
import { bind, commitOrRollback, releaseRequestDb } from './binding.js';
import { handleNotFound } from './errors.js';

export const V1_PREFIX = '/v1';

/** A module of `/v1` routes: registers its routes on the plugin it is given. */
export type V1Routes = (v1: FastifyInstance) => void | Promise<void>;

export interface V1Options {
  pool: pg.Pool;
  /** Extra route modules mounted on `/v1`, for tests only; `main.ts` passes none. */
  routes?: readonly V1Routes[];
}

/** The route modules every copy of the server serves. */
export const V1_ROUTE_MODULES: readonly V1Routes[] = [];

/**
 * The `/v1` plugin, registered with `prefix: '/v1'`. Every versioned route is
 * registered here and nowhere else, and the hooks below are the ONE
 * authentication and binding path: they apply to every route of the plugin,
 * and to its not-found handler, so no route can skip them and an unknown
 * `/v1` path is refused 401 before it is answered `route_not_found`.
 */
export async function v1Plugin(app: FastifyInstance, options: V1Options): Promise<void> {
  app.decorateRequest('auth', null);
  app.decorateRequest('dbState', null);

  app.addHook('onRequest', authenticate(options.pool));
  app.addHook('preHandler', bind);
  app.addHook('onSend', commitOrRollback);
  app.addHook('onResponse', releaseRequestDb);

  app.setNotFoundHandler(handleNotFound);

  for (const routes of [...V1_ROUTE_MODULES, ...(options.routes ?? [])]) {
    await app.register(async (scope) => {
      await routes(scope);
    });
  }
}
