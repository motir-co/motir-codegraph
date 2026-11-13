import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type pg from 'pg';

import { handleError, handleNotFound } from './errors.js';
import { DEFAULT_HEALTH_TIMEOUT_MS, registerHealth } from './health.js';
import { type RateLimitSettings, V1_PREFIX, v1Plugin, type V1Routes } from './v1.js';

export interface BuildAppOptions {
  /** The codegraph_app pool every query runs on: the only state a copy shares. */
  pool: pg.Pool;
  logger?: FastifyServerOptions['logger'];
  /** How long `/health` waits for `SELECT 1`. */
  healthTimeoutMs?: number;
  /** Extra route modules mounted on `/v1`, for tests only. */
  v1Routes?: readonly V1Routes[];
  /** The per-caller request limit on `/v1`; the default when unset. */
  rateLimit?: RateLimitSettings;
  /** The per-address failed-authentication limit on `/v1`; the default when unset. */
  failedAuthLimit?: RateLimitSettings;
  /**
   * The addresses and CIDR ranges of the proxies whose `X-Forwarded-For` is
   * believed, so `request.ip` is the real client. None when unset, and then
   * every caller behind a load balancer shares its address.
   */
  trustProxy?: readonly string[];
}

export interface RegisteredRoute {
  method: string;
  url: string;
}

/**
 * The Ajv options every route schema is compiled with. Fastify merges these
 * over its own defaults, which drop unnamed fields (`removeAdditional: true`)
 * and convert scalars (`coerceTypes: 'array'`), so both are switched off here:
 *
 * - A field a schema does not name is refused, not silently dropped, so a
 *   caller's typo is a 400 rather than a call that ignored what it sent.
 * - A value of the wrong type is refused, not converted. A JSON body already
 *   carries its types, so `7`, `true` or `["x"]` where a string belongs is the
 *   caller's mistake and a 400, never stored as `"7"`, `"true"` or `"x"`.
 *   Path parameters are strings on the wire and every schema for them says
 *   `string`, so they lose nothing. A querystring or header schema compiled
 *   by this validator sees strings too: one that wants a number declares a
 *   string and parses it, since nothing converts it.
 */
const STRICT_AJV_OPTIONS = { removeAdditional: false, coerceTypes: false } as const;

const ROUTES = Symbol('registeredRoutes');

type RecordingApp = FastifyInstance & { [ROUTES]?: RegisteredRoute[] };

/**
 * Builds one copy of the server. It keeps no state between requests: the pool
 * passed in is the only shared object, so any number of copies against one
 * database answer alike.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app: RecordingApp = Fastify({
    logger: options.logger ?? false,
    ajv: { customOptions: STRICT_AJV_OPTIONS },
    // Only these peers' X-Forwarded-For is read; a hop count is not offered,
    // since it cannot tell a proxy from a direct caller (Fastify ignores one).
    trustProxy:
      options.trustProxy === undefined || options.trustProxy.length === 0
        ? false
        : [...options.trustProxy],
  });

  // Every route, as it is registered, by the router itself: the route
  // enumeration reads this, never a hand-kept list.
  const routes: RegisteredRoute[] = [];
  app[ROUTES] = routes;
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      routes.push({ method, url: route.url });
    }
  });

  app.setErrorHandler(handleError);
  app.setNotFoundHandler(handleNotFound);

  registerHealth(app, options.pool, options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS);
  await app.register(v1Plugin, {
    prefix: V1_PREFIX,
    pool: options.pool,
    ...(options.v1Routes === undefined ? {} : { routes: options.v1Routes }),
    ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
    ...(options.failedAuthLimit === undefined ? {} : { failedAuthLimit: options.failedAuthLimit }),
  });
  await app.ready();
  return app;
}

/** Every route `app` registered, as method and full URL. */
export function registeredRoutes(app: FastifyInstance): RegisteredRoute[] {
  const routes = (app as RecordingApp)[ROUTES];
  if (routes === undefined) {
    throw new Error('registeredRoutes needs an app built by buildApp.');
  }
  return [...routes];
}

/** The routes that are neither under `/v1` nor `/health`: none may exist. */
export function unversionedRoutes(routes: readonly RegisteredRoute[]): RegisteredRoute[] {
  return routes.filter(
    ({ url }) => url !== '/health' && url !== V1_PREFIX && !url.startsWith(`${V1_PREFIX}/`),
  );
}
