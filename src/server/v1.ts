import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';

import { authenticate } from './auth.js';
import {
  credentialKey,
  limitFailedAuthentication,
  RATE_LIMITED_MESSAGE,
  type RateLimitSettings,
} from './authLimit.js';
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
  /**
   * Failed authentications one address may make per window;
   * `DEFAULT_FAILED_AUTH_LIMIT` when unset.
   */
  failedAuthLimit?: RateLimitSettings;
}

export type { RateLimitSettings } from './authLimit.js';

/** 1200 requests a minute per caller, per copy. */
export const DEFAULT_RATE_LIMIT: RateLimitSettings = { max: 1200, timeWindowMs: 60_000 };

/** 60 failed authentications a minute per client address, per copy. */
export const DEFAULT_FAILED_AUTH_LIMIT: RateLimitSettings = { max: 60, timeWindowMs: 60_000 };

/**
 * Who a request counts against in the per-caller limit: its credential (as a
 * hash, so no token is held in memory), or its address when it presents none.
 * A caller that sends a new made-up credential on every request gets a new
 * key every time; the failed-authentication limit is what stops that one.
 */
export function rateLimitKey(request: FastifyRequest): string {
  const credential = credentialKey(request);
  return credential === null ? `ip:${request.ip}` : `credential:${credential}`;
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

  // Two limits run before any database work. The first hook counts every
  // request against its credential: a caller over its limit is refused 429
  // before the authenticate call, so a flood that reuses one credential takes
  // no connection. That limit alone does not stop a caller who sends a new
  // made-up credential each time, since each one is a new key; the second
  // limit, wrapped around authentication, counts the refusals per address and
  // refuses an address over it 429 before authenticating, unless the request's
  // credential has already authenticated on this copy.
  await app.register(rateLimit, { global: false });
  const limit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  app.addHook(
    'onRequest',
    app.rateLimit({
      max: limit.max,
      timeWindow: limit.timeWindowMs,
      keyGenerator: rateLimitKey,
      errorResponseBuilder: () => new ApiError('rate_limited', RATE_LIMITED_MESSAGE),
    }),
  );
  app.addHook(
    'onRequest',
    limitFailedAuthentication(
      app,
      authenticate(options.pool),
      options.failedAuthLimit ?? DEFAULT_FAILED_AUTH_LIMIT,
    ),
  );
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
