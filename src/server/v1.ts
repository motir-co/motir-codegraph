import { createHash } from 'node:crypto';

import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';

import { authenticate } from './auth.js';
import { bind, commitOrRollback, releaseRequestDb } from './binding.js';
import { ApiError, handleNotFound } from './errors.js';
import { operatorRoutes } from './operator.js';
import { deleteRoutes } from './routes/deletes.js';
import { statusRoutes } from './routes/status.js';

export const V1_PREFIX = '/v1';

/** A module of `/v1` routes: registers its routes on the plugin it is given. */
export type V1Routes = (v1: FastifyInstance) => void | Promise<void>;

export interface V1Options {
  pool: pg.Pool;
  /** Extra route modules mounted on `/v1`, for tests only; `main.ts` passes none. */
  routes?: readonly V1Routes[];
  /** Requests one caller may make per window; `DEFAULT_RATE_LIMIT` when unset. */
  rateLimit?: RateLimitSettings;
}

export interface RateLimitSettings {
  max: number;
  timeWindowMs: number;
}

/** 1200 requests a minute per caller, per copy. */
export const DEFAULT_RATE_LIMIT: RateLimitSettings = { max: 1200, timeWindowMs: 60_000 };

/**
 * Who a request counts against: its credential (as a hash, so no token is held
 * in memory), or its address when it presents none. Behind a load balancer
 * every caller shares an address, so the credential is the useful key.
 */
export function rateLimitKey(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (authorization === undefined || authorization === '') {
    return `ip:${request.ip}`;
  }
  return `credential:${createHash('sha256').update(authorization).digest('base64url')}`;
}

/** The route modules every copy of the server serves. */
export const V1_ROUTE_MODULES: readonly V1Routes[] = [operatorRoutes, deleteRoutes, statusRoutes];

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

  // The first hook: a caller over its limit is refused 429 before the
  // authenticate call, so a flood costs no database work.
  await app.register(rateLimit, { global: false });
  const limit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  app.addHook(
    'onRequest',
    app.rateLimit({
      max: limit.max,
      timeWindow: limit.timeWindowMs,
      keyGenerator: rateLimitKey,
      errorResponseBuilder: () =>
        new ApiError('rate_limited', 'Too many requests; retry after the Retry-After seconds.'),
    }),
  );
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
