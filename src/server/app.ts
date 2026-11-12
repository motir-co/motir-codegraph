import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type pg from 'pg';

import { handleError, handleNotFound } from './errors.js';
import { DEFAULT_HEALTH_TIMEOUT_MS, registerHealth } from './health.js';
import { V1_PREFIX, v1Plugin, type V1Routes } from './v1.js';

export interface BuildAppOptions {
  /** The codegraph_app pool every query runs on: the only state a copy shares. */
  pool: pg.Pool;
  logger?: FastifyServerOptions['logger'];
  /** How long `/health` waits for `SELECT 1`. */
  healthTimeoutMs?: number;
  /** Extra route modules mounted on `/v1`, for tests only. */
  v1Routes?: readonly V1Routes[];
}

export interface RegisteredRoute {
  method: string;
  url: string;
}

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
    // A field a schema does not name is refused, not silently dropped, so a
    // caller's typo is a 400 rather than a call that ignored what it sent.
    ajv: { customOptions: { removeAdditional: false } },
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
